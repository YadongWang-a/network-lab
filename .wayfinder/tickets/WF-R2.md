---
id: WF-R2
title: 状态管理库选型（研究）
type: research
status: closed
assignee: "wayfinder-charting"
resolved: "2026-08-27"
blocked_by: []
blocks: [WF-1]
labels: wayfinder:research
---

## Question

对比 React 状态管理：**Zustand / Redux Toolkit / Jotai / Valtio**，在「高频报文与状态更新（仿真热路径）、多切片（devices/simulation/visualization/config/ui）、需可序列化存档（WF-13）、避免整树重渲染、可测试性」维度给出推荐与理由。

## Resolution

- **推荐：Zustand（v5）**。
- **理由**：选择器（selector）订阅天然按字段粒度触发重渲染，适合仿真热路径的高频报文更新；store 与 React 解耦，可在框架无关的引擎纯模块中直接读写；`persist`/`partialize` 轻松序列化存档（WF-13）；样板极少。
- **取舍**：无内置时间旅行 devtools（可加 `zustand/middleware` 的 redux 中间件）；大批量 normalized 数据需自行设计切片与索引（用 `Map` 或普通对象 + selector）。相比 Redux Toolkit 少了“规范式”约束，团队需自律——但对本项目的自由拓扑模型反而更合适。
- **落地要点（供 WF-1）**：按领域切片（`devices`/`simulation`/`visualization`/`config`/`ui`）；高频表（ARP/MAC/路由）用 selector + `useShallow` 或 `subscribe` 精确订阅；存档用 `persist` 仅序列化可持久字段，排除 ephemeral 旗标。
