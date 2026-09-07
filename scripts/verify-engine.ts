/**
 * WF-16 引擎竖切验证（Bun 直跑断言，对齐 WF-6/7 验证模式；WF-12 定案前的单测契约形态）。
 * 覆盖：同网段 ping 序列 + ARP 学习、最长前缀查表、TTL 递减/丢弃、
 * 跨网段 ping（两路由器三交换机 + 远端路由消费）、traceroute 逐跳探测。
 */
import { useStore } from '../src/state/store';
import { SimulationEngine, type SimEvent } from '../src/engine/SimulationEngine';
import type {
  ArpHeader,
  Device,
  DhcpdConfig,
  DhcpHeader,
  DnsHeader,
  HttpHeader,
  IcmpHeader,
  IpHeader,
  Packet,
  TcpHeader,
} from '../src/domain/types';
import { ipToInt } from '../src/domain/ipam';
import { fsLs, fsMkdir, fsRead, fsWrite } from '../src/domain/filesystem';
import {
  parseApacheVhost,
  parseDbFile,
  parseDhcpdConf,
  parseNamedConfLocal,
  parseNetworkInterfaces,
} from '../src/parsers/config';

const ctx = {
  getTopology: () => useStore.getState().topology,
  patchDevice: (id: string, patch: Partial<Device>) => useStore.getState().updateDevice(id, patch),
};

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
  else console.log(`✓ ${msg}`);
}

// 层栈收窄（判别联合 kind 判定，类型安全取层）
function ipLayer(p: Packet): IpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'ip');
  return l?.kind === 'ip' ? l : undefined;
}
function arpLayer(p: Packet): ArpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'arp');
  return l?.kind === 'arp' ? l : undefined;
}
function icmpLayer(p: Packet): IcmpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'icmp');
  return l?.kind === 'icmp' ? l : undefined;
}
function dhcpLayer(p: Packet): DhcpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'dhcp');
  return l?.kind === 'dhcp' ? l : undefined;
}
function dnsLayer(p: Packet): DnsHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'dns');
  return l?.kind === 'dns' ? l : undefined;
}
function tcpLayer(p: Packet): TcpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'tcp');
  return l?.kind === 'tcp' ? l : undefined;
}
function httpLayer(p: Packet): HttpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'http');
  return l?.kind === 'http' ? l : undefined;
}

/** 只保留目标类型的逻辑报文（按创建顺序）。 */
function typedPackets(events: SimEvent[], pick: (p: Packet) => boolean): Packet[] {
  const seen = new Set<string>();
  const out: Packet[] = [];
  for (const e of events) {
    if (e.type !== 'hop' || seen.has(e.packet.id)) continue;
    seen.add(e.packet.id);
    if (pick(e.packet)) out.push(e.packet);
  }
  return out;
}

/** 引擎 notice 消息列表（level 过滤可选）。 */
function notices(events: SimEvent[], level?: 'info' | 'warn'): string[] {
  return events.filter((e) => e.type === 'notice' && (!level || e.level === level)).map((e) => (e.type === 'notice' ? e.message : ''));
}

interface Hop {
  from: string;
  to: string;
  delivered: boolean;
  packet: Packet;
}

function hops(events: SimEvent[]): Hop[] {
  return events.flatMap((e) => (e.type === 'hop' ? [{ from: e.from, to: e.to, delivered: Boolean(e.delivered), packet: e.packet }] : []));
}

/** 步进引擎直到收敛；每步后让微任务续延（await/pending）入队。 */
async function drain(engine: SimulationEngine, maxSteps = 600): Promise<SimEvent[]> {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const ev = engine.step();
    await new Promise((r) => setTimeout(r, 0));
    if (ev) events.push(ev);
    if (!ev && engine.isIdle()) return events;
  }
  console.error(`未收敛：queue=${engine.queue.length} pending=${engine.pending.size} 已收 ${events.length} 事件，末尾：`);
  for (const e of events.slice(-12)) {
    if (e.type === 'hop') console.error(`  hop ${e.from}->${e.to} [${e.packet.layers.map((l) => l.kind).join('/')}]${e.delivered ? ' DELIV' : ''}`);
    else console.error(`  drop@${e.at} ${e.reason}`);
  }
  fail(`引擎 ${maxSteps} 步未收敛`);
}
/** 逻辑报文序列（按 packet.id 去重，保留首见顺序）：追踪行的口径。 */
function packetSeq(events: SimEvent[], pick: (p: Packet) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 'hop' || seen.has(e.packet.id)) continue;
    seen.add(e.packet.id);
    const v = pick(e.packet);
    if (v) out.push(v);
  }
  return out;
}

function icmpTypes(events: SimEvent[]): string[] {
  return packetSeq(events, (p) => icmpLayer(p)?.type ?? '');
}

function arpRepliers(events: SimEvent[]): string[] {
  return events
    .filter((e) => e.type === 'hop')
    .map((e) => arpLayer(e.packet))
    .filter((a) => a?.op === 'reply')
    .map((a) => a!.senderIp);
}

function arpOps(events: SimEvent[]): string[] {
  return packetSeq(events, (p) => arpLayer(p)?.op ?? '');
}
function dev(id: string): Device {
  const d = useStore.getState().topology.devices[id];
  if (!d) fail(`设备不存在：${id}`);
  return d;
}

function ipOf(id: string): string {
  const f = Object.values(dev(id).interfaces).find((x) => x.ip);
  if (!f?.ip) fail(`${id} 无 IP`);
  return f.ip;
}

// ———————————————————— 场景 1：同网段两 PC（含交换机学习/洪泛） ————————————————————

async function testSameSubnet(): Promise<void> {
  console.log('\n== 场景 1：同网段 ping（PC-交换机-PC）==');
  const st = useStore.getState();
  const pc0 = st.addDevice('pc', { position: { x: 0, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const sw = st.addDevice('switch', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw);
  st.addConnection(pc1, 'enp0s3', sw);

  const engine = new SimulationEngine(ctx);
  assert(engine.isIdle(), '初始引擎空闲');
  // 单步语义：发起命令只入队首跳，step 一次推进一跳
  void engine.ping(pc0, ipOf(pc1));
  const first = engine.step();
  assert(first?.type === 'hop', 'step 推进第一跳');
  assert(!engine.isIdle(), '单步后未收敛（待续跳）');
  const events = [...(first ? [first] : []), ...(await drain(engine))];

  assert(arpOps(events).join(',') === 'request,reply', 'ARP 序列 = 请求→应答');
  assert(icmpTypes(events).join(',') === 'echo-request,echo-reply', 'ICMP 序列 = 请求→应答');
  const h = hops(events);
  assert(h[0].from === pc0 && h[0].to === sw, '首跳 = PC0→交换机');
  const floods = h.filter((x) => x.from === sw && x.packet.id === h[0].packet.id);
  assert(floods.length === 1, '广播洪泛 1 份（另一端只有 PC1）');
  assert(floods[0]?.delivered === false, '洪泛拷贝 delivered=false');
  const icmpReply = h.filter((x) => icmpLayer(x.packet)?.type === 'echo-reply');
  assert(icmpReply.some((x) => x.delivered), 'echo-reply 定向交付 delivered=true');
  assert(dev(pc0).arpTable.find((a) => a.ip === ipOf(pc1))?.mac === dev(pc1).interfaces.enp0s3.mac, 'PC0 学到 PC1 MAC');
  assert(dev(pc1).arpTable.find((a) => a.ip === ipOf(pc0))?.mac === dev(pc0).interfaces.enp0s3.mac, 'PC1 学到 PC0 MAC');
  const swMac = dev(sw).macTable;
  assert(swMac.some((m) => m.mac === dev(pc0).interfaces.enp0s3.mac), '交换机学到 PC0 MAC');
  assert(swMac.some((m) => m.mac === dev(pc1).interfaces.enp0s3.mac), '交换机学到 PC1 MAC');
  assert(engine.isIdle(), '播完引擎收敛');
  assert(new Set(h.map((x) => x.packet.id)).size === 4, '共 4 个逻辑报文（ARP req/rep + ICMP req/rep）');

  // 第二次 ping：ARP 缓存命中，无 ARP 报文
  void engine.ping(pc0, ipOf(pc1));
  const events2 = await drain(engine);
  assert(arpOps(events2).length === 0, 'ARP 缓存命中：第二次 ping 无 ARP 报文');
  assert(icmpTypes(events2).join(',') === 'echo-request,echo-reply', '第二次 ping 仍完成 ICMP 往返');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————— 场景 2：跨网段（三交换机两路由器；r0.enp0s9 不连线 → 远端路由） ————————

async function testCrossSubnet(): Promise<void> {
  console.log('\n== 场景 2：跨网段 ping（PC0 - sw0 - [r0|r1] - sw1 - r1 - sw2 - PC1）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const sw1 = st.addDevice('switch', { position: { x: 1, y: 0 } });
  const sw2 = st.addDevice('switch', { position: { x: 2, y: 0 } });
  const r0 = st.addDevice('router', { position: { x: 3, y: 0 } });
  const r1 = st.addDevice('router', { position: { x: 4, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 5, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 6, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(r0, 'enp0s3', sw0); // r0 = 192.168.1.1
  st.addConnection(r1, 'enp0s3', sw0); // r1 = 192.168.1.2
  st.addConnection(r0, 'enp0s8', sw1); // r0 = 10.0.0.1（enp0s9 留空 → 172.16 为远端网段）
  st.addConnection(r1, 'enp0s8', sw1); // r1 = 10.0.0.2
  st.addConnection(r1, 'enp0s9', sw2); // r1 = 172.16.0.2（r0 不在段内 → r0 走远端路由）
  st.addConnection(pc1, 'enp0s3', sw2);
  // WF-6 分配与接线无关：pc1 创建时落在 192.168.1.0/24 —— 手动覆盖到 172.16 网段（WF-6 手动覆盖语义）
  st.updateInterface(pc1, 'enp0s3', { ip: '172.16.0.3', netmask: '255.255.255.0', gateway: '172.16.0.2' });

  // WF-7 路由表：r0 到 172.16.0.0/24 应为远端路由（next-hop = r1，段键字典序选经 sw0）
  const r0Route = dev(r0).routingTable.find((r) => r.network === '172.16.0.0');
  assert(r0Route?.nextHop === '192.168.1.2', 'r0 172.16.0.0/24 远端路由 next-hop = r1（经 sw0，Dijkstra 平局取段键字典序）');

  const engine = new SimulationEngine(ctx);
  void engine.ping(pc0, ipOf(pc1));
  const events = await drain(engine);

  assert(arpOps(events).filter((o) => o === 'reply').length === 4, '四次 ARP 解析（r0 网关、r1 next-hop、pc1、回程 pc0）');
  const reqs = hops(events).filter((x) => icmpLayer(x.packet)?.type === 'echo-request');
  assert(reqs.some((x) => x.delivered && x.to === pc1), 'echo-request 从 PC0 定向交付到 PC1');
  assert(arpRepliers(events).includes('192.168.1.2'), 'r1 应答 192.168.1.2 的 ARP（r0 远端路由 ARP next-hop）');
  const ttls = hops(events).flatMap((x) => ipLayer(x.packet)?.ttl ?? []);
  assert(ttls.includes(63), '路由器转发时 TTL 递减（出现 63）');
  assert(dev(r0).arpTable.some((a) => a.ip === '192.168.1.2'), 'r0 学到 r1 的 ARP');
  assert(engine.isIdle(), '跨网段播完收敛');

  // 无路由丢弃：从 pc0 ping 不存在网段
  void engine.ping(pc0, '8.8.8.8');
  const events2 = await drain(engine);
  assert(events2.some((e) => e.type === 'dropped' && e.reason.includes('无路由')), '无路由 → dropped 事件（中文原因）');
  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 3：traceroute（TTL 探测 + time-exceeded） ————————————————————

async function testTraceroute(): Promise<void> {
  console.log('\n== 场景 3：traceroute（TTL 探测 + time-exceeded + 到达）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const sw1 = st.addDevice('switch', { position: { x: 1, y: 0 } });
  const r0 = st.addDevice('router', { position: { x: 2, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 3, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 4, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(r0, 'enp0s3', sw0);
  st.addConnection(r0, 'enp0s8', sw1);
  st.addConnection(pc1, 'enp0s3', sw1);
  // WF-6 分配与接线无关：pc1 创建时落在 192.168.1.0/24 —— 手动覆盖到 10.0.0 网段
  st.updateInterface(pc1, 'enp0s3', { ip: '10.0.0.3', netmask: '255.255.255.0', gateway: '10.0.0.1' });

  const engine = new SimulationEngine(ctx);
  void engine.traceroute(pc0, ipOf(pc1));
  const events = await drain(engine);

  assert(icmpTypes(events).join(',') === 'echo-request,time-exceeded,echo-request,echo-reply', '探测序列 = req,TE,req,reply');
  const te = hops(events).find((x) => icmpLayer(x.packet)?.type === 'time-exceeded');
  assert(te, '产生 time-exceeded 应答');
  const teIp = te && ipLayer(te.packet);
  assert(teIp?.srcIp === '192.168.1.1', 'TE 源 = r0 入接口 IP（与 legacy 一致）');
  assert(hops(events).some((x) => ipLayer(x.packet)?.ttl === 1), 'TTL=1 探测到达路由器');
  assert(engine.isIdle(), 'traceroute 收敛');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 4：DHCP 四步（DORA + 租约落盘 + 客户端绑定） ————————————————————

async function testDhcpDora(): Promise<void> {
  console.log('\n== 场景 4：DHCP 四步（同交换机：PC 未配置 → 绑定池内地址）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const server = st.addDevice('dhcp-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(server, 'enp0s3', sw0);
  // 客户端未配置（dhclient 绑定语义的前提）
  st.updateInterface(pc0, 'enp0s3', { ip: null, netmask: null, gateway: null });
  const pool = dev(server).dhcpPool!;
  const clientMac = dev(pc0).interfaces.enp0s3.mac;

  const engine = new SimulationEngine(ctx);
  void engine.dhcpDora(pc0, server);
  const events = await drain(engine);
  const dmsgs = packetSeq(events, (p) => dhcpLayer(p)?.messageType ?? '');
  assert(dmsgs.join(',') === 'discover,offer,request,ack', 'DHCP 序列 = Discover→Offer→Request→Ack');
  const dhs = typedPackets(events, (p) => Boolean(dhcpLayer(p)));
  assert(new Set(dhs.map((p) => dhcpLayer(p)!.xid)).size === 1, '四步共享同一 xid');
  assert(dhs.every((p) => dhcpLayer(p)!.chaddr === clientMac), '四步 chaddr = 客户端 MAC');
  const yi = dhcpLayer(dhs[dhs.length - 1]!)!.yiaddr!;
  assert(ipToInt(yi) >= ipToInt(pool.rangeStart) && ipToInt(yi) <= ipToInt(pool.rangeEnd), `yiaddr ${yi} 落在服务池内`);
  const lease = dev(server).dhcpLeases?.find((l) => l.mac === clientMac);
  assert(lease?.ip === yi, '服务端租约记录 = 客户端绑定地址');
  assert(lease!.hostname === dev(pc0).label, '租约 hostname = 客户端设备名');
  assert(lease!.expiresAt > Date.now() + pool.leaseTime * 1000 - 5000, '租约到期时间 ≈ now + leaseTime');
  assert(dev(pc0).interfaces.enp0s3.ip === yi, '客户端接口绑定 yiaddr');
  assert(dev(pc0).interfaces.enp0s3.gateway === pool.gateway, '客户端网关 = DHCP 下发网关');
  assert(notices(events, 'info').some((m) => m.includes('绑定成功')), '绑定成功 notice（中文）');
  assert(engine.isIdle(), 'DORA 播完引擎收敛');

  // 续租：客户端已有 IP → 保持静态，服务器复用原租约地址
  void engine.dhcpDora(pc0, server);
  const events2 = await drain(engine);
  const ack2 = packetSeq(events2, (p) => dhcpLayer(p)?.messageType === 'ack' ? dhcpLayer(p)!.yiaddr ?? '' : '');
  assert(ack2.includes(yi), '续租 ack 仍提供原地址（租约复用）');
  assert(notices(events2, 'info').some((m) => m.includes('静态')), '已有静态 IP → 保持原配置 notice');
  assert((dev(server).dhcpLeases ?? []).filter((l) => l.mac === clientMac).length === 1, '租约不重复');

  // 跨广播域：服务器在另一交换机 → 明确中文提示，不发报文
  const sw1 = st.addDevice('switch', { position: { x: 3, y: 0 } });
  const server2 = st.addDevice('dhcp-server', { position: { x: 4, y: 0 } });
  st.addConnection(server2, 'enp0s3', sw1);
  void engine.dhcpDora(pc0, server2);
  const events3 = await drain(engine);
  assert(notices(events3, 'warn').some((m) => m.includes('不在同一广播域')), '跨网段 DHCP → 中文提示（中继未实现）');
  assert(packetSeq(events3, (p) => dhcpLayer(p)?.messageType ?? '').length === 0, '跨网段不发 DHCP 报文');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 5：DNS（zone 命中 / NXDOMAIN + 客户端缓存） ————————————————————

async function testDnsQuery(): Promise<void> {
  console.log('\n== 场景 5：DNS 查询（named zone 命中 → 应答 + 缓存；未知域名 → NXDOMAIN）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const dnsSrv = st.addDevice('dns-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(dnsSrv, 'enp0s3', sw0);

  const engine = new SimulationEngine(ctx);
  void engine.dnsQuery(pc0, dnsSrv, 'www.example.com');
  const events = await drain(engine);
  const dnsPkts = typedPackets(events, (p) => Boolean(dnsLayer(p)));
  assert(dnsPkts.length === 2, 'DNS 逻辑报文 = 查询 + 应答');
  const q = dnsLayer(dnsPkts[0]!);
  const r = dnsLayer(dnsPkts[1]!);
  assert(q?.qr === 'query' && q.name === 'www.example.com', '查询携带域名');
  assert(r?.qr === 'reply' && r.rc === 'NOERROR' && r.answer === '93.184.216.34', 'zone 命中应答 A 记录');
  assert(dev(pc0).dnsCache.some((c) => c.name === 'www.example.com' && c.ip === '93.184.216.34'), '客户端 DNS 缓存写入（resolved）');

  void engine.dnsQuery(pc0, dnsSrv, 'no.such.host');
  const events2 = await drain(engine);
  const r2 = typedPackets(events2, (p) => dnsLayer(p)?.qr === 'reply')[0];
  assert(dnsLayer(r2!)?.rc === 'NXDOMAIN' && !dnsLayer(r2!)?.answer, '未知域名 → NXDOMAIN 应答');
  assert(!dev(pc0).dnsCache.some((c) => c.name === 'no.such.host'), 'NXDOMAIN 不写缓存');
  assert(engine.isIdle(), 'DNS 播完收敛');

  // 目标未运行 named → 明确中文提示
  void engine.dnsQuery(pc0, pc0, 'www.example.com');
  const events3 = await drain(engine);
  assert(notices(events3, 'warn').some((m) => m.includes('未运行') && m.includes('DNS 服务')), '无 named → 中文提示');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 6：HTTP（TCP 握手 + apache2 200） ————————————————————

async function testHttpBrowse(): Promise<void> {
  console.log('\n== 场景 6：浏览网页（TCP 三次握手 → GET → apache2 200）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const web = st.addDevice('pc', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(web, 'enp0s3', sw0);
  // apache2 归并（同拖放 Web 服务器语义：pc kind + apache2 服务）
  st.updateDevice(web, { services: { ...dev(web).services, apache2: { enabled: true, config: { documentRoot: '/var/www/html', vhosts: [] } } } });

  const engine = new SimulationEngine(ctx);
  void engine.httpGet(pc0, web, 'www.example.com');
  const events = await drain(engine);
  const tcpSeq = packetSeq(events, (p) => {
    const t = tcpLayer(p);
    if (!t) return '';
    return t.syn && !t.ackFlag ? 'S' : t.syn && t.ackFlag ? 'SA' : 'A';
  });
  assert(tcpSeq.join(',') === 'S,SA,A,A,A', 'TCP 段序列 = SYN,SYN-ACK,ACK,ACK(GET),ACK(200)');
  const httpSeq = packetSeq(events, (p) => {
    const h = httpLayer(p);
    if (!h) return '';
    return h.method ? 'GET' : h.status !== undefined ? String(h.status) : '';
  });
  assert(httpSeq.join(',') === 'GET,200', 'HTTP 序列 = GET 请求 → 200 响应');
  const ts = typedPackets(events, (p) => Boolean(tcpLayer(p)));
  const syn = tcpLayer(ts[0]!);
  const synack = tcpLayer(ts[1]!);
  const get = ts.find((p) => httpLayer(p)?.method === 'GET')!;
  const ok = ts.find((p) => httpLayer(p)?.status === 200)!;
  assert(synack!.ack === syn!.seq + 1, 'SYN-ACK 确认号 = SYN 序号+1');
  assert(tcpLayer(get)!.ack === synack!.seq + 1, 'GET 确认号 = SYN-ACK 序号+1');
  assert(tcpLayer(ok)!.ack === tcpLayer(get)!.seq + 1, '200 确认号 = GET 序号+1');
  assert(httpLayer(ok)!.status === 200, 'apache2 响应 200');
  assert(engine.isIdle(), 'HTTP 播完收敛');

  // 目标无 apache2 → 明确中文提示（不再硬编码公网目标）
  void engine.httpGet(pc0, pc0, 'www.example.com');
  const events2 = await drain(engine);
  assert(notices(events2, 'warn').some((m) => m.includes('未运行') && m.includes('Web 服务')), '目标未运行 apache2 → 中文提示');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 7：TCP 连接（telnet/ftp 语义）+ ARP 扫描 ————————————————————

async function testTcpAndScan(): Promise<void> {
  console.log('\n== 场景 7：TCP 三次握手（任意可达主机）+ ARP 扫描 ==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(pc1, 'enp0s3', sw0);

  // TCP：telnet 端口语义（目标为任意可达主机，协议体简化仅握手 —— WF-17 标注范围）
  const engine = new SimulationEngine(ctx);
  void engine.tcpConnect(pc0, pc1, 23);
  const events = await drain(engine);
  const tcpSeq = packetSeq(events, (p) => {
    const t = tcpLayer(p);
    if (!t) return '';
    return t.syn && !t.ackFlag ? 'S' : t.syn && t.ackFlag ? 'SA' : 'A';
  });
  assert(tcpSeq.join(',') === 'S,SA,A', 'telnet/ftp = 三次握手（S,SA,A）');
  const ts = typedPackets(events, (p) => Boolean(tcpLayer(p)));
  assert(tcpLayer(ts[0]!)!.dstPort === 23 && tcpLayer(ts[1]!)!.srcPort === 23, '握手端口 = 23（telnet）');
  assert(engine.isIdle(), 'TCP 握手收敛');

  // ARP 扫描：同广播域主机逐条请求 → 应答 + 汇总提示
  void engine.arpScan(pc0);
  const events2 = await drain(engine);
  assert(notices(events2, 'info').some((m) => m.includes('1 台主机在线')), 'ARP 扫描汇总 notice（在线 1 台）');
  assert(dev(pc0).arpTable.some((a) => a.ip === ipOf(pc1)), '扫描学习到目标 MAC');
  assert(engine.isIdle(), 'ARP 扫描收敛');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 8：无服务节点提示（DHCP 目标无服务） ————————————————————

async function testNoService(): Promise<void> {
  console.log('\n== 场景 8：目标无服务 → 明确中文提示（替代静默跳过）==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(pc1, 'enp0s3', sw0);

  const engine = new SimulationEngine(ctx);
  void engine.dhcpDora(pc0, pc1); // pc1 无 dhcpPool
  const events = await drain(engine);
  assert(notices(events, 'warn').some((m) => m.includes('未运行') && m.includes('DHCP 服务')), '目标无 DHCP 服务 → 中文提示');
  assert(packetSeq(events, (p) => dhcpLayer(p)?.messageType ?? '').length === 0, '无服务不发 DHCP 报文');

  const pc2 = st.addDevice('pc', { position: { x: 3, y: 0 } }); // 未接线（无交换机可广播）
  void engine.dhcpDora(pc2, pc1);
  const events2 = await drain(engine);
  assert(notices(events2, 'warn').some((m) => m.includes('未接入交换机')), '源未接入交换机 → 中文提示');
  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———————————————————— 场景 9：虚拟文件系统 + 配置解析器 + 配置驱动引擎 ————————————————————

async function testFsAndParsers(): Promise<void> {
  console.log('\n== 场景 9：终端 FS 原语 + WF-10 解析器 + dhcpd.conf 驱动引擎 ==');
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const server = st.addDevice('dhcp-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(server, 'enp0s3', sw0);
  st.updateInterface(pc0, 'enp0s3', { ip: null, netmask: null, gateway: null });

  // —— FS 原语（WF-11 终端底层）——
  const fs = dev(pc0).filesystem;
  const mkdir1 = fsMkdir(fs, '/var/log', []);
  const mkdir2 = fsMkdir(mkdir1, '/var/log/app', []);
  const mkdir3 = fsMkdir(mkdir2, '/root', []);
  const written = fsWrite(mkdir3, '/etc/hosts.bak', '127.0.0.1 localhost\n', []);
  st.updateDevice(pc0, { filesystem: written });
  const hosts = fsRead(dev(pc0).filesystem, '/etc/hosts.bak', []);
  assert(hosts.includes('127.0.0.1'), 'FS 写读一致（echo/cat 同源原语）');
  const lsLog = fsLs(dev(pc0).filesystem, '/var/log', []);
  assert(lsLog.includes('app/'), 'mkdir 建目录并可 ls');
  let threw = false;
  try {
    fsRead(dev(pc0).filesystem, '/no/such/file', []);
  } catch (e) {
    threw = (e as Error).message.includes('不存在');
  }
  assert(threw, 'FS 中文错误（不存在）');

  // —— 解析器（WF-10）：语法/落盘对象 ——
  const netCfg = parseNetworkInterfaces(
    '# comment\niface enp0s3 inet static address 10.0.0.5 netmask 255.255.255.0 gateway 10.0.0.1\niface enp0s3 inet dhcp',
    ['enp0s3'],
  );
  assert(netCfg.length === 2 && netCfg[0]!.mode === 'static' && netCfg[0]!.address === '10.0.0.5', 'network-interfaces 解析 static/dhcp 块');
  let netErr = '';
  try {
    parseNetworkInterfaces('iface enp0s3 inet static address 999.1.1.1 netmask 255.255.255.0', ['enp0s3']);
  } catch (e) {
    netErr = (e as Error).message;
  }
  assert(netErr.includes('第 1 行') && netErr.includes('999'), 'network-interfaces 非法 IP → 行号中文报错');

  const dhcpConf = parseDhcpdConf([
    'subnet 192.168.1.0 netmask 255.255.255.0 {',
    '  range 192.168.1.150 192.168.1.160;',
    '  option routers 192.168.1.1;',
    '  option subnet-mask 255.255.255.0;',
    '  option domain-name-servers 192.168.1.9;',
    '  default-lease-time 7200;',
    '}',
  ].join('\n'));
  assert(
    dhcpConf.rangeStart === '192.168.1.150' && dhcpConf.rangeEnd === '192.168.1.160' && dhcpConf.gateway === '192.168.1.1' && dhcpConf.dns === '192.168.1.9' && dhcpConf.leaseTime === 7200,
    'dhcpd.conf 解析 range/routers/subnet-mask/dns/lease',
  );

  const zoneEntries = parseNamedConfLocal('zone "lab.local" {\n  type master;\n  file "/etc/bind/db.lab";\n};\n');
  assert(zoneEntries.length === 1 && zoneEntries[0]!.db === '/etc/bind/db.lab', 'named.conf.local 解析 zone→db');
  const db = parseDbFile('www IN A 10.0.0.7\n@ IN A 10.0.0.1\n', 'lab.local');
  assert(db['www.lab.local'] === '10.0.0.7' && db['lab.local'] === '10.0.0.1', 'db 文件解析 A 记录（@ → apex）');

  const apacheConf = parseApacheVhost('<VirtualHost *:80>\n  ServerName www.lab.local\n  DocumentRoot /srv/www\n</VirtualHost>\n');
  assert(apacheConf.vhosts[0] === 'www.lab.local' && apacheConf.documentRoot === '/srv/www', 'apache vhost 解析 ServerName/DocumentRoot');

  // —— 解析结果落 store → 引擎按新池分配（WF-10 → 引擎闭环）——
  const poolCfg = parseDhcpdConf([
    'subnet 192.168.1.0 netmask 255.255.255.0 { range 192.168.1.150 192.168.1.160; default-lease-time 7200; }',
  ].join('\n'));
  const cur = dev(server);
  const pool: DhcpdConfig = {
    rangeStart: poolCfg.rangeStart,
    rangeEnd: poolCfg.rangeEnd,
    leaseTime: poolCfg.leaseTime ?? 3600,
    gateway: poolCfg.gateway ?? '192.168.1.1',
    dns: poolCfg.dns ?? '192.168.1.1',
    netmask: poolCfg.netmask ?? '255.255.255.0',
    listenInterfaces: cur.dhcpPool?.listenInterfaces ?? ['enp0s3'],
  };
  st.updateDevice(server, { dhcpPool: pool, services: { ...cur.services, dhcpd: { enabled: true, config: pool } } });

  const engine = new SimulationEngine(ctx);
  void engine.dhcpDora(pc0, server);
  const events = await drain(engine);
  const ackPkts = typedPackets(events, (p) => dhcpLayer(p)?.messageType === 'ack');
  assert(ackPkts.length === 1, '配置驱动 DORA 完成（ack 到达）');
  assert(dhcpLayer(ackPkts[0]!)!.yiaddr === '192.168.1.150', `yiaddr 落在解析配置的池内（150）`);
  assert(dev(server).dhcpLeases?.[0]?.expiresAt! > Date.now() + 7000 * 1000, '租约按 conf default-lease-time 7200s 落盘');
  assert(engine.isIdle(), '配置驱动 DORA 收敛');

  useStore.setState({ topology: { devices: {}, connections: [] } });
}

await testSameSubnet();
await testCrossSubnet();
await testTraceroute();
await testDhcpDora();
await testDnsQuery();
await testHttpBrowse();
await testTcpAndScan();
await testNoService();
await testFsAndParsers();
console.log('\n全部断言通过 ✓');
