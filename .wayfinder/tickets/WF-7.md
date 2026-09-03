---
id: WF-7
title: 拓扑级路由自动生成
type: task
status: closed
assignee: "main"
blocked_by: []
blocks: []
labels: wayfinder:task
resolved: "2026-09-03"
---

## Question

移植/重写原 `dynamic_routing_lib` 的 Dijkstra 全网段寻路，在**拓扑变更时自动计算并写回各路由器路由表**，实现「拓扑连通即通、无需手填路由」。与 WF-6 协同完成用户选定的自动配置范围。

## Notes

- 原 `findShortestPath`/`getRoutes`/`autoInputRules` 是核心算法，可保留为纯函数。
- 需定义「拓扑变更」触发时机（设备增删、连线变化、IP 变化）。

## Resolution（2026-09-03）

**已实现，验收通过。**

- **模块**：`src/domain/routing.ts`（纯函数，不依赖 store/React，确定性输出）。
  - 算法继承 legacy `dynamic_routing_lib`：以「网络段」为图节点、路由器为段间桥，多点源 Dijkstra 求最短跳数，next-hop = 桥接路由器在共享网段上的接口 IP。
  - **关键差异（拓扑感知）**：legacy `getNodes` 只扫路由器接口子网、不看线缆；WF-6 自动分配下每台路由器在默认三网段都有接口 → 远端路由恒为空。本模块只纳入**已连线且有 IP** 的路由器接口：节点 = `(交换机, 子网)`，同交换机同子网才互为 on-link，跨交换机的同名子网不互通。
  - 直连路由一并生成（`nextHop 0.0.0.0`）；远端条目 >1 且同 next-hop 时按 legacy `groupByDefaultRules` 收拢为 `0.0.0.0/0` 默认路由（其余保留显式）。
- **store 接线（拓扑变更触发器）**：新增 `addConnection`/`removeConnection`（写 `topology.connections` + 接口 `connectedSwitchId`，交换机端口号自增，中文报错：接口已连/对端非交换机/设备不存在）；`addDevice`/`removeDevice`（删设备时清理其连线与对端 `connectedSwitchId` 引用）/`updateInterface`（IP/掩码变更）/`updateDevice`（仅 `interfaces`/`ipv4Forwarding` 键变化）后统一经 `applyRouting` 整表重算写回，断开/删除即清掉陈旧条目。
- **验证**：`tsc --noEmit` + `pnpm build` 通过；Bun 直跑断言全绿 —— 双路由器共享交换机链（远端 172.16.0.0/24 via 对端 .2）、stub 默认路由收拢、核心路由器网格、同子网跨交换机隔离、断线清路由、改 IP 换网段、删路由器清表与连线、幂等断线、确定性重复计算。
- **遗留**：前端原型（AppPrototype）仍为自包含 mock，尚未接入 store 动作/路由表展示 —— 属 WF-14（分阶段迁移）范围，届时 store 动作即本模块真实消费端；vitest 单测待 WF-12 定案补齐（`computeRouterRoutingTables` 为纯函数，可直测）。
