---
id: WF-5
title: 报文可视化可扩展架构
type: grilling
status: closed
assignee: "main"
blocked_by: []
blocks: []
labels: wayfinder:grilling
resolved: "2026-08-31"

## Reopen issue（已修复）

- **报文追踪不随命令执行清空**：演示命令执行时旧追踪行/报文/详情悬浮窗保留并继续追加，时间戳也从上次末尾续接。预期：每次执行新命令，追踪栏清空后按新序列从 0.001s 重新计时。
- **修复**（commit 见 git log）：`playSequence` 开头 `setTraces([])` / `setTracePkts([])` / `setDetails([])`；`runCommand` 时间恒定从 `0.001` 起（不再取旧末行续接）；行 key 去除对旧 `traces.length` 的依赖。浏览器实测连续三次执行：每次行数从 0 增长、首行 `0.001s`。

## Question

设计**协议数据可视化**的插件/注册表接口，使新增协议可视化可插拔（用户明确要求的可扩展性）。定义：

- 可视化层订阅仿真引擎事件的契约（报文产生/转发/丢弃/防火墙拦截）。
- 一个 `ProtocolViz` 插件接口（如 `id`、`label`、`color`、`render(packet, ctx)`），注册表如何发现与装配。
- 与 WF-4 画布层、与 WF-1 `visualization` 切片的关系。

## Notes

- 原 `packet_visualize_lib` + `animations/` 是参考实现，但需抽象为可扩展注册表。
- 色码体系（unicast/icmp/dns/dhcp/broadcast）应作为可配置元数据。

## Decision

### 1. 分层：引擎事件契约（单向依赖，可视化不反向触碰仿真）

- 引擎是唯一事实源：`SimulationEngine.on(SimEvent)`（已定义于 `src/engine/SimulationEngine.ts`）向订阅者发射 `packet-forwarded` / `packet-dropped` / `firewall-blocked` / `arp-resolved`，事件携带 `from`/`to` 设备 id、`packet`、原因/链。
- 可视化层（VizLayer）只依赖 `SimEvent` 类型订阅，不 import 引擎、不调用引擎方法。**引擎不知道可视化的存在**——与 WF-3 决策一致（processor 变纯函数发事件，不再内联 `if (visualToggle) await visualize(...)` 的原版写法）。
- 事件 → 展示动作的翻译是纯函数：`simEventToViz(event): VizAction[]`（`move-dot` / `flash-edge` / `drop-flash` / `block-flash` + 追踪栏行），便于单测与替换展示形态。

### 2. ProtocolViz 插件接口与注册表装配

```ts
interface VizColor { tag: string; hex: string }

interface ProtocolViz {
  id: string;          // 协议标识：追踪 proto 值 / 报文层 kind，如 'icmp'、'dhcp'
  label: string;       // 展示名（实施阶段接 i18n key）
  color: VizColor;     // 默认色码（可被全局配置覆盖）
  match?(p: Packet): boolean;      // 层栈归属判定（默认按 id 精确匹配）
  animate?(ctx: VizContext): Promise<void> | void;  // 专属动画钩子；缺省 = 通用报文标记动画
}
```

- **发现与装配**：静态装配（v1 不做动态加载）——插件文件各自导出 `ProtocolViz`，`new VizRegistry([...])` 聚合为 `Map<id, ProtocolViz>`；`register(p)` 支持运行时覆盖（应用自定义插件/配色），`applyConfig(colors)` 用全局配置覆盖色码（`config.viz.colors[id]`）。
- **两级可视化**：层 1「通用报文动画」（沿线移动标记 + 到达闪烁 + 丢弃/拦截闪光）由事件驱动、对任何协议默认生效，无需插件；层 2「协议专属效果」经 `animate`/`match` 钩子按需挂载（如 DHCP 广播波纹）。v1 只落层 1，钩子接口随实施阶段启用。
- **色码 = 可配置元数据**：已抽离为 `src/visualization/registry.ts`（`viz.colorOf(proto)`，未注册回退默认灰）。内置协议：unicast/arp/icmp/dns/dhcp/tcp/http/broadcast，色值迁移自原版 `packet_visualize_lib`。

### 3. 与 WF-4 画布层、WF-1 visualization 切片的关系

- **WF-4 画布层**：动画层不直接触碰 React Flow 内部；通过几何适配器查询节点坐标/边（`ctx.geometry.nodeCenter(id)`），由 WF-4 的 React Flow 实现提供。可视化可脱离画布运行（无画布时只推追踪栏）。
- **WF-1 `visualization` 切片**：store 只存**意图态**——`visualToggle`（总开关）、`visualSpeed`、`paused`、`traffic`（报文历史，cap 500 已有）。动画中间帧（标记位置、闪烁状态）是 VizLayer 的 ephemeral state（useState/useRef），与引擎 ephemeral 一致，**不进 store**。

### 4. 现状与差距（本 ticket 关闭时点）

- 已落地（commit f2a8b97 + 本 ticket）：色码注册表独立模块 `src/visualization/registry.ts`；原型通用报文标记动画（沿线移动 + 到达闪烁）；追踪栏 Tag 色码；演示命令面板驱动。
- 待实施（排入 WF-14 迁移计划）：`simEventToViz` 事件接线（现在演示序列绕过引擎）、VizLayer 组件、`match`/`animate` 钩子启用、色码配置接入 `config.viz.colors`、原版 `firewall-block` 动画并入事件流。
- 原版参考对照：`movePacket` 的 SVG png 图标（`assets/packets/{type}.png`）→ 新架构统一为注册表色码 + 通用标记；原版暂停/速度全局变量 → store 意图态；原版 processor 内联可视化 → 事件订阅。
