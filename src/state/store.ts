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
import { DEFAULT_SUBNETS, isValidCidr } from '@/domain/ipam';
import type { Cidr } from '@/domain/types';
import { createDevice, KIND_LABEL } from '@/domain/deviceFactory';

// 切片结构（WF-2 归一化 + WF-3 事件可视化）：
// - devices：拓扑与全部设备状态（引擎读写、UI 订阅）
// - visualization：动画开关/速度/暂停/报文轨迹
// - ui：暗色模式等界面态
// - config：全局配置（子网池等，WF-6 落地）
// 注意：引擎的 ephemeral 态（pending Map、计时器句柄）不进 store，见 engine/。

/** 设备 id / 默认标签的单调序号（WF-13 存档加载时再处理 id 冲突）。 */
let deviceSeq = 0;

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
      // 冲突检测：已占用 = 当前拓扑中所有接口的 IP（含手动设置的）。
      const used = new Set<IPv4>();
      for (const d of Object.values(s.topology.devices)) {
        for (const iface of Object.values(d.interfaces)) {
          if (iface.ip) used.add(iface.ip);
        }
      }
      const device = createDevice(kind, {
        id,
        label,
        position: opts?.position ?? { x: 0, y: 0 },
        usedIps: used,
        subnets: s.config.subnetPool.subnets,
      });
      return {
        topology: {
          ...s.topology,
          devices: { ...s.topology.devices, [id]: device },
        },
      };
    });
    return id;
  },
  removeDevice: (id) =>
    set((s) => {
      const devices = { ...s.topology.devices };
      delete devices[id];
      return { topology: { ...s.topology, devices } };
    }),
  updateDevice: (id, patch) =>
    set((s) => {
      const dev = s.topology.devices[id];
      if (!dev) return {};
      return {
        topology: {
          ...s.topology,
          devices: { ...s.topology.devices, [id]: { ...dev, ...patch } },
        },
      };
    }),
  updateInterface: (deviceId, interfaceId, patch) =>
    set((s) => {
      const dev = s.topology.devices[deviceId];
      if (!dev || !dev.interfaces[interfaceId]) return {};
      return {
        topology: {
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
        },
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
