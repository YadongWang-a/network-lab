/**
 * WF-12 引擎单测共享助手：从 scripts/verify-engine.ts（Bun 直跑）迁入 vitest。
 * 断言口径 = 可观测契约：SimEvent 流（hop/dropped/notice）+ store 最终状态。
 */
import type {
  ArpHeader,
  Device,
  DeviceId,
  DhcpHeader,
  DnsHeader,
  HttpHeader,
  IcmpHeader,
  IpHeader,
  Packet,
  TcpHeader,
} from '@/domain/types';
import { useStore } from '@/state/store';
import { SimulationEngine, type SimEvent } from '@/engine/SimulationEngine';

export const ctx = {
  getTopology: () => useStore.getState().topology,
  patchDevice: (id: string, patch: Partial<Device>) => useStore.getState().updateDevice(id, patch),
};

/** 清空拓扑（每用例独立）。 */
export function resetTopology(): void {
  useStore.setState({ topology: { devices: {}, connections: [] } });
}

// ———— 层栈收窄（判别联合 kind 判定，类型安全取层；类型守卫保收窄） ————

export function ipLayer(p: Packet): IpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'ip');
  return l?.kind === 'ip' ? l : undefined;
}
export function arpLayer(p: Packet): ArpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'arp');
  return l?.kind === 'arp' ? l : undefined;
}
export function icmpLayer(p: Packet): IcmpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'icmp');
  return l?.kind === 'icmp' ? l : undefined;
}
export function dhcpLayer(p: Packet): DhcpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'dhcp');
  return l?.kind === 'dhcp' ? l : undefined;
}
export function dnsLayer(p: Packet): DnsHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'dns');
  return l?.kind === 'dns' ? l : undefined;
}
export function tcpLayer(p: Packet): TcpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'tcp');
  return l?.kind === 'tcp' ? l : undefined;
}
export function httpLayer(p: Packet): HttpHeader | undefined {
  const l = p.layers.find((x) => x.kind === 'http');
  return l?.kind === 'http' ? l : undefined;
}

/** 只保留目标类型的逻辑报文（按创建顺序，按 packet.id 去重）。 */
export function typedPackets(events: SimEvent[], pick: (p: Packet) => boolean): Packet[] {
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
export function notices(events: SimEvent[], level?: 'info' | 'warn'): string[] {
  return events
    .filter((e) => e.type === 'notice' && (!level || e.level === level))
    .map((e) => (e.type === 'notice' ? e.message : ''));
}

export interface Hop {
  from: string;
  to: string;
  delivered: boolean;
  packet: Packet;
}

export function hops(events: SimEvent[]): Hop[] {
  return events.flatMap((e) => (e.type === 'hop' ? [{ from: e.from, to: e.to, delivered: Boolean(e.delivered), packet: e.packet }] : []));
}

/** 步进引擎直到收敛；每步后让微任务续延（await/pending）入队。 */
export async function drain(engine: SimulationEngine, maxSteps = 600): Promise<SimEvent[]> {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const ev = engine.step();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0); // 让微任务续延（await/pending）入队
    await promise;
    if (ev) events.push(ev);
    if (!ev && engine.isIdle()) return events;
  }
  throw new Error(`引擎 ${maxSteps} 步未收敛`);
}

/** 逻辑报文序列（按 packet.id 去重，保留首见顺序）：追踪行的口径。 */
export function packetSeq(events: SimEvent[], pick: (p: Packet) => string): string[] {
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

export function icmpTypes(events: SimEvent[]): string[] {
  return packetSeq(events, (p) => icmpLayer(p)?.type ?? '');
}

export function arpRepliers(events: SimEvent[]): string[] {
  return events
    .filter((e) => e.type === 'hop')
    .map((e) => arpLayer(e.packet))
    .filter((a) => a?.op === 'reply')
    .map((a) => a!.senderIp);
}

export function arpOps(events: SimEvent[]): string[] {
  return packetSeq(events, (p) => arpLayer(p)?.op ?? '');
}

export function dev(id: DeviceId | string): Device {
  const d = useStore.getState().topology.devices[id];
  if (!d) throw new Error(`设备不存在：${id}`);
  return d;
}

export function ipOf(id: DeviceId | string): string {
  const f = Object.values(dev(id).interfaces).find((x) => x.ip);
  if (!f?.ip) throw new Error(`${id} 无 IP`);
  return f.ip;
}

/** TCP 段缩写：S / SA / A（握手与 HTTP 序列断言共用）。 */
export function tcpAbbrev(events: SimEvent[]): string[] {
  return packetSeq(events, (p) => {
    const t = tcpLayer(p);
    if (!t) return '';
    return t.syn && !t.ackFlag ? 'S' : t.syn && t.ackFlag ? 'SA' : 'A';
  });
}
