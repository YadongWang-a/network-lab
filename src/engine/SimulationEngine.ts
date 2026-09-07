// 仿真引擎（WF-3 决策 B：全事件队列调度器）+ WF-16 M2 L2/L3 竖切。
// 处理器移植自 src/legacy/processors/{switchProc,hostProc,routerProc,kernelProc,routingProc}.js，
// 改造为「读 ctx.getTopology() 快照 / 经 ctx.patchDevice 写回状态 / 入队物理跳」的纯逻辑。
// 引擎 ephemeral 态（事件队列、xid pending 表、复位代数）不进 store（WF-3 决策 ③）；
// ARP/MAC 表项只写 expiresAt，老化在读取时判断，不需要真实计时器。
//
// 事件模型：队列每个元素 = 一条**物理跳**（两台直连设备间的单次移动），
// 交换机洪泛展开为多条跳事件。`hop.info` 只在报文首跳携带，供追踪行文案。
import type {
  Device,
  DeviceId,
  IcmpHeader,
  IPv4,
  Layer,
  MacAddress,
  NetworkInterface,
  Packet,
  RoutingTableEntry,
  Topology,
  TimerHandle,
} from '@/domain/types';
import { netmaskToCidr, networkOf } from '@/domain/ipam';
import i18n from '@/i18n';

/** 单个物理跳 / 丢弃事件（可视化与追踪栏的唯一数据源，WF-5 两级架构）。 */
export type SimEvent =
  | { type: 'hop'; packet: Packet; from: DeviceId; to: DeviceId; /** 追踪行文案（仅首跳携带）。 */ info?: string; /** 交换机按 MAC 表定向交付（洪泛拷贝为 false）。 */ delivered?: boolean }
  | { type: 'dropped'; packet?: Packet; at: DeviceId; reason: string };

/** 引擎对宿主的唯一依赖：拓扑读取 + 设备状态写回。便于脱离 React/store 单测。 */
export interface EngineCtx {
  getTopology(): Topology;
  patchDevice(id: DeviceId, patch: Partial<Device>): void;
}

const ARP_TTL_MS = 300_000;
const MAC_TTL_MS = 300_000;
/** ARP / 回复等待超时（真实墙钟；暂停期间由 reset 兜底唤醒）。 */
const REPLY_TIMEOUT_MS = 20_000;
const MAX_TRACEROUTE_PROBES = 8;
const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

type Listener = (e: SimEvent) => void;
type Waiter = { resolve: (p: Packet | null) => void; timer: TimerHandle };

export class SimulationEngine {
  private queue: SimEvent[] = [];
  private listeners = new Set<Listener>();
  /** 异步关联表（WF-3 决策 ②）：xid → 等待者。引擎独占，不进 store。 */
  private pending = new Map<number, Waiter>();
  private xidSeq = 1;
  private pktSeq = 0;
  /** 复位代数：reset 后旧的异步续延不得再入队/写状态。 */
  private gen = 0;

  constructor(private ctx: EngineCtx) {}

  /** 订阅仿真事件（可视化/终端/日志）。 */
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * 出队一跳并就地处理（处理过程同步 + 微任务续延，会把后续跳追加到队尾）。
   * 暂停/单步由控制器控制调用节奏（WF-3）。
   */
  step(): SimEvent | undefined {
    const e = this.queue.shift();
    if (!e) return undefined;
    this.listeners.forEach((l) => l(e));
    this.process(e);
    return e;
  }

  /** 队列空且无等待中的请求-应答 → 仿真收敛（控制器据此判定「播完」）。 */
  isIdle(): boolean {
    return this.queue.length === 0 && this.pending.size === 0;
  }

  /** 清空队列、放等待者（resolve null）、递增代数使旧续延失效。 */
  reset(): void {
    this.gen += 1;
    this.queue = [];
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.pending.clear();
  }

  // ———————————————————— 调度 ————————————————————

  private process(e: SimEvent): void {
    if (e.type !== 'hop') return;
    const dev = this.ctx.getTopology().devices[e.to];
    if (!dev) return;
    if (dev.kind === 'switch') this.switchProc(dev, e.from, e.packet);
    else if (dev.ipv4Forwarding) this.routerProc(dev, e.from, e.packet);
    else this.hostProc(dev, e.from, e.packet);
  }

  /** 追加一条物理跳（多处理器共用同一封装，保证事件形状一致）。 */
  private hop(from: DeviceId, to: DeviceId, packet: Packet, info?: string, delivered = false): void {
    this.queue.push({ type: 'hop', packet, from, to, info, delivered });
  }

  private drop(at: DeviceId, reason: string, packet?: Packet): void {
    this.queue.push({ type: 'dropped', packet, at, reason });
    // 报文被丢弃即宣告其事务失败：唤醒等待该报文应答的发起者（如 ping 完成等待），避免挂到超时
    if (packet?.xid !== undefined) this.resolve(packet.xid, null);
  }

  // ———————————————————— L2：交换机 ————————————————————

  /**
   * 交换机（移植 switchProc）：源 MAC 学习 + 未知单播/广播洪泛 + 按 MAC 表定向转发。
   * macTable 表项 port = 对端设备 id（Connection.fromDeviceId，即该端口的直连对端）。
   */
  private switchProc(sw: Device, ingressDevId: DeviceId, packet: Packet): void {
    const eth = packet.layers.find((l) => l.kind === 'ethernet');
    if (!eth || eth.kind !== 'ethernet') return;
    const links = this.ctx.getTopology().connections.filter((c) => c.toSwitchId === sw.id);
    // MAC 学习：源 MAC ↔ 入端口（老化走 expiresAt）
    if (eth.srcMac && eth.srcMac !== BROADCAST_MAC) {
      const macTable = sw.macTable.filter((m) => m.mac !== eth.srcMac);
      macTable.push({ port: ingressDevId, mac: eth.srcMac, expiresAt: Date.now() + MAC_TTL_MS });
      this.ctx.patchDevice(sw.id, { macTable });
    }
    const now = Date.now();
    let targets: DeviceId[];
    if (eth.dstMac === BROADCAST_MAC) {
      targets = links.filter((c) => c.fromDeviceId !== ingressDevId).map((c) => c.fromDeviceId);
    } else {
      const entry = sw.macTable.find((m) => m.mac === eth.dstMac && m.expiresAt > now);
      if (entry && links.some((c) => c.fromDeviceId === entry.port)) {
        // 定向转发；目标 = 入口（无其他去路）则丢弃
        targets = entry.port === ingressDevId ? [] : [entry.port];
      } else {
        // 未知单播洪泛
        targets = links.filter((c) => c.fromDeviceId !== ingressDevId).map((c) => c.fromDeviceId);
      }
    }
    const unicast = eth.dstMac !== BROADCAST_MAC && targets.length === 1 && sw.macTable.some((m) => m.mac === eth.dstMac && m.expiresAt > now);
    for (const to of targets) this.hop(sw.id, to, structuredClone(packet), undefined, unicast);
  }

  // ———————————————————— L3+：主机 / 路由器 ————————————————————

  /** 主机（移植 hostProc）：定位入口接口后交内核。 */
  private hostProc(dev: Device, fromSwitchId: DeviceId, packet: Packet): void {
    if (Object.values(dev.interfaces).some((f) => f.connectedSwitchId === fromSwitchId)) this.kernel(dev, packet);
  }

  /**
   * 路由器（移植 routerProc + routingProc 转发路径）：
   * ARP 帧 / 本机目的 / 广播 → 内核；其余 TTL 递减 → 查表最长前缀 → ARP next-hop → 重写 L2 转发。
   * TTL 归零发 ICMP time-exceeded（traceroute 依赖），原报文静默丢弃（legacy 同义）。
   */
  private routerProc(dev: Device, fromSwitchId: DeviceId, packet: Packet): void {
    const gen = this.gen;
    const ingress = Object.values(dev.interfaces).find((f) => f.connectedSwitchId === fromSwitchId);
    if (!ingress) return;
    const ip = packet.layers.find((l) => l.kind === 'ip');
    if (ip && ip.kind === 'ip') {
      const isMine = Object.values(dev.interfaces).some((f) => f.ip === ip.dstIp);
      if (!isMine && ip.dstIp !== '255.255.255.255') {
        if (ip.ttl <= 1) {
          void this.sendFrom(
            dev,
            ip.srcIp,
            [
              { kind: 'ip', srcIp: ingress.ip ?? '0.0.0.0', dstIp: ip.srcIp, ttl: 64, protocol: 'icmp' },
              { kind: 'icmp', type: 'time-exceeded' },
            ],
            i18n.t('gen.timeExceeded'),
            { xid: packet.xid },
          );
          return;
        }
        const route = this.lookupRoute(dev, ip.dstIp);
        if (!route) {
          this.drop(dev.id, i18n.t('sim.noRoute', { dst: ip.dstIp }), packet);
          return;
        }
        const egress = Object.values(dev.interfaces).find((f) => f.id === route.interfaceId);
        if (!egress?.connectedSwitchId) {
          this.drop(dev.id, i18n.t('sim.noRoute', { dst: ip.dstIp }), packet);
          return;
        }
        void (async () => {
          const nextHopIp = route.nextHop === '0.0.0.0' ? ip.dstIp : route.nextHop;
          const mac = await this.arpLookup(dev, egress, nextHopIp);
          if (gen !== this.gen || !mac) return; // 超时：arpLookup 已报 dropped
          const out = structuredClone(packet);
          const outIp = out.layers.find((l) => l.kind === 'ip');
          if (outIp && outIp.kind === 'ip') outIp.ttl -= 1;
          const eth = out.layers.find((l) => l.kind === 'ethernet');
          if (eth && eth.kind === 'ethernet') {
            eth.dstMac = mac;
            eth.srcMac = egress.mac;
          }
          this.hop(dev.id, egress.connectedSwitchId!, out);
        })();
        return;
      }
    }
    this.kernel(dev, packet);
  }

  /**
   * 内核（移植 kernelProc）：ARP 学习/应答、ICMP echo 应答、echo-reply/time-exceeded
   * 与本机请求按 xid 关联。非本机目的或未实现的 L4 报文静默消耗（服务层 WF-17 接管）。
   */
  private kernel(dev: Device, packet: Packet): void {
    const arp = packet.layers.find((l) => l.kind === 'arp');
    if (arp && arp.kind === 'arp') {
      const myIface = Object.values(dev.interfaces).find((f) => f.ip === arp.targetIp);
      if (!myIface) return; // 不属于本机：不学习不响应（同 legacy）
      this.learnArp(dev, arp.senderIp, arp.senderMac);
      if (arp.op !== 'request') {
        this.resolve(packet.xid, packet);
        return;
      }
      void (async () => {
        const gen = this.gen;
        const myIp = myIface.ip;
        const mac = await this.arpLookup(dev, myIface, arp.senderIp);
        if (gen !== this.gen || !mac || !myIp || !myIface.connectedSwitchId) return;
        this.hop(
          dev.id,
          myIface.connectedSwitchId,
          this.mkPacket(
            [
              { kind: 'ethernet', dstMac: mac, srcMac: myIface.mac, etherType: 'arp' },
              { kind: 'arp', op: 'reply', senderIp: myIface.ip!, senderMac: myIface.mac, targetIp: arp.senderIp, targetMac: arp.senderMac },
            ],
            packet.xid,
          ),
          i18n.t('gen.arpAt', { ip: myIp, mac: myIface.mac }),
        );
      })();
      return;
    }

    const ip = packet.layers.find((l) => l.kind === 'ip');
    if (!ip || ip.kind !== 'ip') return;
    const icmp = packet.layers.find((l) => l.kind === 'icmp');
    if (!icmp || icmp.kind !== 'icmp') return; // 其他 L4/服务：WF-17
    const isMine = Object.values(dev.interfaces).some((f) => f.ip === ip.dstIp);
    if (!isMine) return;
    if (icmp.type === 'echo-request') {
      void this.sendFrom(
        dev,
        ip.srcIp,
        [
          { kind: 'ip', srcIp: ip.dstIp, dstIp: ip.srcIp, ttl: 64, protocol: 'icmp' },
          { kind: 'icmp', type: 'echo-reply' },
        ],
        i18n.t('gen.echoReply'),
        { xid: packet.xid },
      );
    } else {
      // echo-reply / time-exceeded 到达本机：完成对应请求的等待
      this.resolve(packet.xid, packet);
    }
  }

  // ———————————————————— 本机发起的发送 ————————————————————

  /**
   * 本机发起的 IP 发送（移植 routingProc isNotForward 路径）：
   * 有路由表（路由器）→ 查表选路；否则（终端）直连网段直发、越网段走默认网关。
   * L2 由本函数统一封装（egress MAC + ARP 解析的 next-hop MAC）。
   */
  private async sendFrom(
    dev: Device,
    dstIp: IPv4,
    inner: Layer[],
    info?: string,
    opts?: { xid?: number; ttl?: number },
  ): Promise<boolean> {
    const gen = this.gen;
    let egress: NetworkInterface | undefined;
    let nextHop: IPv4;
    if (dev.routingTable.length > 0) {
      const route = this.lookupRoute(dev, dstIp);
      egress = route ? Object.values(dev.interfaces).find((f) => f.id === route.interfaceId) : undefined;
      if (!route || !egress?.connectedSwitchId) {
        this.drop(dev.id, i18n.t('sim.noRoute', { dst: dstIp }));
        return false;
      }
      nextHop = route.nextHop === '0.0.0.0' ? dstIp : route.nextHop;
    } else {
      egress = Object.values(dev.interfaces).find(
        (f) => f.connectedSwitchId && f.ip && f.netmask && networkOf(dstIp, f.netmask) === networkOf(f.ip, f.netmask),
      );
      nextHop = dstIp;
      if (!egress) {
        const gwIface = Object.values(dev.interfaces).find((f) => f.connectedSwitchId && f.ip && f.gateway);
        if (!gwIface) {
          this.drop(dev.id, i18n.t('sim.noGateway', { label: dev.label }));
          return false;
        }
        egress = gwIface;
        nextHop = gwIface.gateway!;
      }
    }
    if (opts?.ttl !== undefined) {
      const ip = inner.find((l) => l.kind === 'ip');
      if (ip && ip.kind === 'ip') ip.ttl = opts.ttl;
    }
    const toSwitch = egress.connectedSwitchId;
    const mac = await this.arpLookup(dev, egress, nextHop);
    if (gen !== this.gen || !mac || !toSwitch) return false;
    const packet = this.mkPacket(
      [{ kind: 'ethernet', dstMac: mac, srcMac: egress.mac, etherType: 'ipv4' }, ...inner],
      opts?.xid,
    );
    this.hop(dev.id, toSwitch, packet, info);
    return true;
  }

  /**
   * ARP 解析：表命中（未过期）直接返回；否则广播请求并挂起等待应答（xid pending 表）。
   * 超时丢弃的报错从这里发出。
   */
  private async arpLookup(dev: Device, iface: NetworkInterface, ip: IPv4): Promise<MacAddress | null> {
    const gen = this.gen;
    if (!iface.connectedSwitchId) return null;
    const now = Date.now();
    // 每次都读最新拓扑：同一拍内刚学习到的表项（如 ARP 应答处理中的续延）必须命中
    const live = this.ctx.getTopology().devices[dev.id];
    const hit = live?.arpTable.find((a) => a.ip === ip && a.expiresAt > now);
    if (hit) return hit.mac;
    const xid = this.xidSeq++;
    const req = this.mkPacket(
      [
        { kind: 'ethernet', dstMac: BROADCAST_MAC, srcMac: iface.mac, etherType: 'arp' },
        { kind: 'arp', op: 'request', senderIp: iface.ip ?? '0.0.0.0', senderMac: iface.mac, targetIp: ip, targetMac: '00:00:00:00:00:00' },
      ],
      xid,
    );
    this.hop(
      dev.id,
      iface.connectedSwitchId,
      req,
      i18n.t('gen.arpWho', { dst: ip, src: iface.ip ?? '0.0.0.0' }),
    );
    const reply = await this.awaitReply(xid);
    if (gen !== this.gen || !reply) {
      this.drop(dev.id, i18n.t('sim.arpTimeout', { ip }));
      return null;
    }
    const arpL = reply.layers.find((l) => l.kind === 'arp');
    return arpL && arpL.kind === 'arp' ? arpL.senderMac : null;
  }

  /** 查路由表：最长前缀匹配（WF-7 自动生成的表；直连 nextHop=0.0.0.0）。 */
  private lookupRoute(dev: Device, dstIp: IPv4): RoutingTableEntry | null {
    let best: RoutingTableEntry | null = null;
    let bestLen = -1;
    for (const r of dev.routingTable) {
      if (networkOf(dstIp, r.netmask) === r.network) {
        const len = netmaskToCidr(r.netmask);
        if (len > bestLen) {
          best = r;
          bestLen = len;
        }
      }
    }
    return best;
  }

  // ———————————————————— 演示命令 API ————————————————————

  /**
   * ping：ICMP echo 往返（WF-16 真引擎驱动）。ARP 不命中时先完成 ARP 交换。
   * 先挂完成等待再发送：避免回程应答先于等待注册被 resolve 丢掉。
   */
  async ping(srcId: DeviceId, dstIp: IPv4): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const srcIp = Object.values(dev.interfaces).find((f) => f.ip)?.ip;
    if (!srcIp) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    const xid = this.xidSeq++;
    const done = this.awaitReply(xid);
    const ok = await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'icmp' },
        { kind: 'icmp', type: 'echo-request' },
      ],
      i18n.t('gen.echoReq'),
      { xid },
    );
    if (!ok || gen !== this.gen) {
      this.resolve(xid, null);
      return;
    }
    await done;
  }

  /** traceroute：TTL=1..N 逐跳探测；time-exceeded → 下一跳，echo-reply → 到达即止。 */
  async traceroute(srcId: DeviceId, dstIp: IPv4): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const srcIp = Object.values(dev.interfaces).find((f) => f.ip)?.ip;
    if (!srcIp) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    for (let ttl = 1; ttl <= MAX_TRACEROUTE_PROBES; ttl++) {
      if (gen !== this.gen) return;
      const xid = this.xidSeq++;
      const done = this.awaitReply(xid);
      const ok = await this.sendFrom(
        dev,
        dstIp,
        [
          { kind: 'ip', srcIp, dstIp, ttl, protocol: 'icmp' },
          { kind: 'icmp', type: 'echo-request' },
        ],
        i18n.t('gen.probe', { ttl: String(ttl) }),
        { xid },
      );
      if (!ok || gen !== this.gen) {
        this.resolve(xid, null);
        return;
      }
      const resp = await done;
      if (!resp || gen !== this.gen) return;
      const icmp = resp.layers.find((l) => l.kind === 'icmp') as IcmpHeader | undefined;
      if (icmp?.type === 'echo-reply') return; // 到达目标
      // time-exceeded → 继续下一跳探测
    }
  }

  // ———————————————————— 基础设施 ————————————————————

  /** 挂起等待 xid 应答；超时 resolve null（ARP 失败/收敛兜底）。 */
  private awaitReply(xid: number, timeoutMs = REPLY_TIMEOUT_MS): Promise<Packet | null> {
    const { promise, resolve } = Promise.withResolvers<Packet | null>();
    const timer: TimerHandle = setTimeout(() => {
      this.pending.delete(xid);
      resolve(null);
    }, timeoutMs);
    this.pending.set(xid, { resolve, timer });
    return promise;
  }

  /** 应答到达时按 xid 唤醒等待者（kernel 处理 echo-reply / time-exceeded / arp-reply 时调用）。 */
  private resolve(xid: number | undefined, packet: Packet | null): void {
    if (xid === undefined) return;
    const waiter = this.pending.get(xid);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(xid);
    waiter.resolve(packet);
  }

  private learnArp(dev: Device, ip: IPv4, mac: MacAddress): void {
    if (!ip || ip === '0.0.0.0' || !mac || mac === '00:00:00:00:00:00') return;
    const arpTable = dev.arpTable.filter((a) => a.ip !== ip);
    arpTable.push({ ip, mac, expiresAt: Date.now() + ARP_TTL_MS });
    this.ctx.patchDevice(dev.id, { arpTable });
  }

  private mkPacket(layers: Layer[], xid?: number): Packet {
    this.pktSeq += 1;
    return { id: `pkt-${this.pktSeq.toString(16).padStart(4, '0')}`, layers, xid, createdAt: Date.now() };
  }
}

/** 报文 → 追踪/动画协议标识（色码注册表键，WF-5）。 */
export function protoOf(packet: Packet): string {
  const arp = packet.layers.find((l) => l.kind === 'arp');
  if (arp) return 'arp';
  const ip = packet.layers.find((l) => l.kind === 'ip');
  return ip && ip.kind === 'ip' ? ip.protocol : 'unicast';
}
