/**
 * 报文 → 字节序列合成（WF-20 包解剖）：从层栈字段精确合成包头字节。
 * 以太网 / ARP / IP / ICMP / TCP / UDP 为真实编码（校验和占位 0x0000，引擎不建模）；
 * 应用层（DHCP/DNS/HTTP）按字段忠实编码但结构简化，段标注 approx（示意）。
 */
import type { Packet, Layer, IpHeader } from './types';

export interface ByteSegment {
  kind: Layer['kind'];
  /** 字节区间 [start, end)。 */
  start: number;
  end: number;
  /** 结构简化/示意（应用层负载）。 */
  approx?: boolean;
}

export interface PacketBytes {
  bytes: number[];
  segments: ByteSegment[];
}

const MAC_RE = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/;

export function macToBytes(mac: string): number[] {
  if (!MAC_RE.test(mac)) throw new Error(`非法 MAC "${mac}"`);
  return mac.split(':').map((h) => parseInt(h, 16));
}

export function ipToBytes(ip: string): number[] {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((x) => x === '' || Number.isNaN(Number(x)))) throw new Error(`非法 IP "${ip}"`);
  return parts.map((x) => Number(x) & 0xff);
}

const be16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const ETHERTYPE: Record<string, number> = { ipv4: 0x0800, arp: 0x0806 };
const IP_PROTO: Record<IpHeader['protocol'], number> = { icmp: 1, tcp: 6, udp: 17 };
const TCP_FLAGS = { syn: 0x02, ack: 0x10 };

/** 文本 → latin1 字节（引擎负载均为 ASCII；超范围字符折叠为 '?'）。 */
function textBytes(text: string): number[] {
  return [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c <= 126 ? c : 0x3f;
  });
}

/** 应用层报文体字节（DHCP/DNS/HTTP；字段忠实编码，结构简化 → approx）。 */
export function appBytes(p: Packet): number[] {
  const app = p.layers.find((x) => x.kind === 'dhcp' || x.kind === 'dns' || x.kind === 'http');
  if (!app) return [];
  if (app.kind === 'http') {
    const text =
      app.method !== undefined
        ? `${app.method} ${app.path ?? '/'} HTTP/1.1\r\nHost: ${app.host ?? ''}\r\n\r\n`
        : `HTTP/1.1 ${app.status ?? 200} OK\r\nContent-Type: text/html\r\n\r\n`;
    return textBytes(text);
  }
  if (app.kind === 'dns') {
    const qname: number[] = [];
    for (const label of (app.name ?? '').split('.')) qname.push(label.length, ...textBytes(label));
    const flags = app.qr === 'reply' ? (app.rc === 'NXDOMAIN' ? 0x8183 : 0x8180) : 0x0100;
    const out = [...be16(app.xid & 0xffff), ...be16(flags), ...be16(1), 0, 0, 0, 0, 0, 0];
    out.push(...qname, 0x00, ...be16(1), ...be16(1));
    if (app.qr === 'reply' && app.answer) {
      out.push(0xc0, 0x0c, ...be16(1), ...be16(1), ...be32(0), ...be16(4), ...ipToBytes(app.answer));
    }
    return out;
  }
  // DHCP：BOOTP 固定头 236B + option 53（消息类型）+ end
  const op = app.messageType === 'offer' || app.messageType === 'ack' ? 2 : 1;
  const optCode = { discover: 1, offer: 2, request: 3, ack: 5, release: 7 }[app.messageType] ?? 1;
  const bytes: number[] = [op, 1, 6, 0, ...be32(app.xid & 0xffffffff), 0, 0, ...be16(0)];
  bytes.push(...new Array(4).fill(0)); // ciaddr
  bytes.push(...(app.yiaddr ? ipToBytes(app.yiaddr) : [0, 0, 0, 0]));
  bytes.push(0, 0, 0, 0); // siaddr
  bytes.push(0, 0, 0, 0); // giaddr
  bytes.push(...macToBytes(app.chaddr), ...new Array(10).fill(0)); // chaddr 16B
  bytes.push(...new Array(64).fill(0)); // sname
  bytes.push(...new Array(128).fill(0)); // file
  bytes.push(0x63, 0x82, 0x53, 0x63); // magic cookie
  bytes.push(53, 1, optCode, 255);
  return bytes;
}

/** 层栈 → 字节序列 + 各层字节区间（外→内，与 layers 顺序一致）。 */
export function packetToBytes(p: Packet): PacketBytes {
  const bytes: number[] = [];
  const segments: ByteSegment[] = [];

  const eth = p.layers.find((x) => x.kind === 'ethernet');
  const arpL = p.layers.find((x) => x.kind === 'arp');
  const l3 = p.layers.find((x) => x.kind === 'ip');
  const l4 = p.layers.find((x) => x.kind === 'icmp' || x.kind === 'tcp' || x.kind === 'udp');
  const app = p.layers.find((x) => x.kind === 'dhcp' || x.kind === 'dns' || x.kind === 'http');
  const appLen = appBytes(p).length;

  // —— 二层：以太网帧头 +（可选）ARP 载荷 ——
  if (eth) {
    segments.push({ kind: 'ethernet', start: bytes.length, end: bytes.length + 14 });
    bytes.push(...macToBytes(eth.dstMac), ...macToBytes(eth.srcMac), ...be16(ETHERTYPE[eth.etherType]));
  }
  if (arpL) {
    segments.push({ kind: 'arp', start: bytes.length, end: bytes.length + 28 });
    bytes.push(0x00, 0x01, ...be16(0x0800), 6, 4, ...be16(arpL.op === 'reply' ? 2 : 1));
    bytes.push(...macToBytes(arpL.senderMac), ...ipToBytes(arpL.senderIp), ...macToBytes(arpL.targetMac), ...ipToBytes(arpL.targetIp));
  }

  // —— 三层（总长 = IP 头 20 + 传输层 + 载荷）——
  if (l3?.kind === 'ip') {
    const l4Size = l4?.kind === 'tcp' ? 20 : l4 ? 8 : 0;
    segments.push({ kind: 'ip', start: bytes.length, end: bytes.length + 20 });
    bytes.push(0x45, 0x00, ...be16(20 + l4Size + appLen), 0x00, 0x01, ...be16(0x4000), l3.ttl & 0xff, IP_PROTO[l3.protocol]);
    bytes.push(0, 0, ...ipToBytes(l3.srcIp), ...ipToBytes(l3.dstIp)); // checksum 占位
  }

  // —— 四层 ——
  if (l4?.kind === 'tcp') {
    segments.push({ kind: 'tcp', start: bytes.length, end: bytes.length + 20 });
    bytes.push(...be16(l4.srcPort), ...be16(l4.dstPort), ...be32(l4.seq >>> 0), ...be32(l4.ack >>> 0));
    bytes.push(0x50, (l4.syn ? TCP_FLAGS.syn : 0) | (l4.ackFlag ? TCP_FLAGS.ack : 0));
    bytes.push(...be16(0xffff), 0, 0, 0, 0); // window + checksum/urg 占位
  } else if (l4?.kind === 'udp') {
    segments.push({ kind: 'udp', start: bytes.length, end: bytes.length + 8 });
    bytes.push(...be16(l4.srcPort), ...be16(l4.dstPort), ...be16(8 + appLen), 0, 0);
  } else if (l4?.kind === 'icmp') {
    segments.push({ kind: 'icmp', start: bytes.length, end: bytes.length + 8 });
    const type = { 'echo-request': 8, 'echo-reply': 0, 'time-exceeded': 11 }[l4.type];
    bytes.push(type, 0, 0, 0, 0, 0, 0, 0); // checksum/id/seq 占位
  }

  // —— 应用层（approx）——
  if (app) {
    segments.push({ kind: app.kind, start: bytes.length, end: bytes.length + appLen, approx: true });
    bytes.push(...appBytes(p));
  }

  return { bytes, segments };
}
