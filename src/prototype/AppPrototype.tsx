/*
 * PROTOTYPE — 非生产代码（WF-9 UI 原型 + WF-8 i18n + WF-5 可视化）。
 * 布局：顶部标题栏 + [左画布 | 右报文追踪栏]；设备图标条悬浮于画布底部居中（不分组）。
 * 画布复刻原版（React Flow）：白底 #A0E7E5 网格、原版 SVG 图标、缩放/平移、拖放设备、
 * 悬停四边蓝点拖拽连线、设备名牌、悬停操作按钮（终端/租约）、命令面板驱动报文流动动画。
 * 全部界面文案接入 react-i18next（中文默认）。真实实现由 WF-4/WF-5/正式实现替换本文件。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
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
import { FolderOpenOutlined, PlusOutlined, CaretRightOutlined, CodeOutlined, TableOutlined, RightOutlined, LeftOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import type { Layer, Packet } from '@/domain/types';
import { viz } from '@/visualization/registry';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  addEdge,
  ConnectionMode,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeChange, NodeProps } from '@xyflow/react';
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
  { key: 'annotation', icon: 'annotation.svg', tipKey: 'panel.annotation', drag: true },
  { key: 'traffic', icon: 'traffic.svg', tipKey: 'panel.traffic', tool: 'traffic' },
  { key: 'cmd', icon: 'bus.svg', tipKey: 'panel.cmd', tool: 'cmd' },
  { key: 'animation', icon: 'animationControls.svg', tipKey: 'panel.animation', tool: 'animation' },
  { key: 'settings', icon: 'settings.svg', tipKey: 'panel.settings', tool: 'settings' },
  { key: 'hide', icon: 'hide-panel.svg', tipKey: 'panel.hide', tool: 'hide' },
];

// —— 协议可视化注册表（WF-5）：色码元数据已抽离至 src/visualization/registry.ts ——
const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface TraceRow {
  key: string; time: string; proto: string; src: string; dst: string; info: string;
}

const traceData: TraceRow[] = [
  { key: '1', time: '0.001', proto: 'arp', src: '192.168.1.10', dst: '?', info: i18n.t('gen.arpWho', { dst: '192.168.1.1', src: '192.168.1.10' }) },
  { key: '2', time: '0.002', proto: 'arp', src: '192.168.1.1', dst: '192.168.1.10', info: i18n.t('gen.arpAt', { ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:01' }) },
  { key: '3', time: '0.004', proto: 'icmp', src: '192.168.1.10', dst: '192.168.1.1', info: i18n.t('gen.echoReq') },
  { key: '4', time: '0.005', proto: 'icmp', src: '192.168.1.1', dst: '192.168.1.10', info: i18n.t('gen.echoReply') },
  { key: '5', time: '0.020', proto: 'dhcp', src: '0.0.0.0', dst: '255.255.255.255', info: 'DHCP Discover' },
];

// 示例报文（WF-2 层栈模型）：供"报文详情"悬浮窗逐层展示
function mkPacket(layers: Layer[], xid?: number): Packet {
  return { id: `pkt-${Math.random().toString(16).slice(2, 8)}`, layers, xid, createdAt: Date.now() };
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

// —— React Flow 节点/边 ——
type DeviceData = {
  kind: Kind;
  label: string;
  ip: string;
  netmask: string;
  gateway: string;
  ipv4Forwarding: boolean;
};
type DeviceFlowNode = Node<DeviceData, 'device'>;

function DeviceNodeView({ data }: NodeProps<DeviceFlowNode>) {
  const { t } = useTranslation();
  const showIp = data.ip !== '—' && data.kind !== 'annotation';
  const actions = useContext(NodeActions);
  const [hover, setHover] = useState(false);
  // 中心锚点（隐藏）：所有边显式锚定到设备中心，渲染确定性
  return (
    <div
      style={{ width: 80, height: 80 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle id="src-c" type="source" position={Position.Top} style={{ left: '50%', top: '50%', opacity: 0 }} />
      <img
        src={`/assets/board/${boardIcon[data.kind]}`}
        alt={t(kindKey[data.kind])}
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
      {hover && data.kind !== 'annotation' && iconBtn(t('panel.openTerminal'), -8, () => actions.openTerminal(data.label, data.ip === '—' ? t('device.unconfigured') : data.ip), <CodeOutlined style={{ fontSize: 12 }} />)}
      {hover && data.kind === 'dhcpserver' && iconBtn(t('panel.leases'), 18, () => actions.openLeases(data.label), <TableOutlined style={{ fontSize: 12 }} />)}
      {/* 设备名牌：名称 + IP（按类型区分；绝对定位，不影响节点尺寸与连线中心） */}
      <div
        style={{
          position: 'absolute', top: 82, left: '50%', transform: 'translateX(-50%)',
          width: 'max-content', maxWidth: 110, textAlign: 'center', pointerEvents: 'none', zIndex: 1,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '16px', color: '#1f1f1f', textShadow: '0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff' }}>
          {data.label}
        </div>
        {showIp && (
          <div style={{ fontSize: 11, lineHeight: '14px', color: '#444', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>
            {data.ip}
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

const seedNodes: DeviceFlowNode[] = [
  { id: 'pc-0', type: 'device', position: { x: 180, y: 100 }, data: { kind: 'pc', label: 'PC-0', ip: '192.168.1.10', netmask: '255.255.255.0', gateway: '192.168.1.1', ipv4Forwarding: false } },
  { id: 'pc-1', type: 'device', position: { x: 180, y: 290 }, data: { kind: 'pc', label: 'PC-1', ip: '192.168.1.11', netmask: '255.255.255.0', gateway: '192.168.1.1', ipv4Forwarding: false } },
  { id: 'sw-0', type: 'device', position: { x: 430, y: 195 }, data: { kind: 'switch', label: 'Switch-0', ip: '—', netmask: '', gateway: '', ipv4Forwarding: false } },
  { id: 'r-0', type: 'device', position: { x: 680, y: 195 }, data: { kind: 'router', label: 'Router-0', ip: '192.168.1.1', netmask: '255.255.255.0', gateway: '', ipv4Forwarding: true } },
  { id: 'dhcp-0', type: 'device', position: { x: 680, y: 380 }, data: { kind: 'dhcpserver', label: 'DHCP-0', ip: '192.168.1.1', netmask: '255.255.255.0', gateway: '', ipv4Forwarding: false } },
];

const seedEdges: Edge[] = [
  { id: 'pc-0-sw-0', source: 'pc-0', target: 'sw-0', sourceHandle: 'src-c', targetHandle: 'tgt-c' },
  { id: 'pc-1-sw-0', source: 'pc-1', target: 'sw-0', sourceHandle: 'src-c', targetHandle: 'tgt-c' },
  { id: 'sw-0-r-0', source: 'sw-0', target: 'r-0', sourceHandle: 'src-c', targetHandle: 'tgt-c' },
  { id: 'r-0-dhcp-0', source: 'r-0', target: 'dhcp-0', sourceHandle: 'src-c', targetHandle: 'tgt-c' },
];

const edgeStyle = { stroke: '#5a7d7c', strokeWidth: 2 };
const edgeFlashStyle = { stroke: '#fa8c16', strokeWidth: 4 };

type CmdKind = 'ping' | 'tcp' | 'http';

function macOf(i: number): string {
  return `aa:bb:cc:dd:ee:${(i + 1).toString(16).padStart(2, '0')}`;
}

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
  { value: 'tcp', labelKey: 'cmd.tcp' },
  { value: 'http', labelKey: 'cmd.http' },
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

function Shell() {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<DeviceFlowNode[]>(seedNodes);
  const [edges, setEdges] = useState<Edge[]>(seedEdges);
  const [selected, setSelected] = useState<DeviceFlowNode | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [traceOpen, setTraceOpen] = useState(true);
  const [traceWidth, setTraceWidth] = useState(400);
  const [details, setDetails] = useState<Array<{ id: number; row: TraceRow; packet: Packet; x: number; y: number }>>([]);
  const detailSeq = useRef(0);
  const termSeq = useRef(0);
  const [traces, setTraces] = useState<TraceRow[]>(traceData);
  const [tracePkts, setTracePkts] = useState<Packet[]>(tracePackets);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdPos, setCmdPos] = useState({ x: 140, y: 90 });
  const [srcId, setSrcId] = useState<string | undefined>();
  const [dstId, setDstId] = useState<string | undefined>();
  const [cmdKind, setCmdKind] = useState<CmdKind>('ping');
  const [url, setUrl] = useState('www.example.com');
  const [terminals, setTerminals] = useState<Array<{ id: number; label: string; ip: string; x: number; y: number; lines: string[]; input: string }>>([]);
  const [leaseWin, setLeaseWin] = useState<{ x: number; y: number; label: string } | null>(null);
  const [vizDots, setVizDots] = useState<Array<{ id: number; x: number; y: number; hex: string }>>([]);
  const [flashEdgeId, setFlashEdgeId] = useState<string | null>(null);
  const [animBusy, setAnimBusy] = useState(false);
  const vizSeq = useRef(0);
  const seq = useRef(0);
  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  function onNodesChange(changes: NodeChange<DeviceFlowNode>[]) {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }

  function onDropDevice(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const kind = e.dataTransfer.getData('text/plain') as Kind;
    if (!(kind in boardIcon)) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    seq.current += 1;
    const id = `${kind}-${seq.current}`;
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: 'device',
        position: { x: pos.x - 40, y: pos.y - 40 },
        data: { kind, label: id, ip: kind === 'switch' ? '—' : t('device.unconfigured'), netmask: '255.255.255.0', gateway: '', ipv4Forwarding: false },
      },
    ]);
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

  // 拖拽演示命令面板
  function startDragCmd(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const { x, y } = cmdPos;
    function onMove(ev: MouseEvent) {
      setCmdPos({ x: x + ev.clientX - startX, y: y + ev.clientY - startY });
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
  function handleTermKey(t: { id: number; label: string; ip: string; lines: string[]; input: string }, e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const cmd = t.input.trim();
    const out: string[] = [`root@${t.label}:~$ ${t.input}`];
    if (cmd === 'help') {
      out.push(i18n.t('term.help'));
    } else if (cmd === 'ip a') {
      out.push('1: lo: <LOOPBACK,UP,LOWER_UP>', '    inet 127.0.0.1/8 scope host lo', '2: enp0s3: <BROADCAST,MULTICAST,UP>', `    inet ${t.ip}/24 brd 192.168.1.255 scope global enp0s3`);
    } else if (cmd.startsWith('ping ')) {
      const dstIp = cmd.slice(5).trim() || '0.0.0.0';
      for (let i = 1; i <= 4; i++) out.push(`64 bytes from ${dstIp}: icmp_seq=${i} ttl=64 time=0.${10 + i * 7} ms`);
    } else if (cmd === 'clear') {
      setTerminals((ts) => ts.map((x) => (x.id === t.id ? { ...x, lines: [], input: '' } : x)));
      return;
    } else if (cmd) {
      out.push(i18n.t('term.notFound', { cmd: cmd.split(' ')[0] }));
    }
    setTerminals((ts) => ts.map((x) => (x.id === t.id ? { ...x, lines: [...x.lines, ...out], input: '' } : x)));
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

  async function animateHop(hop: { fromId: string; toId: string; proto: string }) {
    const a = nodeCenterOnScreen(hop.fromId);
    const b = nodeCenterOnScreen(hop.toId);
    if (!a || !b) return;
    const hex = viz.colorOf(hop.proto).hex;
    vizSeq.current += 1;
    const dotId = vizSeq.current;
    setVizDots((ds) => [...ds, { id: dotId, x: a.x, y: a.y, hex }]);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await waitMs(40);
      setVizDots((ds) => ds.map((d) => (d.id === dotId ? { ...d, x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps } : d)));
    }
    setVizDots((ds) => ds.filter((d) => d.id !== dotId));
  }

  async function playSequence(rows: TraceRow[], pkts: Packet[], hops: Array<{ fromId: string; toId: string; proto: string }>) {
    // 每次执行新命令：清空旧追踪行/报文与详情悬浮窗（Reopen issue）
    setTraces([]);
    setTracePkts([]);
    setDetails([]);
    setAnimBusy(true);
    setTraceOpen(true);
    for (let i = 0; i < hops.length; i++) {
      await animateHop(hops[i]);
      // B：到达闪烁
      const eid = edges.find((e) => (e.source === hops[i].fromId && e.target === hops[i].toId) || (e.source === hops[i].toId && e.target === hops[i].fromId))?.id;
      if (eid) {
        setFlashEdgeId(eid);
        await waitMs(320);
        setFlashEdgeId(null);
      }
      setTraces((ts) => [...ts, rows[i]]);
      setTracePkts((ps) => [...ps, pkts[i]]);
    }
    setAnimBusy(false);
  }

  // 执行演示命令：生成报文序列 → 报文沿线流动 → 轨迹同步增长
  function runCommand() {
    if (animBusy) return;
    const src = nodes.find((n) => n.id === srcId);
    if (!src) return;
    const dst = nodes.find((n) => n.id === dstId);
    if (cmdKind !== 'http' && !dst) return;
    const smac = macOf(nodes.findIndex((n) => n.id === srcId));
    const sip = src.data.ip === '—' || src.data.ip === t('device.unconfigured') ? '0.0.0.0' : src.data.ip;
    const dip = cmdKind === 'http'
      ? '93.184.216.34'
      : (dst!.data.ip === '—' || dst!.data.ip === t('device.unconfigured') ? sip : dst!.data.ip);
    const dmac = dst ? macOf(nodes.findIndex((n) => n.id === dstId)) : macOf(63);
    let time = 0.001;
    const rows: TraceRow[] = [];
    const pkts: Packet[] = [];
    const hops: Array<{ fromId: string; toId: string; proto: string }> = [];
    const srcNodeId = src.id;
    const dstNodeId = dst ? dst.id : src.id;
    function add(proto: string, s: string, d: string, info: string, packet: Packet, fromId: string, toId: string) {
      rows.push({ key: `c-${Date.now()}-${rows.length}`, time: time.toFixed(3), proto, src: s, dst: d, info });
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
    if (cmdKind === 'ping') {
      add('icmp', sip, dip, i18n.t('gen.echoReq'), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'icmp'), { kind: 'icmp', type: 'echo-request' }]), srcNodeId, dstNodeId);
      add('icmp', dip, sip, i18n.t('gen.echoReply'), mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'icmp'), { kind: 'icmp', type: 'echo-reply' }]), dstNodeId, srcNodeId);
    }
    if (cmdKind === 'tcp' || cmdKind === 'http') {
      add('tcp', sip, dip, i18n.t('gen.syn'), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, cmdKind === 'http' ? 80 : 8080, 1000, 0, true, false)]), srcNodeId, dstNodeId);
      add('tcp', dip, sip, i18n.t('gen.synAck'), mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'tcp'), tcpLayer(cmdKind === 'http' ? 80 : 8080, 49152, 3000, 1001, true, true)]), dstNodeId, srcNodeId);
      add('tcp', sip, dip, i18n.t('gen.ack'), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, cmdKind === 'http' ? 80 : 8080, 1001, 3001, false, true)]), srcNodeId, dstNodeId);
    }
    if (cmdKind === 'http') {
      add('http', sip, dip, i18n.t('gen.get', { url }), mkPacket([ethLayer(dmac, smac), ipLayer(sip, dip, 'tcp'), tcpLayer(49152, 80, 1001, 3001, false, true), { kind: 'http', method: 'GET', host: url, path: '/' }]), srcNodeId, dstNodeId);
      add('http', dip, sip, i18n.t('gen.ok', { url }), mkPacket([ethLayer(smac, dmac), ipLayer(dip, sip, 'tcp'), tcpLayer(80, 49152, 3001, 1002, false, true), { kind: 'http', status: 200 }]), dstNodeId, srcNodeId);
    }
    void playSequence(rows, pkts, hops);
  }

  // 原生 click 监听：节点选择 → 打开配置抽屉（按钮点击已排除）
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return; // 设备上的操作按钮（终端/租约）不触发抽屉
      const nodeEl = target.closest('.react-flow__node');
      if (!nodeEl) {
        if (target.closest('.react-flow__pane')) {
          setSelected(null);
        }
        return;
      }
      const id = nodeEl.getAttribute('data-id');
      const n = nodes.find((nd) => nd.id === id);
      if (n) setSelected(n);
    }
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [nodes]);

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
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setNodes([]); setEdges([]); setSelected(null); }}>
              {t('nav.new')}
            </Button>
          </Space>
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
              connectionMode={ConnectionMode.Loose}
              connectionRadius={80}
              onConnect={(c) => setEdges((es) => addEdge({ ...c, type: 'straight', style: edgeStyle }, es))}
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
                  position: 'absolute', left: d.x - 8, top: d.y - 8, width: 16, height: 16,
                  borderRadius: '50%', background: d.hex, border: '2px solid #fff',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.35)', zIndex: 30, pointerEvents: 'none',
                }}
              />
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
                          : it.tool === 'cmd' ? () => setCmdOpen((v) => !v)
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
                        onClick={() => openDetail(row, index)}
                        style={{ display: 'block', padding: '6px 4px', cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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

        {/* 演示命令面板（悬浮、可拖拽） */}
        {cmdOpen && (
          <Card
            size="small"
            title={
              <span
                style={{ cursor: 'move', userSelect: 'none', display: 'block', width: '100%' }}
                onMouseDown={startDragCmd}
              >
                {t('cmd.title')}
              </span>
            }
            extra={<a onClick={() => setCmdOpen(false)}>{t('common.close')}</a>}
            style={{
              position: 'fixed', left: cmdPos.x, top: cmdPos.y, width: 360, zIndex: 1002,
              boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
            }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                placeholder={t('cmd.src')}
                style={{ width: '100%' }}
                value={srcId}
                onChange={(v) => setSrcId(v)}
                options={nodes.map((n) => ({ value: n.id, label: `${n.data.label}（${t(kindKey[n.data.kind])}）` }))}
              />
              <Select
                style={{ width: '100%' }}
                value={cmdKind}
                onChange={(v) => setCmdKind(v as CmdKind)}
                options={cmdOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
              {cmdKind === 'http' ? (
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('cmd.url')} />
              ) : (
                <Select
                  placeholder={t('cmd.target')}
                  style={{ width: '100%' }}
                  value={dstId}
                  onChange={(v) => setDstId(v)}
                  options={nodes.filter((n) => n.id !== srcId).map((n) => ({ value: n.id, label: `${n.data.label}（${t(kindKey[n.data.kind])}）` }))}
                />
              )}
              <Button type="primary" icon={<CaretRightOutlined />} onClick={runCommand} disabled={animBusy} block>
                {t('cmd.run')}
              </Button>
            </Space>
          </Card>
        )}
      </div>

      {/* 设备配置抽屉（点设备弹出；保存写回设备数据） */}
      <Drawer
        title={selected ? t('drawer.title', { label: selected.data.label, kind: t(kindKey[selected.data.kind]) }) : t('drawer.titlePlain')}
        open={selected !== null}
        onClose={() => setSelected(null)}
        width={360}
      >
        {selected && (
          <Form
            key={selected.id}
            layout="vertical"
            initialValues={{
              label: selected.data.label,
              ip: selected.data.ip,
              mask: selected.data.netmask,
              gw: selected.data.gateway,
              fwd: selected.data.ipv4Forwarding,
            }}
            onFinish={(vals) => {
              setNodes((nds) =>
                nds.map((n) =>
                  n.id === selected.id
                    ? { ...n, data: { ...n.data, label: vals.label, ip: vals.ip, netmask: vals.mask, gateway: vals.gw, ipv4Forwarding: Boolean(vals.fwd) } }
                    : n
                )
              );
              setSelected(null);
            }}
          >
            <Form.Item label={t('drawer.label')} name="label"><Input /></Form.Item>
            <Form.Item label={t('drawer.ip')} name="ip"><Input /></Form.Item>
            <Form.Item label={t('drawer.mask')} name="mask"><Input /></Form.Item>
            <Form.Item label={t('drawer.gw')} name="gw"><Input /></Form.Item>
            <Form.Item label={t('drawer.forwarding')} name="fwd" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item label={t('drawer.services')}>
              <Space>
                <Tag color="blue">{t('svc.dhclient')}</Tag>
                <Tag color="green">{t('svc.resolved')}</Tag>
                <Tag>{t('svc.browser')}</Tag>
              </Space>
            </Form.Item>
            <Form.Item label={t('drawer.firewall')}>
              <Table
                size="small"
                pagination={false}
                columns={[
                  { title: t('fw.protocol'), dataIndex: 'p' },
                  { title: t('fw.action'), dataIndex: 'a' },
                ]}
                dataSource={[
                  { key: '1', p: 'all', a: 'ACCEPT' },
                  { key: '2', p: 'tcp/22', a: 'DROP' },
                ]}
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

      {/* DHCP 租约悬浮窗 */}
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
      <ReactFlowProvider>
        <Shell />
      </ReactFlowProvider>
    </ConfigProvider>
  );
}
