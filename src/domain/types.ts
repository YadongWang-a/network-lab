// 领域模型（WF-2 决定）：状态从 DOM 抽离为归一化 store；报文用判别联合 + 有序层栈。
// WF-3 决定 engine 以事件队列驱动，本文件只定义数据形状，不依赖 React。

export type DeviceId = string;
export type InterfaceId = string;
export type MacAddress = string;
export type IPv4 = string;
export type Cidr = string;

export type DeviceKind =
  | 'pc'
  | 'router'
  | 'switch'
  | 'dns-server'
  | 'dhcp-server'
  | 'dhcp-relay-agent';

export interface Vec2 {
  x: number;
  y: number;
}

// —— 接口（取代原 ip-/mac-/netmask-/data-switch-<iface> DOM 属性）——
export interface NetworkInterface {
  id: InterfaceId;
  name: string;
  mac: MacAddress;
  ip: IPv4 | null;
  netmask: IPv4 | null;
  gateway: IPv4 | null;
  connectedSwitchId: DeviceId | null;
}

export interface RoutingTableEntry {
  network: IPv4;
  netmask: IPv4;
  interfaceId: InterfaceId;
  nextHop: IPv4; // "0.0.0.0" = 直连
}

export interface ArpEntry {
  ip: IPv4;
  mac: MacAddress;
  expiresAt: number;
}
export interface MacTableEntry {
  port: InterfaceId;
  mac: MacAddress;
  expiresAt: number;
}
export interface DnsCacheEntry {
  name: string;
  ip: IPv4;
  expiresAt: number;
}

// —— 防火墙（取代原 iptablesRule 散属性；含 NAT/connTrack）——
export type FirewallAction =
  | 'ACCEPT'
  | 'DROP'
  | 'REJECT'
  | 'MASQUERADE'
  | 'DNAT'
  | 'SNAT';
export type FirewallChain =
  | 'INPUT'
  | 'OUTPUT'
  | 'FORWARD'
  | 'PREROUTING'
  | 'POSTROUTING';

export interface FirewallRule {
  table: 'filter' | 'nat' | 'mangle';
  chain: FirewallChain;
  protocol?: 'tcp' | 'udp' | 'icmp' | 'all';
  src?: IPv4;
  dst?: IPv4;
  inInterface?: InterfaceId;
  outInterface?: InterfaceId;
  sport?: number;
  dport?: number;
  action: FirewallAction;
  nat?: { toIp?: IPv4; toPort?: number };
}

export interface FirewallState {
  defaultPolicy: Record<'INPUT' | 'OUTPUT' | 'FORWARD', 'ACCEPT' | 'DROP'>;
  rules: FirewallRule[];
}

// —— 服务（取代 dhcpd="true" 等布尔 + data-range-* 散属性）——
export type ServiceName =
  | 'dhcpd'
  | 'dhclient'
  | 'dhcrelay'
  | 'named'
  | 'apache2'
  | 'iptables';

export interface DhcpdConfig {
  rangeStart: IPv4;
  rangeEnd: IPv4;
  leaseTime: number;
  gateway: IPv4;
  dns: IPv4;
  listenInterfaces: InterfaceId[];
}
export interface NamedConfig {
  zones: Record<string, IPv4>;
}
export interface ApacheConfig {
  documentRoot: string;
  vhosts: string[];
}
export type ServiceConfig =
  | DhcpdConfig
  | NamedConfig
  | ApacheConfig
  | Record<string, unknown>;

export interface ServiceState {
  enabled: boolean;
  config: ServiceConfig;
}

export interface FilesystemNode {
  [name: string]: FilesystemNode | string;
}

// —— 设备 + 拓扑（归一化，O(1) 查找，Zustand selector 友好）——
export interface Device {
  id: DeviceId;
  kind: DeviceKind;
  label: string;
  position: Vec2;
  interfaces: Record<InterfaceId, NetworkInterface>;
  arpTable: ArpEntry[];
  dnsCache: DnsCacheEntry[];
  routingTable: RoutingTableEntry[];
  macTable: MacTableEntry[];
  firewall: FirewallState;
  services: Partial<Record<ServiceName, ServiceState>>;
  ipv4Forwarding: boolean;
  resolvedEnabled: boolean;
  filesystem: FilesystemNode;
  dhcpPool?: DhcpdConfig;
}

export interface Connection {
  id: string;
  fromDeviceId: DeviceId;
  fromInterfaceId: InterfaceId;
  toSwitchId: DeviceId;
  toPort: number;
}

export interface Topology {
  devices: Record<DeviceId, Device>;
  connections: Connection[];
}

// —— 报文：判别联合 + 有序层栈（取代 packets_lib 类继承与扁平字段）——
export type Layer =
  | EthernetHeader
  | ArpHeader
  | IpHeader
  | IcmpHeader
  | TcpHeader
  | UdpHeader
  | DhcpHeader
  | DnsHeader
  | HttpHeader;

export interface EthernetHeader {
  kind: 'ethernet';
  dstMac: MacAddress;
  srcMac: MacAddress;
  etherType: 'ipv4' | 'arp';
}
export interface ArpHeader {
  kind: 'arp';
  op: 'request' | 'reply';
  senderIp: IPv4;
  senderMac: MacAddress;
  targetIp: IPv4;
  targetMac: MacAddress;
}
export interface IpHeader {
  kind: 'ip';
  srcIp: IPv4;
  dstIp: IPv4;
  ttl: number;
  protocol: 'icmp' | 'tcp' | 'udp';
}
export interface IcmpHeader {
  kind: 'icmp';
  type: 'echo-request' | 'echo-reply' | 'time-exceeded';
}
export interface TcpHeader {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  syn: boolean;
  ackFlag: boolean;
}
export interface UdpHeader {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
}
export interface DhcpHeader {
  kind: 'dhcp';
  messageType: 'discover' | 'offer' | 'request' | 'ack' | 'release';
  xid: number;
  chaddr: MacAddress;
  yiaddr?: IPv4;
}
export interface DnsHeader {
  kind: 'dns';
  qr: 'query' | 'reply';
  xid: number;
  name?: string;
}
export interface HttpHeader {
  kind: 'http';
  method?: string;
  host?: string;
  path?: string;
  status?: number;
}

export interface Packet {
  id: string;
  layers: Layer[]; // 外→内：[ethernet, ip, tcp, http]
  xid?: number; // 事务关联（请求/应答配对）
  replyTo?: string; // 指向对应请求 Packet.id（引擎运行时填充）
  createdAt: number;
}

// 派生访问器（不存）：l2 / l3 / l4 / app
export const l2 = (p: Packet): EthernetHeader | ArpHeader | undefined =>
  p.layers.find((l) => l.kind === 'ethernet' || l.kind === 'arp') as
    | EthernetHeader
    | ArpHeader
    | undefined;
export const l3 = (p: Packet): IpHeader | undefined =>
  p.layers.find((l) => l.kind === 'ip') as IpHeader | undefined;
export const l4 = (p: Packet): TcpHeader | UdpHeader | IcmpHeader | undefined =>
  p.layers.find((l) => l.kind === 'tcp' || l.kind === 'udp' || l.kind === 'icmp') as
    | TcpHeader
    | UdpHeader
    | IcmpHeader
    | undefined;
export const appLayer = (
  p: Packet,
): DhcpHeader | DnsHeader | HttpHeader | undefined =>
  p.layers.find((l) => l.kind === 'dhcp' || l.kind === 'dns' || l.kind === 'http') as
    | DhcpHeader
    | DnsHeader
    | HttpHeader
    | undefined;
// 计时器句柄（setTimeout 返回值）。命名导出，供引擎 pending 表等复用（WF-3 决策 ③）。
export type TimerHandle = ReturnType<typeof setTimeout>;
