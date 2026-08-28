---
id: WF-4
title: 拓扑画布交互方案（PoC）
type: prototype
status: closed
assignee: ""
blocked_by: [WF-R3]
blocks: []
labels: wayfinder:prototype
---

## Question

基于 **WF-R3** 结论，用所选库做一个最小可运行 PoC：从侧栏拖放设备到画布、设备间连线成拓扑、画布缩放/平移、设备选中与配置入口。验证「操作更方便合理」的体验目标，并确认它与 WF-5 可视化层可共存。

## Notes

- 用 `/prototype` 产出可在浏览器打开的粗糙原型供评审。
- 需与原交互（DOM 拖拽、`startBoardItemMove`）对比，明确改进点。
## Resolution

拓扑画布 PoC 经 WF-9 UI 原型一并验证（2026-08-28，用户确认）：React Flow(@xyflow/react) 承载画布——滚轮缩放、拖拽平移、控件按钮、设备节点拖动、设备间拉线、拖放放置设备，全部成立并经无头浏览器端到端实测。

结论：正式画布采用 React Flow；自定义设备节点；连线端点（Handle）置于节点中心，直线中心到中心、绘制于图标下层（复刻原版）。产物同 `src/prototype/AppPrototype.tsx`。
