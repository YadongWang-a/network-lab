import type { Packet, TimerHandle } from '@/domain/types';

// 仿真引擎骨架（WF-3 决策 B：全事件队列调度器）。
// 当前为骨架：事件队列 + 订阅 + xid/Promise 关联（pending）。
// 六个 processor（kernel/service/routing/switch/host/router）按 WF-3 迁移顺序接入。

export type SimEvent =
  | { type: 'packet-forwarded'; packet: Packet; from: string; to: string }
  | { type: 'packet-dropped'; packet: Packet; at: string; reason: string }
  | { type: 'firewall-blocked'; packet: Packet; at: string; chain: string }
  | { type: 'arp-resolved'; ip: string; mac: string };

type Listener = (e: SimEvent) => void;
type Pending = { resolve: (p: Packet) => void; timer: TimerHandle };

export class SimulationEngine {
  private queue: SimEvent[] = [];
  private listeners = new Set<Listener>();
  /** 异步关联表（WF-3 决策 ②）：xid → 等待者。引擎独占，不进 store。 */
  private pending = new Map<number, Pending>();

  /** 订阅仿真事件（可视化/终端/日志）。 */
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: SimEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  /** 入队一个仿真事件（WF-3 决策 B 的队列）。 */
  enqueue(e: SimEvent): void {
    this.queue.push(e);
  }

  /** 处理一跳（调度器核心）。暂停/单步由 SimulationController 控制调用节奏。 */
  step(): SimEvent | undefined {
    const e = this.queue.shift();
    if (e) this.emit(e);
    return e;
  }

  /**
   * 发起一个等待回复的请求（如 arpResolve）。
   * 返回 Promise，reply 事件按 xid 到达即 resolve（取代原 flag+buffer 全局态）。
   */
  request(xid: number, enqueue: () => void, timeoutMs = 5000): Promise<Packet> {
    return new Promise<Packet>((resolve) => {
      const timer: TimerHandle = setTimeout(() => this.pending.delete(xid), timeoutMs);
      this.pending.set(xid, { resolve, timer });
      enqueue();
    });
  }

  /** 当 reply 事件被处理时调用，按 xid 解 Promise。 */
  resolvePending(xid: number, packet: Packet): void {
    const waiter = this.pending.get(xid);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(xid);
      waiter.resolve(packet);
    }
  }
}
