/**
 * WF-20 包解剖字节合成契约：层栈 → 真实包头字节 + 段区间。
 * 断言可观测结果 = 合成字节与 RFC 形状一致、区间连续覆盖、应用层标注 approx。
 */
import { describe, expect, test } from 'vitest';
import { appBytes, ipToBytes, macToBytes, packetToBytes } from '@/domain/packetBytes';
import type { Packet } from '@/domain/types';

const mac = (n: number) => `A4:5E:60:11:22:${n.toString(16).padStart(2, '0').toUpperCase()}`;

function ipPacket(over: Partial<Parameters<typeof packetToBytes>[0]> = {}): Packet {
  return {
    id: 'p1',
    xid: undefined,
    createdAt: 0,
    ...over,
    layers: over.layers ?? [
      { kind: 'ethernet', dstMac: mac(0x33), srcMac: mac(0x10), etherType: 'ipv4' },
      { kind: 'ip', srcIp: '192.168.1.2', dstIp: '192.168.1.3', ttl: 64, protocol: 'tcp' },
      { kind: 'tcp', srcPort: 12345, dstPort: 80, seq: 0, ack: 0, syn: true, ackFlag: false },
    ],
  } as never;
}

describe('包头字节合成（packetToBytes）', () => {
  test('以太网帧头：MAC/EtherType 精确编码，段区间 [0,14)', () => {
    const { bytes, segments } = packetToBytes(ipPacket());
    expect(segments[0]).toEqual({ kind: 'ethernet', start: 0, end: 14 });
    expect(bytes.slice(0, 6)).toEqual(macToBytes(mac(0x33)));
    expect(bytes.slice(6, 12)).toEqual(macToBytes(mac(0x10)));
    expect(bytes.slice(12, 14)).toEqual([0x08, 0x00]);
  });

  test('IP 头：总长 = 20 + 传输层 + 载荷，TTL/协议号/地址落位', () => {
    const { bytes, segments } = packetToBytes(ipPacket());
    expect(segments.find((s) => s.kind === 'ip')).toEqual({ kind: 'ip', start: 14, end: 34 });
    const ip = bytes.slice(14, 34);
    expect(ip[0]).toBe(0x45); // 版本 4 / IHL 5
    expect((ip[2]! << 8) | ip[3]!).toBe(20 + 20); // 无载荷：总长 40
    expect(ip[8]).toBe(64); // TTL
    expect(ip[9]).toBe(6); // TCP
    expect(ip.slice(12, 16)).toEqual(ipToBytes('192.168.1.2'));
    expect(ip.slice(16, 20)).toEqual(ipToBytes('192.168.1.3'));
  });

  test('TCP 头：端口/序号/确认号/标志（SYN=0x02, SYN+ACK=0x12）', () => {
    const { bytes, segments } = packetToBytes(ipPacket());
    expect(segments.find((s) => s.kind === 'tcp')).toEqual({ kind: 'tcp', start: 34, end: 54 });
    const tcp = bytes.slice(34, 54);
    expect(tcp).toHaveLength(20);
    expect((tcp[0]! << 8) | tcp[1]!).toBe(12345);
    expect((tcp[2]! << 8) | tcp[3]!).toBe(80);
    expect(tcp.slice(4, 8)).toEqual([0, 0, 0, 0]); // seq=0
    expect(tcp[13]).toBe(0x02); // SYN
    const synAck = packetToBytes(ipPacket({
      layers: [
        { kind: 'ethernet', dstMac: mac(0x10), srcMac: mac(0x33), etherType: 'ipv4' },
        { kind: 'ip', srcIp: '192.168.1.3', dstIp: '192.168.1.2', ttl: 64, protocol: 'tcp' },
        { kind: 'tcp', srcPort: 80, dstPort: 12345, seq: 0, ack: 1, syn: true, ackFlag: true },
      ],
    }));
    expect(synAck.bytes[34 + 13]).toBe(0x12);
  });

  test('ARP 请求：28B 定长，op=1，目标 MAC 全 0', () => {
    const { bytes, segments } = packetToBytes({
      id: 'a1', createdAt: 0,
      layers: [
        { kind: 'ethernet', dstMac: 'FF:FF:FF:FF:FF:FF', srcMac: mac(0x10), etherType: 'arp' },
        { kind: 'arp', op: 'request', senderIp: '192.168.1.2', senderMac: mac(0x10), targetIp: '192.168.1.3', targetMac: '00:00:00:00:00:00' },
      ],
    });
    expect(bytes).toHaveLength(14 + 28);
    const arp = bytes.slice(14);
    expect((arp[6]! << 8) | arp[7]!).toBe(1); // op
    expect(arp.slice(18, 24)).toEqual(new Array(6).fill(0)); // target MAC 全 0
    expect(arp.slice(24, 28)).toEqual(ipToBytes('192.168.1.3'));
    expect(segments).toHaveLength(2);
  });

  test('ICMP echo-request：协议号 1，type 8', () => {
    const { bytes } = packetToBytes(ipPacket({
      layers: [
        { kind: 'ethernet', dstMac: mac(0x33), srcMac: mac(0x10), etherType: 'ipv4' },
        { kind: 'ip', srcIp: '192.168.1.2', dstIp: '192.168.1.3', ttl: 64, protocol: 'icmp' },
        { kind: 'icmp', type: 'echo-request' },
      ],
    }));
    expect(bytes[14 + 9]).toBe(1); // IP 协议号 icmp
    expect(bytes[34]).toBe(8); // ICMP echo-request
  });

  test('HTTP GET 载荷：approx 标注 + ASCII 可读', () => {
    const { bytes, segments } = packetToBytes(ipPacket({
      layers: [
        { kind: 'ethernet', dstMac: mac(0x33), srcMac: mac(0x10), etherType: 'ipv4' },
        { kind: 'ip', srcIp: '192.168.1.2', dstIp: '93.184.216.34', ttl: 63, protocol: 'tcp' },
        { kind: 'tcp', srcPort: 54321, dstPort: 80, seq: 1, ack: 1, syn: false, ackFlag: true },
        { kind: 'http', method: 'GET', host: 'www.example.com', path: '/' },
      ],
    }));
    const app = segments.find((s) => s.kind === 'http')!;
    expect(app.approx).toBe(true);
    expect(app.start).toBe(54);
    expect(app.end).toBe(bytes.length);
    const ascii = bytes.slice(54).map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '?')).join('');
    expect(ascii).toContain('GET / HTTP/1.1');
    expect(ascii).toContain('Host: www.example.com');
    expect((bytes[14 + 2]! << 8) | bytes[14 + 3]!).toBe(20 + 20 + app.end - app.start); // IP 总长含负载
  });

  test('DNS 应答：应答地址写入 rdata 区', () => {
    const { bytes, segments } = packetToBytes(ipPacket({
      layers: [
        { kind: 'ethernet', dstMac: mac(0x33), srcMac: mac(0x10), etherType: 'ipv4' },
        { kind: 'ip', srcIp: '192.168.1.2', dstIp: '192.168.1.9', ttl: 64, protocol: 'udp' },
        { kind: 'udp', srcPort: 53, dstPort: 54321 },
        { kind: 'dns', qr: 'reply', xid: 0x1234, name: 'www.example.com', answer: '93.184.216.34', rc: 'NOERROR' },
      ],
    }));
    expect(segments.find((s) => s.kind === 'dns')!.approx).toBe(true);
    const rdata = bytes.slice(-4); // 末 4 字节 = A 记录地址
    expect(rdata).toEqual(ipToBytes('93.184.216.34'));
    const dnsStart = segments.find((s) => s.kind === 'dns')!.start;
    expect((bytes[dnsStart]! << 8) | bytes[dnsStart + 1]!).toBe(0x1234);
  });

  test('DHCP discover：BOOTP op=1 + option 53=1（BOOTP 240B 含 magic + 4B 选项）', () => {
    const ab = appBytes({
      id: 'd1', createdAt: 0,
      layers: [
        { kind: 'ethernet', dstMac: 'FF:FF:FF:FF:FF:FF', srcMac: mac(0x10), etherType: 'ipv4' },
        { kind: 'dhcp', messageType: 'discover', xid: 0xabcdef01, chaddr: mac(0x10) },
      ],
    });
    expect(ab).toHaveLength(244);
    expect(ab[0]).toBe(1); // op = bootrequest
    expect(ab.slice(4, 8)).toEqual([0xab, 0xcd, 0xef, 0x01]);
    expect(ab.slice(236, 240)).toEqual([0x63, 0x82, 0x53, 0x63]); // magic cookie
    expect(ab.slice(240, 244)).toEqual([53, 1, 1, 255]); // option 53 discover + end
  });

  test('段区间连续无缝隙（覆盖整个帧）', () => {
    const { bytes, segments } = packetToBytes(ipPacket());
    let cursor = 0;
    for (const s of segments) {
      expect(s.start).toBe(cursor);
      cursor = s.end;
    }
    expect(cursor).toBe(bytes.length);
  });
});
