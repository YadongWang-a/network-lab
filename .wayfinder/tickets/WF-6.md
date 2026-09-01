---
id: WF-6
title: 设备级自动配置 IPAM
type: task
status: closed
assignee: "main"
blocked_by: []
blocks: []
labels: wayfinder:task
resolved: "2026-09-01"
---

## Question

实现拖入设备即**自动分配 IP / 掩码 / 网关**：设计子网地址池（subnet pool）管理、地址分配与冲突检测、与 store 的接入。用户选定范围为「设备级 + 拓扑级路由」，本 ticket 负责设备级部分，并与 WF-7 协同。

## Notes

- 参考原 `installDhclient` / `getRandomMac` / `setRouterIps` 逻辑，但状态迁入 store。
- 需支持手动覆盖（自动分配后仍可改）。

## Resolution（2026-09-01）

**已实现，验收通过。**

- **模块**：`src/domain/ipam.ts`（纯函数：IP 运算 + `SubnetPool` 分配器 + 冲突检测）+ `src/domain/deviceFactory.ts`（按类型构造 Device：默认接口/随机 MAC/自动 IP）。
- **分配语义**：路由器每个接口占一个子网的网关地址（惯例 .1，被占则顺延下一空闲主机）；终端设备从 .2 起分配（.1 预留网关）；DHCP 服务器自动生成服务范围 `.100–.254`（静态地址留 .2–.99）；交换机仅分配 MAC 不占 IP。默认子网池 `192.168.1.0/24`、`10.0.0.0/24`、`172.16.0.0/24`（沿 legacy `setRouterIps` 三网段惯例）。
- **store 接入**：`addDevice(kind, opts)` 自动分配并返回 id（冲突检测 = 扫描当前拓扑全部接口 IP）；`updateInterface` 支持手动覆盖，后续分配自动跳过手动地址；`config.subnetPool`（`setSubnets`/`addSubnet`，CIDR 校验）；池耗尽抛中文错误。
- **原型接入**：`AppPrototype.tsx` 拖放改用同一 `SubnetPool`（含 id 冲突与连丢闭包修复）。浏览器实测：拖入 PC→.2、路由器→.1（被占顺延）、DHCP→.4、交换机无 IP，全部地址唯一、种子数据不受影响。
- **验证**：`tsc --noEmit` + `pnpm build` 通过；IPAM/工厂/store 断言（Bun 直跑）全绿；浏览器端到端拖放实测通过。
- **遗留**：vitest 单测待 WF-12（测试策略）定案后补齐；WF-7 可直接复用 `ipam` 的 `networkOf`/`netmaskToCidr` 等纯计算。
