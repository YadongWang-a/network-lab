/**
 * 包解剖视图（WF-20）：对齐 数据包可视化演示_单视图整合版.html 的形态 ——
 * 层条（flex 按层头字节数，点层切换）+ 字段/值/说明表 + hex 视图（点层高亮字节段）。
 * 数据全部来自真实 Packet（packetToBytes 按层字段合成字节），无对话框；
 * 由报文追踪面板在行点击时内联承载。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Layer, Packet, ArpHeader, DhcpHeader, DnsHeader, EthernetHeader, HttpHeader, IcmpHeader, IpHeader, TcpHeader } from '@/domain/types';
import { packetToBytes, type ByteSegment } from '@/domain/packetBytes';

/** 层条配色 + 头部字节数（应用层 flex 取合成负载长度）。 */
const LAYER_STYLE: Record<Layer['kind'], { bg: string; fg: string }> = {
  ethernet: { bg: '#EDE7FB', fg: '#5B4DB8' },
  arp: { bg: '#F9F0FF', fg: '#722ED1' },
  ip: { bg: '#E0F7FA', fg: '#007C8C' },
  icmp: { bg: '#FFF1F0', fg: '#C0392B' },
  tcp: { bg: '#FFF4E0', fg: '#B45309' },
  udp: { bg: '#FFF4E0', fg: '#B45309' },
  dhcp: { bg: '#E8F5E9', fg: '#1B7A4A' },
  dns: { bg: '#E8F5E9', fg: '#1B7A4A' },
  http: { bg: '#E8F5E9', fg: '#1B7A4A' },
};

const IP_PROTO_NO: Record<IpHeader['protocol'], string> = { icmp: '1 (ICMP)', tcp: '6 (TCP)', udp: '17 (UDP)' };
const ICMP_TYPE_NO: Record<IcmpHeader['type'], string> = { 'echo-request': '8 (echo-request)', 'echo-reply': '0 (echo-reply)', 'time-exceeded': '11 (time-exceeded)' };
const ARP_OP_NO: Record<ArpHeader['op'], string> = { request: '1 (request)', reply: '2 (reply)' };
const ETH_TYPE_HEX: Record<EthernetHeader['etherType'], string> = { ipv4: '0x0800', arp: '0x0806' };
const DHCP_OPT_NO: Record<DhcpHeader['messageType'], string> = { discover: '1', offer: '2', request: '3', ack: '5', release: '7' };

type TFn = (key: string, opt?: Record<string, unknown>) => string;

/** 单层字段行（与原详情窗口径一致，加说明列）。 */
function buildRows(layer: Layer, t: TFn): Array<{ label: string; value: string; desc: string }> {
  const r = (label: string, value: string, descKey: string) => ({ label, value, desc: t(descKey) });
  switch (layer.kind) {
    case 'ethernet':
      return [
        r(t('field.dstMac'), layer.dstMac, 'desc.ethernet.dstMac'),
        r(t('field.srcMac'), layer.srcMac, 'desc.ethernet.srcMac'),
        r(t('field.etherType'), ETH_TYPE_HEX[layer.etherType], 'desc.ethernet.etherType'),
      ];
    case 'arp':
      return [
        r(t('arp.op'), `${ARP_OP_NO[layer.op]} · ${layer.op === 'request' ? t('arp.request') : t('arp.reply')}`, 'desc.arp.op'),
        r(t('arp.senderIp'), layer.senderIp, 'desc.arp.senderIp'),
        r(t('arp.senderMac'), layer.senderMac, 'desc.arp.senderMac'),
        r(t('arp.targetIp'), layer.targetIp, 'desc.arp.targetIp'),
        r(t('arp.targetMac'), layer.targetMac, 'desc.arp.targetMac'),
      ];
    case 'ip':
      return [
        r(t('ip.src'), layer.srcIp, 'desc.ip.src'),
        r(t('ip.dst'), layer.dstIp, 'desc.ip.dst'),
        r(t('ip.ttl'), String(layer.ttl), 'desc.ip.ttl'),
        r(t('ip.proto'), IP_PROTO_NO[layer.protocol], 'desc.ip.proto'),
      ];
    case 'icmp':
      return [r(t('icmp.type'), ICMP_TYPE_NO[layer.type], 'desc.icmp.type')];
    case 'tcp': {
      const flags = ((layer as TcpHeader).syn ? 0x02 : 0) | ((layer as TcpHeader).ackFlag ? 0x10 : 0);
      return [
        r(t('tcp.srcPort'), String(layer.srcPort), 'desc.tcp.srcPort'),
        r(t('tcp.dstPort'), String(layer.dstPort), 'desc.tcp.dstPort'),
        r(t('tcp.seq'), String(layer.seq), 'desc.tcp.seq'),
        r(t('tcp.ack'), String(layer.ack), 'desc.tcp.ack'),
        r(t('tcp.flags'), `${layer.syn ? 'SYN ' : ''}${layer.ackFlag ? 'ACK' : ''}`.trim() + ` (0x${flags.toString(16).padStart(2, '0')})`, 'desc.tcp.flags'),
      ];
    }
    case 'udp':
      return [
        r(t('tcp.srcPort'), String(layer.srcPort), 'desc.udp.srcPort'),
        r(t('tcp.dstPort'), String(layer.dstPort), 'desc.udp.dstPort'),
      ];
    case 'dhcp': {
      const d = layer as DhcpHeader;
      const rows = [
        r(t('dhcp.msgType'), `${d.messageType} (${DHCP_OPT_NO[d.messageType]})`, 'desc.dhcp.msgType'),
        r(t('dhcp.xid'), `0x${d.xid.toString(16)}`, 'desc.dhcp.xid'),
        r(t('dhcp.chaddr'), d.chaddr, 'desc.dhcp.chaddr'),
      ];
      if (d.yiaddr) rows.push(r(t('dhcp.yiaddr'), d.yiaddr, 'desc.dhcp.yiaddr'));
      if (d.netmask) rows.push(r(t('dhcp.netmask'), d.netmask, 'desc.dhcp.netmask'));
      if (d.gateway) rows.push(r(t('dhcp.gateway'), d.gateway, 'desc.dhcp.gateway'));
      if (d.hostname) rows.push(r(t('lease.host'), d.hostname, 'desc.dhcp.hostname'));
      return rows;
    }
    case 'dns': {
      const d = layer as DnsHeader;
      const rows = [r(t('dns.qr'), d.qr === 'query' ? t('dns.query') : t('dns.reply'), 'desc.dns.qr'), r(t('dhcp.xid'), `0x${d.xid.toString(16)}`, 'desc.dhcp.xid')];
      if (d.name) rows.push(r(t('dns.name'), d.name, 'desc.dns.name'));
      if (d.answer) rows.push(r(t('dns.answer'), d.answer, 'desc.dns.answer'));
      if (d.rc) rows.push(r(t('dns.rc'), d.rc, 'desc.dns.rc'));
      return rows;
    }
    case 'http': {
      const d = layer as HttpHeader;
      if (d.method) {
        return [
          r(t('http.method'), d.method, 'desc.http.method'),
          r(t('http.host'), d.host ?? '—', 'desc.http.host'),
          r(t('http.path'), d.path ?? '/', 'desc.http.path'),
        ];
      }
      return [r(t('http.status'), String(d.status ?? '—'), 'desc.http.status')];
    }
  }
}

interface HexRowProps {
  bytes: number[];
  offset: number;
  active?: ByteSegment;
}

/** 一行 hex（16 字节）：偏移 + 字节（选中段高亮）+ ASCII 尾列。 */
function HexRow({ bytes, offset, active }: HexRowProps) {
  const cells: React.ReactNode[] = [];
  const ascii: string[] = [];
  for (let i = offset; i < Math.min(offset + 16, bytes.length); i++) {
    const v = bytes[i]!;
    const on = active !== undefined && i >= active.start && i < active.end;
    cells.push(
      <span key={i} style={on ? { fontWeight: 700, boxShadow: 'inset 0 0 0 1.5px #1A3A6B', borderRadius: 3 } : undefined}>
        {v.toString(16).padStart(2, '0').toUpperCase()}
      </span>,
    );
    cells.push(i % 8 === 7 ? '  ' : ' ');
    ascii.push(v >= 32 && v <= 126 ? String.fromCharCode(v) : '.');
  }
  return (
    <div>
      <span style={{ color: '#B9C2D0' }}>{offset.toString(16).padStart(4, '0')}</span>
      {'  '}
      {cells}
      <span style={{ color: '#8A94A6' }}>{ascii.join('')}</span>
    </div>
  );
}


export default function PacketDissect({ packet }: { packet: Packet | undefined }) {
  const { t } = useTranslation();
  const [selKind, setSelKind] = useState<Layer['kind'] | null>(null);

  const pb = useMemo(() => (packet ? packetToBytes(packet) : undefined), [packet]);
  const kinds = packet?.layers.map((l) => l.kind) ?? [];
  // 默认选最内层（应用层 / 传输层），与演示行为一致；切包自动回落
  const kind: Layer['kind'] | undefined = selKind !== null && kinds.includes(selKind) ? selKind : kinds[kinds.length - 1];

  if (!packet || !pb) {
    return <div style={{ color: '#999', fontSize: 12, padding: '4px 2px' }}>{t('dissect.empty')}</div>;
  }

  const layer = packet.layers.find((l) => l.kind === kind);
  const segment = pb.segments.find((s) => s.kind === kind);
  const rows = layer ? buildRows(layer, t) : [];
  const rowStarts: number[] = [];
  for (let i = 0; i < pb.bytes.length; i += 16) rowStarts.push(i);

  return (
    <div>
      {/* 层条：flex 按层头/负载字节数 */}
      <div style={{ display: 'flex', borderRadius: 12, overflow: 'hidden', border: '1px solid #D8DEE9', boxShadow: '0 2px 6px rgba(16,32,64,.06)' }}>
        {pb.segments.map((s, i) => {
          const st = LAYER_STYLE[s.kind];
          const size = s.end - s.start;
          const on = s.kind === kind;
          return (
            <div
              key={s.kind}
              onClick={() => setSelKind(s.kind)}
              style={{
                flex: Math.max(size, 8), textAlign: 'center', padding: '14px 4px', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', opacity: on ? 1 : 0.55, background: st.bg, color: st.fg,
                outline: on ? '2px solid #1A3A6B' : 'none', outlineOffset: 1, transition: 'all .15s',
                borderRight: i < pb.segments.length - 1 ? '1px solid #fff' : 'none',
                overflow: 'hidden',
              }}
            >
              <span style={{ display: 'block' }}>{t(`layer.${s.kind}`)}{s.approx ? '*' : ''}</span>
              <span style={{ display: 'block', fontSize: 10, fontWeight: 400, marginTop: 2 }}>{size}B</span>
            </div>
          );
        })}
      </div>

      {/* 字段表：字段 / 值 / 说明 */}
      {layer && (
        <div style={{ border: '1px solid #E4E6EB', borderRadius: 12, overflow: 'hidden', marginTop: 12 }}>
          <div style={{ display: 'flex', fontSize: 11, color: '#8A94A6', background: '#F7F9FC', padding: '8px 12px', fontWeight: 600 }}>
            <div style={{ flex: 2 }}>{t('dissect.field')}</div>
            <div style={{ flex: 2 }}>{t('dissect.value')}</div>
            <div style={{ flex: 3 }}>{t('dissect.desc')}</div>
          </div>
          {rows.map((rw, i) => (
            <div key={i} style={{ display: 'flex', fontSize: 12.5, padding: '8px 12px', borderBottom: i === rows.length - 1 ? undefined : '1px solid #F0F2F6' }}>
              <div style={{ flex: 2, color: '#1A1B1C', fontWeight: 600 }}>{rw.label}</div>
              <div style={{ flex: 2, color: '#0E8F7E', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', wordBreak: 'break-all' }}>{rw.value}</div>
              <div style={{ flex: 3, color: '#6B7280' }}>{rw.desc}</div>
            </div>
          ))}
        </div>
      )}

      {/* hex 视图：点层高亮对应字节段 */}
      <div style={{ fontSize: 11, color: '#8A94A6', marginTop: 12 }}>
        {t('dissect.hexTitle')}
        {segment && (
          <>
            {' · '}
            {t('dissect.byteRange', { layer: t(`layer.${kind}`), from: segment.start, to: segment.end - 1 })}
            {segment.approx ? ` · ${t('dissect.approx')}` : ''}
          </>
        )}
      </div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.75, background: '#FAFBFD', border: '1px solid #E4E6EB', borderRadius: 12, padding: '10px 14px', color: '#3A4356', overflowX: 'auto', marginTop: 6 }}>
        {rowStarts.map((start) => (
          <HexRow key={start} bytes={pb.bytes} offset={start} active={segment} />
        ))}
      </div>
    </div>
  );
}
