---
id: WF-9
title: UI 设计系统与组件库（原型）
type: prototype
status: closed
assignee: "main"
blocked_by: []
blocks: [WF-8]
labels: wayfinder:prototype
---

## Question

选定组件库与设计语言（候选：Ant Design / Arco / shadcn/ui），产出关键界面高保真静态稿：设备侧栏、设备配置抽屉、拓扑画布、报文轨迹/协议可视化面板、终端、设置。验证「好看 + 中文友好 + 暗色模式」。用 `/prototype` 产出可评审稿。

## Notes

- 中文生态与文档完整度是重要权重（Ant Design / Arco 占优）。
- 设计语言需覆盖 WF-8 的文案体系与 WF-4 的画布。
## Resolution（用户已确认）

UI 设计系统与组件库已定（WF-9 原型验证通过）。

**组件库 = Ant Design v6（antd 6.6.1 + @ant-design/icons）**。理由：中文资料最全、暗色 `theme.darkAlgorithm` 开箱、中后台/网络管理组件齐全（Layout / Drawer / Form / Table / Tabs / Tag / Menu），与 react-i18next 协同顺畅。

**设计语言**：暗色优先（默认暗色、可切亮色）、主色 `#1677ff`、圆角 6。布局 = 顶部标题栏（标题 + 暗色切换 + 语言(中文) + 新建）+ 左侧设备面板(Sider/Menu) + 中部画布(占位，WF-4 接 React Flow) + 底部报文轨迹/终端(Tabs) + 设备配置抽屉(Form + 防火墙表 + 服务标签)。

**原型产物（标注 PROTOTYPE 非生产）**：`src/prototype/AppPrototype.tsx`，`App.tsx` 暂挂载它；`pnpm dev` 可览。`tsc --noEmit` + `vite build` 验证通过（antd 全量致 ~957KB，后续按需/code-split 优化）。

**供后续对接的关键决策**：协议色码体系（unicast/icmp/dns/dhcp/tcp/broadcast → Tag 颜色）作为可配置元数据，对接 WF-5；配置抽屉字段对接 WF-6/7 自动配置；终端对接 WF-11。如需与 shadcn/Tailwind 极简风做 A/B 对比，可再产一个变体（原型技能 UI 分支建议多变体；本次先交付推荐方向）。

用户已确认（2026-08-28）。本票关闭，解锁 WF-8。最终设计以上述为准；产物 `src/prototype/AppPrototype.tsx`（PROTOTYPE 标注，由 WF-8/WF-5/正式实现替换）。
