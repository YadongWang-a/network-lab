/**
 * WF-12 场景 6 + 7：HTTP（TCP 三次握手 + apache2 200）、无服务提示、
 * TCP 连接（telnet/ftp 端口语义）、ARP 扫描。契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { ctx, dev, drain, httpLayer, ipOf, notices, resetTopology, tcpAbbrev, tcpLayer, typedPackets } from '../helpers/engine';

beforeEach(resetTopology);

function setup(): { pc0: string; web: string; engine: SimulationEngine } {
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const web = st.addDevice('pc', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(web, 'enp0s3', sw0);
  return { pc0, web, engine: new SimulationEngine(ctx) };
}

describe('浏览网页（HTTP over TCP）', () => {
  test('TCP 序列号推进 + GET→200', async () => {
    const { pc0, web, engine } = setup();
    // apache2 归并（同拖放 Web 服务器语义：pc kind + apache2 服务）
    useStore.getState().updateDevice(web, { services: { ...dev(web).services, apache2: { enabled: true, config: { documentRoot: '/var/www/html', vhosts: [] } } } });

    void engine.httpGet(pc0, web, 'www.example.com');
    const events = await drain(engine);

    expect(tcpAbbrev(events).join(',')).toBe('S,SA,A,A,A'); // SYN,SYN-ACK,ACK,ACK(GET),ACK(200)
    const httpSeq = typedPackets(events, (p) => Boolean(httpLayer(p))).map((p) => {
      const h = httpLayer(p)!;
      return h.method ? 'GET' : String(h.status ?? '');
    });
    expect(httpSeq.join(',')).toBe('GET,200');
    const ts = typedPackets(events, (p) => Boolean(tcpLayer(p)));
    const syn = tcpLayer(ts[0]!)!;
    const synack = tcpLayer(ts[1]!)!;
    const get = ts.find((p) => httpLayer(p)?.method === 'GET')!;
    const ok = ts.find((p) => httpLayer(p)?.status === 200)!;
    expect(synack.ack).toBe(syn.seq + 1);
    expect(tcpLayer(get)!.ack).toBe(synack.seq + 1);
    expect(tcpLayer(ok)!.ack).toBe(tcpLayer(get)!.seq + 1);
    expect(engine.isIdle()).toBe(true);
  });

  test('目标未运行 apache2 → 中文提示', async () => {
    const { pc0, engine } = setup();
    void engine.httpGet(pc0, pc0, 'www.example.com');
    const events = await drain(engine);
    expect(notices(events, 'warn').some((m) => m.includes('未运行') && m.includes('Web 服务'))).toBe(true);
  });
});

describe('TCP 连接与 ARP 扫描', () => {
  test('telnet 语义：三次握手端口 23（协议体简化仅握手 —— WF-17 范围）', async () => {
    const { pc0, web, engine } = setup();
    void engine.tcpConnect(pc0, web, 23);
    const events = await drain(engine);
    expect(tcpAbbrev(events).join(',')).toBe('S,SA,A');
    const ts = typedPackets(events, (p) => Boolean(tcpLayer(p)));
    expect(tcpLayer(ts[0]!)!.dstPort).toBe(23);
    expect(tcpLayer(ts[1]!)!.srcPort).toBe(23);
    expect(engine.isIdle()).toBe(true);
  });

  test('ARP 扫描：汇总提示 + 学习目标 MAC', async () => {
    const { pc0, web, engine } = setup();
    void engine.arpScan(pc0);
    const events = await drain(engine);
    expect(notices(events, 'info').some((m) => m.includes('1 台主机在线'))).toBe(true);
    expect(dev(pc0).arpTable.some((a) => a.ip === ipOf(web))).toBe(true);
    expect(engine.isIdle()).toBe(true);
  });
});
