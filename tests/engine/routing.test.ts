/**
 * WF-12 场景 2：跨网段 ping（三交换机两路由器）—— WF-7 路由表消费、最长前缀查表、
 * TTL 递减、远端路由 next-hop、无路由丢弃。契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { arpOps, arpRepliers, ctx, dev, drain, hops, icmpLayer, ipLayer, ipOf, resetTopology } from '../helpers/engine';
beforeEach(resetTopology);

function setup(): { r0: string; r1: string; pc0: string; pc1: string; engine: SimulationEngine } {
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
  return { r0, r1, pc0, pc1, engine: new SimulationEngine(ctx) };
}

describe('跨网段 ping（路由器查表转发）', () => {
  test('WF-7 路由表：远端网段 next-hop = 桥接路由器（Dijkstra 平局取段键字典序）', () => {
    const { r0 } = setup();
    const r0Route = dev(r0).routingTable.find((r) => r.network === '172.16.0.0');
    expect(r0Route?.nextHop).toBe('192.168.1.2'); // r1 应答，经 sw0 共享段
  });

  test('四次 ARP + 定向交付 + TTL 递减 + r0 学到 r1', async () => {
    const { r0, r1, pc0, pc1, engine } = setup();
    void engine.ping(pc0, ipOf(pc1));
    const events = await drain(engine);

    expect(arpOps(events).filter((o) => o === 'reply')).toHaveLength(4); // r0 网关、r1 next-hop、pc1、回程 pc0
    expect(hops(events).filter((x) => icmpLayer(x.packet)?.type === 'echo-request').some((x) => x.delivered && x.to === pc1)).toBe(true);
    expect(arpRepliers(events)).toContain('192.168.1.2'); // r1 应答远端路由 next-hop 的 ARP
    expect(hops(events).flatMap((x) => ipLayer(x.packet)?.ttl ?? [])).toContain(63); // 转发时 TTL 递减
    expect(dev(r0).arpTable.some((a) => a.ip === '192.168.1.2')).toBe(true);
    expect(dev(r1).interfaces.enp0s3!.ip).toBe('192.168.1.2');
    expect(engine.isIdle()).toBe(true);
  });

  test('无路由 → dropped 事件（中文原因）', async () => {
    const { pc0, engine } = setup();
    void engine.ping(pc0, '8.8.8.8');
    const events = await drain(engine);
    expect(events.some((e) => e.type === 'dropped' && e.reason.includes('无路由'))).toBe(true);
  });
});
