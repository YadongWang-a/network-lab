/**
 * WF-12 场景 1：同网段 ping（PC-交换机-PC）—— ARP 学习/洪泛、交换机 MAC 学习、
 * ICMP 往返、单步语义、ARP 缓存命中。契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { arpOps, ctx, dev, drain, hops, icmpLayer, icmpTypes, ipOf, resetTopology } from '../helpers/engine';

beforeEach(resetTopology);

function setup(): { pc0: string; pc1: string; sw: string; engine: SimulationEngine } {
  const st = useStore.getState();
  const pc0 = st.addDevice('pc', { position: { x: 0, y: 0 } });
  const pc1 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const sw = st.addDevice('switch', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw);
  st.addConnection(pc1, 'enp0s3', sw);
  return { pc0, pc1, sw, engine: new SimulationEngine(ctx) };
}

describe('同网段 ping（PC-交换机-PC）', () => {
  test('ARP 请求→应答 + ICMP 往返 + 交换机学习', async () => {
    const { pc0, pc1, sw, engine } = setup();
    void engine.ping(pc0, ipOf(pc1));
    const events = await drain(engine);

    expect(arpOps(events).join(',')).toBe('request,reply');
    expect(icmpTypes(events).join(',')).toBe('echo-request,echo-reply');
    const h = hops(events);
    expect(h[0]!.from).toBe(pc0);
    expect(h[0]!.to).toBe(sw);
    const floods = h.filter((x) => x.from === sw && x.packet.id === h[0]!.packet.id);
    expect(floods).toHaveLength(1); // 广播洪泛 1 份（另一端只有 PC1）
    expect(floods[0]!.delivered).toBe(false);
    expect(h.filter((x) => icmpLayer(x.packet)?.type === 'echo-reply').some((x) => x.delivered)).toBe(true);
    expect(dev(pc0).arpTable.find((a) => a.ip === ipOf(pc1))?.mac).toBe(dev(pc1).interfaces.enp0s3!.mac);
    expect(dev(pc1).arpTable.find((a) => a.ip === ipOf(pc0))?.mac).toBe(dev(pc0).interfaces.enp0s3!.mac);
    const swMac = dev(sw).macTable;
    expect(swMac.some((m) => m.mac === dev(pc0).interfaces.enp0s3!.mac)).toBe(true);
    expect(swMac.some((m) => m.mac === dev(pc1).interfaces.enp0s3!.mac)).toBe(true);
    expect(engine.isIdle()).toBe(true);
    expect(new Set(h.map((x) => x.packet.id)).size).toBe(4); // ARP req/rep + ICMP req/rep
  });

  test('单步语义：发起命令只入队首跳，step 推进一跳', async () => {
    const { pc0, pc1, sw, engine } = setup();
    expect(engine.isIdle()).toBe(true);
    void engine.ping(pc0, ipOf(pc1));
    const first = engine.step();
    expect(first?.type).toBe('hop');
    expect(first && 'from' in first ? first.from : '').toBe(pc0);
    expect(first && 'to' in first ? first.to : '').toBe(sw);
    expect(engine.isIdle()).toBe(false); // 单步后未收敛（待续跳）
    await drain(engine);
    expect(engine.isIdle()).toBe(true);
  });

  test('ARP 缓存命中：第二次 ping 无 ARP 报文', async () => {
    const { pc0, pc1, engine } = setup();
    void engine.ping(pc0, ipOf(pc1));
    await drain(engine);
    void engine.ping(pc0, ipOf(pc1));
    const events2 = await drain(engine);
    expect(arpOps(events2)).toHaveLength(0);
    expect(icmpTypes(events2).join(',')).toBe('echo-request,echo-reply');
  });
});
