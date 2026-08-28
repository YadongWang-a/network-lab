---
id: WF-2
title: 领域模型与类型定义
type: grilling
status: closed
assignee: "main"
blocked_by: []
blocks: [WF-3, WF-5, WF-6, WF-7, WF-10, WF-13]
labels: wayfinder:grilling
---

## Question

定义 TS 领域类型，作为一切状态的基础：

- `NetworkDevice`（kind: pc/router/switch/dhcp-server/dns-server/...；位置；接口列表）
- `NetworkInterface`（name、ip、netmask、mac、connectedSwitchId、gateway）
- `Packet` 及子类（Arp/Dhcp/Dns/Icmp/Tcp/Http，含 origin/destination mac+ip、ttl、xid）
- 表类型：`RoutingTableEntry`、`ArpEntry`、`MacEntry`、`DnsCacheEntry`
- `FirewallRule`（table/chain/protocol/src/dst/sport/dport/action）、`Service`（dhcpd/named/apache2/...）
- `Topology`、`Connection`（设备-交换机连线）

确立设备/接口在拓扑中的标识与关系，**替代原 DOM 属性 `ip-enp0s3` 等魔法字符串**。建议结合 `/domain-modeling` 产出 ubiquitous language。

## Notes

- 类型应可序列化（用于 WF-13 存档）与可测试（用于 WF-12）。
- 保留原 `getNetwork/getBroadcast/ttl` 等纯计算逻辑，仅换输入输出载体。
## Resolution

领域模型已定（grilling 确认，2026-08-27）。核心结论：

1. **状态从 DOM 抽离为归一化 store**：原 DOM 属性（`ip-enp0s3`/`mac-enp0s3`/`data-switch-enp0s3`/`dhcpd="true"`/`filesystem`/各 `<table>` 状态表）统一为 `Topology { devices: Record<DeviceId, Device>; connections: Connection[] }`；设备/接口/表用 `Record<id, T>` 归一化，便于 Zustand selector 精确订阅、避免整树重渲染。
2. **报文 = 判别联合 + 有序层栈**：`Packet { id; layers: Layer[]; xid?; replyTo?; createdAt }`；`Layer` 为 `Ethernet | Arp | Ip | Icmp | Tcp | Udp | Dhcp | Dns | Http` 判别联合；`layers` 由外到内表达封装嵌套（ARP=`[ethernet,arp]`，DHCP=`[ethernet,ip,udp,dhcp]`，HTTP=`[ethernet,ip,tcp,http]`）。取代原 `packets_lib` 类继承与扁平字段。请求/应答关联用 `xid` + `replyTo`/`Map<xid,pending>`（取代原 `buffer`/`*Flag` 全局 map）。
3. **引擎 = 事件发射器**：`step(packet, ctx)` 向外发 `packet-forwarded`/`packet-dropped`/`arp-resolved`/`firewall-blocked` 等事件；可视化/终端/日志订阅，支持暂停/单步/回放。
4. **其余约定**：防火墙并入 `FirewallState`（含 nat/connTrack）；服务配置用类型化子接口（`DhcpdConfig`/`NamedConfig`/`ApacheConfig`）；`connTrack` 并入 NAT 表。

实现落地：具体 `.ts` 类型文件在 WF-1（脚手架）建立、WF-3（引擎迁移）填充。本 ticket 只定决策，不写代码。

已解锁：WF-3、WF-5、WF-13（完全解锁）；WF-6（仍受 WF-1 阻塞）、WF-7（仍受 WF-3 阻塞）、WF-10（仍受 WF-3 阻塞）已移除 WF-2 依赖。
