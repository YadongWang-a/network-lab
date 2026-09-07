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
  DhcpdConfig,
  DhcpHeader,
  DnsHeader,
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
import { intToIp, ipToInt, isValidIp, netmaskToCidr, networkOf } from '@/domain/ipam';
import i18n from '@/i18n';

/** named zone 表类型守卫：Record<域名, IPv4>（离线演示用，逐值校验合法 IPv4）。 */
function isNamedZones(x: unknown): x is Record<string, IPv4> {
  return (
    typeof x === 'object' &&
    x !== null &&
    !Array.isArray(x) &&
    Object.values(x).every((v) => typeof v === 'string' && isValidIp(v))
  );
}

/** 单个物理跳 / 丢弃 / 提示事件（可视化与追踪栏的唯一数据源，WF-5 两级架构）。 */
export type SimEvent =
  | { type: 'hop'; packet: Packet; from: DeviceId; to: DeviceId; /** 追踪行文案（仅首跳携带）。 */ info?: string; /** 交换机按 MAC 表定向交付（洪泛拷贝为 false）。 */ delivered?: boolean }
  | { type: 'dropped'; packet?: Packet; at: DeviceId; reason: string }
  /** 命令级结果/拒绝提示（如 DHCP 绑定完成、目标未运行服务）；UI 以消息横幅呈现。 */
  | { type: 'notice'; message: string; level?: 'info' | 'warn' };

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
    const ingress = Object.values(dev.interfaces).find((f) => f.connectedSwitchId === fromSwitchId);
    if (ingress) this.kernel(dev, packet, ingress);
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
    this.kernel(dev, packet, ingress);
  }

  /**
   * 内核（移植 kernelProc）：ARP 学习/应答、ICMP echo 应答、echo-reply/time-exceeded
   * 与本机请求按 xid 关联；DHCP/L4 服务（WF-17：dhcpd/dhclient、named、apache2、
   * TCP 握手应答）经服务层分发。非本机目的或未实现的服务报文静默消耗。
   * @param ingress 报文到达接口（服务监听/应答出接口判定用）。
   */
  private kernel(dev: Device, packet: Packet, ingress?: NetworkInterface): void {
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
    const dhcp = packet.layers.find((l) => l.kind === 'dhcp');
    if (dhcp) {
      // DHCP 广播/单播：dhcpd 响应 + dhclient 侧 offer/ack 关联均在此（无 IP 语义，先于 isMine）。
      this.dhcpService(dev, packet, dhcp, ingress);
      return;
    }
    const icmp = packet.layers.find((l) => l.kind === 'icmp');
    if (icmp && icmp.kind === 'icmp') {
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
      return;
    }

    // —— L4 服务层（WF-17）：TCP/UDP 到达本机 → 应答关联 + 按监听服务分发 ——
    const isMine = Object.values(dev.interfaces).some((f) => f.ip === ip.dstIp);
    if (!isMine) return;
    const udp = packet.layers.find((l) => l.kind === 'udp');
    if (udp && udp.kind === 'udp') {
      const dns = packet.layers.find((l) => l.kind === 'dns');
      if (dns) {
        if (dns.kind !== 'dns') return;
        if (dns.qr === 'reply') {
          this.resolve(packet.xid, packet); // 客户端侧：DNS 应答到达
          return;
        }
        // 服务端侧：UDP/53 查询 → named（bind9）应答
        if (udp.dstPort === 53 && dev.services?.named?.enabled) this.dnsService(dev, packet, ip, dns, udp);
        return;
      }
      return; // 其余 UDP（非服务端口）静默
    }
    const tcp = packet.layers.find((l) => l.kind === 'tcp');
    if (tcp && tcp.kind === 'tcp') {
      if (tcp.syn && tcp.ackFlag) {
        this.resolve(packet.xid, packet); // SYN-ACK 到达发起者：完成握手阶段等待
        return;
      }
      const http = packet.layers.find((l) => l.kind === 'http');
      if (http && http.kind === 'http' && http.status !== undefined) {
        this.resolve(packet.xid, packet); // 客户端侧：HTTP 响应到达
        return;
      }
      this.l4TcpService(dev, packet, tcp, http?.kind === 'http' ? http : undefined);
    }
  }

  // ———————————————————— 服务层：DHCP / DNS / HTTP / TCP（WF-17 M3） ————————————————————

  /** 队列追加命令级提示（UI 横幅；随 step 出队送达）。 */
  private notice(message: string, level: 'info' | 'warn' = 'info'): void {
    this.queue.push({ type: 'notice', message, level });
  }

  /** DHCP 服务端/客户端处理（广播域内；dhcpd 用设备 dhcpPool 配置表示启用）。 */
  private dhcpService(dev: Device, packet: Packet, dhcp: DhcpHeader, ingress?: NetworkInterface): void {
    const udp = packet.layers.find((l) => l.kind === 'udp');
    if (!udp || udp.kind !== 'udp') return;
    const myMac =
      ingress?.mac ?? Object.values(dev.interfaces).find((f) => f.connectedSwitchId)?.mac;
    if (!myMac) return;
    // 客户端侧：offer/ack 只发给广播发起者（chaddr=本机 MAC）→ 完成发起命令对应阶段等待
    if ((dhcp.messageType === 'offer' || dhcp.messageType === 'ack') && dhcp.chaddr === myMac) {
      this.resolve(packet.xid, packet);
      return;
    }
    // 服务端侧：仅 UDP/67 的 discover/request/release 进入 dhcpd
    if (udp.dstPort !== 67 || !dev.dhcpPool) return;
    const egress = ingress && ingress.connectedSwitchId ? ingress : Object.values(dev.interfaces).find((f) => f.connectedSwitchId);
    if (!egress?.connectedSwitchId) return;
    const pool = dev.dhcpPool;
    const netmask = pool.netmask ?? ingress?.netmask ?? egress.netmask ?? '255.255.255.0';
    if (dhcp.messageType === 'discover') {
      const offerIp = this.pickDhcpOfferIp(dev, pool, dhcp.chaddr);
      if (!offerIp) {
        this.notice(i18n.t('sim.poolExhausted', { server: dev.label }), 'warn');
        return;
      }
      this.hop(
        dev.id,
        egress.connectedSwitchId,
        this.mkPacket(
          [
            { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: egress.mac, etherType: 'ipv4' },
            { kind: 'ip', srcIp: egress.ip ?? '0.0.0.0', dstIp: '255.255.255.255', ttl: 64, protocol: 'udp' },
            { kind: 'udp', srcPort: 67, dstPort: 68 },
            { kind: 'dhcp', messageType: 'offer', xid: dhcp.xid, chaddr: dhcp.chaddr, yiaddr: offerIp, netmask, gateway: pool.gateway },
          ],
          packet.xid,
        ),
        i18n.t('gen.dhcpOffer', { ip: offerIp }),
      );
      return;
    }
    if (dhcp.messageType === 'request') {
      const yi = dhcp.yiaddr;
      const leases = (dev.dhcpLeases ?? []).filter((l) => l.expiresAt > Date.now() && l.mac !== dhcp.chaddr);
      // 客户端请求的地址必须在池内且未被其他租约/拓扑占用
      if (!yi || !this.ipInPool(pool, yi) || leases.some((l) => l.ip === yi) || this.ipUsedByDevice(yi, dhcp.chaddr)) {
        this.notice(i18n.t('sim.dhcpConflict', { ip: yi ?? '?', server: dev.label }), 'warn');
        return;
      }
      leases.push({ mac: dhcp.chaddr, ip: yi, hostname: dhcp.hostname, expiresAt: Date.now() + pool.leaseTime * 1000 });
      this.ctx.patchDevice(dev.id, { dhcpLeases: leases });
      this.hop(
        dev.id,
        egress.connectedSwitchId,
        this.mkPacket(
          [
            { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: egress.mac, etherType: 'ipv4' },
            { kind: 'ip', srcIp: egress.ip ?? '0.0.0.0', dstIp: '255.255.255.255', ttl: 64, protocol: 'udp' },
            { kind: 'udp', srcPort: 67, dstPort: 68 },
            { kind: 'dhcp', messageType: 'ack', xid: dhcp.xid, chaddr: dhcp.chaddr, yiaddr: yi, netmask, gateway: pool.gateway },
          ],
          packet.xid,
        ),
        i18n.t('gen.dhcpAck', { ip: yi }),
      );
      return;
    }
    if (dhcp.messageType === 'release') {
      const leases = (dev.dhcpLeases ?? []).filter((l) => l.mac !== dhcp.chaddr);
      this.ctx.patchDevice(dev.id, { dhcpLeases: leases });
    }
  }

  /** 为客户端挑一个可租地址：同 MAC 未过期租约优先续租，否则扫池内第一个空闲地址。 */
  private pickDhcpOfferIp(server: Device, pool: DhcpdConfig, chaddr: MacAddress): IPv4 | null {
    const now = Date.now();
    const mine = (server.dhcpLeases ?? []).find((l) => l.mac === chaddr && l.expiresAt > now);
    if (mine && !this.ipUsedByDevice(mine.ip, chaddr)) return mine.ip;
    for (let n = ipToInt(pool.rangeStart); n <= ipToInt(pool.rangeEnd); n++) {
      const ip = intToIp(n);
      const leased = (server.dhcpLeases ?? []).some((l) => l.ip === ip && l.expiresAt > now && l.mac !== chaddr);
      if (!leased && !this.ipUsedByDevice(ip, chaddr)) return ip;
    }
    return null;
  }

  /** 地址是否落在 DHCP 服务范围（含端点）。 */
  private ipInPool(pool: DhcpdConfig, ip: IPv4): boolean {
    const n = ipToInt(ip);
    return n >= ipToInt(pool.rangeStart) && n <= ipToInt(pool.rangeEnd);
  }

  /** 地址是否被拓扑中其他设备接口占用（冲突检测；excludeMac 排除客户端自身）。 */
  private ipUsedByDevice(ip: IPv4, excludeMac?: MacAddress): boolean {
    for (const d of Object.values(this.ctx.getTopology().devices)) {
      for (const f of Object.values(d.interfaces)) {
        if (f.ip === ip) {
          if (excludeMac && Object.values(d.interfaces).some((x) => x.mac === excludeMac)) return false;
          return true;
        }
      }
    }
    return false;
  }

  /** DNS 服务端侧：zone 命中回 A 记录，未命中回 NXDOMAIN（离线，无递归）。 */
  private dnsService(dev: Device, packet: Packet, ip: Layer & { kind: 'ip' }, dns: DnsHeader, udp: Layer & { kind: 'udp' }): void {
    const named = dev.services?.named;
    const cfg = named?.enabled ? named.config : undefined;
    const zones = cfg && 'zones' in cfg && isNamedZones(cfg.zones) ? cfg.zones : undefined;
    const name = dns.name ?? '';
    const answer = zones ? zones[name] : undefined;
    const info = answer ? i18n.t('gen.dnsReply', { ip: answer }) : i18n.t('gen.dnsNx');
    void this.sendFrom(
      dev,
      ip.srcIp,
      [
        { kind: 'ip', srcIp: ip.dstIp, dstIp: ip.srcIp, ttl: 64, protocol: 'udp' },
        { kind: 'udp', srcPort: 53, dstPort: udp.srcPort },
        answer
          ? { kind: 'dns', qr: 'reply', xid: dns.xid, name, answer, rc: 'NOERROR' }
          : { kind: 'dns', qr: 'reply', xid: dns.xid, name, rc: 'NXDOMAIN' },
      ],
      info,
      { xid: packet.xid },
    );
  }

  /** TCP 服务端侧（WF-17）：SYN → SYN-ACK；HTTP GET → apache2 200。无连接状态，应答数字从请求推导。 */
  private l4TcpService(dev: Device, packet: Packet, tcp: Layer & { kind: 'tcp' }, http?: Layer & { kind: 'http' }): void {
    const ip = packet.layers.find((l) => l.kind === 'ip');
    if (!ip || ip.kind !== 'ip') return;
    if (tcp.syn && !tcp.ackFlag) {
      // 三次握手应答：任意可达主机均可建立 TCP 会话（telnet/ftp/自定义端口，WF-17 标注简化）
      const serverSeq = 3000 + (tcp.seq % 100);
      void this.sendFrom(
        dev,
        ip.srcIp,
        [
          { kind: 'ip', srcIp: ip.dstIp, dstIp: ip.srcIp, ttl: 64, protocol: 'tcp' },
          { kind: 'tcp', srcPort: tcp.dstPort, dstPort: tcp.srcPort, seq: serverSeq, ack: tcp.seq + 1, syn: true, ackFlag: true },
        ],
        i18n.t('gen.synAck'),
        { xid: packet.xid },
      );
      return;
    }
    if (tcp.ackFlag && http?.method && dev.services?.apache2?.enabled) {
      // HTTP 请求（GET 等）→ apache2 响应 200（documentRoot 简化：固定根路径）
      void this.sendFrom(
        dev,
        ip.srcIp,
        [
          { kind: 'ip', srcIp: ip.dstIp, dstIp: ip.srcIp, ttl: 64, protocol: 'tcp' },
          { kind: 'tcp', srcPort: tcp.dstPort, dstPort: tcp.srcPort, seq: tcp.ack, ack: tcp.seq + 1, syn: false, ackFlag: true },
          { kind: 'http', status: 200 },
        ],
        i18n.t('gen.ok', { url: http.host ?? ip.srcIp }),
        { xid: packet.xid },
      );
      return;
    }
    // 其余 TCP 段（握手最终 ACK、无 apache2 的 GET 等）静默消耗
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

  /**
   * DHCP 四步（DORA，WF-17）：广播 Discover → Offer → Request → Ack，全步共享同一 xid。
   * 客户端侧 dhclient 语义：接口未配置（无 IP）时把 offer/ack 下发的 IP/掩码/网关写回接口
   * （WF-6 冲突检测语义）；已有静态 IP 时保持原配置、仅演示协议序列。租约由服务端 dhcpd
   * 落盘到 `dev.dhcpLeases`。仅支持同一广播域（中继未实现，跨网段报中文提示）。
   */
  async dhcpDora(srcId: DeviceId, serverId: DeviceId): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const iface = Object.values(dev.interfaces).find((f) => f.connectedSwitchId && f.mac);
    if (!iface?.connectedSwitchId) {
      this.notice(i18n.t('sim.noLink', { label: dev.label }), 'warn');
      return;
    }
    const server = this.ctx.getTopology().devices[serverId];
    if (!server?.dhcpPool) {
      this.notice(i18n.t('sim.noService', { label: server?.label ?? serverId, svc: i18n.t('svc.dhcpd') }), 'warn');
      return;
    }
    const serverLink = Object.values(server.interfaces).find(
      (f) => f.connectedSwitchId === iface.connectedSwitchId && f.ip,
    );
    if (!serverLink) {
      this.notice(i18n.t('sim.dhcpAcrossSegment', { label: server.label }), 'warn');
      return;
    }
    const xid = this.xidSeq++;
    const mac = iface.mac;
    const hostname = dev.label;
    const toSwitch = iface.connectedSwitchId;
    const sendDhcpMsg = (msg: { kind: 'dhcp' } & DhcpHeader, info: string): void => {
      this.hop(
        srcId,
        toSwitch,
        this.mkPacket(
          [
            { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: mac, etherType: 'ipv4' },
            { kind: 'ip', srcIp: '0.0.0.0', dstIp: '255.255.255.255', ttl: 64, protocol: 'udp' },
            { kind: 'udp', srcPort: 68, dstPort: 67 },
            msg,
          ],
          xid,
        ),
        info,
      );
    };
    // 1) Discover（广播）
    sendDhcpMsg({ kind: 'dhcp', messageType: 'discover', xid, chaddr: mac, hostname }, i18n.t('gen.dhcpDiscover'));
    let reply = await this.awaitReply(xid);
    if (!reply || gen !== this.gen) {
      if (gen === this.gen) this.notice(i18n.t('sim.dhcpNoReply', { label: server.label }), 'warn');
      return;
    }
    const offer = reply.layers.find((l) => l.kind === 'dhcp');
    const offerIp = offer && offer.kind === 'dhcp' ? offer.yiaddr : undefined;
    if (!offerIp) return;
    // 2) Request（请求 offer 地址；带主机名供租约窗展示）
    sendDhcpMsg({ kind: 'dhcp', messageType: 'request', xid, chaddr: mac, yiaddr: offerIp, hostname }, i18n.t('gen.dhcpRequest', { ip: offerIp }));
    reply = await this.awaitReply(xid);
    if (!reply || gen !== this.gen) {
      if (gen === this.gen) this.notice(i18n.t('sim.dhcpNoReply', { label: server.label }), 'warn');
      return;
    }
    const ack = reply.layers.find((l) => l.kind === 'dhcp');
    const yiaddr = ack && ack.kind === 'dhcp' ? ack.yiaddr : undefined;
    if (!yiaddr) return;
    // 3) 绑定（dhclient 语义）：仅当接口尚无 IP 才写回配置
    const live = this.ctx.getTopology().devices[srcId];
    const liveIface = live && Object.values(live.interfaces).find((f) => f.id === iface.id);
    if (liveIface && !liveIface.ip) {
      const netmask = (ack && ack.kind === 'dhcp' && ack.netmask) || liveIface.netmask;
      const gateway = (ack && ack.kind === 'dhcp' && ack.gateway) || liveIface.gateway;
      const next: NetworkInterface = { ...liveIface, ip: yiaddr, netmask, gateway };
      this.ctx.patchDevice(srcId, { interfaces: { ...live.interfaces, [iface.id]: next } });
      this.notice(i18n.t('sim.dhcpBound', { ip: yiaddr, lease: String(server.dhcpPool.leaseTime), server: server.label }));
    } else {
      this.notice(i18n.t('sim.dhcpStatic', { ip: liveIface?.ip ?? yiaddr }));
    }
  }

  /**
   * DNS 查询（type-A，UDP/53 → named）：zone 命中回 A 记录并写入客户端 DNS 缓存
   * （resolved 语义），未命中回 NXDOMAIN。离线仿真，无递归。
   */
  async dnsQuery(srcId: DeviceId, serverId: DeviceId, name: string): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const srcIp = Object.values(dev.interfaces).find((f) => f.ip)?.ip;
    if (!srcIp) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    const server = this.ctx.getTopology().devices[serverId];
    if (!server?.services?.named?.enabled) {
      this.notice(i18n.t('sim.noService', { label: server?.label ?? serverId, svc: i18n.t('svc.named') }), 'warn');
      return;
    }
    const serverIp = Object.values(server.interfaces).find((f) => f.ip)?.ip;
    if (!serverIp) {
      this.drop(server.id, i18n.t('sim.noIp', { label: server.label }));
      return;
    }
    const xid = this.xidSeq++;
    const done = this.awaitReply(xid);
    const ok = await this.sendFrom(
      dev,
      serverIp,
      [
        { kind: 'ip', srcIp, dstIp: serverIp, ttl: 64, protocol: 'udp' },
        { kind: 'udp', srcPort: 49152, dstPort: 53 },
        { kind: 'dns', qr: 'query', xid, name },
      ],
      i18n.t('gen.dnsQuery', { name }),
      { xid },
    );
    if (!ok || gen !== this.gen) {
      this.resolve(xid, null);
      return;
    }
    const resp = await done;
    if (!resp || gen !== this.gen) return;
    const dns = resp.layers.find((l) => l.kind === 'dns');
    if (dns?.kind === 'dns' && dns.qr === 'reply' && dns.rc === 'NOERROR' && dns.answer) {
      const dnsCache = dev.dnsCache.filter((c) => c.name !== name);
      dnsCache.push({ name, ip: dns.answer, expiresAt: Date.now() + 60_000 });
      this.ctx.patchDevice(srcId, { dnsCache });
    }
  }

  /** TCP 三次握手（WF-17）：任意可达主机均应答 SYN（telnet/ftp/自定义端口共用；协议体简化仅握手）。 */
  async tcpConnect(srcId: DeviceId, dstId: DeviceId, dstPort: number): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const srcIp = Object.values(dev.interfaces).find((f) => f.ip)?.ip;
    if (!srcIp) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    const dst = this.ctx.getTopology().devices[dstId];
    const dstIp = dst ? Object.values(dst.interfaces).find((f) => f.ip)?.ip : undefined;
    if (!dstIp) {
      this.drop(dst?.id ?? dstId, i18n.t('sim.noIp', { label: dst?.label ?? dstId }));
      return;
    }
    const sport = 49152 + (this.xidSeq % 1000);
    const sseq = 1000 + (this.xidSeq % 90);
    const xid = this.xidSeq++;
    const done = this.awaitReply(xid);
    const ok = await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: sport, dstPort, seq: sseq, ack: 0, syn: true, ackFlag: false },
      ],
      i18n.t('gen.syn'),
      { xid },
    );
    if (!ok || gen !== this.gen) {
      this.resolve(xid, null);
      return;
    }
    const resp = await done;
    if (!resp || gen !== this.gen) return;
    const synack = resp.layers.find((l) => l.kind === 'tcp');
    const serverSeq = synack && synack.kind === 'tcp' ? synack.seq : sseq + 1;
    // 最终 ACK：完成三次握手（无等待，对端无需回执）
    await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: sport, dstPort, seq: sseq + 1, ack: serverSeq + 1, syn: false, ackFlag: true },
      ],
      i18n.t('gen.ack'),
    );
  }

  /**
   * 浏览网页（HTTP/1.1 GET，WF-17）：对 apache2 节点完成 TCP 握手后发 GET，等待 200。
   * apache2 服务（documentRoot 简化：固定根路径，任意 Host 均响应 200）。
   */
  async httpGet(srcId: DeviceId, dstId: DeviceId, host: string): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const srcIp = Object.values(dev.interfaces).find((f) => f.ip)?.ip;
    if (!srcIp) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    const dst = this.ctx.getTopology().devices[dstId];
    if (!dst?.services?.apache2?.enabled) {
      this.notice(i18n.t('sim.noService', { label: dst?.label ?? dstId, svc: i18n.t('svc.apache2') }), 'warn');
      return;
    }
    const dstIp = Object.values(dst.interfaces).find((f) => f.ip)?.ip;
    if (!dstIp) {
      this.drop(dst.id, i18n.t('sim.noIp', { label: dst.label }));
      return;
    }
    const sport = 49152 + (this.xidSeq % 1000);
    const sseq = 1000 + (this.xidSeq % 90);
    // 三次握手
    const hxid = this.xidSeq++;
    const done = this.awaitReply(hxid);
    let ok = await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: sport, dstPort: 80, seq: sseq, ack: 0, syn: true, ackFlag: false },
      ],
      i18n.t('gen.syn'),
      { xid: hxid },
    );
    if (!ok || gen !== this.gen) {
      this.resolve(hxid, null);
      return;
    }
    const synack = await done;
    if (!synack || gen !== this.gen) return;
    const synackTcp = synack.layers.find((l) => l.kind === 'tcp');
    const serverSeq = synackTcp && synackTcp.kind === 'tcp' ? synackTcp.seq : sseq + 1;
    await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: sport, dstPort: 80, seq: sseq + 1, ack: serverSeq + 1, syn: false, ackFlag: true },
      ],
      i18n.t('gen.ack'),
    );
    if (gen !== this.gen) return;
    // GET 请求（独立事务 xid），等待 200 应答
    const gxid = this.xidSeq++;
    const gdone = this.awaitReply(gxid);
    ok = await this.sendFrom(
      dev,
      dstIp,
      [
        { kind: 'ip', srcIp, dstIp, ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: sport, dstPort: 80, seq: sseq + 1, ack: serverSeq + 1, syn: false, ackFlag: true },
        { kind: 'http', method: 'GET', host, path: '/' },
      ],
      i18n.t('gen.get', { url: host }),
      { xid: gxid },
    );
    if (!ok || gen !== this.gen) {
      this.resolve(gxid, null);
      return;
    }
    await gdone; // 200 到达（或超时静默）
  }

  /** ARP 扫描（同广播域）：对每台邻居设备逐条请求 → 应答，统计在线主机并写 ARP 表。 */
  async arpScan(srcId: DeviceId): Promise<void> {
    const gen = this.gen;
    const dev = this.ctx.getTopology().devices[srcId];
    if (!dev) return;
    const iface = Object.values(dev.interfaces).find((f) => f.connectedSwitchId && f.ip);
    if (!iface?.connectedSwitchId || !iface.ip) {
      this.drop(srcId, i18n.t('sim.noIp', { label: dev.label }));
      return;
    }
    const mySwitch = iface.connectedSwitchId;
    const candidates = new Set<IPv4>();
    for (const d of Object.values(this.ctx.getTopology().devices)) {
      if (d.id === srcId) continue;
      for (const f of Object.values(d.interfaces)) {
        if (f.connectedSwitchId === mySwitch && f.ip && f.ip !== iface.ip) candidates.add(f.ip);
      }
    }
    const targets = [...candidates].sort((a, b) => ipToInt(a) - ipToInt(b));
    let hits = 0;
    for (const target of targets) {
      if (gen !== this.gen) return;
      const xid = this.xidSeq++;
      const done = this.awaitReply(xid);
      this.hop(
        srcId,
        mySwitch,
        this.mkPacket(
          [
            { kind: 'ethernet', dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: iface.mac, etherType: 'arp' },
            { kind: 'arp', op: 'request', senderIp: iface.ip, senderMac: iface.mac, targetIp: target, targetMac: '00:00:00:00:00:00' },
          ],
          xid,
        ),
        i18n.t('gen.arpWho', { dst: target, src: iface.ip }),
      );
      const reply = await done;
      if (gen !== this.gen) return;
      if (reply) hits += 1; // 无应答主机：跳过（不刷 dropped，静默离线）
    }
    this.notice(i18n.t('sim.scanDone', { n: String(hits) }));
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
