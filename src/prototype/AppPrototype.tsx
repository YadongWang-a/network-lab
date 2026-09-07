/*
 * 应用 UI 壳（源自 WF-9 原型；WF-15 M1 后拓扑数据流已入库）。
 * - 拓扑单一事实源 = `store.topology`：画布节点/边是其投影；拖放建设备、拉线、编辑、
 *   拖动位置、删除一律经 store 动作写回（WF-6 自动分配 / WF-7 自动路由随之生效）。
 * - 连线语义：线缆一端为设备接口、另一端为交换机（WF-14 决策）；路由器多接口按空闲
 *   顺序接线（enp0s3 → enp0s8 → enp0s9）。
 * - 仿真（WF-16 + WF-17）：全部演示命令由真实 SimulationEngine 驱动 —— ping/traceroute
 *   L2/L3；DHCP DORA/DNS/HTTP/TCP(FTP·telnet)/ARP 扫描走服务层（dhcpd/dhclient、named、
 *   apache2）。追踪/详情/动画为引擎事件的 UI 壳。
 * - 全部界面文案接入 react-i18next（中文默认）。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  App as AntApp,
  ConfigProvider,
  Tooltip,
  Drawer,
  Form,
  Input,
  Switch,
  Table,
  Tag,
  List,
  Descriptions,
  Select,
  Button,
  Card,
  Space,
} from 'antd';
import { FolderOpenOutlined, PlusOutlined, CaretRightOutlined, CodeOutlined, TableOutlined, RightOutlined, LeftOutlined, PauseCircleOutlined, StepForwardOutlined, ReloadOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import type { Device, DeviceId, DeviceKind, Layer, Packet, ServiceState } from '@/domain/types';
import { useStore } from '@/state/store';
import { viz } from '@/visualization/registry';
import { SimulationEngine, protoOf, type SimEvent } from '@/engine/SimulationEngine';
import TerminalBody from '@/terminal/TerminalBody';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ConnectionMode,
  useReactFlow,
} from '@xyflow/react';
import type { Connection as FlowConnection, Edge, EdgeChange, Node, NodeChange, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import i18n from '@/i18n';

// —— 设备类型（面板名 → 画布图标，完全取自原项目 assets）——
type Kind = 'pc' | 'router' | 'switch' | 'dhcpserver' | 'dhcprelay' | 'dnsserver' | 'apache2' | 'annotation';

const boardIcon: Record<Kind, string> = {
  pc: 'pc.svg',
  router: 'router.svg',
  switch: 'switch.svg',
  dhcpserver: 'dhcp.svg',
  dhcprelay: 'dhcprelay.svg',
  dnsserver: 'dns.svg',
  apache2: 'www-server.svg',
  annotation: 'pack.svg',
};

const kindKey: Record<Kind, string> = {
  pc: 'kind.pc',
  router: 'kind.router',
  switch: 'kind.switch',
  dhcpserver: 'kind.dhcpserver',
  dhcprelay: 'kind.dhcprelay',
  dnsserver: 'kind.dnsserver',
  apache2: 'kind.apache2',
  annotation: 'kind.annotation',
};

/** 域 DeviceKind → 面板/画布 UI kind（图标/文案用）。 */
const DOMAIN_KIND_UI: Record<DeviceKind, Kind> = {
  pc: 'pc',
  router: 'router',
  switch: 'switch',
  'dhcp-server': 'dhcpserver',
  'dhcp-relay-agent': 'dhcprelay',
  'dns-server': 'dnsserver',
};

/**
 * 设备图标来源：Device 真实状态决定（apache2 服务启用 → Web 服务器图标，WF-17 归并方向；
 * 其余按域 kind）。画布不信任拖放时的面板 kind。
 */
function uiKindOf(d: Device): Kind {
  return d.services?.apache2?.enabled ? 'apache2' : DOMAIN_KIND_UI[d.kind];
}

/** 拖放面板 kind → store DeviceKind；annotation 等画布标注不入拓扑（返回 null）。 */
function storeKindOf(ui: Kind): DeviceKind | null {
  switch (ui) {
    case 'pc':
    case 'apache2':
      return 'pc';
    case 'router':
      return 'router';
    case 'switch':
      return 'switch';
    case 'dhcpserver':
      return 'dhcp-server';
    case 'dhcprelay':
      return 'dhcp-relay-agent';
    case 'dnsserver':
      return 'dns-server';
    default:
      return null;
  }
}

/** 设备主接口 IP（首个有 IP 的接口；未配置 → null）。单事实源是 store 的 ip=null。 */
function ifaceIp(d: Device): string | null {
  for (const f of Object.values(d.interfaces)) if (f.ip) return f.ip;
  return null;
}

// —— 设备节点动作（终端/租约等），由 Shell 通过 Context 提供给节点组件 ——
const NodeActions = createContext<{
  openTerminal: (deviceId: string) => void;
  openLeases: (deviceId: string) => void;
}>({ openTerminal: () => {}, openLeases: () => {} });

// —— 面板条目（顺序/图标与原项目 panel.js 一致；悬浮画布底部居中，不分组）——
interface PanelItem {
  key: string;
  icon: string;
  tipKey: string;
  drag?: boolean;
  tool?: 'traffic' | 'hide' | 'cmd' | 'animation' | 'settings';
}

const panelItems: PanelItem[] = [
  { key: 'pc', icon: 'pc.svg', tipKey: 'panel.pc', drag: true },
  { key: 'router', icon: 'router.svg', tipKey: 'panel.router', drag: true },
  { key: 'switch', icon: 'switch.svg', tipKey: 'panel.switch', drag: true },
  { key: 'dhcpserver', icon: 'dhcpserver.svg', tipKey: 'panel.dhcpserver', drag: true },
  { key: 'dhcprelay', icon: 'dhcprelay.svg', tipKey: 'panel.dhcprelay', drag: true },
  { key: 'dnsserver', icon: 'dnsserver.svg', tipKey: 'panel.dnsserver', drag: true },
  { key: 'isc-dhcp-server', icon: 'isc-dhcp-server.svg', tipKey: 'panel.iscDhcpServer' },
  { key: 'isc-dhcp-client', icon: 'isc-dhcp-client.svg', tipKey: 'panel.iscDhcpClient' },
  { key: 'isc-dhcp-relay', icon: 'isc-dhcp-relay.svg', tipKey: 'panel.iscDhcpRelay' },
  { key: 'bind9', icon: 'bind9.svg', tipKey: 'panel.bind9' },
  { key: 'apache2', icon: 'apache2.svg', tipKey: 'panel.apache2', drag: true },
  { key: 'annotation', icon: 'annotation.svg', tipKey: 'panel.annotation' },
  { key: 'traffic', icon: 'traffic.svg', tipKey: 'panel.traffic', tool: 'traffic' },
  { key: 'animation', icon: 'animationControls.svg', tipKey: 'panel.animation', tool: 'animation' },
  { key: 'settings', icon: 'settings.svg', tipKey: 'panel.settings', tool: 'settings' },
  { key: 'hide', icon: 'hide-panel.svg', tipKey: 'panel.hide', tool: 'hide' },
];

// —— 协议可视化注册表（WF-5）：色码元数据已抽离至 src/visualization/registry.ts ——
const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface TraceRow {
  key: string; seq: number; time: string; proto: string; src: string; dst: string; info: string;
  /** 报文经过的设备节点（演示命令直接记录；示例数据由 IP 反查）。点击行时重放对应动画。 */
  fromId?: string; toId?: string;
}

/** 引擎事件报文 → 追踪行（src/dst/proto 从层栈推导；ARP 请求目的记 '?'）。 */
function rowOfPacket(p: Packet, info: string, seq: number): TraceRow {
  const arp = p.layers.find((l) => l.kind === 'arp');
  const ipL = p.layers.find((l) => l.kind === 'ip');
  let proto = 'unicast';
  let src = '';
  let dst = '';
  if (arp?.kind === 'arp') {
    proto = 'arp';
    src = arp.senderIp;
    dst = arp.op === 'request' ? '?' : arp.targetIp;
  } else if (ipL?.kind === 'ip') {
    proto = ipL.protocol;
    src = ipL.srcIp;
    dst = ipL.dstIp;
  }
  return { key: `e-${p.id}`, seq, time: (seq * 0.001).toFixed(3), proto, src, dst, info };
}

// 层名与字段抽取（报文详情悬浮窗用；文案走 i18n）
function layerTitle(kind: Layer['kind']): string {
  return i18n.t(`layer.${kind}`);
}

function layerFields(layer: Layer): Array<[string, string]> {
  switch (layer.kind) {
    case 'ethernet':
      return [[i18n.t('field.dstMac'), layer.dstMac], [i18n.t('field.srcMac'), layer.srcMac], [i18n.t('field.etherType'), layer.etherType]];
    case 'arp':
      return [
        [i18n.t('arp.op'), layer.op === 'request' ? i18n.t('arp.request') : i18n.t('arp.reply')],
        [i18n.t('arp.senderIp'), layer.senderIp], [i18n.t('arp.senderMac'), layer.senderMac],
        [i18n.t('arp.targetIp'), layer.targetIp], [i18n.t('arp.targetMac'), layer.targetMac],
      ];
    case 'ip':
      return [[i18n.t('ip.src'), layer.srcIp], [i18n.t('ip.dst'), layer.dstIp], [i18n.t('ip.ttl'), String(layer.ttl)], [i18n.t('ip.proto'), layer.protocol]];
    case 'icmp':
      return [[i18n.t('icmp.type'), layer.type]];
    case 'tcp':
      return [
        [i18n.t('tcp.srcPort'), String(layer.srcPort)], [i18n.t('tcp.dstPort'), String(layer.dstPort)],
        [i18n.t('tcp.seq'), String(layer.seq)], [i18n.t('tcp.ack'), String(layer.ack)],
        [i18n.t('tcp.flags'), `${layer.syn ? 'SYN ' : ''}${layer.ackFlag ? 'ACK' : ''}`.trim() || '—'],
      ];
    case 'udp':
      return [[i18n.t('tcp.srcPort'), String(layer.srcPort)], [i18n.t('tcp.dstPort'), String(layer.dstPort)]];
    case 'dhcp': {
      const fields: Array<[string, string]> = [
        [i18n.t('dhcp.msgType'), layer.messageType], [i18n.t('dhcp.xid'), `0x${layer.xid.toString(16)}`], [i18n.t('dhcp.chaddr'), layer.chaddr],
      ];
      if (layer.hostname) fields.push([i18n.t('lease.host'), layer.hostname]);
      if (layer.yiaddr) fields.push([i18n.t('dhcp.yiaddr'), layer.yiaddr]);
      if (layer.netmask) fields.push([i18n.t('dhcp.netmask'), layer.netmask]);
      if (layer.gateway) fields.push([i18n.t('dhcp.gateway'), layer.gateway]);
      return fields;
    }
    case 'dns': {
      const fields: Array<[string, string]> = [
        [i18n.t('dns.qr'), layer.qr === 'query' ? i18n.t('dns.query') : i18n.t('dns.reply')],
        [i18n.t('dhcp.xid'), `0x${layer.xid.toString(16)}`], [i18n.t('dns.name'), layer.name ?? '—'],
      ];
      if (layer.answer) fields.push([i18n.t('dns.answer'), layer.answer]);
      if (layer.rc === 'NXDOMAIN') fields.push([i18n.t('dns.rc'), 'NXDOMAIN']);
      return fields;
    }
    case 'http':
      return [[i18n.t('http.method'), layer.method ?? '—'], [i18n.t('http.host'), layer.host ?? '—'], [i18n.t('http.path'), layer.path ?? '—'], [i18n.t('http.status'), layer.status ? String(layer.status) : '—']];
  }
}

// —— React Flow 节点/边：data 只带投影所需最小信息，内容经 store 订阅 ——
type DeviceData = { kind: Kind; deviceId: DeviceId };
type DeviceFlowNode = Node<DeviceData, 'device'>;

function DeviceNodeView({ data }: NodeProps<DeviceFlowNode>) {
  const { t } = useTranslation();
  const actions = useContext(NodeActions);
  const [hover, setHover] = useState(false);
  // 节点内容 = store 真 Device（WF-15）：删除/改名/改 IP 后画布自动同步。
  const device = useStore((s) => s.topology.devices[data.deviceId]);
  if (!device) return null;
  const kind = uiKindOf(device);
  const ip = ifaceIp(device);
  return (
    <div
      style={{ width: 80, height: 80 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle id="src-c" type="source" position={Position.Top} style={{ left: '50%', top: '50%', opacity: 0 }} />
      <img
        src={`/assets/board/${boardIcon[kind]}`}
        alt={t(kindKey[kind])}
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        draggable={false}
      />
      <Handle id="tgt-c" type="target" position={Position.Top} style={{ left: '50%', top: '50%', opacity: 0 }} />
      {/* 连接点：始终挂载（拖拽中途卸载会中止连线），悬停时显示四边蓝点 */}
      {(['top', 'right', 'bottom', 'left'] as const).map((pos) => (
        <Handle
          key={pos}
          id={`src-${pos}`}
          type="source"
          position={pos === 'top' ? Position.Top : pos === 'bottom' ? Position.Bottom : pos === 'left' ? Position.Left : Position.Right}
          style={{
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? 'all' : 'none',
            width: 11,
            height: 11,
            background: '#1677ff',
            border: '2px solid #fff',
          }}
        />
      ))}
      {hover && kind !== 'annotation' && iconBtn(t('panel.openTerminal'), -8, () => actions.openTerminal(device.id), <CodeOutlined style={{ fontSize: 12 }} />)}
      {hover && kind === 'dhcpserver' && iconBtn(t('panel.leases'), 18, () => actions.openLeases(device.id), <TableOutlined style={{ fontSize: 12 }} />)}
      {/* 设备名牌：名称 + IP（按类型区分；绝对定位，不影响节点尺寸与连线中心） */}
      <div
        style={{
          position: 'absolute', top: 82, left: '50%', transform: 'translateX(-50%)',
          width: 'max-content', maxWidth: 110, textAlign: 'center', pointerEvents: 'none', zIndex: 1,
        }}
      >
        <div className="dev-name" style={{ fontSize: 12, fontWeight: 600, lineHeight: '16px', color: '#1f1f1f', textShadow: '0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff' }}>
          {device.label}
        </div>
        {ip && (
          <div className="dev-ip" style={{ fontSize: 11, lineHeight: '14px', color: '#444', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>
            {ip}
          </div>
        )}
      </div>
    </div>
  );
}

function iconBtn(tip: string, right: number, onClick: () => void, icon: React.ReactNode) {
  return (
    <Tooltip title={tip} placement="top">
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          position: 'absolute', top: -8, right, width: 22, height: 22, borderRadius: '50%',
          border: '1px solid #d9d9d9', background: '#fff', cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5,
          boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

const nodeTypes = { device: DeviceNodeView };

const edgeStyle = { stroke: '#5a7d7c', strokeWidth: 2 };
const edgeFlashStyle = { stroke: '#fa8c16', strokeWidth: 4 };

type CmdKind = 'ping' | 'tcp' | 'http' | 'ftp' | 'traceroute' | 'dns' | 'dhcp' | 'telnet' | 'arpscan';

const cmdOptions: Array<{ value: CmdKind; labelKey: string }> = [
  { value: 'ping', labelKey: 'cmd.ping' },
  { value: 'traceroute', labelKey: 'cmd.traceroute' },
  { value: 'dns', labelKey: 'cmd.dns' },
  { value: 'dhcp', labelKey: 'cmd.dhcp' },
  { value: 'tcp', labelKey: 'cmd.tcp' },
  { value: 'telnet', labelKey: 'cmd.telnet' },
  { value: 'http', labelKey: 'cmd.http' },
  { value: 'ftp', labelKey: 'cmd.ftp' },
  { value: 'arpscan', labelKey: 'cmd.arpscan' },
];

// 画布背景：白底 + 青色 10px 网格（原 .board 参数）
const boardStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
  overflow: 'hidden',
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(to right, #A0E7E5 1px, transparent 1px), linear-gradient(to bottom, #A0E7E5 1px, transparent 1px)',
  backgroundSize: '10px 10px',
};

/** 首次挂载灌入演示种子拓扑（等价旧 seedNodes/seedEdges 语义，但全部经 store 动作）。 */
function seedTopology(): void {
  const st = useStore.getState();
  if (Object.keys(st.topology.devices).length > 0) return;
  const pc0 = st.addDevice('pc', { position: { x: 180, y: 100 } });
  const pc1 = st.addDevice('pc', { position: { x: 180, y: 290 } });
  const sw = st.addDevice('switch', { position: { x: 430, y: 195 } });
  const r0 = st.addDevice('router', { position: { x: 680, y: 195 } });
  const dhcp = st.addDevice('dhcp-server', { position: { x: 680, y: 380 } });
  // 恢复旧原型的友好名称（store 默认名按全局序号：Switch-2/Router-3/DHCP-4）
  st.updateDevice(sw, { label: 'Switch-0' });
  st.updateDevice(r0, { label: 'Router-0' });
  st.updateDevice(dhcp, { label: 'DHCP-0' });
  // 全部接入同一交换机（192.168.1.0/24 段）：PC .2/.3、路由器 enp0s3 取网关 .1、DHCP .4
  st.addConnection(pc0, 'enp0s3', sw);
  st.addConnection(pc1, 'enp0s3', sw);
  st.addConnection(r0, 'enp0s3', sw);
  st.addConnection(dhcp, 'enp0s3', sw);
}

/** 服务名 → i18n 标签（配置抽屉展示用）。 */
const SERVICE_KEYS: Record<string, string> = {
  dhcpd: 'svc.dhcpd',
  dhclient: 'svc.dhclient',
  dhcrelay: 'svc.dhcrelay',
  named: 'svc.named',
  apache2: 'svc.apache2',
  iptables: 'svc.iptables',
};

/** 服务配置详情行（抽屉「已安装服务」标签下的真实字段摘要；无细节可展示返回 null）。 */
function serviceDetailLine(name: string, config: unknown): string | null {
  if (config === null || typeof config !== 'object') return null;
  if (name === 'dhcpd' && 'rangeStart' in config && 'rangeEnd' in config) {
    const start = config.rangeStart;
    const end = config.rangeEnd;
    if (typeof start === 'string' && typeof end === 'string') {
      const lease = 'leaseTime' in config && typeof config.leaseTime === 'number' ? String(config.leaseTime) : '—';
      return i18n.t('svcDetail.dhcpPool', { start, end, lease });
    }
  }
  if (name === 'named' && 'zones' in config) {
    const zones = config.zones;
    if (zones !== null && typeof zones === 'object' && !Array.isArray(zones)) {
      const list = Object.keys(zones).join(', ');
      return i18n.t('svcDetail.zones', { list: list || '—' });
    }
  }
  if (name === 'apache2' && 'documentRoot' in config) {
    const root = config.documentRoot;
    const hosts =
      'vhosts' in config && Array.isArray(config.vhosts) && config.vhosts.every((v) => typeof v === 'string')
        ? config.vhosts.join(', ')
        : '—';
    return i18n.t('svcDetail.apache', { root: typeof root === 'string' ? root : '—', hosts });
  }
  return null;
}

function Shell() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  // —— store.topology 投影（节点/边只是派生视图，永远不本地持有拓扑）——
  const deviceMap = useStore((s) => s.topology.devices);
  const connections = useStore((s) => s.topology.connections);
  // RF 受控选中态（节点/边删除键目标；不落 store）
  const [selNodeIds, setSelNodeIds] = useState<string[]>([]);
  const [selEdgeIds, setSelEdgeIds] = useState<string[]>([]);
  const nodes: DeviceFlowNode[] = useMemo(
    () =>
      Object.values(deviceMap).map((d) => ({
        id: d.id,
        type: 'device',
        position: d.position,
        data: { kind: uiKindOf(d), deviceId: d.id },
        selected: selNodeIds.includes(d.id),
      })),
    [deviceMap, selNodeIds],
  );
  const edges: Edge[] = useMemo(
    () =>
      connections.map((c) => ({
        id: c.id,
        source: c.fromDeviceId,
        target: c.toSwitchId,
        type: 'straight',
        style: edgeStyle,
        selected: selEdgeIds.includes(c.id),
      })),
    [connections, selEdgeIds],
  );
  const [selectedId, setSelectedId] = useState<DeviceId | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [traceOpen, setTraceOpen] = useState(true);
  const [traceWidth, setTraceWidth] = useState(400);
  const [details, setDetails] = useState<Array<{ id: number; row: TraceRow; packet: Packet; x: number; y: number }>>([]);
  const detailSeq = useRef(0);
  const termSeq = useRef(0);
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [tracePkts, setTracePkts] = useState<Packet[]>([]);
  const [simState, setSimState] = useState<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const simStateRef = useRef<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const [srcId, setSrcId] = useState<string | undefined>();
  const [dstId, setDstId] = useState<string | undefined>();
  const [cmdKind, setCmdKind] = useState<CmdKind>('ping');
  const [url, setUrl] = useState('www.example.com');
  const [targetPort, setTargetPort] = useState('80');
  const [terminals, setTerminals] = useState<Array<{ id: number; deviceId: string; x: number; y: number }>>([]);
  const [leaseWin, setLeaseWin] = useState<{ x: number; y: number; deviceId: string } | null>(null);
  const [vizDots, setVizDots] = useState<Array<{ id: number; x: number; y: number; hex: string; seq: number }>>([]);
  const [flashEdgeId, setFlashEdgeId] = useState<string | null>(null);
  const vizSeq = useRef(0);
  const runGen = useRef(0); // 复位代数：递增使进行中的动画失效
  const loopTokenRef = useRef(0); // 播放循环令牌：新循环使旧循环失效
  const seededOnce = useRef(false); // 种子拓扑只灌一次（New 后不自动重灌）
  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  // —— 真引擎（WF-16/17）：全部演示命令由 SimulationEngine 驱动，读 store / 写回设备状态 ——
  const engine = useMemo(
    () =>
      new SimulationEngine({
        getTopology: () => useStore.getState().topology,
        patchDevice: (id, patch) => useStore.getState().updateDevice(id, patch),
      }),
    [],
  );
  /** 引擎报文旅程：packetId →（首跳起点，定向交付终点）。 */
  const journeysRef = useRef<Map<string, { from: DeviceId; to?: DeviceId }>>(new Map());
  const rowSeqRef = useRef(0);

  // 首次挂载灌入演示种子（StrictMode 双调用由 seededOnce 幂等化）
  useEffect(() => {
    if (seededOnce.current) return;
    seededOnce.current = true;
    seedTopology();
  }, []);

  // —— 拓扑编辑一律写回 store：位置/删除/连线；选中态仅本地（RF 删除键目标）——
  function onNodesChange(changes: NodeChange<DeviceFlowNode>[]) {
    const st = useStore.getState();
    for (const ch of changes) {
      if (ch.type === 'remove') {
        st.removeDevice(ch.id);
        setSelNodeIds((s) => s.filter((x) => x !== ch.id));
      } else if (ch.type === 'position' && ch.position) {
        st.updateDevice(ch.id, { position: { x: ch.position.x, y: ch.position.y } });
      } else if (ch.type === 'select') {
        setSelNodeIds((s) => (ch.selected ? (s.includes(ch.id) ? s : [...s, ch.id]) : s.filter((x) => x !== ch.id)));
      }
      // dimensions：忽略
    }
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    const st = useStore.getState();
    for (const ch of changes) {
      if (ch.type === 'remove') {
        setSelEdgeIds((s) => s.filter((x) => x !== ch.id));
        const conn = st.topology.connections.find((c) => c.id === ch.id);
        if (conn) st.removeConnection(conn.fromDeviceId, conn.fromInterfaceId);
      } else if (ch.type === 'select') {
        setSelEdgeIds((s) => (ch.selected ? (s.includes(ch.id) ? s : [...s, ch.id]) : s.filter((x) => x !== ch.id)));
      }
    }
  }

  // 拉线（WF-15）：一端设备接口、一端交换机；路由器取第一个空闲接口接线
  function handleConnect(c: FlowConnection) {
    if (c.source === c.target) return;
    const st = useStore.getState();
    const src = st.topology.devices[c.source];
    const tgt = st.topology.devices[c.target];
    if (!src || !tgt) return;
    const sw = src.kind === 'switch' ? src : tgt.kind === 'switch' ? tgt : null;
    const dev = src === sw ? tgt : src;
    if (!sw || dev.kind === 'switch') {
      message.warning(t('msg.needSwitch'));
      return;
    }
    const free = Object.values(dev.interfaces).find((f) => f.connectedSwitchId === null);
    if (!free) {
      message.warning(t('msg.noFreeIface', { label: dev.label }));
      return;
    }
    try {
      st.addConnection(dev.id, free.id, sw.id);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  // 拖放建设备（WF-6 语义走 store.addDevice，含 apache2 → pc+apache2 服务归并）
  function onDropDevice(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation(); // 同一 handler 挂在外层 div 与 ReactFlow 两层：阻止冒泡二次建设备
    const kind = e.dataTransfer.getData('text/plain') as Kind;
    const devKind = storeKindOf(kind);
    if (!devKind) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    try {
      const id = useStore.getState().addDevice(devKind, { position: { x: pos.x - 40, y: pos.y - 40 } });
      if (kind === 'apache2') {
        // addDevice 后读最新快照（captured st 是旧状态，直接展开会拿不到新设备）
        const cur = useStore.getState().topology.devices[id];
        useStore.getState().updateDevice(id, {
          services: {
            ...(cur?.services ?? {}),
            apache2: { enabled: true, config: { documentRoot: '/var/www/html', vhosts: [] } },
          },
        });
      }
    } catch (err) {
      message.error((err as Error).message); // 地址池耗尽等
    }
  }

  function clearTopology() {
    const st = useStore.getState();
    for (const id of Object.keys(st.topology.devices)) st.removeDevice(id);
    setSelectedId(null);
  }

  // 拖拽侧边栏左缘调宽（280–640px）
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = traceWidth;
    function onMove(ev: MouseEvent) {
      setTraceWidth(Math.min(640, Math.max(280, startW + (startX - ev.clientX))));
    }
    function onUp() {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // 打开一个报文详情悬浮窗（支持同时多个，层叠排布）
  function openDetail(row: TraceRow, index: number) {
    detailSeq.current += 1;
    const id = detailSeq.current;
    const n = details.length;
    setDetails((ds) => [
      ...ds,
      {
        id,
        row,
        packet: tracePkts[index],
        x: Math.min(Math.max(window.innerWidth - 580, 20), 480 + n * 28),
        y: 90 + n * 24,
      },
    ]);
  }

  // 按住悬浮窗标题栏拖动
  function startDragPanel(id: number, e: React.MouseEvent) {
    e.preventDefault();
    const inst = details.find((d) => d.id === id);
    if (!inst) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { x, y } = inst;
    function onMove(ev: MouseEvent) {
      setDetails((ds) => ds.map((d) => (d.id === id ? { ...d, x: x + ev.clientX - startX, y: y + ev.clientY - startY } : d)));
    }
    function onUp() {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // 打开设备终端悬浮窗（可同时多个；内容 = 真终端 TerminalBody，按设备 id 关联 store）
  function openTerminal(deviceId: string) {
    termSeq.current += 1;
    const id = termSeq.current;
    const n = terminals.length;
    setTerminals((ts) => [...ts, { id, deviceId, x: Math.min(window.innerWidth - 620, 160 + n * 26), y: 120 + n * 22 }]);
  }

  function startDragTerm(id: number, e: React.MouseEvent) {
    e.preventDefault();
    const inst = terminals.find((t) => t.id === id);
    if (!inst) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { x, y } = inst;
    function onMove(ev: MouseEvent) {
      setTerminals((ts) => ts.map((t) => (t.id === id ? { ...t, x: x + ev.clientX - startX, y: y + ev.clientY - startY } : t)));
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function openLeases(deviceId: string) {
    setLeaseWin({ x: 240, y: 180, deviceId });
  }

  function startDragLease(e: React.MouseEvent) {
    e.preventDefault();
    if (!leaseWin) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { x, y } = leaseWin;
    function onMove(ev: MouseEvent) {
      setLeaseWin((w) => (w ? { ...w, x: x + ev.clientX - startX, y: y + ev.clientY - startY } : w));
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // —— WF-5 可视化：报文沿线移动（A）+ 到达后连线闪烁（B）——
  function nodeCenterOnScreen(id: string): { x: number; y: number } | null {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    const cr = canvasRef.current?.getBoundingClientRect();
    if (!el || !cr) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2 - cr.x, y: r.y + r.height / 2 - cr.y };
  }

  async function animateHop(hop: { fromId: string; toId: string; proto: string }, seq: number, gen: number = runGen.current) {
    const a = nodeCenterOnScreen(hop.fromId);
    const b = nodeCenterOnScreen(hop.toId);
    if (!a || !b) return;
    const hex = viz.colorOf(hop.proto).hex;
    vizSeq.current += 1;
    const dotId = vizSeq.current;
    setVizDots((ds) => [...ds, { id: dotId, x: a.x, y: a.y, hex, seq }]);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await waitMs(40);
      if (runGen.current !== gen) {
        setVizDots((ds) => ds.filter((d) => d.id !== dotId));
        return;
      }
      setVizDots((ds) => ds.map((d) => (d.id === dotId ? { ...d, x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps } : d)));
    }
    setVizDots((ds) => ds.filter((d) => d.id !== dotId));
  }

  // 沿拓扑边求 fromId→toId 的最短节点路径（BFS）；不连通返回 null
  function nodePathBetween(fromId: string, toId: string): string[] | null {
    if (fromId === toId) return [fromId];
    const prev = new Map<string, string | null>([[fromId, null]]);
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === toId) break;
      for (const e of edges) {
        const nb = e.source === cur ? e.target : e.target === cur ? e.source : null;
        if (nb && !prev.has(nb)) {
          prev.set(nb, cur);
          queue.push(nb);
        }
      }
    }
    if (!prev.has(toId)) return null;
    const path: string[] = [];
    for (let cur: string | null = toId; cur !== null; cur = prev.get(cur) ?? null) path.unshift(cur);
    return path;
  }

  // 报文沿物理路径逐段移动：途经交换机/路由器可见，并闪烁经过的链路
  async function animatePath(fromId: string, toId: string, proto: string, seq: number) {
    const gen = runGen.current;
    const path = nodePathBetween(fromId, toId);
    if (!path || path.length < 2) {
      // 不连通或无连线：退化为直线飞行
      await animateHop({ fromId, toId, proto }, seq, gen);
      return;
    }
    for (let i = 0; i < path.length - 1; i++) {
      await animateHop({ fromId: path[i], toId: path[i + 1], proto }, seq, gen);
      if (runGen.current !== gen) return;
      const eid = edges.find((e) => (e.source === path[i] && e.target === path[i + 1]) || (e.source === path[i + 1] && e.target === path[i]))?.id;
      if (eid) {
        setFlashEdgeId(eid);
        await waitMs(320);
        if (runGen.current !== gen) return;
        setFlashEdgeId(null);
      }
    }
  }

  // 点击追踪行：重放该报文对应的画布动画（WF-5 续）。演示命令行直接用记录的节点；
  // 示例数据行（无 fromId/toId）按 src/dst IP 反查拓扑设备，两端齐全才重放。
  function replayHop(row: TraceRow) {
    const devs = Object.values(useStore.getState().topology.devices);
    const fromId = row.fromId ?? devs.find((d) => ifaceIp(d) === row.src)?.id;
    const toId = row.toId ?? devs.find((d) => ifaceIp(d) === row.dst)?.id;
    if (fromId && toId && toId !== fromId) {
      void animatePath(fromId, toId, row.proto, 1);
      return;
    }
    // 广播/洪泛行（引擎行无定向交付终点）：向所有邻居逐个重放
    if (fromId) void replayFlood(fromId, row.proto);
  }

  // —— 真引擎驱动（WF-16）：动画与追踪行都由引擎事件生成（WF-5 事件驱动两级架构）——
  /** 广播行重播：从源设备向每个邻居逐跳重放洪泛。 */
  async function replayFlood(fromId: string, proto: string) {
    const neighbors = edges.flatMap((e) => (e.source === fromId ? [e.target] : e.target === fromId ? [e.source] : []));
    for (const n of neighbors) await animateHopPhys(fromId, n, proto);
  }
  async function animateHopPhys(fromId: string, toId: string, proto: string) {
    const gen = runGen.current;
    await animateHop({ fromId, toId, proto }, vizSeq.current);
    if (runGen.current !== gen) return;
    const eid = edges.find((e) => (e.source === fromId && e.target === toId) || (e.source === toId && e.target === fromId))?.id;
    if (eid) {
      setFlashEdgeId(eid);
      await waitMs(320);
      if (runGen.current !== gen) return;
      setFlashEdgeId(null);
    }
  }

  /** 引擎事件 → 画布动画 + 追踪行。首跳建行（fromId=起点）；仅「定向交付」跳更新
   *  终点 toId（洪泛拷贝不改写终点），重播按 toId 走完整路径、无 toId 时重放洪泛。 */
  async function consumeEngineEvent(ev: SimEvent) {
    if (ev.type === 'notice') {
      (ev.level === 'warn' ? message.warning : message.info)(ev.message);
      return;
    }
    if (ev.type === 'dropped') {
      message.warning(ev.reason);
      return;
    }
    const gen = runGen.current;
    await animateHopPhys(ev.from, ev.to, protoOf(ev.packet));
    if (runGen.current !== gen) return;
    const seen = journeysRef.current.get(ev.packet.id);
    if (!seen) {
      journeysRef.current.set(ev.packet.id, { from: ev.from, to: ev.delivered ? ev.to : undefined });
      rowSeqRef.current += 1;
      const row: TraceRow = { ...rowOfPacket(ev.packet, ev.info ?? '', rowSeqRef.current), fromId: ev.from };
      if (ev.delivered) row.toId = ev.to;
      setTraces((ts) => [...ts, row]);
      setTracePkts((ps) => [...ps, ev.packet]);
    } else if (ev.delivered) {
      seen.to = ev.to;
      const key = `e-${ev.packet.id}`;
      setTraces((ts) => ts.map((r) => (r.key === key ? { ...r, toId: ev.to } : r)));
    }
  }

  /** 演示命令 → 目标端口（TCP 类命令；http/FTP/telnet 固定约定端口）。 */
  function cmdPort(): number {
    if (cmdKind === 'ftp') return 21;
    if (cmdKind === 'telnet') return 23;
    return parseInt(targetPort, 10) || 8080;
  }

  /** 启动真引擎命令（WF-16/17）：校验选择 → 复位引擎与追踪 → 按类型分发引擎 API。 */
  function beginEngineOp(): boolean {
    const st = useStore.getState();
    const src = srcId ? st.topology.devices[srcId] : undefined;
    const dst = dstId ? st.topology.devices[dstId] : undefined;
    const srcIp = src ? ifaceIp(src) : null;
    const dstIp = dst ? ifaceIp(dst) : null;
    if (!src) {
      message.warning(t('sim.pickIncomplete'));
      return false;
    }
    // 服务类命令需要目标节点；拓扑中无对应服务节点 → 明确中文提示（不再静默/硬编码公网）
    if (cmdKind === 'dns' && !dst) {
      message.warning(
        nodes.some((n) => n.data.kind === 'dnsserver') ? t('sim.pickIncomplete') : t('sim.needDns'),
      );
      return false;
    }
    if (cmdKind === 'dhcp' && !dst) {
      message.warning(
        nodes.some((n) => n.data.kind === 'dhcpserver') ? t('sim.pickIncomplete') : t('sim.needDhcp'),
      );
      return false;
    }
    if (cmdKind === 'http' && !dst) {
      message.warning(t('sim.needHttp'));
      return false;
    }
    // DHCP 客户端允许无 IP（Discover 从 0.0.0.0 广播，绑定语义由引擎 dhcpDora 处理）
    const needsSrcIp = cmdKind !== 'dhcp';
    if ((needsSrcIp && !srcIp) || (dst && !dstIp)) {
      message.warning(t('sim.pickIncomplete'));
      return false;
    }
    engine.reset();
    journeysRef.current = new Map();
    rowSeqRef.current = 0;
    setTraces([]);
    setTracePkts([]);
    setDetails([]);
    setTraceOpen(true);
    const host = url.trim() || 'www.example.com';
    switch (cmdKind) {
      case 'ping': void engine.ping(src.id, dstIp!); break;
      case 'traceroute': void engine.traceroute(src.id, dstIp!); break;
      case 'dhcp': void engine.dhcpDora(src.id, dst!.id); break;
      case 'dns': void engine.dnsQuery(src.id, dst!.id, host); break;
      case 'http': void engine.httpGet(src.id, dst!.id, host); break;
      case 'tcp':
      case 'ftp':
      case 'telnet': void engine.tcpConnect(src.id, dst!.id, cmdPort()); break;
      case 'arpscan': void engine.arpScan(src.id); break;
    }
    return true;
  }

  /** 引擎播放循环：逐跳 step→动画→追踪；队列排空且引擎收敛 → 播完。 */
  async function runEngineLoop() {
    const gen = runGen.current;
    const token = ++loopTokenRef.current; // 新循环使旧循环在下一检查点退出
    for (;;) {
      if (simStateRef.current !== 'running' || runGen.current !== gen || loopTokenRef.current !== token) return;
      const ev = engine.step();
      if (!ev) {
        await waitMs(30); // 让处理续延（ARP/应答 Promise）入队
        if (loopTokenRef.current !== token) return;
        if (engine.isIdle()) {
          // 收敛判定前再让一拍：末跳应答的续延（如 arpScan/DORA 收尾 notice）可能刚入微任务
          await waitMs(60);
          if (loopTokenRef.current !== token) return;
          if (engine.isIdle()) break;
        }
        continue;
      }
      await consumeEngineEvent(ev);
    }
    if (loopTokenRef.current === token && runGen.current === gen && simStateRef.current === 'running') {
      simStateRef.current = 'finished';
      setSimState('finished');
    }
  }

  // —— 真引擎播放控制（WF-16/17）：start/step/resume 统一走 runEngineLoop ——
  function startSim() {
    runGen.current += 1; // 使进行中的单步动画失效
    if (!beginEngineOp()) return;
    simStateRef.current = 'running';
    setSimState('running');
    void runEngineLoop();
  }

  function pauseSim() {
    simStateRef.current = 'paused';
    setSimState('paused');
  }

  /** 单步：空闲时先发起命令再推进一步（异步续延由后续 step/播放推进）。 */
  async function stepSim() {
    if (simState !== 'idle' && simState !== 'paused') return;
    if (simState === 'idle' && !beginEngineOp()) return;
    simStateRef.current = 'paused';
    setSimState('paused');
    const gen = runGen.current;
    const ev = engine.step();
    if (ev) await consumeEngineEvent(ev);
    if (runGen.current !== gen) return; // 复位打断
    await waitMs(30); // 让处理续延（ARP/应答 Promise）入队
    if (engine.isIdle()) {
      simStateRef.current = 'finished';
      setSimState('finished');
    }
  }

  function resumeSim() {
    simStateRef.current = 'running';
    setSimState('running');
    void runEngineLoop();
  }

  function resetSim() {
    runGen.current += 1; // 使进行中的动画全部失效
    simStateRef.current = 'idle';
    setSimState('idle');
    setTraces([]);
    setTracePkts([]);
    setDetails([]);
    setVizDots([]);
    setFlashEdgeId(null);
    engine.reset(); // 清引擎队列/等待者
    journeysRef.current = new Map();
  }

  // 改变演示参数后旧序列作废：自动复位
  useEffect(() => {
    if (simStateRef.current !== 'idle') resetSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, dstId, cmdKind]);

  // 目标设备必须与命令类型匹配（DNS/DHCP 需对应服务节点）；切命令后残留的旧目标作废
  useEffect(() => {
    if (!dstId) return;
    const d = deviceMap[dstId];
    const valid = d && (cmdKind === 'dns' ? d.kind === 'dns-server' : cmdKind === 'dhcp' ? d.kind === 'dhcp-server' : true);
    if (!valid) setDstId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdKind, deviceMap]);

  // 原生 click 监听：节点选择 → 打开配置抽屉（按钮点击已排除）；读 store 快照，不依赖闭包
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return; // 设备上的操作按钮（终端/租约）不触发抽屉
      const nodeEl = target.closest('.react-flow__node');
      if (!nodeEl) {
        if (target.closest('.react-flow__pane')) {
          setSelectedId(null);
        }
        return;
      }
      const id = nodeEl.getAttribute('data-id');
      if (id && useStore.getState().topology.devices[id]) setSelectedId(id);
    }
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  const selected = selectedId ? deviceMap[selectedId] : undefined;
  // 租约窗数据源：dhcp-server 设备上的真实租约（引擎 dhcpd 落盘，订阅 store 实时联动）
  const leaseServer = leaseWin && deviceMap[leaseWin.deviceId] ? deviceMap[leaseWin.deviceId] : undefined;

  return (
    <NodeActions.Provider value={{ openTerminal, openLeases }}>
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* —— 顶部标题栏 —— */}
        <div
          style={{
            height: 48, flexShrink: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', padding: '0 16px',
            background: '#fff', borderBottom: '1px solid #e5e5e5',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>{t('app.title')}</span>
          <Space>
            <Tooltip title={t('nav.openTooltip')}>
              <Button icon={<FolderOpenOutlined />}>{t('nav.open')}</Button>
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={clearTopology}>
              {t('nav.new')}
            </Button>
          </Space>
        </div>

        {/* —— 命令面板（固定在画布上方）—— */}
        <div
          style={{
            height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
            padding: '0 16px', background: '#fafafa', borderBottom: '1px solid #e5e5e5',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: '#666', flexShrink: 0 }}>{t('cmd.title')}</span>
          <Select
            style={{ width: 130 }}
            value={cmdKind}
            onChange={(v) => setCmdKind(v as CmdKind)}
            options={cmdOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            size="small"
          />
          <Select
            placeholder={t('cmd.src')}
            style={{ width: 130 }}
            value={srcId}
            onChange={(v) => setSrcId(v)}
            options={nodes.map((n) => ({ value: n.id, label: deviceMap[n.id]?.label ?? n.id }))}
            size="small"
          />
          {cmdKind === 'arpscan' ? null : (
            <>
              <Select
                placeholder={
                  cmdKind === 'dns' ? t('cmd.dnsServer')
                  : cmdKind === 'dhcp' ? t('cmd.dhcpServer')
                  : cmdKind === 'http' ? t('cmd.webServer')
                  : t('cmd.target')
                }
                style={{ width: 140 }}
                value={dstId}
                onChange={(v) => setDstId(v)}
                options={
                  cmdKind === 'dns'
                    ? nodes.filter((n) => n.data.kind === 'dnsserver').map((n) => ({ value: n.id, label: deviceMap[n.id]?.label ?? n.id }))
                    : cmdKind === 'dhcp'
                      ? nodes.filter((n) => n.data.kind === 'dhcpserver').map((n) => ({ value: n.id, label: deviceMap[n.id]?.label ?? n.id }))
                      : nodes.filter((n) => n.id !== srcId).map((n) => ({ value: n.id, label: deviceMap[n.id]?.label ?? n.id }))
                }
                size="small"
              />
              {(cmdKind === 'tcp' || cmdKind === 'ftp' || cmdKind === 'telnet') && (
                <Input
                  value={targetPort}
                  onChange={(e) => setTargetPort(e.target.value)}
                  placeholder={cmdKind === 'ftp' ? '21' : cmdKind === 'telnet' ? '23' : '8080'}
                  style={{ width: 130 }}
                  size="small"
                  addonBefore={cmdKind === 'telnet' ? 'Telnet' : cmdKind === 'ftp' ? 'FTP' : 'Port'}
                />
              )}
            </>
          )}
          {(cmdKind === 'http' || cmdKind === 'dns') && (
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={cmdKind === 'dns' ? t('cmd.domain') : t('cmd.url')}
              style={{ width: 170 }}
              size="small"
            />
          )}
          {simState === 'running' ? (
            <Button size="small" icon={<PauseCircleOutlined />} onClick={pauseSim}>
              {t('sim.pause')}
            </Button>
          ) : (
            <Button size="small" type="primary" icon={<CaretRightOutlined />} onClick={simState === 'paused' ? resumeSim : startSim} disabled={simState === 'finished'}>
              {simState === 'paused' ? t('sim.resume') : t('sim.start')}
            </Button>
          )}
          <Button size="small" icon={<StepForwardOutlined />} onClick={stepSim} disabled={simState === 'running' || simState === 'finished'}>
            {t('sim.step')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={resetSim} disabled={simState === 'idle'}>
            {t('sim.reset')}
          </Button>
        </div>

        {/* —— 内容区：左画布 + 右报文追踪 —— */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 画布（复刻原 .board） */}
          <div ref={canvasRef} style={boardStyle} onDragOver={(e) => e.preventDefault()} onDrop={onDropDevice}>
            <ReactFlow<DeviceFlowNode>
              nodes={nodes}
              edges={edges.map((e) => (flashEdgeId === e.id ? { ...e, style: edgeFlashStyle } : e))}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={80}
              onConnect={handleConnect}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropDevice}
              defaultEdgeOptions={{ type: 'straight', style: edgeStyle }}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              style={{ width: '100%', height: '100%', background: '#fff' }}
            >
              <Background variant={BackgroundVariant.Lines} gap={10} color="#A0E7E5" />
              <Controls showInteractive={false} position="top-left" />
            </ReactFlow>

            {/* 收起报文追踪后的展开按钮（画布右上角） */}
            {!traceOpen && (
              <Tooltip title={t('trace.expand')} placement="left">
                <Button
                  size="small"
                  icon={<LeftOutlined />}
                  onClick={() => setTraceOpen(true)}
                  style={{ position: 'absolute', top: 10, right: 10, zIndex: 10 }}
                />
              </Tooltip>
            )}

            {/* WF-5 报文动画层：沿线移动的报文标记 */}
            {vizDots.map((d) => (
              <div
                key={d.id}
                className="viz-dot"
                style={{
                  position: 'absolute', left: d.x - 10, top: d.y - 10, width: 20, height: 20,
                  borderRadius: '50%', background: d.hex, border: '2px solid #fff',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.35)', zIndex: 30, pointerEvents: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
                  {d.seq}
                </span>
              </div>
            ))}

            {/* 设备图标条：悬浮于画布底部、水平居中（不分组，原版图标与顺序） */}
            {panelOpen && (
              <div
                style={{
                  position: 'absolute', left: '50%', bottom: 10, zIndex: 10, transform: 'translateX(-50%)',
                  display: 'flex', alignItems: 'center', gap: 2,
                  backgroundColor: '#fff', border: '1px solid #d9d9d9', borderRadius: 8,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)', padding: '4px 8px',
                  maxWidth: 'calc(100% - 20px)', overflowX: 'auto',
                }}
              >
                {panelItems.map((it) => {
                  const tile = (
                    <div
                      key={it.key}
                      draggable={Boolean(it.drag)}
                      onDragStart={it.drag ? (e) => e.dataTransfer.setData('text/plain', it.key) : undefined}
                      onClick={
                        it.tool === 'traffic' ? () => setTraceOpen((v) => !v)
                          : it.tool === 'hide' ? () => setPanelOpen(false)
                            : undefined
                      }
                      style={{
                        width: 40, height: 40, borderRadius: 6, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: it.drag || it.tool ? 'pointer' : 'default',
                      }}
                    >
                      <img src={`/assets/panel/${it.icon}`} alt={it.key} style={{ width: 30, height: 30 }} draggable={false} />
                    </div>
                  );
                  return <Tooltip key={it.key} title={t(it.tipKey)} placement="top">{tile}</Tooltip>;
                })}
              </div>
            )}

            {/* 收起设备栏后的展开把手（左下角） */}
            {!panelOpen && (
              <Tooltip title={t('panel.expandBar')} placement="top">
                <div
                  onClick={() => setPanelOpen(true)}
                  style={{
                    position: 'absolute', left: 10, bottom: 10, zIndex: 10, width: 44, height: 44,
                    backgroundColor: '#fff', border: '1px solid #d9d9d9', borderRadius: 8,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  }}
                >
                  <img src="/assets/panel/settings.svg" alt="panel" style={{ width: 30, height: 30 }} />
                </div>
              </Tooltip>
            )}
          </div>

          {/* 右侧报文追踪栏（traffic 图标开关） */}
          {traceOpen && (
            <>
              {/* 拖拽手柄：调宽报文追踪栏 */}
              <div
                onMouseDown={startResize}
                style={{ width: 4, flexShrink: 0, cursor: 'col-resize', userSelect: 'none' }}
              />
              <div
                style={{
                  width: traceWidth, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e5e5e5',
                  display: 'flex', flexDirection: 'column', minHeight: 0,
                }}
              >
                <div
                  style={{
                    height: 40, flexShrink: 0, display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', padding: '0 12px', borderBottom: '1px solid #f0f0f0',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{t('trace.title')}</span>
                  <Tooltip title={t('trace.collapse')}>
                    <Button size="small" icon={<RightOutlined />} onClick={() => setTraceOpen(false)} />
                  </Tooltip>
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px' }}>
                  <List
                    size="small"
                    dataSource={traces}
                    renderItem={(row, index) => (
                      <List.Item
                        onClick={() => { openDetail(row, index); replayHop(row); }}
                        style={{ display: 'block', padding: '6px 4px', cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: '#8c8c8c', minWidth: 16, textAlign: 'center' }}>
                            {row.seq}
                          </span>
                          <Tag color={viz.colorOf(row.proto).tag} style={{ marginInlineEnd: 0 }}>
                            {row.proto.toUpperCase()}
                          </Tag>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.src} → {row.dst}
                          </span>
                          <span style={{ flexShrink: 0, color: '#999', fontSize: 12 }}>{row.time}s</span>
                        </div>
                        <div style={{ marginTop: 2, color: '#666', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.info}
                        </div>
                      </List.Item>
                    )}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 设备配置抽屉（点设备弹出；保存写回 store：updateDevice/updateInterface） */}
      <Drawer
        title={
          selected
            ? t('drawer.title', { label: selected.label, kind: t(kindKey[uiKindOf(selected)]) })
            : t('drawer.titlePlain')
        }
        open={selected !== undefined}
        onClose={() => setSelectedId(null)}
        width={400}
      >
        {selected && (
          <Form
            key={selected.id}
            layout="vertical"
            initialValues={{
              label: selected.label,
              ...(selected.kind === 'router' ? { fwd: selected.ipv4Forwarding } : {}),
              ...Object.fromEntries(
                Object.values(selected.interfaces).flatMap((f, i) => [
                  [`ip${i}`, f.ip ?? ''],
                  [`mask${i}`, f.netmask ?? ''],
                  [`gw${i}`, f.gateway ?? ''],
                ]),
              ),
            }}
            onFinish={(vals) => {
              const st = useStore.getState();
              const patch: Partial<Device> = { label: vals.label };
              if (selected.kind === 'router') patch.ipv4Forwarding = Boolean(vals.fwd);
              st.updateDevice(selected.id, patch);
              Object.values(selected.interfaces).forEach((f, i) => {
                const ip = (vals[`ip${i}`] as string | undefined)?.trim() || null;
                const mask = (vals[`mask${i}`] as string | undefined)?.trim() || null;
                if (ip || mask) {
                  st.updateInterface(selected.id, f.id, { ip, netmask: mask });
                }
                const gw = (vals[`gw${i}`] as string | undefined)?.trim() || null;
                if (selected.kind !== 'router' && gw) {
                  st.updateInterface(selected.id, f.id, { gateway: gw });
                }
              });
              setSelectedId(null);
              message.success(t('msg.saved'));
            }}
          >
            <Form.Item label={t('drawer.label')} name="label"><Input /></Form.Item>
            {selected.kind === 'switch' && (
              <Form.Item>
                <span style={{ color: '#999', fontSize: 12 }}>{t('drawer.switchL2')}</span>
              </Form.Item>
            )}
            {selected.kind !== 'switch' && (
              <>
                {selected.kind === 'router' && (
                  <Form.Item label={t('drawer.forwarding')} name="fwd" valuePropName="checked"><Switch /></Form.Item>
                )}
                <Form.Item label={t('drawer.interfaces')}>
                  {Object.values(selected.interfaces).map((f, i) => (
                    <div key={f.id} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
                      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{f.name}</div>
                      <Space direction="vertical" style={{ width: '100%' }} size={4}>
                        <Form.Item label={t('drawer.ip')} name={`ip${i}`} style={{ marginBottom: 4 }}><Input placeholder="0.0.0.0" /></Form.Item>
                        <Form.Item label={t('drawer.mask')} name={`mask${i}`} style={{ marginBottom: 4 }}><Input placeholder="255.255.255.0" /></Form.Item>
                        {selected.kind !== 'router' && (
                          <Form.Item label={t('drawer.gw')} name={`gw${i}`} style={{ marginBottom: 0 }}><Input placeholder="192.168.1.1" /></Form.Item>
                        )}
                      </Space>
                    </div>
                  ))}
                </Form.Item>
              </>
            )}
            <Form.Item label={t('drawer.services')}>
              {(() => {
                const entries = Object.entries(selected.services).filter(
                  (e): e is [string, ServiceState] => Boolean(e[1]?.enabled),
                );
                // dhcpd 配置实际落在 device.dhcpPool（WF-2/6 沿用）；补一条合成条目供展示
                if (selected.dhcpPool && !entries.some(([name]) => name === 'dhcpd')) {
                  entries.push(['dhcpd', { enabled: true, config: selected.dhcpPool }]);
                }
                if (entries.length === 0) {
                  return <span style={{ color: '#999' }}>{t('common.none')}</span>;
                }
                return (
                  <>
                    <Space wrap>
                      {entries.map(([name]) => (
                        <Tag key={name} color={name === 'dhcpd' ? 'blue' : 'green'}>{t(SERVICE_KEYS[name] ?? 'common.none')}</Tag>
                      ))}
                    </Space>
                    {entries.map(([name, svc]) => {
                      const detail = serviceDetailLine(name, svc.config);
                      return detail ? (
                        <div key={`${name}-detail`} style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
                          {detail}
                        </div>
                      ) : null;
                    })}
                  </>
                );
              })()}
            </Form.Item>
            <Form.Item label={t('drawer.routingTable')}>
              <Table
                size="small"
                pagination={false}
                columns={[
                  { title: t('route.net'), dataIndex: 'net' },
                  { title: t('route.nextHop'), dataIndex: 'hop' },
                  { title: t('route.egress'), dataIndex: 'egress' },
                ]}
                dataSource={
                  selected.routingTable.length > 0
                    ? selected.routingTable.map((r, i) => ({
                        key: String(i),
                        net: `${r.network}/${r.netmask}`,
                        hop: r.nextHop === '0.0.0.0' ? t('route.direct') : r.nextHop,
                        egress: r.interfaceId,
                      }))
                    : [{ key: 'empty', net: t('route.empty'), hop: '', egress: '' }]
                }
              />
            </Form.Item>
            <Form.Item label={t('drawer.firewall')}>
              <Table
                size="small"
                pagination={false}
                columns={[
                  { title: t('fw.protocol'), dataIndex: 'p' },
                  { title: t('fw.action'), dataIndex: 'a' },
                ]}
                dataSource={
                  selected.firewall.rules.length > 0
                    ? selected.firewall.rules.map((r, i) => ({ key: String(i), p: r.protocol ?? 'all', a: r.action }))
                    : [{ key: 'none', p: t('common.none'), a: '' }]
                }
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>
              {t('drawer.save')}
            </Button>
          </Form>
        )}
      </Drawer>

      {/* 报文详情悬浮窗（可拖拽、可同时打开多个） */}
      {details.map((p) => (
        <Card
          key={p.id}
          size="small"
          title={
            <span
              style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
              onMouseDown={(e) => startDragPanel(p.id, e)}
            >
              {t('packet.detailTitle', { proto: p.row.proto.toUpperCase() })}
            </span>
          }
          extra={<a onClick={() => setDetails((ds) => ds.filter((d) => d.id !== p.id))}>{t('common.close')}</a>}
          style={{
            position: 'fixed', left: p.x, top: p.y, width: 560, zIndex: 1000 + p.id,
            boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
          }}
        >
          <Descriptions
            size="small"
            column={2}
            bordered
            items={[
              { key: 'time', label: t('packet.time'), children: `${p.row.time}s` },
              { key: 'proto', label: t('packet.proto'), children: p.row.proto.toUpperCase() },
              { key: 'src', label: t('packet.src'), children: p.row.src },
              { key: 'dst', label: t('packet.dst'), children: p.row.dst },
            ]}
          />
          <div style={{ margin: '12px 0 6px', fontWeight: 600 }}>{t('packet.layers')}</div>
          {p.packet.layers.map((layer, i) => (
            <div key={i} style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {i + 1}. {layerTitle(layer.kind)}
                <Tag style={{ marginInlineStart: 8 }}>{layer.kind}</Tag>
              </div>
              <Descriptions
                size="small"
                column={2}
                items={layerFields(layer).map(([k, v], j) => ({ key: `${j}`, label: k, children: v }))}
              />
            </div>
          ))}
        </Card>
      ))}

      {/* 设备终端悬浮窗（可拖拽、可同时打开多个；内容 = 真终端命令注册表 TerminalBody） */}
      {terminals.map((tm) => {
        const termDev = deviceMap[tm.deviceId];
        return (
          <Card
            key={tm.id}
            size="small"
            title={
              <span
                style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
                onMouseDown={(e) => startDragTerm(tm.id, e)}
              >
                {t('term.title', { label: termDev?.label ?? tm.deviceId })}
              </span>
            }
            extra={<a onClick={() => setTerminals((ts) => ts.filter((x) => x.id !== tm.id))}>{t('common.close')}</a>}
            style={{
              position: 'fixed', left: tm.x, top: tm.y, width: 620, zIndex: 1100 + tm.id,
              boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
            }}
          >
            {termDev ? (
              <TerminalBody
                deviceId={tm.deviceId}
                onClose={() => setTerminals((ts) => ts.filter((x) => x.id !== tm.id))}
              />
            ) : (
              <div style={{ color: '#999', padding: 12 }}>{t('common.none')}</div>
            )}
          </Card>
        );
      })}

      {/* DHCP 租约悬浮窗（数据源 = dhcp-server 设备 dhcpLeases；引擎 DORA 落盘实时联动） */}
      {leaseServer && leaseWin && (
        <Card
          size="small"
          title={
            <span
              style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
              onMouseDown={startDragLease}
            >
              {t('lease.title', { label: leaseServer.label })}
            </span>
          }
          extra={<a onClick={() => setLeaseWin(null)}>{t('common.close')}</a>}
          style={{
            position: 'fixed', left: leaseWin.x, top: leaseWin.y, width: 440, zIndex: 1100,
            boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
          }}
        >
          <Table
            size="small"
            pagination={false}
            columns={[
              { title: t('lease.host'), dataIndex: 'h' },
              { title: t('lease.ip'), dataIndex: 'ip' },
              { title: t('lease.mac'), dataIndex: 'mac' },
              { title: t('lease.exp'), dataIndex: 'exp' },
            ]}
            dataSource={
              (() => {
                const rows = (leaseServer.dhcpLeases ?? [])
                  .filter((l) => l.expiresAt > Date.now())
                  .map((l) => {
                    const d = new Date(l.expiresAt);
                    const p = (n: number) => String(n).padStart(2, '0');
                    return { key: l.mac, h: l.hostname ?? '—', ip: l.ip, mac: l.mac, exp: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
                  });
                return rows.length > 0
                  ? rows
                  : [{ key: 'empty', h: t('lease.empty'), ip: '', mac: '', exp: '' }];
              })()
            }
          />
        </Card>
      )}
    </NodeActions.Provider>
  );
}

export default function AppPrototype() {
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 6 } }}>
      <AntApp>
        <ReactFlowProvider>
          <Shell />
        </ReactFlowProvider>
      </AntApp>
    </ConfigProvider>
  );
}
