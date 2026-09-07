/**
 * WF-16 引擎竖切验证（Bun 直跑断言，对齐 WF-6/7 验证模式；WF-12 定案前的单测契约形态）。
 * 覆盖：同网段 ping 序列 + ARP 学习、最长前缀查表、TTL 递减/丢弃、
 * 跨网段 ping（两路由器三交换机 + 远端路由消费）、traceroute 逐跳探测。
 */
import { useStore } from '../src/state/store';
import { SimulationEngine, type SimEvent } from '../src/engine/SimulationEngine';
import type { ArpHeader, Device, IcmpHeader, IpHeader, Packet } from '../src/domain/types';

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

await testSameSubnet();
await testCrossSubnet();
await testTraceroute();
console.log('\n全部断言通过 ✓');
