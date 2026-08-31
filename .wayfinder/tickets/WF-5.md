---
id: WF-5
title: 报文可视化可扩展架构
type: grilling
status: open
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
