import { create } from 'zustand';
import type {
  Device,
  DeviceId,
  DeviceKind,
  InterfaceId,
  IPv4,
  NetworkInterface,
  Packet,
  Topology,
  Vec2,
} from '@/domain/types';
import { DEFAULT_SUBNETS, isValidCidr, SubnetPool } from '@/domain/ipam';
import type { Cidr, Connection } from '@/domain/types';
import { createDevice, KIND_LABEL, syncRouterPorts } from '@/domain/deviceFactory';
import { computeRouterRoutingTables } from '@/domain/routing';

// 切片结构（WF-2 归一化 + WF-3 事件可视化）：
// - devices：拓扑与全部设备状态（引擎读写、UI 订阅）
// - visualization：动画开关/速度/暂停/报文轨迹
// - ui：暗色模式等界面态
// - config：全局配置（子网池等，WF-6 落地）
// 注意：引擎的 ephemeral 态（pending Map、计时器句柄）不进 store，见 engine/。

/** 设备 id / 默认标签的单调序号（WF-13 存档加载时再处理 id 冲突）。 */
let deviceSeq = 0;
/** 连线 id 的单调序号（store 生命周期内唯一即可）。 */
let connSeq = 0;

/**
 * 拓扑变更后重算全部路由器路由表并写回（WF-7）。纯计算失败/无变化时返回原对象，
 * 便于调用方原样合并。所有拓扑动作（设备增删、连线变化、IP/掩码变更）都经此收口。
 */
function applyRouting(topology: Topology): Topology {
  const tables = computeRouterRoutingTables(topology);
  let devices = topology.devices;
  for (const [id, rows] of Object.entries(tables)) {
    const dev = devices[id];
    if (!dev || !dev.ipv4Forwarding) continue;
    devices = { ...devices, [id]: { ...dev, routingTable: rows } };
  }
  return devices === topology.devices ? topology : { ...topology, devices };
}

/**
 * 冲突检测口径（WF-6）：已占用 = 拓扑中全部接口的 IP（含手动设置的）。
 * `excludeDeviceId` 供「重分配自身地址」的设备使用（自身旧地址不算占用）。
 */
function usedIpsIn(topology: Topology, excludeDeviceId?: DeviceId): Set<IPv4> {
  const used = new Set<IPv4>();
  for (const d of Object.values(topology.devices)) {
    if (d.id === excludeDeviceId) continue;
    for (const iface of Object.values(d.interfaces)) {
      if (iface.ip) used.add(iface.ip);
    }
  }
  return used;
}

export interface DevicesSlice {
  topology: Topology;
  /**
   * 添加设备并自动配置（WF-6）：按类型生成默认接口、随机 MAC，并从子网池
   * 自动分配 IP/掩码/网关（路由器每个接口占一个子网的网关，终端设备从 .2 起）。
   * 池耗尽时抛出中文错误。返回新设备 id。
   */
  addDevice: (
    kind: DeviceKind,
    opts?: { label?: string; position?: Vec2 },
  ) => DeviceId;
  removeDevice: (id: DeviceId) => void;
  updateDevice: (id: DeviceId, patch: Partial<Device>) => void;
  /** 手动覆盖：直接改单个接口的 ip/netmask/gateway/mac 等（自动分配后仍可改）。 */
  updateInterface: (
    deviceId: DeviceId,
    interfaceId: InterfaceId,
    patch: Partial<NetworkInterface>,
  ) => void;
  /**
   * PC DHCP 客户端开关（WF-23）：开 = 清空接口静态 IP/掩码/网关，标记 services.dhclient，
   * 地址改由 DORA 租约下发（引擎「无 IP 才绑定」语义不变）；关 = 重新走 IPAM 分配
   * 静态地址（扫描当前拓扑占用）。池耗尽抛中文错误。随即重算路由。
   */
  setDhcpClient: (deviceId: DeviceId, enabled: boolean) => void;
  /**
   * 拉线：设备接口 → 交换机端口（WF-7）。写 topology.connections + 接口
   * connectedSwitchId，随即重算路由。对端必须是交换机；接口已连线则抛中文错误。
   */
  addConnection: (
    deviceId: DeviceId,
    interfaceId: InterfaceId,
    switchId: DeviceId,
  ) => void;
  /** 断线：按 (设备, 接口) 移除对应连线并清 connectedSwitchId，随即重算路由。幂等。 */
  removeConnection: (deviceId: DeviceId, interfaceId: InterfaceId) => void;
}

export interface VisualizationSlice {
  visualToggle: boolean;
  visualSpeed: number;
  paused: boolean;
  traffic: Packet[];
  setVisualToggle: (v: boolean) => void;
  setPaused: (v: boolean) => void;
  pushTraffic: (p: Packet) => void;
}

export interface UiSlice {
  darkMode: boolean;
  setDarkMode: (v: boolean) => void;
}

/** 子网地址池配置（WF-6）：分配按池顺序取子网，路由器逐接口取用，终端设备取第一个有空位的。 */
export interface SubnetPoolConfig {
  subnets: Cidr[];
}

export interface ConfigSlice {
  config: { subnetPool: SubnetPoolConfig };
  setSubnets: (subnets: Cidr[]) => void;
  addSubnet: (cidr: Cidr) => void;
}

export type StoreState = DevicesSlice & VisualizationSlice & UiSlice & ConfigSlice;

export const useStore = create<StoreState>((set) => ({
  // —— devices 切片 ——
  topology: { devices: {}, connections: [] },
  addDevice: (kind, opts) => {
    const id = `${kind}-${deviceSeq}`;
    const label = opts?.label ?? `${KIND_LABEL[kind]}-${deviceSeq}`;
    deviceSeq += 1;
    set((s) => {
      const device = createDevice(kind, {
        id,
        label,
        position: opts?.position ?? { x: 0, y: 0 },
        usedIps: usedIpsIn(s.topology),
        subnets: s.config.subnetPool.subnets,
      });
      // WF-7：新设备尚无连线，路由表不变（返回原对象），统一走 applyRouting 收口。
      return {
        topology: applyRouting({
          ...s.topology,
          devices: { ...s.topology.devices, [id]: device },
        }),
      };
    });
    return id;
  },
  removeDevice: (id) =>
    set((s) => {
      const devices = { ...s.topology.devices };
      delete devices[id];
      // 残留接线清理：删除指向被删设备（作为连线对端交换机）或由其发出的连线，
      // 并清空幸存设备接口上指向被删交换机的 connectedSwitchId。
      const connections = s.topology.connections.filter(
        (c) => c.fromDeviceId !== id && c.toSwitchId !== id,
      );
      // WF-25：被删交换机释放端口 → 路由器回收多余空口（与断线同口径）。
      const used = usedIpsIn({ devices, connections });
      const pool = new SubnetPool(s.config.subnetPool.subnets);
      for (const devId of Object.keys(devices)) {
        const d = devices[devId];
        let interfaces = d.interfaces;
        let touched = false;
        for (const ifaceId of Object.keys(d.interfaces)) {
          const iface = d.interfaces[ifaceId];
          if (iface.connectedSwitchId === id) {
            interfaces = { ...interfaces, [ifaceId]: { ...iface, connectedSwitchId: null } };
            touched = true;
          }
        }
        if (!touched) continue;
        const dev: Device = { ...d, interfaces };
        devices[devId] = { ...dev, interfaces: syncRouterPorts(dev, pool, used) ?? interfaces };
      }
      // WF-7：路由重算 —— 删路由器后其远端条目与途经它的 next-hop 一并消失。
      return { topology: applyRouting({ devices, connections }) };
    }),
  updateDevice: (id, patch) =>
    set((s) => {
      const dev = s.topology.devices[id];
      if (!dev) return {};
      const next = { ...s.topology, devices: { ...s.topology.devices, [id]: { ...dev, ...patch } } };
      // 只在与路由相关的键变化时才重算（位置/标签等高频更新不触发）。
      if ('interfaces' in patch || 'ipv4Forwarding' in patch) {
        return { topology: applyRouting(next) };
      }
      return { topology: next };
    }),
  updateInterface: (deviceId, interfaceId, patch) =>
    set((s) => {
      const dev = s.topology.devices[deviceId];
      if (!dev || !dev.interfaces[interfaceId]) return {};
      // WF-7：IP/掩码变更改变网段归属，需重算路由。
      return {
        topology: applyRouting({
          ...s.topology,
          devices: {
            ...s.topology.devices,
            [deviceId]: {
              ...dev,
              interfaces: {
                ...dev.interfaces,
                [interfaceId]: { ...dev.interfaces[interfaceId], ...patch },
              },
            },
          },
        }),
      };
    }),
  setDhcpClient: (deviceId, enabled) =>
    set((s) => {
      const dev = s.topology.devices[deviceId];
      if (!dev || dev.kind !== 'pc') return {};
      const used = usedIpsIn(s.topology, deviceId);
      const pool = new SubnetPool(s.config.subnetPool.subnets);
      const interfaces: Record<string, NetworkInterface> = {};
      for (const [ifaceId, iface] of Object.entries(dev.interfaces)) {
        if (!enabled) {
          const a = pool.allocateEndDevice(used);
          if (!a) {
            throw new Error(
              'IP 地址池已耗尽，无法为该设备分配静态地址。请在全局配置中添加子网，或先释放部分地址。',
            );
          }
          used.add(a.ip);
          interfaces[ifaceId] = { ...iface, ip: a.ip, netmask: a.netmask, gateway: a.gateway };
        } else {
          interfaces[ifaceId] = { ...iface, ip: null, netmask: null, gateway: null };
        }
      }
      return {
        topology: applyRouting({
          ...s.topology,
          devices: {
            ...s.topology.devices,
            [deviceId]: {
              ...dev,
              interfaces,
              services: { ...dev.services, dhclient: { enabled, config: {} } },
            },
          },
        }),
      };
    }),
  addConnection: (deviceId, interfaceId, switchId) =>
    set((s) => {
      const dev = s.topology.devices[deviceId];
      if (!dev) throw new Error(`设备不存在：${deviceId}`);
      const iface = dev.interfaces[interfaceId];
      if (!iface) throw new Error(`接口不存在：${deviceId}.${interfaceId}`);
      const sw = s.topology.devices[switchId];
      if (!sw || sw.kind !== 'switch') throw new Error(`线缆只能连接到交换机：${switchId}`);
      if (
        iface.connectedSwitchId ||
        s.topology.connections.some((c) => c.fromDeviceId === deviceId && c.fromInterfaceId === interfaceId)
      ) {
        throw new Error(`接口 ${deviceId}.${interfaceId} 已连接，请先断开`);
      }
      // 交换机端口号取现有最大 +1（引擎 MAC 表端口引用）。
      const toPort =
        s.topology.connections.reduce(
          (max, c) => (c.toSwitchId === switchId ? Math.max(max, c.toPort) : max),
          0,
        ) + 1;
      const connection: Connection = {
        id: `conn-${connSeq}`,
        fromDeviceId: deviceId,
        fromInterfaceId: interfaceId,
        toSwitchId: switchId,
        toPort,
      };
      connSeq += 1;
      // WF-25：路由器端口随连线数浮动 —— 连线占掉最后一个空口时自动追加新口。
      const connected: Device = {
        ...dev,
        interfaces: { ...dev.interfaces, [interfaceId]: { ...iface, connectedSwitchId: switchId } },
      };
      const grown = syncRouterPorts(
        connected,
        new SubnetPool(s.config.subnetPool.subnets),
        usedIpsIn(s.topology),
      );
      // WF-7：新网段/新桥出现 → 重算路由。
      return {
        topology: applyRouting({
          ...s.topology,
          devices: {
            ...s.topology.devices,
            [deviceId]: { ...connected, interfaces: grown ?? connected.interfaces },
          },
          connections: [...s.topology.connections, connection],
        }),
      };
    }),
  removeConnection: (deviceId, interfaceId) =>
    set((s) => {
      const dev = s.topology.devices[deviceId];
      if (!dev || !dev.interfaces[interfaceId]) return {}; // 幂等
      const iface = dev.interfaces[interfaceId];
      if (!iface.connectedSwitchId) return {}; // 未连线
      // WF-25：断开释放端口 → 路由器回收尾部未配置的空口。
      const opened: Device = {
        ...dev,
        interfaces: { ...dev.interfaces, [interfaceId]: { ...iface, connectedSwitchId: null } },
      };
      const shrunk = syncRouterPorts(
        opened,
        new SubnetPool(s.config.subnetPool.subnets),
        usedIpsIn(s.topology),
      );
      // WF-7：断线 → 该接口退出网段图 → 重算路由。
      return {
        topology: applyRouting({
          ...s.topology,
          devices: {
            ...s.topology.devices,
            [deviceId]: { ...opened, interfaces: shrunk ?? opened.interfaces },
          },
          connections: s.topology.connections.filter(
            (c) => !(c.fromDeviceId === deviceId && c.fromInterfaceId === interfaceId),
          ),
        }),
      };
    }),

  // —— visualization 切片 ——
  visualToggle: false,
  visualSpeed: 300,
  paused: false,
  traffic: [],
  setVisualToggle: (v) => set({ visualToggle: v }),
  setPaused: (v) => set({ paused: v }),
  pushTraffic: (p) => set((s) => ({ traffic: [...s.traffic, p].slice(-500) })),

  // —— ui 切片 ——
  darkMode: false,
  setDarkMode: (v) => set({ darkMode: v }),

  // —— config 切片（WF-6 子网池）——
  config: { subnetPool: { subnets: DEFAULT_SUBNETS } },
  setSubnets: (subnets) =>
    set((s) => ({ config: { ...s.config, subnetPool: { subnets } } })),
  addSubnet: (cidr) =>
    set((s) => {
      if (!isValidCidr(cidr)) throw new Error(`无效的子网 CIDR：${cidr}`);
      if (s.config.subnetPool.subnets.includes(cidr)) {
        throw new Error(`子网已在池中：${cidr}`);
      }
      return {
        config: {
          ...s.config,
          subnetPool: { subnets: [...s.config.subnetPool.subnets, cidr] },
        },
      };
    }),
}));
