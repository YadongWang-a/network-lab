/*
 * 应用 UI 壳（源自 WF-9 原型；WF-15 M1 后拓扑数据流已入库）。
 * - 拓扑单一事实源 = `store.topology`：画布节点/边是其投影；拖放建设备、拉线、编辑、
 *   拖动位置、删除一律经 store 动作写回（WF-6 自动分配 / WF-7 自动路由随之生效）。
 * - 连线语义：线缆一端为设备接口、另一端为交换机（WF-14 决策）；路由器多接口按空闲
 *   顺序接线（enp0s3 → enp0s8 → enp0s9）。
 * - 仿真双轨（WF-16）：ping/traceroute 由真实 SimulationEngine 驱动；其余演示命令
 *   仍走原型假序列（buildSequence + waitMs），随 WF-17 逐个转真。追踪/详情/动画为 UI 壳。
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
import type { Device, DeviceId, DeviceKind, Layer, Packet } from '@/domain/types';
import { useStore } from '@/state/store';
import { viz } from '@/visualization/registry';
import { SimulationEngine, protoOf, type SimEvent } from '@/engine/SimulationEngine';
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

/** 设备主接口 MAC（接口一定存在；假仿真帧用真实 MAC，增删设备不再错位）。 */
function ifaceMac(d: Device): string {
  return Object.values(d.interfaces)[0]?.mac ?? '00:00:00:00:00:00';
}

// —— 设备节点动作（终端/租约等），由 Shell 通过 Context 提供给节点组件 ——
const NodeActions = createContext<{
  openTerminal: (label: string, ip: string) => void;
  openLeases: (label: string) => void;
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

const traceData: TraceRow[] = [
  { key: '1', seq: 1, time: '0.001', proto: 'arp', src: '192.168.1.10', dst: '?', info: i18n.t('gen.arpWho', { dst: '192.168.1.1', src: '192.168.1.10' }) },
  { key: '2', seq: 2, time: '0.002', proto: 'arp', src: '192.168.1.1', dst: '192.168.1.10', info: i18n.t('gen.arpAt', { ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:01' }) },
  { key: '3', seq: 3, time: '0.004', proto: 'icmp', src: '192.168.1.10', dst: '192.168.1.1', info: i18n.t('gen.echoReq') },
  { key: '4', seq: 4, time: '0.005', proto: 'icmp', src: '192.168.1.1', dst: '192.168.1.10', info: i18n.t('gen.echoReply') },
  { key: '5', seq: 5, time: '0.020', proto: 'dhcp', src: '0.0.0.0', dst: '255.255.255.255', info: 'DHCP Discover' },
];

// 示例报文（WF-2 层栈模型）：供"报文详情"悬浮窗逐层展示
function mkPacket(layers: Layer[], xid?: number): Packet {
  return { id: `pkt-${Math.random().toString(16).slice(2, 8)}`, layers, xid, createdAt: Date.now() };
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

const tracePackets: Packet[] = [
  mkPacket([
    { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: 'aa:bb:cc:dd:ee:10', etherType: 'arp' },
    { kind: 'arp', op: 'request', senderIp: '192.168.1.10', senderMac: 'aa:bb:cc:dd:ee:10', targetIp: '192.168.1.1', targetMac: '00:00:00:00:00:00' },
  ]),
  mkPacket([
    { kind: 'ethernet', dstMac: 'aa:bb:cc:dd:ee:10', srcMac: 'aa:bb:cc:dd:ee:01', etherType: 'arp' },
    { kind: 'arp', op: 'reply', senderIp: '192.168.1.1', senderMac: 'aa:bb:cc:dd:ee:01', targetIp: '192.168.1.10', targetMac: 'aa:bb:cc:dd:ee:10' },
  ]),
  mkPacket([
    { kind: 'ethernet', dstMac: 'aa:bb:cc:dd:ee:01', srcMac: 'aa:bb:cc:dd:ee:10', etherType: 'ipv4' },
    { kind: 'ip', srcIp: '192.168.1.10', dstIp: '192.168.1.1', ttl: 64, protocol: 'icmp' },
    { kind: 'icmp', type: 'echo-request' },
  ]),
  mkPacket([
    { kind: 'ethernet', dstMac: 'aa:bb:cc:dd:ee:10', srcMac: 'aa:bb:cc:dd:ee:01', etherType: 'ipv4' },
    { kind: 'ip', srcIp: '192.168.1.1', dstIp: '192.168.1.10', ttl: 64, protocol: 'icmp' },
    { kind: 'icmp', type: 'echo-reply' },
  ]),
  mkPacket([
    { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: 'aa:bb:cc:dd:ee:20', etherType: 'ipv4' },
    { kind: 'ip', srcIp: '0.0.0.0', dstIp: '255.255.255.255', ttl: 64, protocol: 'udp' },
    { kind: 'udp', srcPort: 68, dstPort: 67 },
    { kind: 'dhcp', messageType: 'discover', xid: 0x3d1d, chaddr: 'aa:bb:cc:dd:ee:20' },
  ]),
];

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
      if (layer.yiaddr) fields.push([i18n.t('dhcp.yiaddr'), layer.yiaddr]);
      return fields;
    }
    case 'dns':
      return [[i18n.t('dns.qr'), layer.qr === 'query' ? i18n.t('dns.query') : i18n.t('dns.reply')], [i18n.t('dhcp.xid'), `0x${layer.xid.toString(16)}`], [i18n.t('dns.name'), layer.name ?? '—']];
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
      {hover && kind !== 'annotation' && iconBtn(t('panel.openTerminal'), -8, () => actions.openTerminal(device.label, ip ?? t('device.unconfigured')), <CodeOutlined style={{ fontSize: 12 }} />)}
      {hover && kind === 'dhcpserver' && iconBtn(t('panel.leases'), 18, () => actions.openLeases(device.label), <TableOutlined style={{ fontSize: 12 }} />)}
      {/* 设备名牌：名称 + IP（按类型区分；绝对定位，不影响节点尺寸与连线中心） */}
      <div
        style={{
          position: 'absolute', top: 82, left: '50%', transform: 'translateX(-50%)',
          width: 'max-content', maxWidth: 110, textAlign: 'center', pointerEvents: 'none', zIndex: 1,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '16px', color: '#1f1f1f', textShadow: '0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff' }}>
          {device.label}
        </div>
        {ip && (
          <div style={{ fontSize: 11, lineHeight: '14px', color: '#444', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>
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

/** http 演示的假想公网目标（无对应节点时沿用惯例，WF-17 转真实后移除）。 */
const INTERNET_IP = '93.184.216.34';

function ethLayer(dstMac: string, srcMac: string): Layer {
  return { kind: 'ethernet', dstMac, srcMac, etherType: 'ipv4' };
}

function ipLayer(srcIp: string, dstIp: string, protocol: 'icmp' | 'tcp' | 'udp', ttl = 64): Layer {
  return { kind: 'ip', srcIp, dstIp, ttl, protocol };
}

function tcpLayer(srcPort: number, dstPort: number, seq: number, ack: number, syn: boolean, ackFlag: boolean): Layer {
  return { kind: 'tcp', srcPort, dstPort, seq, ack, syn, ackFlag };
}

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
  const [traces, setTraces] = useState<TraceRow[]>(traceData);
  const [tracePkts, setTracePkts] = useState<Packet[]>(tracePackets);
  const [simState, setSimState] = useState<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const simStateRef = useRef<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const simRef = useRef<{ rows: TraceRow[]; pkts: Packet[]; hops: Array<{ fromId: string; toId: string; proto: string }>; index: number } | null>(null);
  const [srcId, setSrcId] = useState<string | undefined>();
  const [dstId, setDstId] = useState<string | undefined>();
  const [cmdKind, setCmdKind] = useState<CmdKind>('ping');
  const [url, setUrl] = useState('www.example.com');
  const [targetPort, setTargetPort] = useState('80');
  const [terminals, setTerminals] = useState<Array<{ id: number; label: string; ip: string; x: number; y: number; lines: string[]; input: string }>>([]);
  const [leaseWin, setLeaseWin] = useState<{ x: number; y: number; label: string } | null>(null);
  const [vizDots, setVizDots] = useState<Array<{ id: number; x: number; y: number; hex: string; seq: number }>>([]);
  const [flashEdgeId, setFlashEdgeId] = useState<string | null>(null);
  const vizSeq = useRef(0);
  const runGen = useRef(0); // 复位代数：递增使进行中的动画失效
  const hoppingRef = useRef(false); // 跳动画互斥：同一时刻只允许一跳
  const loopTokenRef = useRef(0); // 播放循环令牌：新循环使旧循环失效
  const seededOnce = useRef(false); // 种子拓扑只灌一次（New 后不自动重灌）
  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  // —— 真引擎（WF-16）：ping/traceroute 由 SimulationEngine 驱动，读 store / 写回设备状态 ——
  const engine = useMemo(
    () =>
      new SimulationEngine({
        getTopology: () => useStore.getState().topology,
        patchDevice: (id, patch) => useStore.getState().updateDevice(id, patch),
      }),
    [],
  );
  /** 引擎模式报文旅程：packetId →（首跳起点，定向交付终点）。 */
  const journeysRef = useRef<Map<string, { from: DeviceId; to?: DeviceId }>>(new Map());
  const rowSeqRef = useRef(0);
  const cmdIsEngine = cmdKind === 'ping' || cmdKind === 'traceroute';

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
      const st = useStore.getState();
      const id = st.addDevice(devKind, { position: { x: pos.x - 40, y: pos.y - 40 } });
      if (kind === 'apache2') {
        st.updateDevice(id, {
          services: {
            ...st.topology.devices[id].services,
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

  // 打开设备终端悬浮窗（可同时多个）
  function openTerminal(label: string, ip: string) {
    termSeq.current += 1;
    const id = termSeq.current;
    const n = terminals.length;
    setTerminals((ts) => [
      ...ts,
      { id, label, ip, x: Math.min(window.innerWidth - 620, 160 + n * 26), y: 120 + n * 22, lines: [i18n.t('term.welcome', { label })], input: '' },
    ]);
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

  // 迷你 shell：help / ip a / ping <ip> / clear（提示文案走 i18n；ping 输出保持惯例英文）
  function handleTermKey(tm: { id: number; label: string; ip: string; lines: string[]; input: string }, e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const cmd = tm.input.trim();
    const out: string[] = [`root@${tm.label}:~$ ${tm.input}`];
    if (cmd === 'help') {
      out.push(i18n.t('term.help'));
    } else if (cmd === 'ip a') {
      out.push('1: lo: <LOOPBACK,UP,LOWER_UP>', '    inet 127.0.0.1/8 scope host lo', '2: enp0s3: <BROADCAST,MULTICAST,UP>', `    inet ${tm.ip}/24 brd 192.168.1.255 scope global enp0s3`);
    } else if (cmd.startsWith('ping ')) {
      const dstIp = cmd.slice(5).trim() || '0.0.0.0';
      for (let i = 1; i <= 4; i++) out.push(`64 bytes from ${dstIp}: icmp_seq=${i} ttl=64 time=0.${10 + i * 7} ms`);
    } else if (cmd === 'clear') {
      setTerminals((ts) => ts.map((x) => (x.id === tm.id ? { ...x, lines: [], input: '' } : x)));
      return;
    } else if (cmd) {
      out.push(i18n.t('term.notFound', { cmd: cmd.split(' ')[0] }));
    }
    setTerminals((ts) => ts.map((x) => (x.id === tm.id ? { ...x, lines: [...x.lines, ...out], input: '' } : x)));
  }

  function openLeases(label: string) {
    setLeaseWin({ x: 240, y: 180, label });
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

  /** 启动真引擎命令（ping/traceroute）：校验选择 → 复位引擎与追踪 → 异步发起。 */
  function beginEngineOp(): boolean {
    const st = useStore.getState();
    const src = srcId ? st.topology.devices[srcId] : undefined;
    const dst = dstId ? st.topology.devices[dstId] : undefined;
    const dstIp = dst ? ifaceIp(dst) : null;
    if (!src || !dstIp || !ifaceIp(src)) {
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
    void (cmdKind === 'ping' ? engine.ping(srcId!, dstIp) : engine.traceroute(srcId!, dstIp));
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
        if (engine.isIdle()) break;
        continue;
      }
      await consumeEngineEvent(ev);
    }
    if (loopTokenRef.current === token && runGen.current === gen && simStateRef.current === 'running') {
      simStateRef.current = 'finished';
      setSimState('finished');
    }
  }

  // —— 假仿真序列合成（WF-16 换真实引擎；数据源 = store 设备真身）——
  function buildSequence(): { rows: TraceRow[]; pkts: Packet[]; hops: Array<{ fromId: string; toId: string; proto: string }> } | null {
    const devs = Object.values(useStore.getState().topology.devices);
    const src = devs.find((d) => d.id === srcId);
    if (!src) return null;
    const dst = devs.find((d) => d.id === dstId);
    if (cmdKind !== 'http' && !dst) return null;
    const smac = ifaceMac(src);
    const sip = ifaceIp(src) ?? '0.0.0.0';
    const dip = cmdKind === 'http' ? INTERNET_IP : (dst ? ifaceIp(dst) ?? sip : sip);
    const dmac = dst ? ifaceMac(dst) : 'aa:bb:cc:dd:ee:40';
    let time = 0.001;
    const rows: TraceRow[] = [];
    const pkts: Packet[] = [];
    const hops: Array<{ fromId: string; toId: string; proto: string }> = [];
    const srcNodeId = src.id;
    const dstNodeId = dst ? dst.id : src.id;
    function add(proto: string, s: string, d: string, info: string, packet: Packet, fromId: string, toId: string) {
      rows.push({ key: `c-${Date.now()}-${rows.length}`, seq: rows.length + 1, time: time.toFixed(3), proto, src: s, dst: d, info, fromId, toId });
      pkts.push(packet);
      hops.push({ fromId, toId, proto });
      time += 0.001;
    }
    const arpPkt = (op: 'request' | 'reply', sMac: string, dMac: string, sIp: string, dIp: string) =>
      mkPacket([
        { kind: 'ethernet', dstMac: op === 'request' ? 'ff:ff:ff:ff:ff:ff' : sMac, srcMac: dMac, etherType: 'arp' },
        { kind: 'arp', op, senderIp: dIp, senderMac: dMac, targetIp: sIp, targetMac: sMac },
      ]);
    add('arp', sip, dip, i18n.t('gen.arpWho', { dst: dip, src: sip }), arpPkt('request', smac, dmac, sip, dip), srcNodeId, dstNodeId);
    add('arp', dip, sip, i18n.t('gen.arpAt', { ip: dip, mac: dmac }), arpPkt('reply', dmac, smac, dip, sip), dstNodeId, srcNodeId);
    if (cmdKind === 'tcp' || cmdKind === 'http' || cmdKind === 'ftp' || cmdKind === 'telnet') {
      const port = cmdKind === 'http' ? 80 : cmdKind === 'ftp' ? 21 : cmdKind === 'telnet' ? 23 : parseInt(targetPort) || 8080;
      add('tcp', sip, dip, i18n.t('gen.syn'), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, port, 1000, 0, true, false)]), srcNodeId, dstNodeId);
      add('tcp', dip, sip, i18n.t('gen.synAck'), mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'tcp'), tcpLayer(port, 49152, 3000, 1001, true, true)]), dstNodeId, srcNodeId);
      add('tcp', sip, dip, i18n.t('gen.ack'), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, port, 1001, 3001, false, true)]), srcNodeId, dstNodeId);
    }
    if (cmdKind === 'http') {
      add('http', sip, dip, i18n.t('gen.get', { url }), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, 80, 1001, 3001, false, true), { kind: 'http', method: 'GET', host: url, path: '/' }]), srcNodeId, dstNodeId);
      add('http', dip, sip, i18n.t('gen.ok', { url }), mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'tcp'), tcpLayer(80, 49152, 3001, 1002, false, true), { kind: 'http', status: 200 }]), dstNodeId, srcNodeId);
    }
    if (cmdKind === 'ftp') {
      add('ftp', sip, dip, `USER anonymous`, mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, 21, 1001, 3001, false, true), { kind: 'http', method: 'USER', host: 'ftp', path: 'anonymous' }]), srcNodeId, dstNodeId);
      add('ftp', dip, sip, `331 Please specify the password.`, mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'tcp'), tcpLayer(21, 49152, 3001, 1002, false, true), { kind: 'http', status: 331 }]), dstNodeId, srcNodeId);
    }
    if (cmdKind === 'telnet') {
      add('tcp', sip, dip, 'Telnet 会话建立', mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, 23, 1001, 3001, false, true)]), srcNodeId, dstNodeId);
    }
    if (cmdKind === 'dns') {
      const dnsDev = devs.find((d) => uiKindOf(d) === 'dnsserver');
      const dnsIp = (dnsDev ? ifaceIp(dnsDev) : dst ? ifaceIp(dst) : null) ?? dip;
      add('dns', sip, dnsIp, `DNS 查询 ${url}`, mkPacket([ethLayer(dmac, smac), ipLayer(sip, dnsIp, 'udp'), { kind: 'udp', srcPort: 49152, dstPort: 53 }, { kind: 'dns', qr: 'query', xid: 0x1234, name: url }]), srcNodeId, dnsDev?.id ?? dstNodeId);
      add('dns', dnsIp, sip, `DNS 应答 → ${dip}`, mkPacket([ethLayer(smac, dmac), ipLayer(dnsIp, sip, 'udp'), { kind: 'udp', srcPort: 53, dstPort: 49152 }, { kind: 'dns', qr: 'reply', xid: 0x1234, name: url }]), dnsDev?.id ?? dstNodeId, srcNodeId);
    }
    if (cmdKind === 'dhcp') {
      const dhcpDev = devs.find((d) => uiKindOf(d) === 'dhcpserver');
      if (dhcpDev) {
        const dhcpIp = ifaceIp(dhcpDev) ?? '192.168.1.1';
        add('dhcp', '0.0.0.0', '255.255.255.255', 'DHCP Discover（广播）', mkPacket([ethLayer('ff:ff:ff:ff:ff:ff', smac), ipLayer('0.0.0.0', '255.255.255.255', 'udp'), { kind: 'udp', srcPort: 68, dstPort: 67 }, { kind: 'dhcp', messageType: 'discover', xid: 0x3d1d, chaddr: smac }]), srcNodeId, dhcpDev.id);
        add('dhcp', dhcpIp, sip, `DHCP Offer → 提供 ${sip}`, mkPacket([ethLayer(smac, dmac), ipLayer(dhcpIp, sip, 'udp'), { kind: 'udp', srcPort: 67, dstPort: 68 }, { kind: 'dhcp', messageType: 'offer', xid: 0x3d1d, chaddr: smac, yiaddr: sip }]), dhcpDev.id, srcNodeId);
        add('dhcp', '0.0.0.0', '255.255.255.255', 'DHCP Request（广播确认）', mkPacket([ethLayer('ff:ff:ff:ff:ff:ff', smac), ipLayer('0.0.0.0', '255.255.255.255', 'udp'), { kind: 'udp', srcPort: 68, dstPort: 67 }, { kind: 'dhcp', messageType: 'request', xid: 0x3d1d, chaddr: smac }]), srcNodeId, dhcpDev.id);
        add('dhcp', dhcpIp, sip, `DHCP Ack → 确认 ${sip}`, mkPacket([ethLayer(smac, dmac), ipLayer(dhcpIp, sip, 'udp'), { kind: 'udp', srcPort: 67, dstPort: 68 }, { kind: 'dhcp', messageType: 'ack', xid: 0x3d1d, chaddr: smac, yiaddr: sip }]), dhcpDev.id, srcNodeId);
      }
    }
    if (cmdKind === 'arpscan') {
      const sameSubnet = devs.filter((d) => d.id !== srcId && ifaceIp(d) !== null);
      sameSubnet.forEach((dev) => {
        const devMac = ifaceMac(dev);
        const devIp = ifaceIp(dev)!;
        add('arp', sip, devIp, `ARP 扫描 → ${devIp}`, mkPacket([ethLayer(devMac, smac), { kind: 'arp', op: 'request', senderIp: sip, senderMac: smac, targetIp: devIp, targetMac: '00:00:00:00:00:00' }]), srcNodeId, dev.id);
        add('arp', devIp, sip, `${devIp} 位于 ${devMac}`, mkPacket([ethLayer(smac, devMac), { kind: 'arp', op: 'reply', senderIp: devIp, senderMac: devMac, targetIp: sip, targetMac: smac }]), dev.id, srcNodeId);
      });
    }
    return { rows, pkts, hops };
  }

  async function animateNextHop(): Promise<boolean> {
    const sim = simRef.current;
    if (!sim || sim.index >= sim.hops.length || hoppingRef.current) return false;
    hoppingRef.current = true;
    try {
      const gen = runGen.current;
      const hop = sim.hops[sim.index];
      await animatePath(hop.fromId, hop.toId, hop.proto, sim.index + 1);
      if (runGen.current !== gen) return false; // 复位打断：丢弃本跳
      // 先捕获当前行：updater 在渲染时才求值，届时 index 已递增，
      // 在 updater 内读 sim.index 会取错行甚至越界（undefined → List 崩溃）
      const row = sim.rows[sim.index];
      const pkt = sim.pkts[sim.index];
      setTraces((ts) => [...ts, row]);
      setTracePkts((ps) => [...ps, pkt]);
      sim.index++;
      return true;
    } finally {
      hoppingRef.current = false;
    }
  }

  async function runLoop() {
    const gen = runGen.current;
    const token = ++loopTokenRef.current; // 新循环使旧循环在下一检查点退出
    while (simStateRef.current === 'running' && runGen.current === gen && simRef.current && simRef.current.index < simRef.current.hops.length) {
      const advanced = await animateNextHop();
      if (loopTokenRef.current !== token) return; // 被新循环接替
      if (!advanced) await waitMs(50);
    }
    if (loopTokenRef.current === token && runGen.current === gen && simRef.current && simRef.current.index >= simRef.current.hops.length) {
      simStateRef.current = 'finished';
      setSimState('finished');
    }
  }

  function startSim() {
    runGen.current += 1; // 使进行中的单步动画失效
    if (cmdIsEngine) {
      if (!beginEngineOp()) return;
      simStateRef.current = 'running';
      setSimState('running');
      void runEngineLoop();
      return;
    }
    const seq = buildSequence();
    if (!seq) return;
    simRef.current = { ...seq, index: 0 };
    simStateRef.current = 'running';
    setSimState('running');
    setTraces([]);
    setTracePkts([]);
    setDetails([]);
    setTraceOpen(true);
    // 自动播放：由 runLoop 持续推进，直到暂停或播完
    void runLoop();
  }

  function pauseSim() {
    simStateRef.current = 'paused';
    setSimState('paused');
  }

  async function stepSim() {
    if (simState !== 'idle' && simState !== 'paused') return;
    if (cmdIsEngine) {
      // 真引擎：空闲时先发起命令，再推进一跳；推进后保持暂停/播完
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
      return;
    }
    if (hoppingRef.current) return; // 上一跳动画进行中，忽略本次点击
    const gen = runGen.current;
    if (simState === 'idle') {
      // 空闲：构建序列，只播放第一跳
      const seq = buildSequence();
      if (!seq) return;
      simRef.current = { ...seq, index: 0 };
      setTraces([]);
      setTracePkts([]);
      setDetails([]);
      setTraceOpen(true);
    }
    if (!simRef.current) return;
    await animateNextHop();
    if (runGen.current !== gen || simStateRef.current === 'running') return; // 复位打断，或恢复播放已接管状态
    if (simRef.current.index >= simRef.current.hops.length) {
      simStateRef.current = 'finished';
      setSimState('finished');
    } else {
      simStateRef.current = 'paused';
      setSimState('paused');
    }
  }

  function resumeSim() {
    simStateRef.current = 'running';
    setSimState('running');
    void (cmdIsEngine ? runEngineLoop() : runLoop());
  }

  function resetSim() {
    runGen.current += 1; // 使进行中的动画全部失效
    simStateRef.current = 'idle';
    setSimState('idle');
    simRef.current = null;
    setTraces([]);
    setTracePkts([]);
    setDetails([]);
    setVizDots([]);
    setFlashEdgeId(null);
    engine.reset(); // 清引擎队列/等待者（ping/traceroute 真轨）
    journeysRef.current = new Map();
  }

  // 改变演示参数后旧序列作废：自动复位
  useEffect(() => {
    if (simStateRef.current !== 'idle') resetSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, dstId, cmdKind]);

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
          {cmdKind === 'http' ? (
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('cmd.url')}
              style={{ width: 160 }}
              size="small"
            />
          ) : cmdKind === 'arpscan' ? null : (
            <>
              <Select
                placeholder={
                  cmdKind === 'dns' ? t('cmd.dnsServer')
                  : cmdKind === 'dhcp' ? t('cmd.dhcpServer')
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
                const enabled = Object.entries(selected.services)
                  .filter(([, svc]) => svc?.enabled)
                  .map(([name]) => name);
                if (selected.dhcpPool) enabled.push('dhcpd');
                return enabled.length > 0 ? (
                  <Space wrap>
                    {enabled.map((name) => (
                      <Tag key={name} color={name === 'dhcpd' ? 'blue' : 'green'}>{t(SERVICE_KEYS[name] ?? 'common.none')}</Tag>
                    ))}
                  </Space>
                ) : (
                  <span style={{ color: '#999' }}>{t('common.none')}</span>
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

      {/* 设备终端悬浮窗（可拖拽、可同时打开多个） */}
      {terminals.map((tm) => (
        <Card
          key={tm.id}
          size="small"
          title={
            <span
              style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
              onMouseDown={(e) => startDragTerm(tm.id, e)}
            >
              {t('term.title', { label: tm.label })}
            </span>
          }
          extra={<a onClick={() => setTerminals((ts) => ts.filter((x) => x.id !== tm.id))}>{t('common.close')}</a>}
          style={{
            position: 'fixed', left: tm.x, top: tm.y, width: 560, zIndex: 1100 + tm.id,
            boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
          }}
        >
          <div style={{ background: '#141414', color: '#d6deeb', fontFamily: 'Consolas, Menlo, monospace', fontSize: 13, height: 320, overflowY: 'auto', padding: 10, borderRadius: 4 }}>
            {tm.lines.map((l, i) => (
              <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{l}</div>
            ))}
            <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
              <span style={{ color: '#9ece6a', flexShrink: 0 }}>root@{tm.label}:~$</span>
              <input
                value={tm.input}
                onChange={(e) => setTerminals((ts) => ts.map((x) => (x.id === tm.id ? { ...x, input: e.target.value } : x)))}
                onKeyDown={(e) => handleTermKey(tm, e)}
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#d6deeb', fontFamily: 'inherit', fontSize: 13 }}
                autoFocus
              />
            </div>
          </div>
        </Card>
      ))}

      {/* DHCP 租约悬浮窗（静态示例；WF-17 接真实租约） */}
      {leaseWin && (
        <Card
          size="small"
          title={
            <span
              style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
              onMouseDown={startDragLease}
            >
              {t('lease.title', { label: leaseWin.label })}
            </span>
          }
          extra={<a onClick={() => setLeaseWin(null)}>{t('common.close')}</a>}
          style={{
            position: 'fixed', left: leaseWin.x, top: leaseWin.y, width: 420, zIndex: 1100,
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
            dataSource={[
              { key: '1', h: 'pc-0', ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01', exp: '23:41:02' },
              { key: '2', h: 'pc-1', ip: '192.168.1.11', mac: 'aa:bb:cc:dd:ee:02', exp: '22:07:55' },
            ]}
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
