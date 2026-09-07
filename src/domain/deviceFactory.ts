/**
 * 设备工厂（WF-6）：按设备类型构造完整 Device —— 默认接口、随机 MAC、自动 IP/掩码/网关。
 * 自动配置接入点：store.addDevice 与原型拖放共用本工厂，保证两处分配语义一致。
 * 手动覆盖：分配只发生在创建时；之后通过 store.updateDevice / updateInterface 修改即可，
 * 后续分配会扫描当前拓扑，自动跳过已手动设置的地址（冲突检测）。
 */
import type {
  Cidr,
  Device,
  DeviceId,
  DeviceKind,
  DhcpdConfig,
  FilesystemNode,
  IPv4,
  NetworkInterface,
  Vec2,
} from './types';
import { SubnetPool, ipToInt, intToIp, randomMac, type SubnetAllocation } from './ipam';

/** 各设备类型的默认接口（沿 legacy network_elements/*.js）。 */
export const KIND_INTERFACES: Record<DeviceKind, readonly string[]> = {
  pc: ['enp0s3'],
  router: ['enp0s3', 'enp0s8', 'enp0s9'],
  switch: ['enp0s3'],
  'dns-server': ['enp0s3'],
  'dhcp-server': ['enp0s3'],
  'dhcp-relay-agent': ['enp0s3'],
};

/** 设备类型 → 默认标签前缀（store 生成 PC-0 / Router-1 这类名称）。 */
export const KIND_LABEL: Record<DeviceKind, string> = {
  pc: 'PC',
  router: 'Router',
  switch: 'Switch',
  'dns-server': 'DNS',
  'dhcp-server': 'DHCP',
  'dhcp-relay-agent': 'DHCPRelay',
};

/** 基础虚拟文件系统（沿 legacy，WF-10 解析器将读写 /etc 下文件）。 */
const BASE_FILESYSTEM: FilesystemNode = {
  '/': {
    bin: {},
    boot: {},
    dev: {},
    etc: {
      hosts: '127.0.0.1 localhost',
      'resolv.conf': '',
      network: { interfaces: '' },
    },
    home: {},
    var: {},
  },
};

export interface CreateDeviceOptions {
  id: DeviceId;
  label: string;
  position: Vec2;
  /** 已占用 IP（调用方从拓扑扫描得到）；分配时跳过（冲突检测）。 */
  usedIps: ReadonlySet<IPv4>;
  /** 子网池（来自 store config.subnetPool）。 */
  subnets: Cidr[];
}

/**
 * DHCP 服务默认范围：从子网首地址（.1）起 +99 → .100 到子网末位，
 * 静态/手动地址留在 .2–.99；子网过小（+99 越界）时收敛到末位，退化为单地址范围。
 */
function defaultDhcpPool(a: SubnetAllocation, listenInterface: string): DhcpdConfig {
  const gateway = a.gateway ?? a.ip;
  const startInt = Math.min(ipToInt(gateway) + 99, ipToInt(a.subnet.lastHost));
  return {
    rangeStart: intToIp(startInt),
    rangeEnd: a.subnet.lastHost,
    leaseTime: 3600,
    gateway,
    dns: gateway,
    listenInterfaces: [listenInterface],
  };
}

export function createDevice(kind: DeviceKind, opts: CreateDeviceOptions): Device {
  const pool = new SubnetPool(opts.subnets);
  const used = new Set(opts.usedIps);
  const interfaces: Record<string, NetworkInterface> = {};
  let dhcpAllocation: SubnetAllocation | null = null;

  for (const [index, name] of KIND_INTERFACES[kind].entries()) {
    const iface: NetworkInterface = {
      id: name,
      name,
      mac: randomMac(),
      ip: null,
      netmask: null,
      gateway: null,
      connectedSwitchId: null,
    };
    if (kind === 'switch') {
      // L2 设备：只分配 MAC，不占 IP。
    } else if (kind === 'router') {
      const a = pool.allocateRouterInterface(index, used);
      if (a) {
        iface.ip = a.ip;
        iface.netmask = a.netmask;
        used.add(a.ip);
      }
    } else {
      const a = pool.allocateEndDevice(used);
      if (!a) {
        throw new Error(
          `IP 地址池已耗尽，无法为 ${opts.label} 分配地址。请在全局配置中添加子网，或先删除部分设备释放地址。`,
        );
      }
      iface.ip = a.ip;
      iface.netmask = a.netmask;
      iface.gateway = a.gateway;
      used.add(a.ip);
      dhcpAllocation = a;
    }
    interfaces[name] = iface;
  }

  return {
    id: opts.id,
    kind,
    label: opts.label,
    position: opts.position,
    interfaces,
    arpTable: [],
    dnsCache: [],
    routingTable: [],
    macTable: [],
    firewall: {
      defaultPolicy: { INPUT: 'ACCEPT', OUTPUT: 'ACCEPT', FORWARD: 'ACCEPT' },
      rules: [],
    },
    // 域 kind 自带服务：dns-server 预置 named（bind9）与示例 zone（离线环境演示查询/应答，
    // 无该域名的查询返回 NXDOMAIN；递归/公网解析不在仿真范围）。
    services:
      kind === 'dns-server'
        ? { named: { enabled: true, config: { zones: { 'www.example.com': '93.184.216.34' } } } }
        : {},
    ipv4Forwarding: kind === 'router',
    resolvedEnabled: kind !== 'switch',
    filesystem: JSON.parse(JSON.stringify(BASE_FILESYSTEM)) as FilesystemNode,
    dhcpPool:
      kind === 'dhcp-server' && dhcpAllocation
        ? defaultDhcpPool(dhcpAllocation, KIND_INTERFACES[kind][0])
        : undefined,
  };
}
