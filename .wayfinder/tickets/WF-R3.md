---
id: WF-R3
title: 拓扑画布与报文可视化库选型（研究）
type: research
status: closed
assignee: "wayfinder-charting"
resolved: "2026-08-27"
blocked_by: []
blocks: [WF-4]
labels: wayfinder:research
---

## Question

对比 React 下「拓扑画布 + 实时报文动画」实现：**react-flow / react-konva / 自绘 SVG-Canvas**，在「拖拽/连线/缩放、实时报文流动画、协议可视化可扩展性、大拓扑性能、组件库集成」维度给出推荐。

## Resolution

- **推荐：React Flow（`@xyflow/react`）做拓扑画布 + 自定义边/叠加层做报文动画**（分层：图结构用 React Flow，流动粒子用其自定义边或独立叠加层）。
- **理由**：开箱拖拽/连线/缩放/平移；自定义节点可承载设备图标与状态徽标；自定义边 + CSS/SVG 动画可表达报文沿链路流动并按协议着色；官方性能调优（memo、`onlyRenderVisibleElements`）覆盖大拓扑。
- **取舍**：极大量链路（数百）仍需针对性调优；复杂粒子动画可在 React Flow 之上叠加独立 Canvas/SVG 层（分层渲染，互不拖累）。
- **对 WF-5 的宿主建议**：协议可视化插件以「自定义边类型 + 叠加层渲染器」为宿主，注册表决定某协议走哪条动画边/叠加样式——天然可插拔，符合用户要求的扩展能力。
