---
id: WF-5
title: 报文可视化可扩展架构
type: grilling
status: closed
assignee: "main"
blocked_by: []
blocks: []
labels: wayfinder:grilling
---

## Question

设计**协议数据可视化**的插件/注册表接口，使新增协议可视化可插拔（用户明确要求的可扩展性）。定义：

- 可视化层订阅仿真引擎事件的契约（报文产生/转发/丢弃/防火墙拦截）。
- 一个 `ProtocolViz` 插件接口（如 `id`、`label`、`color`、`render(packet, ctx)`），注册表如何发现与装配。
- 与 WF-4 画布层、与 WF-1 `visualization` 切片的关系。

## Notes

- 原 `packet_visualize_lib` + `animations/` 是参考实现，但需抽象为可扩展注册表。
- 色码体系（unicast/icmp/dns/dhcp/broadcast）应作为可配置元数据。
## Resolution

协议可视化架构已实现并端到端实测通过（2026-08-31，用户选定 A+B 组合：沿线移动 + 到达闪烁）。

- **注册表**：`vizRegistry: Record<proto, { tag, hex }>` —— 轨迹 Tag 色码与画布动画标记共用同一色码源；新增协议可视化 = 注册一项。
- **A 沿线移动**：命令面板执行命令后，按协议着色的报文标记沿对应连线从源设备滑到目标设备（12 步插值动画，~480ms/跳）；命令序列逐跳播放，轨迹列表同步增长。
- **B 到达闪烁**：报文到达后该连线高亮（橙色加粗，320ms）。
- **接线**：订阅点已按 WF-3 事件形态预留（原型由命令面板直接驱动 hop 序列，正式实现改由引擎事件驱动，animateHop/playSequence 接口不变）。
- **关键坑**：RF 连接点不能条件卸载（`{hover && <Handle/>}` 会在拖拽中途卸载导致连线静默中止）——改为始终挂载、样式控制显隐。

实测（无头 Edge + puppeteer-core，脚本 `scripts/probe-viz.mjs`）：拖拽连线 connected=true、动画中 viz-dot 可见、轨迹 5→9。
