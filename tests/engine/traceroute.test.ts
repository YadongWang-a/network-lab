/**
 * WF-12 场景 3：traceroute —— TTL 逐跳探测、time-exceeded、到达。
 * 契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { ctx, drain, hops, icmpLayer, icmpTypes, ipLayer, ipOf, resetTopology } from '../helpers/engine';

beforeEach(resetTopology);

describe('traceroute（TTL 探测 + time-exceeded）', () => {
  test('探测序列 req→TE→req→reply，TE 源 = 路由器入接口 IP', async () => {
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

    expect(icmpTypes(events).join(',')).toBe('echo-request,time-exceeded,echo-request,echo-reply');
    const te = hops(events).find((x) => icmpLayer(x.packet)?.type === 'time-exceeded');
    expect(te).toBeDefined();
    const teIp = te && ipLayer(te.packet);
    expect(teIp?.srcIp).toBe('192.168.1.1'); // TE 源 = r0 入接口 IP（与 legacy 一致）
  });
});
