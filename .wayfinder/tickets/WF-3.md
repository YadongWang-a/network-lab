---
id: WF-3
title: 仿真引擎迁移策略
type: grilling
status: closed
assignee: "main"
blocked_by: []
blocks: [WF-7, WF-10, WF-11]
labels: wayfinder:grilling
---

## Question

如何把 vanilla `processors/`（switchProc / hostProc / routerProc / routingProc / kernelProc / serviceProc）从「读写 DOM 属性、查 `<table>` 行」改为「读写 store 状态」，同时**保留** ARP / ICMP / DHCP / DNS / TCP 三次握手 / HTTP 算法逻辑？

- 报文流转的递归调用链（switch→host/router→kernel→service→routing→switch）如何在 store + 事件/异步模型下重建？
- 防火墙 NAT / `connTrack` 改写如何迁入新状态层？
- 全局旗标（`arpFlag`/`dnsRequestFlag`/`buffer` 等）如何用 store 切片或 ephemeral 状态替代？

## Notes

- 目标是「逻辑可单测、UI 可替换」；引擎应为框架无关纯模块。
- 性能：高频报文更新不应触发整树重渲染（见 WF-R2 选型）。
## Resolution

仿真引擎迁移策略已定（grilling 确认，2026-08-27）。三项关键决策：

1. **① 引擎形态 = B 全事件队列调度器**：砍掉原同步递归调用链，报文变为事件进仿真队列；`SimulationEngine` 调度器每次弹一个事件、处理"一跳"、emit、再把下一跳作为新事件入队。每个 processor 改为纯函数："给定报文在节点 X，返回下一步事件列表"。协议保真度不变（ARP/ICMP/DHCP/DNS/TCP/HTTP/路由/TTL/NAT 全模拟），仅编排骨架换成队列。暂停/单步/回放为一等公民（停调度=暂停、pop 一次=单步、重放 event log=回放）。
2. **② 异步关联 = xid + Promise 的 `pending` 表**：删除原 `arpFlag`/`dnsRequestFlag`/`dhcp*Flag`/`tcpSyncFlag`/`traceFlag` 布尔旗标与 `buffer`/`httpBuffer`/`dhcpOfferBuffer`/`tcpBuffer`/`traceBuffer` 缓冲；改为 `engine.pending: Map<xid,{resolve,timer}>`，`arpResolve(ip)` 等返回 Promise，reply 事件按 xid 解 Promise。并发去重用 read-through（同 key 返回同一 Promise）。`connTrack`→`device.firewall.nat`；`trafficBuffer`由 event log 派生；`nodes*`由 selector 派生；计时器句柄走引擎 ephemeral Map。
3. **③ 定时器态 = A 引擎 ephemeral `Map<key,timeoutId>`**：DHCP 租约 / ARP / MAC / DNS 缓存过期计时器句柄存引擎（不进可持久化 store）；store 只存 `expiresAt`（已入 WF-2 模型）。增改表项→`armExpiry` 挂计时器；到点→改 store+清句柄；手动删→`clearTimer`。存档只序列化 `expiresAt`，读档后引擎重挂。

**状态访问替换**：所有 `getElementById(id).getAttribute("ip-enp0s3")`→`topology.devices[id].interfaces.enp0s3.ip`；`setAttribute`→Zustand `set`/`updateDevice`；路由表/ARP/MAC 表 `<table>` 行→`device.routingTable`/`arpTable`/`switch.macTable`；`firewallProcessorFilter`/`firewallProc`→`device.firewall`（含 nat/connTrack）。

**防火墙 NAT/connTrack**：`routing()` 对转发包调 `firewallProc` 做 MASQUERADE/SNAT/DNAT，迁入引擎，改写 `device.firewall.nat` 与报文 IP，回程按五元组还原。

**迁移顺序（自底向上、每步可单测，衔接 WF-12）**：① `kernelProcessor` ② `serviceProcessor`+各 service ③ `routing` ④ `switchProcessor` ⑤ `packetProcessor_Host`/`Router` ⑥ 之上套 `SimulationEngine`+`SimulationController`。

解锁：WF-7（拓扑级路由自动生成）、WF-10（配置解析器迁移）、WF-11（终端组件，仍受 WF-1 阻塞）。
