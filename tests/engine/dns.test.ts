/**
 * WF-12 场景 5：DNS —— zone 命中应答 + 客户端缓存、NXDOMAIN 不写缓存、
 * 目标未运行 named 提示。契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { ctx, dev, drain, dnsLayer, notices, resetTopology, typedPackets } from '../helpers/engine';

beforeEach(resetTopology);

function setup(): { pc0: string; dnsSrv: string; engine: SimulationEngine } {
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const dnsSrv = st.addDevice('dns-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(dnsSrv, 'enp0s3', sw0);
  return { pc0, dnsSrv, engine: new SimulationEngine(ctx) };
}

describe('DNS 查询', () => {
  test('zone 命中：查询/应答 + A 记录 + 客户端缓存', async () => {
    const { pc0, dnsSrv, engine } = setup();
    void engine.dnsQuery(pc0, dnsSrv, 'www.example.com');
    const events = await drain(engine);

    const dnsPkts = typedPackets(events, (p) => Boolean(dnsLayer(p)));
    expect(dnsPkts).toHaveLength(2); // 查询 + 应答
    const q = dnsLayer(dnsPkts[0]!);
    const r = dnsLayer(dnsPkts[1]!);
    expect(q?.qr).toBe('query');
    expect(q?.name).toBe('www.example.com');
    expect(r?.qr).toBe('reply');
    expect(r?.rc).toBe('NOERROR');
    expect(r?.answer).toBe('93.184.216.34');
    expect(dev(pc0).dnsCache.some((c) => c.name === 'www.example.com' && c.ip === '93.184.216.34')).toBe(true);
  });

  test('未知域名：NXDOMAIN 应答且不写缓存', async () => {
    const { pc0, dnsSrv, engine } = setup();
    void engine.dnsQuery(pc0, dnsSrv, 'no.such.host');
    const events = await drain(engine);
    const r2 = typedPackets(events, (p) => dnsLayer(p)?.qr === 'reply')[0]!;
    expect(dnsLayer(r2)?.rc).toBe('NXDOMAIN');
    expect(dnsLayer(r2)?.answer).toBeUndefined();
    expect(dev(pc0).dnsCache.some((c) => c.name === 'no.such.host')).toBe(false);
    expect(engine.isIdle()).toBe(true);
  });

  test('目标未运行 named → 中文提示', async () => {
    const { pc0, engine } = setup();
    void engine.dnsQuery(pc0, pc0, 'www.example.com');
    const events = await drain(engine);
    expect(notices(events, 'warn').some((m) => m.includes('未运行') && m.includes('DNS 服务'))).toBe(true);
  });
});
