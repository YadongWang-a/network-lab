/**
 * WF-12 场景 4 + 场景 8（DHCP 部分）：DORA 四步、租约落盘/复用、跨广播域提示、
 * 目标无服务/源未接线提示。契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { ipToInt } from '@/domain/ipam';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { dhcpLayer, ctx, dev, drain, notices, packetSeq, resetTopology, typedPackets } from '../helpers/engine';
beforeEach(resetTopology);

function setup(): { sw0: string; pc0: string; server: string; engine: SimulationEngine } {
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const server = st.addDevice('dhcp-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(server, 'enp0s3', sw0);
  // 客户端未配置（dhclient 绑定语义的前提）
  st.updateInterface(pc0, 'enp0s3', { ip: null, netmask: null, gateway: null });
  return { sw0, pc0, server, engine: new SimulationEngine(ctx) };
}

describe('DHCP DORA（同广播域）', () => {
  test('四步序列：xid/chaddr 一致、yiaddr 落池、租约与客户端绑定', async () => {
    const { pc0, server, engine } = setup();
    const pool = dev(server).dhcpPool!;
    const clientMac = dev(pc0).interfaces.enp0s3!.mac;

    void engine.dhcpDora(pc0, server);
    const events = await drain(engine);

    const dmsgs = packetSeq(events, (p) => dhcpLayer(p)?.messageType ?? '');
    expect(dmsgs.join(',')).toBe('discover,offer,request,ack');
    const dhs = typedPackets(events, (p) => Boolean(dhcpLayer(p)));
    expect(new Set(dhs.map((p) => dhcpLayer(p)!.xid)).size).toBe(1);
    expect(dhs.every((p) => dhcpLayer(p)!.chaddr === clientMac)).toBe(true);
    const yi = dhcpLayer(dhs[dhs.length - 1]!)!.yiaddr!;
    expect(ipToInt(yi)).toBeGreaterThanOrEqual(ipToInt(pool.rangeStart));
    expect(ipToInt(yi)).toBeLessThanOrEqual(ipToInt(pool.rangeEnd));
    const lease = dev(server).dhcpLeases?.find((l) => l.mac === clientMac);
    expect(lease?.ip).toBe(yi);
    expect(lease?.hostname).toBe(dev(pc0).label);
    expect(lease!.expiresAt).toBeGreaterThan(Date.now() + pool.leaseTime * 1000 - 5000);
    expect(dev(pc0).interfaces.enp0s3!.ip).toBe(yi);
    expect(dev(pc0).interfaces.enp0s3!.gateway).toBe(pool.gateway);
    expect(notices(events, 'info').some((m) => m.includes('绑定成功'))).toBe(true);
    expect(engine.isIdle()).toBe(true);
  });

  test('续租：客户端已有 IP → 租约复用原地址且不重复', async () => {
    const { pc0, server, engine } = setup();
    const clientMac = dev(pc0).interfaces.enp0s3!.mac;
    void engine.dhcpDora(pc0, server);
    const yi = packetSeq(await drain(engine), (p) => dhcpLayer(p)?.messageType === 'ack' ? dhcpLayer(p)!.yiaddr ?? '' : '')[0]!;

    void engine.dhcpDora(pc0, server);
    const events2 = await drain(engine);
    const ack2 = packetSeq(events2, (p) => dhcpLayer(p)?.messageType === 'ack' ? dhcpLayer(p)!.yiaddr ?? '' : '');
    expect(ack2).toContain(yi);
    expect(notices(events2, 'info').some((m) => m.includes('静态'))).toBe(true);
    expect((dev(server).dhcpLeases ?? []).filter((l) => l.mac === clientMac)).toHaveLength(1);
  });

  test('跨广播域：中文提示且不发 DHCP 报文', async () => {
    const { pc0, engine } = setup();
    const st = useStore.getState();
    const sw1 = st.addDevice('switch', { position: { x: 3, y: 0 } });
    const server2 = st.addDevice('dhcp-server', { position: { x: 4, y: 0 } });
    st.addConnection(server2, 'enp0s3', sw1);
    void engine.dhcpDora(pc0, server2);
    const events = await drain(engine);
    expect(notices(events, 'warn').some((m) => m.includes('不在同一广播域'))).toBe(true);
    expect(packetSeq(events, (p) => dhcpLayer(p)?.messageType ?? '')).toHaveLength(0);
  });
});

describe('DHCP 错误路径（中文提示，替代静默跳过）', () => {
  test('目标无 DHCP 服务 → 提示且不发报文', async () => {
    const st = useStore.getState();
    const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
    const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
    const pc1 = st.addDevice('pc', { position: { x: 2, y: 0 } });
    st.addConnection(pc0, 'enp0s3', sw0);
    st.addConnection(pc1, 'enp0s3', sw0);
    const engine = new SimulationEngine(ctx);
    void engine.dhcpDora(pc0, pc1); // pc1 无 dhcpPool
    const events = await drain(engine);
    expect(notices(events, 'warn').some((m) => m.includes('未运行') && m.includes('DHCP 服务'))).toBe(true);
    expect(packetSeq(events, (p) => dhcpLayer(p)?.messageType ?? '')).toHaveLength(0);
  });

  test('源未接入交换机 → 提示', async () => {
    const st = useStore.getState();
    const pc1 = st.addDevice('pc', { position: { x: 2, y: 0 } });
    const pc2 = st.addDevice('pc', { position: { x: 3, y: 0 } }); // 未接线（无交换机可广播）
    const engine = new SimulationEngine(ctx);
    void engine.dhcpDora(pc2, pc1);
    const events = await drain(engine);
    expect(notices(events, 'warn').some((m) => m.includes('未接入交换机'))).toBe(true);
  });
});
