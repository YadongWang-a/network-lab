/**
 * 配置解析器（WF-10）：从设备虚拟文件系统的真实守护进程配置文件语法，
 * 解析为可落 store 的类型化配置。纯函数：`parse*` 只做文本 → 配置对象，
 * 错误带行号的中文信息（接 WF-8 文案习惯）。应用侧见 `apply*` 帮助函数
 * （store 接线由调用方——终端 `systemctl` 命令与 verify——提供 update 回调）。
 *
 * 语法沿用 legacy `parsers/*`（注释 # 与空行忽略；指令块解析忽略额外空白）。
 * 简化边界：路由规则/保留地址等后置特性不解析（见 WF-11 ticket 标注）。
 */

import type { Cidr } from '../domain/types';

/** 剥离注释与空行，返回保留行号的行数组。 */
function codeLines(content: string): Array<{ n: number; text: string }> {
  return content
    .split('\n')
    .map((raw, i) => ({ n: i + 1, text: raw.trim().replace(/\/\/.*$/, '').trim() }))
    .filter((l) => l.text.length > 0 && !l.text.startsWith('#'));
}

function configError(line: number, msg: string): Error {
  return new Error(`配置错误（第 ${line} 行）：${msg}`);
}

function validIp(ip: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) && ip.split('.').every((o) => Number(o) <= 255);
}

function validCidr(c: string): boolean {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c);
  return Boolean(m && validIp(m[1]!) && Number(m[2]) <= 32);
}

// ———————————————————— /etc/network/interfaces ————————————————————

export interface IfaceStaticConfig {
  iface: string;
  mode: 'static';
  address: string;
  netmask: string;
  gateway?: string;
}
export interface IfaceDhcpConfig {
  iface: string;
  mode: 'dhcp';
}
export type IfaceConfig = IfaceStaticConfig | IfaceDhcpConfig;

/**
 * iface 块语法（同 legacy）：`iface <iface> inet static|dhcp [address A netmask M [gateway G]]`。
 * 块内其余行忽略（路由规则由 WF-7 自动路由覆盖）。
 */
export function parseNetworkInterfaces(content: string, available: string[]): IfaceConfig[] {
  const out: IfaceConfig[] = [];
  const lines = codeLines(content);
  for (let i = 0; i < lines.length; i++) {
    const { n, text } = lines[i]!;
    if (!text.startsWith('iface ')) continue;
    const parts = text.split(/\s+/);
    // iface <iface> inet <type> …
    const iface = parts[1] ?? '';
    const inet = parts[3] ?? '';
    if (!available.includes(iface)) throw configError(n, `未知接口 "${iface}"`);
    if (parts[2] !== 'inet') throw configError(n, `预期 "iface ${iface} inet …"`);
    if (inet === 'dhcp') {
      out.push({ iface, mode: 'dhcp' });
      continue;
    }
    if (inet !== 'static') throw configError(n, `未知的网络类型 "${inet}"（支持 static / dhcp）`);
    const opts: Record<string, string> = {};
    for (let j = 4; j < parts.length - 1; j += 2) {
      const key = parts[j];
      const val = parts[j + 1];
      if (key && val) opts[key] = val;
    }
    if (!opts['address'] || !opts['netmask']) {
      throw configError(n, 'static 块必须提供 address 与 netmask');
    }
    if (!validIp(opts['address']!)) throw configError(n, `非法 IP 地址 "${opts['address']}"`);
    if (!validIp(opts['netmask']!)) throw configError(n, `非法子网掩码 "${opts['netmask']}"`);
    if (opts['gateway'] && !validIp(opts['gateway']!)) throw configError(n, `非法网关 "${opts['gateway']}"`);
    out.push({ iface, mode: 'static', address: opts['address']!, netmask: opts['netmask']!, gateway: opts['gateway'] });
  }
  return out;
}

// ———————————————————— /etc/dhcp/dhcpd.conf ————————————————————

export interface DhcpdConf {
  rangeStart: string;
  rangeEnd: string;
  netmask?: string;
  gateway?: string;
  dns?: string;
  leaseTime?: number;
}

/**
 * 支持 `subnet <net> netmask <mask> { … }` 块（legacy 相同语义），块内：
 * range <start> <end> / option subnet-mask <m> / option routers <g> /
 * option domain-name-servers <dns> / default-lease-time <sec>。
 * 其余块（host/保留地址）忽略。
 */
export function parseDhcpdConf(content: string): DhcpdConf {
  // 归一化花括号/分号：兼容单行块（subnet … { range …; } 一行写完）与多行格式
  const norm = content
    .replace(/[{}]/g, (c) => (c === '{' ? '{\n' : '\n}'))
    .replace(/;\s*/g, ';\n');
  const conf: DhcpdConf = { rangeStart: '', rangeEnd: '' };
  const lines = codeLines(norm);
  let i = 0;
  while (i < lines.length) {
    const { text } = lines[i]!;
    if (text.startsWith('subnet ')) {
      i += 1;
      for (; i < lines.length; i++) {
        const inner = lines[i]!;
        if (inner.text === '}') break;
        const t = inner.text;
        const { n: inl } = inner;
        const kv = (key: string) => {
          const m = new RegExp(`^${key}\\s+(.*)$`).exec(t);
          if (!m) return undefined;
          return m[1].replace(/;\s*$/, '').trim();
        };
        const range = kv('range');
        if (range) {
          const [s, e] = range.split(/\s+/);
          if (!s || !e || !validIp(s) || !validIp(e)) throw configError(inl, `range 需要两个合法 IP：${range}`);
          conf.rangeStart = s;
          conf.rangeEnd = e;
          continue;
        }
        const mask = kv('option subnet-mask');
        if (mask) {
          if (!validIp(mask)) throw configError(inl, `非法子网掩码 "${mask}"`);
          conf.netmask = mask;
          continue;
        }
        const gw = kv('option routers');
        if (gw) {
          if (!validIp(gw)) throw configError(inl, `非法网关 "${gw}"`);
          conf.gateway = gw;
          continue;
        }
        const dns = kv('option domain-name-servers');
        if (dns) {
          const first = dns.split(',')[0]!.trim();
          if (!validIp(first)) throw configError(inl, `非法 DNS 地址 "${first}"`);
          conf.dns = first;
          continue;
        }
        const lease = kv('default-lease-time');
        if (lease) {
          const num = Number(lease);
          if (!Number.isFinite(num) || num <= 0) throw configError(inl, `lease-time 需要正整数："${lease}"`);
          conf.leaseTime = num;
          continue;
        }
      }
      continue;
    }
    i += 1;
  }
  if (!conf.rangeStart || !conf.rangeEnd) throw new Error('配置错误：缺少 subnet/range 地址池定义');
  return conf;
}

// ———————————————————— bind9 zone / db 文件 ————————————————————

export interface NamedZones {
  /** zone 名 → A 记录 { host → ip }（host '@' 表示 zone 顶点）。 */
  zones: Record<string, Record<string, string>>;
}

/** 解析 named.conf.local：`zone "<name>" { … file "<db>"; };` 记录 zone → db 文件。 */
export function parseNamedConfLocal(content: string): Array<{ zone: string; db: string }> {
  const out: Array<{ zone: string; db: string }> = [];
  const lines = codeLines(content);
  let zone: string | null = null;
  let cur: { zone: string; db: string } | null = null;
  for (const { text } of lines) {
    const z = /^zone\s+"([^"]+)"\s*\{$/.exec(text);
    if (z) {
      if (cur) out.push(cur);
      zone = z[1]!;
      cur = { zone, db: '' };
      continue;
    }
    if (text === '};') {
      if (cur) {
        out.push(cur);
        cur = null;
        zone = null;
      }
      continue;
    }
    if (cur) {
      const f = /file\s+"([^"]+)";$/.exec(text);
      if (f) cur.db = f[1]!;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 解析 db 文件：`<host> [IN] A <ip>`；host '@' = zone 顶点。空 host 取 '@'。 */
export function parseDbFile(content: string, apex: string): Record<string, string> {
  const records: Record<string, string> = {};
  for (const { n, text } of codeLines(content)) {
    const m = /^(\S+)\s+(?:IN\s+)?A\s+(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (!m) {
      const skip = text.startsWith('$ORIGIN') || text.startsWith('@') || text.startsWith(';') || text.startsWith('$TTL');
      if (!skip) throw configError(n, `无法识别的资源记录："${text}"`);
      continue;
    }
    const host = m[1] === '@' ? apex : m[1]!;
    const ip = m[2]!;
    if (!validIp(ip)) throw configError(n, `非法 IP "${ip}"`);
    const fqdn = host.endsWith(apex) ? host : `${host}.${apex}`;
    records[fqdn] = ip;
  }
  return records;
}

// ———————————————————— apache2 vhost ————————————————————

export interface ApacheConf {
  documentRoot: string;
  vhosts: string[];
}

/** 解析 `<VirtualHost *:80>` 块内 ServerName / DocumentRoot（首个 ServerName 作 vhost）。 */
export function parseApacheVhost(content: string): ApacheConf {
  const conf: ApacheConf = { documentRoot: '/var/www/html', vhosts: [] };
  const lines = codeLines(content);
  let inVhost = false;
  for (const { n, text } of lines) {
    if (text.startsWith('<VirtualHost')) {
      inVhost = true;
      continue;
    }
    if (text.startsWith('</VirtualHost>')) {
      inVhost = false;
      continue;
    }
    if (!inVhost) continue;
    const sn = /^ServerName\s+(\S+)$/.exec(text);
    if (sn) {
      conf.vhosts.push(sn[1]!);
      continue;
    }
    const dr = /^DocumentRoot\s+(\S+)$/.exec(text);
    if (dr) {
      conf.documentRoot = dr[1]!;
      continue;
    }
    const any = text;
    if (/^<.*>$/.test(any)) continue;
    void n;
  }
  if (conf.vhosts.length === 0) throw new Error('配置错误：未找到 ServerName（缺少 VirtualHost 块？）');
  return conf;
}

// ———————————————————— 校验小工具（跨解析器复用） ————————————————————

export function isValidIpv4(ip: string): boolean {
  return validIp(ip);
}
export function isValidCidr4(c: string): boolean {
  return validCidr(c);
}

/** 解析 CIDR（复用 ipam 语义的薄封装；供 parser 校验）。 */
export function parseCidr4(c: Cidr): { network: string; netmask: string; prefix: number } {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c);
  if (!m) throw new Error(`配置错误：非法 CIDR "${c}"`);
  const prefix = Number(m[2]);
  const netmask = intToDotted((~0 << (32 - prefix)) >>> 0);
  return { network: m[1]!, netmask, prefix };
}

function intToDotted(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
