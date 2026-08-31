---
title: PackeTTrino 前端框架重构 — 决策地图
labels: wayfinder:map
status: open
---

# PackeTTrino 前端框架重构 — 决策地图

## Destination

产出一份**可执行的重构蓝图与规格**：把 PackeTTrino 从纯原生（vanilla）JS 重构为 React + TypeScript 工程，仿真状态从 DOM 属性抽离到框架 store，UI 现代化且全中文，并具备「协议数据可视化」与「全自动配置」的可扩展架构。本地图只下决策、不交付代码；终点是经各决策 ticket 确认、可直接进入实施阶段的重构规格/里程碑计划。

## Notes

- 领域：网络模拟器重构。核心难点是「状态存在 DOM 元素属性上（`ip-enp0s3`、`dhcpd="true"`、路由表是真实 `<table>` 被引擎 `querySelectorAll` 读取）」与框架范式冲突，必须抽离到 store。
- 每会话开始前先重读本地图低分辨率视图，再选下一张 frontier ticket（open / unblocked / unclaimed）。
- 追踪器为本地 markdown：`.wayfinder/tickets/*.md`，每张 ticket 一个文件；阻塞关系用 frontmatter `blocked_by` 表达（本环境无原生 issue tracker，以此模拟）。
- 研究 ticket（WF-R*）在本 charting 会话内并行调研并就地解决，结论写回对应 ticket 文件。
- 已通过 grilling 锁定的基础决策见「Decisions so far」，不再另立 ticket。

## Decisions so far

- **[框架 = React + TypeScript]**（grilling 已定）— 取可视化/扩展生态最大者（react-flow、visx、d3）。
- **[架构 = 彻底重写·状态入 store]**（grilling 已定）— 仿真状态从 DOM 属性迁到框架状态层，UI 与仿真逻辑解耦。
- **[自动配置 = 设备级 + 拓扑级路由]**（grilling 已定）— 拖入设备自动分配 IP/掩码/网关；拓扑连通即自动计算并下发全网路由。
- **[i18n = 中文默认 + i18n 框架]**（grilling 已定）— 全中文显示，底层 i18n 层保留可切多语言能力。
- **[状态库 = Zustand]**（WF-R2 研究已定）— 选择器订阅避免热路径重渲染，易序列化存档（WF-13）。
- **[i18n 库 = react-i18next]**（WF-R1 研究已定）— 生态最大、支持运行时切语言、与组件库协同。
- **[画布 = React Flow(@xyflow/react) + 自定义边/叠加层动画]**（WF-R3 研究已定）— 开箱拓扑交互，动画与协议可视化可插拔（宿主 WF-5）。
- **[仿真引擎迁移 = 事件队列调度器]**（WF-3 已决）— 砍递归改事件队列；processor 变纯函数返回事件；异步靠 xid+Promise `pending` 表取代 flag/buffer；计时器句柄走引擎 ephemeral Map，store 只存 `expiresAt`。解锁 WF-7/10/11。
- **[脚手架 = React+TS+Vite+Zustand 已立]**（WF-1 已决）— `src/domain/types.ts`(WF-2)、`src/state/store.ts`(Zustand 切片)、`src/engine/SimulationEngine.ts`(WF-3 B)、`src/i18n/`(react-i18next 中文默认)；原 vanilla 迁入 `src/legacy/`。构建验证通过。解锁 WF-6/11。
- **[领域模型 = 归一化 store + 报文层栈]**（WF-2 已决）— 状态从 DOM 抽离为 `Record<id,T>`；报文用判别联合 + 有序 `layers` 层栈（取代类继承/扁平字段），请求应答靠 `xid` 关联；引擎事件发射器驱动可视化。解锁 WF-3/5/6/7/10/13。
- **[UI 设计系统 = Ant Design v6·仅浅色]**（WF-9 原型已确认）— 顶栏 + [画布 | 报文追踪栏] + 底部固定设备栏（横排不分组）；画布/图标复刻原版；设备名牌、悬停操作按钮（终端/租约）、可拖多开报文详情、演示命令面板（Ping/TCP/浏览网页 生成报文序列）。产物 `src/prototype/AppPrototype.tsx`。解锁 WF-8。
- **[画布 PoC = React Flow 已验证]**（WF-4 已决）— 滚轮缩放/拖拽平移/控件/节点拖动/拉线/拖放全成立；Handle 置节点中心、直线中心连线。与 WF-9 同产物。
- **[i18n = react-i18next 已落地]**（WF-8 已决）— 全部界面文案进 zh/en locale（~110 key），中文默认；协议/命令名保留原文；main.tsx 初始化顺序修正。实测通过。
- **[可视化 = 注册表 + 沿线报文 + 到达闪烁]**（WF-5 已决）— vizRegistry 统一色码；命令驱动报文沿边流动动画 + 到达高亮；RF 连接点须常挂载。实测通过。

## Not yet specified（fog）

- 优先做哪些「协议数据可视化」扩展（用户举例但未指定首批清单/优先级）。
- 自动配置的交互形态细节（实时自动 vs 向导式确认）。
- 性能与规模目标（单拓扑设备数 / 并发报文数上限）。
- 终端是否保留全部原命令（apt/nano/realnode 等）还是精简。
- 旧 `.ptt` 存档是否需要一次性导入转换器。

## Out of scope

- **真实网卡桥接（realnode）**：超出 v1 核心目标（更好看/更方便/可扩展/自动配置/中文），留待后续立 ticket。
- **移动端 / 触控适配**：未要求。
- **多人协作 / 云端存档**：未要求。
- **旧 `.ptt` 存档读入兼容**：采用新 JSON 格式，不保证读旧档（如需再立 ticket）。
