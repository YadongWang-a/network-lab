/**
 * WF-5 协议可视化注册表（可扩展架构 · 第一落点）。
 * 完整架构决策见 `.wayfinder/tickets/WF-5.md`。
 *
 * 分层：仿真引擎 SimEvent → 可视化层（本注册表 + VizLayer）→ 画布动画 / 报文追踪栏。
 * 本模块承载「协议元数据」：色码、展示名，供追踪栏 Tag 与画布动画共用；
 * 引擎事件接线与专属渲染钩子（render/animate/match）按 WF-5 决策在实施阶段接入。
 *
 * 色码体系迁移自原版 `packet_visualize_lib`（unicast/arp/icmp/dns/dhcp/tcp/broadcast），
 * 原版以 `assets/packets/{type}.png` 选图标，新架构统一为可配置色码 + 通用报文标记。
 */

export interface VizColor {
  /** Ant Design Tag 颜色名。 */
  tag: string;
  /** 画布动画标记的十六进制色。 */
  hex: string;
}

/**
 * 协议可视化插件（v1：静态装配的元数据插件）。
 * 实施阶段扩展点：`match(packet): boolean`（层栈归属判定）、`animate(ctx)`（专属动画钩子）。
 */
export interface ProtocolViz {
  /** 协议标识：追踪 proto 值 / 报文层 kind，如 'icmp'、'dhcp'。 */
  id: string;
  /** 展示名（实施阶段接入追踪栏与 i18n key）。 */
  label: string;
  /** 默认色码；可被全局配置覆盖（applyConfig）。 */
  color: VizColor;
}

/** 未注册协议的兜底色码。 */
const fallback: VizColor = { tag: 'default', hex: '#8c8c8c' };

/** 内置协议插件（色码体系参考原版 packet_visualize_lib）。 */
const builtins: ProtocolViz[] = [
  { id: 'unicast', label: 'unicast', color: { tag: 'blue', hex: '#1677ff' } },
  { id: 'arp', label: 'ARP', color: { tag: 'geekblue', hex: '#2f54eb' } },
  { id: 'icmp', label: 'ICMP', color: { tag: 'green', hex: '#52c41a' } },
  { id: 'dns', label: 'DNS', color: { tag: 'purple', hex: '#722ed1' } },
  { id: 'dhcp', label: 'DHCP', color: { tag: 'orange', hex: '#fa8c16' } },
  { id: 'tcp', label: 'TCP', color: { tag: 'cyan', hex: '#13c2c2' } },
  { id: 'http', label: 'HTTP', color: { tag: 'blue', hex: '#1677ff' } },
  { id: 'broadcast', label: 'broadcast', color: { tag: 'red', hex: '#f5222d' } },
];

/**
 * 协议注册表：静态装配（v1）+ 运行时覆盖（配置/插件）。
 * 色码查询按协议 id 精确匹配，未注册回退默认灰。
 */
export class VizRegistry {
  private map = new Map<string, ProtocolViz>();

  constructor(plugins: ProtocolViz[] = []) {
    plugins.forEach((p) => this.register(p));
  }

  /** 注册/覆盖一个协议插件（后注册者胜，用于应用自定义插件）。 */
  register(p: ProtocolViz): void {
    this.map.set(p.id, p);
  }

  /** 按协议 id 解析色码；未注册 → 默认灰。 */
  colorOf(proto: string): VizColor {
    return this.map.get(proto)?.color ?? fallback;
  }

  /** 按协议 id 解析插件；未注册 → undefined（调用方自取 fallback）。 */
  resolve(id: string): ProtocolViz | undefined {
    return this.map.get(id);
  }

  /** 应用全局配置的色码覆盖（如 `config.viz.colors`，WF-6 落地后接入）。 */
  applyConfig(colors: Record<string, Partial<VizColor>>): void {
    for (const [id, patch] of Object.entries(colors)) {
      const viz = this.map.get(id);
      if (viz) viz.color = { ...viz.color, ...patch };
    }
  }

  /** 已注册协议 id（调试/文档用）。 */
  ids(): string[] {
    return [...this.map.keys()];
  }
}

/** 全局单例：内置协议 + 配置覆盖入口。 */
export const viz = new VizRegistry(builtins);
