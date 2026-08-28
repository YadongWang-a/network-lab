---
id: WF-6
title: 设备级自动配置 IPAM
type: task
status: open
assignee: ""
blocked_by: []
blocks: []
labels: wayfinder:task
---

## Question

实现拖入设备即**自动分配 IP / 掩码 / 网关**：设计子网地址池（subnet pool）管理、地址分配与冲突检测、与 store 的接入。用户选定范围为「设备级 + 拓扑级路由」，本 ticket 负责设备级部分，并与 WF-7 协同。

## Notes

- 参考原 `installDhclient` / `getRandomMac` / `setRouterIps` 逻辑，但状态迁入 store。
- 需支持手动覆盖（自动分配后仍可改）。
