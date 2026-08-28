---
id: WF-7
title: 拓扑级路由自动生成
type: task
status: open
assignee: ""
blocked_by: []
blocks: []
labels: wayfinder:task
---

## Question

移植/重写原 `dynamic_routing_lib` 的 Dijkstra 全网段寻路，在**拓扑变更时自动计算并写回各路由器路由表**，实现「拓扑连通即通、无需手填路由」。与 WF-6 协同完成用户选定的自动配置范围。

## Notes

- 原 `findShortestPath`/`getRoutes`/`autoInputRules` 是核心算法，可保留为纯函数。
- 需定义「拓扑变更」触发时机（设备增删、连线变化、IP 变化）。
