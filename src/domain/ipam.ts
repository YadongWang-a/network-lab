/**
 * IPAM（WF-6）：子网池管理 + 地址分配 + 冲突检测。
 *
 * 设计约定：
 * - 纯函数模块，不依赖 store/React（可直接单测，对齐 WF-12）。
 * - 不持久化分配状态：「已占用」集合由调用方从拓扑扫描得到（设备接口上的 ip 即占用），
 *   本模块只负责在给定占用集下找空闲地址。天然支持 WF-13 存档，无需额外序列化。
 * - 子网惯例：网关取「首个主机地址」（.1），路由器该网段接口即此地址；终端设备从 .2 起分配；
 *   DHCP 服务默认范围 .100–.254（静态/手动地址留在 .2–.99，见 deviceFactory）。
 * - 冲突检测：分配时跳过 `used` 集合中的 IP（含用户手动设置的地址），耗尽返回 null，由调用方报错。
 */
import type { Cidr, IPv4, MacAddress } from './types';

// —— 基础 IP 运算（移植自 legacy lib/network_lib.js，纯计算）——

/** 点分十进制 → uint32。 */
export function ipToInt(ip: IPv4): number {
  if (!isValidIp(ip)) throw new Error(`无效的 IP 地址：${ip}`);
  return ip.split('.').reduce((acc, oct) => (acc * 256 + Number(oct)) >>> 0, 0);
}

/** uint32 → 点分十进制。 */
export function intToIp(n: number): IPv4 {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 是否合法点分 IPv4（4 段、每段 0–255）。 */
export function isValidIp(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((oct) => {
    if (!/^\d{1,3}$/.test(oct)) return false;
    const n = Number(oct);
    return n >= 0 && n <= 255;
  });
}

/** 是否合法 CIDR（点分 IP + 0–32 前缀）。 */
export function isValidCidr(cidr: string): boolean {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return false;
  if (!isValidIp(m[1])) return false;
  const prefix = Number(m[2]);
  return prefix >= 0 && prefix <= 32;
}

/** CIDR 解析 → 网络地址 + 点分掩码 + 前缀长度。 */
export function parseCidr(cidr: Cidr): { network: IPv4; netmask: IPv4; prefix: number } {
  if (!isValidCidr(cidr)) throw new Error(`无效的 CIDR：${cidr}`);
  const [ip, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  return { network: ip as IPv4, netmask: cidrToNetmask(prefix), prefix };
}

/** 前缀长度 → 点分掩码。 */
export function cidrToNetmask(prefix: number): IPv4 {
  if (prefix < 0 || prefix > 32) throw new Error(`无效的 CIDR 前缀：${prefix}`);
  return intToIp(prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0);
}

/** 点分掩码 → 前缀长度（前导 1 个数，不校验连续性，同 legacy）。 */
export function netmaskToCidr(netmask: IPv4): number {
  if (!isValidIp(netmask)) throw new Error(`无效的子网掩码：${netmask}`);
  const bin = ipToInt(netmask).toString(2).padStart(32, '0');
  const firstZero = bin.indexOf('0');
  return firstZero === -1 ? 32 : firstZero;
}

/** 网络地址（IP & 掩码）。 */
export function networkOf(ip: IPv4, netmask: IPv4): IPv4 {
  if (!isValidIp(ip)) throw new Error(`无效的 IP 地址：${ip}`);
  if (!isValidIp(netmask)) throw new Error(`无效的子网掩码：${netmask}`);
  return intToIp(ipToInt(ip) & ipToInt(netmask));
}

/** 广播地址（IP | ~掩码）。 */
export function broadcastOf(ip: IPv4, netmask: IPv4): IPv4 {
  if (!isValidIp(ip)) throw new Error(`无效的 IP 地址：${ip}`);
  if (!isValidIp(netmask)) throw new Error(`无效的子网掩码：${netmask}`);
  return intToIp((ipToInt(ip) | ~ipToInt(netmask)) >>> 0);
}

/** 随机 48 位单播 MAC（小写冒号分隔，同 legacy getRandomMac）。 */
export function randomMac(): MacAddress {
  const bytes: string[] = [];
  for (let i = 0; i < 6; i++) {
    bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  }
  return bytes.join(':');
}

// —— 子网信息 ——

export interface SubnetInfo {
  cidr: Cidr;
  network: IPv4;
  netmask: IPv4;
  prefix: number;
  /** 首个主机地址（网络地址 +1）。 */
  firstHost: IPv4;
  /** 末个主机地址（广播地址 -1）。 */
  lastHost: IPv4;
  /** 网关约定：本子网首个主机地址（路由器该网段接口 IP，惯例 .1）。 */
  gateway: IPv4;
}

export function subnetInfo(cidr: Cidr): SubnetInfo {
  const { network, netmask, prefix } = parseCidr(cidr);
  const networkInt = ipToInt(network);
  const broadcastInt = (networkInt | ~ipToInt(netmask)) >>> 0;
  return {
    cidr,
    network,
    netmask,
    prefix,
    firstHost: intToIp(networkInt + 1),
    lastHost: intToIp(broadcastInt - 1),
    gateway: intToIp(networkInt + 1),
  };
}

// —— 分配 ——

/** 一次地址分配的结果。 */
export interface SubnetAllocation {
  ip: IPv4;
  netmask: IPv4;
  /** 终端设备 = 所在子网网关（.1）；路由器接口 = null（自身即网关）。 */
  gateway: IPv4 | null;
  /** 所在子网（DHCP 服务范围等扩展需要）。 */
  subnet: SubnetInfo;
}

/** 默认子网池（路由器三接口对应的三个网段，沿 legacy setRouterIps 惯例）。 */
export const DEFAULT_SUBNETS: Cidr[] = ['192.168.1.0/24', '10.0.0.0/24', '172.16.0.0/24'];

export class SubnetPool {
  constructor(private readonly subnets: Cidr[]) {}

  /** 在 [from .. lastHost] 内找第一个不在 used 中的主机地址；无 → null。 */
  private scan(info: SubnetInfo, used: ReadonlySet<IPv4>, from: number): IPv4 | null {
    for (let n = from; n <= ipToInt(info.lastHost); n++) {
      const ip = intToIp(n);
      if (!used.has(ip)) return ip;
    }
    return null;
  }

  /**
   * 终端设备分配：按池顺序取第一个有空位的子网，从网关 +1（.2）起分配（.1 预留给路由器）。
   * 全部耗尽 → null（调用方报错）。
   */
  allocateEndDevice(used: ReadonlySet<IPv4>): SubnetAllocation | null {
    for (const cidr of this.subnets) {
      const info = subnetInfo(cidr);
      const ip = this.scan(info, used, ipToInt(info.gateway) + 1);
      if (ip) return { ip, netmask: info.netmask, gateway: info.gateway, subnet: info };
    }
    return null;
  }

  /**
   * 路由器第 i 个接口分配：取第 i 个子网的网关（.1）；已被占用则顺延到下一空闲主机。
   * 池中没有第 i 个子网 → null（该接口保持未配置）。
   */
  allocateRouterInterface(index: number, used: ReadonlySet<IPv4>): SubnetAllocation | null {
    if (index < 0 || index >= this.subnets.length) return null;
    const info = subnetInfo(this.subnets[index]);
    const ip = this.scan(info, used, ipToInt(info.gateway));
    if (!ip) return null;
    return { ip, netmask: info.netmask, gateway: null, subnet: info };
  }
}
