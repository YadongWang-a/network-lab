import { create } from 'zustand';
import type { Device, Packet, Topology } from '@/domain/types';

// 切片结构（WF-2 归一化 + WF-3 事件可视化）：
// - devices：拓扑与全部设备状态（引擎读写、UI 订阅）
// - visualization：动画开关/速度/暂停/报文轨迹
// - ui：暗色模式等界面态
// - config：全局配置（子网池等，WF-6 落地）
// 注意：引擎的 ephemeral 态（pending Map、计时器句柄）不进 store，见 engine/。

export interface DevicesSlice {
  topology: Topology;
  addDevice: (d: Device) => void;
  removeDevice: (id: string) => void;
  updateDevice: (id: string, patch: Partial<Device>) => void;
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

export interface ConfigSlice {
  // 全局配置占位（WF-6 自动配置落地）
}

export type StoreState = DevicesSlice & VisualizationSlice & UiSlice & ConfigSlice;

export const useStore = create<StoreState>((set) => ({
  // —— devices 切片 ——
  topology: { devices: {}, connections: [] },
  addDevice: (d) =>
    set((s) => ({
      topology: {
        ...s.topology,
        devices: { ...s.topology.devices, [d.id]: d },
      },
    })),
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
}));
