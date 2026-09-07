/**
 * 终端命令注册表（WF-11）：命令表 + 执行器，替代 legacy `commandFunctions` 硬编码。
 * 每个命令通过 TermCtx 访问：store（useStore.getState 直读/写回）、引擎驱动、
 * 行输出（实时流式）、cwd。命令全部「真跑」：文件系统命令落在设备虚拟 FS，
 * ping/traceroute/dig/arpscan/dhclient 由真实 SimulationEngine 驱动并流式输出，
 * systemctl 重读守护进程配置文件（解析器 src/parsers/config.ts）落 store。
 */

import type { Device, DeviceId, DhcpdConfig, FilesystemNode as FsNode, IPv4, MacAddress, ServiceName } from '@/domain/types';
import { useStore } from '@/state/store';
import { SimulationEngine, type SimEvent } from '@/engine/SimulationEngine';
import {
  dirExists,
  fsAppend,
  fsLs,
  fsMkdir,
  fsMoveCopy,
  fsRead,
  fsRm,
  fsTouch,
  fsWrite,
  resolveSegments,
} from '@/domain/filesystem';
import { intToIp, ipToInt, netmaskToCidr, networkOf } from '@/domain/ipam';
import {
  parseApacheVhost,
  parseDbFile,
  parseDhcpdConf,
  parseNamedConfLocal,
  parseNetworkInterfaces,
} from '@/parsers/config';

export interface TermCtx {
  deviceId: DeviceId;
  /** 追加一行输出（可为多行文本，原样显示）。 */
  print(text: string): void;
  engine: SimulationEngine;
  cwd(): string[];
  setCwd(segs: string[]): void;
  setBusy(b: boolean): void;
  close(): void;
}

type CmdHandler = (ctx: TermCtx, argv: string[], raw: string) => Promise<void>;

/** store 侧设备文件树读写（每命令读最新快照）。 */
function devOf(deviceId: DeviceId): Device | undefined {
  return useStore.getState().topology.devices[deviceId];
}

function fsOf(deviceId: DeviceId): FsNode {
  const d = devOf(deviceId);
  return (d?.filesystem ?? {}) as FsNode;
}

function patchFs(deviceId: DeviceId, next: FsNode): void {
  useStore.getState().updateDevice(deviceId, { filesystem: next });
}

/** 主接口信息（终端常用）。 */
function primaryIface(d: Device): { name: string; mac: MacAddress; ip: IPv4 | null; netmask: IPv4 | null; gateway: IPv4 | null } | null {
  const f = Object.values(d.interfaces)[0];
  if (!f) return null;
  return { name: f.name, mac: f.mac, ip: f.ip, netmask: f.netmask, gateway: f.gateway };
}

function noDevice(ctx: TermCtx): boolean {
  if (!devOf(ctx.deviceId)) {
    ctx.print('终端：设备不存在（已删除）');
    return true;
  }
  return false;
}

function cfgPath(unit: string): string | null {
  switch (unit) {
    case 'isc-dhcp-server':
      return '/etc/dhcp/dhcpd.conf';
    case 'bind9':
      return '/etc/bind/named.conf.local';
    case 'apache2':
      return '/etc/apache2/sites-available/000-default.conf';
    default:
      return null;
  }
}

// ———————————————————— 引擎驱动（流式输出） ————————————————————

export async function driveEngine(
  ctx: TermCtx,
  run: (engine: SimulationEngine) => Promise<void>,
  onEvent: (ev: SimEvent) => void,
): Promise<void> {
  const engine = ctx.engine;
  const p = run(engine);
  let guard = 0;
  for (;;) {
    const ev = engine.step();
    if (ev) {
      // 逐事件回调：同报文多跳各自到达（洪泛拷贝、定向末跳由各命令按 to=本机过滤）
      onEvent(ev);
    } else if (engine.isIdle()) {
      await new Promise((r) => setTimeout(r, 20)); // 让驱动续延/收尾 notice 入队
      if (engine.isIdle()) break;
      continue;
    } else {
      await new Promise((r) => setTimeout(r, 14));
    }
    if (guard++ > 4000) break;
  }
  await p;
}

// ———————————————————— 命令实现 ————————————————————

const HELP_LINES = [
  '可用命令：',
  '  cd <dir> | pwd | ls [path] | cat <file> | echo <text>[>file]',
  '  mkdir <dir> | touch <file> | rm [-r] <path> | mv <src> <dst> | cp <src> <dst>',
  '  ip a | arp | arpscan | ping <ip> | traceroute <ip> | dig <域名>',
  '  systemctl <status|start|stop|restart> <unit>（isc-dhcp-server / isc-dhcp-client / bind9 / apache2）',
  '  clear | help | exit（↑/↓ 命令历史）',
].join('\n');

async function help(ctx: TermCtx): Promise<void> {
  ctx.print(HELP_LINES);
}

async function exitCmd(ctx: TermCtx): Promise<void> {
  ctx.close();
}

async function pwd(ctx: TermCtx): Promise<void> {
  ctx.print(`/${ctx.cwd().join('/')}`);
}

async function cd(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx)) return;
  const target = argv[1] ?? '/';
  const segs = resolveSegments(target, ctx.cwd());
  // 校验目录存在
  const fs = fsOf(ctx.deviceId);
  if (!dirExists(fs, segs)) {
    ctx.print(`cd: 目录不存在：${target}`);
    return;
  }
  ctx.setCwd(segs);
}

async function ls(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx)) return;
  try {
    ctx.print(fsLs(fsOf(ctx.deviceId), argv[1] ?? '.', ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

async function cat(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx)) return;
  if (!argv[1]) {
    ctx.print('cat: 缺少文件名');
    return;
  }
  try {
    ctx.print(fsRead(fsOf(ctx.deviceId), argv[1], ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

/** echo [text | "quoted"] [>|>> file] —— 无重定向打印文本，否则写/追加到文件。 */
async function echo(ctx: TermCtx, _argv: string[], raw: string): Promise<void> {
  const body = raw.slice(4).trim();
  if (!body) {
    ctx.print('');
    return;
  }
  const redir = /^(.*?)\s*(>>|>)\s+(\S+)\s*$/.exec(body);
  if (!redir) {
    ctx.print(stripQuotes(body));
    return;
  }
  if (noDevice(ctx)) return;
  const content = stripQuotes(redir[1]!.trim());
  const target = redir[3]!;
  try {
    const fs = fsOf(ctx.deviceId);
    const next = redir[2] === '>>' ? fsAppend(fs, target, `${content}\n`, ctx.cwd()) : fsWrite(fs, target, `${content}\n`, ctx.cwd());
    patchFs(ctx.deviceId, next);
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

async function mkdir(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx) || !argv[1]) return;
  try {
    patchFs(ctx.deviceId, fsMkdir(fsOf(ctx.deviceId), argv[1], ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

async function touch(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx) || !argv[1]) return;
  try {
    patchFs(ctx.deviceId, fsTouch(fsOf(ctx.deviceId), argv[1], ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

async function rm(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx)) return;
  const recursive = argv[1] === '-r';
  const target = argv[recursive ? 2 : 1];
  if (!target) {
    ctx.print('rm: 缺少参数');
    return;
  }
  try {
    patchFs(ctx.deviceId, fsRm(fsOf(ctx.deviceId), target, recursive, ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

async function mv(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx) || !argv[1] || !argv[2]) return;
  try {
    patchFs(ctx.deviceId, fsMoveCopy(fsOf(ctx.deviceId), argv[1], argv[2], false, ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

async function cp(ctx: TermCtx, argv: string[]): Promise<void> {
  if (noDevice(ctx) || !argv[1] || !argv[2]) return;
  try {
    patchFs(ctx.deviceId, fsMoveCopy(fsOf(ctx.deviceId), argv[1], argv[2], true, ctx.cwd()));
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

/** ip a / ip addr：设备接口地址（只读 store 真身）。 */
async function ipCmd(ctx: TermCtx): Promise<void> {
  const d = devOf(ctx.deviceId);
  if (!d) return;
  const lines: string[] = ['1: lo: <LOOPBACK,UP,LOWER_UP>', '    inet 127.0.0.1/8 scope host lo'];
  Object.values(d.interfaces).forEach((f, i) => {
    lines.push(`${i + 2}: ${f.name}: <BROADCAST,MULTICAST,UP> mtu 1500`, `    link/ether ${f.mac}`);
    if (f.ip && f.netmask) {
      const cidr = netmaskToCidr(f.netmask);
      const brd = intToIp((ipToInt(f.ip) | ~ipToInt(f.netmask)) >>> 0);
      lines.push(`    inet ${f.ip}/${cidr} brd ${brd} scope global ${f.name}`);
      if (f.gateway) lines.push(`    valid_lft forever preferred_lft forever (网关 ${f.gateway})`);
    } else {
      lines.push('    （未配置 IP）');
    }
  });
  ctx.print(lines.join('\n'));
}

/** arp：本机 ARP 表。 */
async function arp(ctx: TermCtx): Promise<void> {
  const d = devOf(ctx.deviceId);
  if (!d) return;
  const rows = d.arpTable.map((a) => `  ${a.ip}        ether   ${a.mac}`);
  ctx.print(rows.length ? `Address                  HWtype  HWaddress\n${rows.join('\n')}` : 'ARP 表为空（可执行 arpscan 扫描）');
}

/** arpscan：真实引擎对同广播域主机逐条探测。 */
async function arpscan(ctx: TermCtx): Promise<void> {
  const d = devOf(ctx.deviceId);
  if (!d) return;
  ctx.setBusy(true);
  try {
    let hits = 0;
    await driveEngine(
      ctx,
      (engine) => engine.arpScan(ctx.deviceId),
      (ev) => {
        if (ev.type === 'notice') {
          ctx.print(ev.message);
          return;
        }
        if (ev.type === 'hop') {
          const arpL = ev.packet.layers.find((l) => l.kind === 'arp');
          if (arpL?.kind === 'arp' && arpL.op === 'reply' && ev.to === ctx.deviceId) {
            hits += 1;
            ctx.print(`${arpL.senderIp} 位于 ${arpL.senderMac}`);
          }
        }
      },
    );
    ctx.print(`共发现 ${hits} 台主机在线`);
  } finally {
    ctx.setBusy(false);
  }
}

async function ping(ctx: TermCtx, argv: string[]): Promise<void> {
  const target = argv[1];
  const d = devOf(ctx.deviceId);
  if (!target) {
    ctx.print('ping: 用法 ping <ip>');
    return;
  }
  if (!d) return;
  ctx.setBusy(true);
  try {
    const myIp = primaryIface(d)?.ip;
    if (!myIp) {
      ctx.print('ping: 本机未配置 IP（先执行 ifconfig/DHCP）');
      return;
    }
    const srcStart = Date.now();
    let ok = 0;
    for (let probe = 1; probe <= 4; probe++) {
      let received = false;
      let ttl = 64;
      await driveEngine(
        ctx,
        (engine) => engine.ping(ctx.deviceId, target),
        (ev) => {
          if (ev.type === 'dropped' && !received) ctx.print(`ping: ${ev.reason}`);
          if (ev.type === 'hop') {
            const ipL = ev.packet.layers.find((l) => l.kind === 'ip');
            const icmp = ev.packet.layers.find((l) => l.kind === 'icmp');
            if (icmp?.kind === 'icmp' && ipL?.kind === 'ip' && icmp.type === 'echo-reply' && ev.to === ctx.deviceId) {
              received = true;
              ttl = ipL.ttl;
            }
          }
        },
      );
      if (received) {
        ok += 1;
        const ms = ((Date.now() - srcStart) / probe).toFixed(3);
        ctx.print(`64 bytes from ${target}: icmp_seq=${probe} ttl=${ttl} time=${ms} ms`);
      }
    }
    ctx.print('');
    ctx.print(`--- ${target} ping statistics ---`);
    ctx.print(`4 packets transmitted, ${ok} received, ${4 - ok} packet loss`);
  } finally {
    ctx.setBusy(false);
  }
}

async function traceroute(ctx: TermCtx, argv: string[]): Promise<void> {
  const target = argv[1];
  if (!target) {
    ctx.print('traceroute: 用法 traceroute <ip>');
    return;
  }
  ctx.setBusy(true);
  try {
    let hop = 0;
    let arrived = false;
    const start = Date.now();
    await driveEngine(
      ctx,
      (engine) => engine.traceroute(ctx.deviceId, target),
      (ev) => {
        if (ev.type !== 'hop') return;
        const ipL = ev.packet.layers.find((l) => l.kind === 'ip');
        const icmp = ev.packet.layers.find((l) => l.kind === 'icmp');
        if (icmp?.kind !== 'icmp' || ipL?.kind !== 'ip') return;
        if (ev.to !== ctx.deviceId) return;
        if (icmp.type === 'time-exceeded') {
          hop += 1;
          ctx.print(`${hop}  ${ipL.srcIp}  ${((Date.now() - start) / hop).toFixed(1)} ms`);
        } else if (icmp.type === 'echo-reply') {
          arrived = true;
          hop += 1;
          ctx.print(`${hop}  ${target}  ${((Date.now() - start) / hop).toFixed(1)} ms`);
        }
      },
    );
    ctx.print(arrived ? `到达 ${target}（共 ${hop} 跳）` : `traceroute: 无法到达 ${target}`);
  } finally {
    ctx.setBusy(false);
  }
}

/** dig <域名>：经拓扑中 named 服务器查询（真实引擎 DNS）。 */
async function dig(ctx: TermCtx, argv: string[]): Promise<void> {
  const name = argv[1];
  if (!name) {
    ctx.print('dig: 用法 dig <域名>');
    return;
  }
  const st = useStore.getState();
  const server = Object.values(st.topology.devices).find((d) => d.services?.named?.enabled);
  if (!server) {
    ctx.print('dig: 拓扑中没有运行 named 的 DNS 服务器');
    return;
  }
  ctx.setBusy(true);
  try {
    let answered = false;
    let nxdomain = false;
    await driveEngine(
      ctx,
      (engine) => engine.dnsQuery(ctx.deviceId, server.id, name),
      (ev) => {
        if (ev.type !== 'hop') return;
        const dns = ev.packet.layers.find((l) => l.kind === 'dns');
        if (dns?.kind !== 'dns' || dns.qr !== 'reply') return;
        if (answered || nxdomain) return;
        ctx.print(';; ANSWER SECTION:');
        if (dns.rc === 'NXDOMAIN' || !dns.answer) {
          nxdomain = true;
          ctx.print(`; ${name} — NXDOMAIN（无记录）`);
        } else {
          answered = true;
          ctx.print(`${name}.  60  IN  A  ${dns.answer}`);
        }
      },
    );
    if (!answered && !nxdomain) ctx.print('dig: 无应答');
  } finally {
    ctx.setBusy(false);
  }
}

/** unit（systemd 名）→ 域 ServiceName。 */
const UNIT_SERVICE: Record<string, ServiceName> = {
  'isc-dhcp-server': 'dhcpd',
  'isc-dhcp-client': 'dhclient',
  'isc-dhcp-relay': 'dhcrelay',
  bind9: 'named',
  apache2: 'apache2',
  iptables: 'iptables',
};

function serviceEnabled(d: Device, svc: ServiceName): boolean {
  if (svc === 'dhcpd') return Boolean(d.dhcpPool);
  return Boolean(d.services?.[svc]?.enabled);
}

function serviceSummary(d: Device, svc: ServiceName): string {
  if (svc === 'dhcpd') {
    const p = d.dhcpPool;
    return p ? `${p.rangeStart}–${p.rangeEnd}，租期 ${p.leaseTime}s${p.netmask ? `，掩码 ${p.netmask}` : ''}` : '未配置地址池';
  }
  const s = d.services?.[svc];
  if (!s) return '未安装';
  const cfg = s.config;
  if (svc === 'named' && cfg && typeof cfg === 'object' && 'zones' in cfg) {
    const zones = cfg.zones;
    if (zones && typeof zones === 'object') {
      return `zone：${Object.keys(zones).join(', ') || '（无）'}`;
    }
  }
  if (svc === 'apache2' && cfg && typeof cfg === 'object') {
    const root = 'documentRoot' in cfg && typeof cfg.documentRoot === 'string' ? cfg.documentRoot : '?';
    const hosts = 'vhosts' in cfg && Array.isArray(cfg.vhosts) ? cfg.vhosts.join(', ') : '';
    return `documentRoot ${root}${hosts ? `，vhosts：${hosts}` : ''}`;
  }
  return s.enabled ? '已启用' : '未启用';
}

async function systemctl(ctx: TermCtx, argv: string[]): Promise<void> {
  const [action, unit] = [argv[1], argv[2]];
  const svc = UNIT_SERVICE[unit ?? ''];
  if (!action || !unit) {
    ctx.print('systemctl: 用法 systemctl <status|start|stop|restart> <unit>');
    return;
  }
  const d = devOf(ctx.deviceId);
  if (!d) return;
  if (!svc) {
    ctx.print(`systemctl: Unit ${unit} 不存在（可用：isc-dhcp-server / isc-dhcp-client / bind9 / apache2）`);
    return;
  }
  if (action === 'status') {
    ctx.print(`● ${unit} — ${serviceEnabled(d, svc) ? 'active (running)' : 'inactive (dead)'}`);
    ctx.print(`  状态摘要：${serviceSummary(d, svc)}`);
    return;
  }
  if (action === 'stop') {
    if (svc === 'dhcpd') {
      const cur = devOf(ctx.deviceId);
      const services = { ...(cur?.services ?? {}) };
      services.dhcpd = { enabled: false, config: {} };
      useStore.getState().updateDevice(ctx.deviceId, { services, dhcpPool: undefined });
      ctx.print('dhcpd 已停止（地址池回收）');
      return;
    }
    const cur = devOf(ctx.deviceId);
    const services = { ...(cur?.services ?? {}) };
    if (!(svc in services)) {
      ctx.print(`systemctl: ${unit} 未安装`);
      return;
    }
    services[svc] = services[svc] ? { ...services[svc], enabled: false } : { enabled: false, config: {} };
    useStore.getState().updateDevice(ctx.deviceId, { services });
    ctx.print(`${unit} 已停止`);
    return;
  }
  if (action === 'start' || action === 'restart') {
    ctx.setBusy(true);
    try {
      await startUnit(ctx, unit, svc);
    } finally {
      ctx.setBusy(false);
    }
    return;
  }
  ctx.print(`systemctl: 未知动作 ${action}`);
}

/** 启动单元：dhclient 走引擎 DORA；dhcpd/named/apache2 有配置文件则解析落 store。 */
async function startUnit(ctx: TermCtx, unit: string, svc: ServiceName): Promise<void> {
  const d = devOf(ctx.deviceId);
  if (!d) return;
  if (svc === 'dhclient') {
    await startDhclient(ctx, d);
    return;
  }
  const file = cfgPath(unit);
  const raw = file ? readConfig(ctx, file) : null;
  if (raw !== null) {
    try {
      if (svc === 'dhcpd') {
        applyDhcpdConf(ctx, raw);
        ctx.print(`${unit} 已启动（配置文件生效）`);
        return;
      }
      if (svc === 'named') {
        applyNamedConf(ctx, raw);
        return;
      }
      if (svc === 'apache2') {
        applyApacheConf(ctx, raw);
        return;
      }
    } catch (e) {
      ctx.print((e as Error).message);
      return;
    }
  }
  // 无配置文件：已有启用态（拖放/默认安装）则沿用配置仅启用；否则明确提示
  if (svc === 'dhcpd' && d.dhcpPool) {
    ctx.print(`${unit} 已启动（沿用现有地址池）`);
    return;
  }
  const installed = d.services?.[svc];
  if (installed) {
    const cur = devOf(ctx.deviceId);
    const services = { ...(cur?.services ?? {}) };
    services[svc] = { ...installed, enabled: true };
    useStore.getState().updateDevice(ctx.deviceId, { services });
    ctx.print(`${unit} 已启动（沿用现有配置）`);
    return;
  }
  ctx.print(`systemctl: ${unit} 未安装且缺少配置文件 ${file ?? '?'}`);
  if (file) ctx.print(`提示：先用 echo 写入 ${file} 后再 start/restart（或先安装软件包）`);
}

async function startDhclient(ctx: TermCtx, d: Device): Promise<void> {
  const myIface = Object.values(d.interfaces).find((f) => f.connectedSwitchId);
  if (!myIface?.connectedSwitchId) {
    ctx.print('dhclient: 本机未接入交换机');
    return;
  }
  const server = Object.values(useStore.getState().topology.devices).find(
    (x) => x.dhcpPool && Object.values(x.interfaces).some((f) => f.connectedSwitchId === myIface.connectedSwitchId),
  );
  if (!server) {
    ctx.print('dhclient: 同网段没有运行的 DHCP 服务器');
    return;
  }
  const got = { offer: false, ack: false };
  await driveEngine(
    ctx,
    (engine) => engine.dhcpDora(ctx.deviceId, server.id),
    (ev) => {
      if (ev.type === 'notice') {
        ctx.print(ev.message);
        return;
      }
      if (ev.type !== 'hop') return;
      const dhcp = ev.packet.layers.find((l) => l.kind === 'dhcp');
      if (dhcp?.kind !== 'dhcp' || ev.to !== ctx.deviceId) return;
      if (dhcp.messageType === 'offer') {
        got.offer = true;
        ctx.print(`DHCPOFFER of ${dhcp.yiaddr ?? '?'} from ${server.label}`);
      } else if (dhcp.messageType === 'ack') {
        got.ack = true;
        ctx.print(`DHCPACK of ${dhcp.yiaddr ?? '?'} from ${server.label}`);
      }
    },
  );
  if (!got.offer && !got.ack) ctx.print('dhclient: 未收到 DHCP 应答');
}

function readConfig(ctx: TermCtx, file: string): string | null {
  const fs = fsOf(ctx.deviceId);
  try {
    return fsRead(fs, file, []);
  } catch {
    return null;
  }
}

function applyDhcpdConf(ctx: TermCtx, raw: string): void {
  const conf = parseDhcpdConf(raw);
  const d = devOf(ctx.deviceId)!;
  const iface = Object.values(d.interfaces).find((f) => f.ip && f.netmask && f.connectedSwitchId);
  const oldPool = d.dhcpPool;
  let subnetGw = '192.168.1.1';
  let ifaceMask: IPv4 | undefined;
  let ifaceName: string | undefined;
  if (iface && iface.ip && iface.netmask) {
    subnetGw = intToIp(ipToInt(networkOf(iface.ip, iface.netmask)) + 1);
    ifaceMask = iface.netmask;
    ifaceName = iface.name;
  }
  const pool: DhcpdConfig = {
    rangeStart: conf.rangeStart,
    rangeEnd: conf.rangeEnd,
    leaseTime: conf.leaseTime ?? oldPool?.leaseTime ?? 3600,
    gateway: conf.gateway ?? oldPool?.gateway ?? subnetGw,
    dns: conf.dns ?? oldPool?.dns ?? subnetGw,
    netmask: conf.netmask ?? oldPool?.netmask ?? ifaceMask ?? '255.255.255.0',
    listenInterfaces: oldPool?.listenInterfaces ?? (ifaceName ? [ifaceName] : []),
  };
  const services = { ...d.services };
  services.dhcpd = { enabled: true, config: pool };
  useStore.getState().updateDevice(ctx.deviceId, { services, dhcpPool: pool });
}

function applyNamedConf(ctx: TermCtx, raw: string): void {
  const zones: Record<string, IPv4> = {};
  for (const entry of parseNamedConfLocal(raw)) {
    const dbRaw = readConfig(ctx, entry.db);
    if (dbRaw === null) {
      ctx.print(`bind9: 无法读取 zone 文件 ${entry.db}`);
      return;
    }
    const records = parseDbFile(dbRaw, entry.zone);
    Object.assign(zones, records);
  }
  const d = devOf(ctx.deviceId)!;
  const services = { ...d.services };
  const prev = services.named ?? { enabled: true, config: { zones: {} } };
  const cfg = prev.config && typeof prev.config === 'object' && 'zones' in prev.config && typeof prev.config.zones === 'object' && prev.config.zones !== null
    ? { zones: { ...(prev.config.zones as Record<string, IPv4>), ...zones } }
    : { zones };
  services.named = { enabled: true, config: cfg };
  useStore.getState().updateDevice(ctx.deviceId, { services });
  ctx.print(`bind9 已加载 zone：${Object.keys(zones).join(', ') || '（空）'}`);
}

function applyApacheConf(ctx: TermCtx, raw: string): void {
  const conf = parseApacheVhost(raw);
  const d = devOf(ctx.deviceId)!;
  const services = { ...d.services };
  services.apache2 = { enabled: true, config: conf };
  useStore.getState().updateDevice(ctx.deviceId, { services });
  ctx.print(`apache2 已启动（ServerName：${conf.vhosts.join(', ')}，documentRoot ${conf.documentRoot}）`);
}

/** 接口配置（ifup 语义）：解析 /etc/network/interfaces 应用 static/dhcp。 */
async function interfacesUp(ctx: TermCtx, argv: string[]): Promise<void> {
  const raw = readConfig(ctx, '/etc/network/interfaces');
  if (raw === null) {
    ctx.print('ifup: 未找到 /etc/network/interfaces');
    return;
  }
  const d = devOf(ctx.deviceId);
  if (!d) return;
  const target = argv[1] ?? '-a';
  try {
    const parsed = parseNetworkInterfaces(raw, Object.keys(d.interfaces));
    for (const c of parsed) {
      if (target !== '-a' && target !== c.iface) continue;
      const f = d.interfaces[c.iface];
      if (!f) continue;
      if (c.mode === 'static') {
        useStore.getState().updateInterface(ctx.deviceId, f.id, {
          ip: c.address,
          netmask: c.netmask,
          gateway: c.gateway ?? f.gateway,
        });
        ctx.print(`${c.iface}: 已配置静态 ${c.address}/${c.netmask}`);
      } else {
        ctx.print(`${c.iface}: inet dhcp（请用 systemctl start isc-dhcp-client 获取地址）`);
      }
    }
  } catch (e) {
    ctx.print((e as Error).message);
  }
}

// ———————————————————— 注册表 ————————————————————

export const registry: Record<string, CmdHandler> = {
  help,
  '?': help,
  exit: exitCmd,
  pwd,
  cd,
  ls,
  cat,
  echo,
  mkdir,
  touch,
  rm,
  mv,
  cp,
  ip: ipCmd,
  arp,
  arpscan,
  ping,
  traceroute,
  dig,
  systemctl,
  ifup: interfacesUp,
};

/** 未知命令提示（Linux 风格，保留 cmd 名）。 */
export function unknownCommand(ctx: TermCtx, name: string): void {
  ctx.print(`bash: ${name}: 未找到命令（输入 help 查看可用命令）`);
}
