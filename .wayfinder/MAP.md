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
- **[报文可视化 = 事件驱动两级架构]**（WF-5 已决）— 引擎单向发事件（`SimulationEngine.on`），可视化层 `simEventToViz` 纯函数翻译为动画动作；`ProtocolViz` 插件（id/label/color + match/animate 钩子）静态装配进 `VizRegistry`，色码为可配置元数据；store 只存意图态（开关/速度/暂停/报文历史），动画帧为组件 ephemeral；画布几何经适配器解耦。落点 `src/visualization/registry.ts`（已抽离，原型已改用），事件接线/钩子排 WF-14。解锁 WF-12（可视化单测）、WF-14。
- **[设备级自动配置 IPAM = 子网池 + 网关惯例]**（WF-6 已决）— `src/domain/ipam.ts` 纯函数子网池（默认 192.168.1.0/24、10.0.0.0/24、172.16.0.0/24）；路由器每接口占一子网网关 .1（被占顺延下一空闲主机），终端设备从 .2 起分配；DHCP 服务器自动生成服务范围 .100–.254；「已占用」集合由拓扑扫描得出（冲突检测），手动覆盖（updateInterface）后后续分配自动跳过；池耗尽抛中文错误。`store.addDevice` 自动接入，原型拖放同源（`src/domain/deviceFactory.ts`）。解锁 WF-7（复用 ipam 纯计算）。
- **[拓扑级路由自动生成 = 网段图 Dijkstra + 触发整表重算]**（WF-7 已决）— `src/domain/routing.ts` 纯函数：节点 = (交换机, 子网) 的**线缆感知**网段图（只纳入已连线且有 IP 的路由器接口，规避 WF-6 默认子网下 legacy 无缆算法的「全网直连」失效），路由器为段间桥，多点源 Dijkstra 求最短跳数，next-hop = 桥接路由器在共享网段上的接口 IP；直连条目一并生成（nextHop 0.0.0.0），同 next-hop 远端 >1 条时按 legacy 收拢为 0.0.0.0/0 默认路由。store 新增 `addConnection`/`removeConnection`，拓扑动作（设备增删、连线变化、IP/掩码变更）统一经 `applyRouting` 整表重算写回各路由器 `routingTable`；跨交换机同名子网不互通，断线/删除即清陈旧条目。**拓扑连通即通、无需手填路由**（引擎消费留 WF-11/14 接线）。
- **[M2 引擎竖切 = 物理跳事件队列 + 最小处理器集]**（WF-16 已决）——`SimulationEngine` 落地：
  队列元素 = 物理跳（洪泛展开多事件、`delivered` 区分定向交付）；switchProc（MAC 学习/洪泛/
  定向）、kernelProc（ARP 学习应答、ICMP echo、xid pending 唤醒）、routerProc（TTL→最长前缀
  查表消费 WF-7 表→ARP next-hop→重写 L2）；`sendFrom` 双轨（路由器查表/终端直连+网关）；
  引擎只依赖 `EngineCtx{getTopology,patchDevice}`，ephemeral（队列/pending/复位代数）不进 store；
  `drop` 即结算同 xid 等待。ping/traceroute 真引擎驱动（traceroute 逐跳 TTL 探测 + time-exceeded
  已含），其余 7 命令仍 mock 待 WF-17。追踪行/动画由引擎事件生成（首跳建行、delivered 才更新
  终点，广播行重播=逐邻居重放）。单测契约暂以 `scripts/verify-engine.ts`（Bun 直跑）承载，WF-12
  定案后归位。顺带修 M1 遗留：拖放双建设备（onDropDevice 冒泡双触发）。解锁 WF-17、WF-11。
- **[迁移策略 = 绞杀者 strangler·连线语义 = 交换机终端]**（WF-14 已决）— 运行中 UI = 原型 mock（1316 行），legacy vanilla 108 文件零引用死代码；**UI 外壳保留**（WF-4/9 已确认），按序替换四条数据流：D1 拓扑入库 → M1（WF-15：画布 nodes/edges/拖放/编辑改走 `store.topology`，拉线强制设备接口→交换机，路由随拓扑自动重算）→ D2 仿真真引擎 → M2（WF-16：处理器最小集 switch 学习洪泛 + host ARP/ICMP + router 查表转发，播放键驱动 `SimulationEngine.step`，消费 WF-7 路由表）→ M3（WF-17：服务层 dhcpd/named/apache2 + L4 TCP/UDP + TTL/time-exceeded，9 个演示命令逐个转真，apache2 设备归并为「pc + apache2 服务」）→ M4（WF-11 终端/命令注册表 + WF-10 解析器）→ M5（WF-13 JSON 存档 + WF-12 测试 + WF-18 清理：删 legacy、剥离 mock）。每个里程碑以浏览器实测演示命令为验收门，中间版本始终可运行；M1 前先读 WF-15 接线面清单（行号已核）。
- **[M3 服务层与 L4 = 全协议真引擎 + 服务按设备能力分发]**（WF-17 已决）— 引擎 kernel 扩展：DHCP 广播域（dhcpd 池分配/租约落 `dhcpLeases`、dhclient 未配置才绑定、跨段提示、中继未实现）、DNS UDP/53 named zone 应答 + 客户端 dnsCache、apache2 HTTP GET→200（documentRoot 简化任意 Host）、TCP 三次握手任意可达主机（FTP/telnet 协议体简化仅握手并标注）；9 个演示命令全真（假序列 buildSequence 已删，硬编码公网 IP 移除）；租约窗/抽屉服务区接 store 真数据；无服务节点中文提示。验收：`scripts/verify-engine.ts` 场景 4–8 + 浏览器实测 16/16 全绿（`ui-wf17.png`）。解锁 M4（WF-11/WF-10）与 WF-18 清理。
- **[M4 终端 = React 组件 + 命令注册表；配置 = 解析器落 store]**（WF-11/WF-10 已决）— 终端 `src/terminal/`：注册表替代 legacy `commandFunctions`，命令分三类：FS 命令（`src/domain/filesystem.ts` 纯函数操作 Device.filesystem）、引擎驱动命令（ping/traceroute/dig/arpscan/dhclient，`driveEngine` 逐事件流式输出；顺带修复首跳去重缺陷）、配置命令（`systemctl start/restart <unit>` 读设备 FS 真实守护进程配置经解析器落 store）；UI 含 ↑/↓ 历史、设备上下文提示符、busy 输入禁用。解析器 `src/parsers/config.ts` 纯函数（network-interfaces / dhcpd.conf / bind9 zone+db / apache vhost），错误带行号中文；落点 dhcpPool（新增可选 netmask 供 offer 下发掩码）、named zones、apache2 config。验收：verify 场景 9（FS+解析器+conf 驱动引擎按新池分配）+ 浏览器实测 6/6（`ui-m4.png`）。解锁 M5（WF-13 存档 / WF-12 测试 / WF-18 清理：legacy unix/terminal/utilities/parsers 可整删）。
- **[M5 清理 = 仓库只含生产轨]**（WF-18 已决·重构终点）— 整删 `src/legacy/`（108 文件）与 `tests/`（vitest DOM 旧测试）；`AppPrototype.tsx` 升格 `src/ui/App.tsx`；剥离死 tile（annotation/isc-dhcp-*/bind9/animation/settings）；i18n 孤儿 key 审计归零（zh/en 对齐 176 key）；`lint` 脚本修正为 `eslint scripts`（TS 门禁 = tsc strict）。验收：`tsc`+`vite build`+verify 场景 1–9 全绿 + 冷启动冒烟 4/4（真 store/引擎路径无 legacy 引用）。`src/` 仅剩 domain/state/engine/visualization/terminal/parsers/ui/i18n。剩余开放：WF-13 存档（用户暂缓，open）、WF-12 测试策略（待定案；verify-engine Bun 断言暂为契约载体）。
- **[测试策略 = vitest 契约单测 + Playwright 最小冒烟]**（WF-12 已决·2026-09-08）—— `scripts/verify-engine.ts`（Bun 直跑 9 场景）退役，契约拆入 `tests/engine/*.test.ts`（7 文件 25 用例，断言口径 = SimEvent 流 + store 终态的可观测契约，不测源码文本）；组件测试不做（UI 靠 E2E 兜底）；E2E = Playwright 最小冒烟 4 用例（中文 UI / 拖放+IPAM+拉线 / 种子拓扑演示 ping 追踪行+动画帧 / 终端 ip addr），webServer 自动拉起 vite；命令 = `pnpm test` / `pnpm e2e` 独立两条，不挂 pre-commit，TS 门禁仍为 tsc strict。注意：App 挂载即播种演示拓扑，e2e ping/终端复用种子（连通 /24 段），拖放用例先「新建拓扑」清场。验收：tsc ✓ + vitest 25/25 + e2e 4/4×2 轮 + build ✓ + eslint 0 error。至此全票 closed（WF-13 存档暂缓、WF-19 backlog 待排期除外）。
- **[包解剖视图 = 追踪面板内联 + 字节合成]**（WF-20 已决·2026-09-08，对齐 数据包可视化演示_单视图整合版.html）——点追踪行在追踪面板下方内联解剖（无对话框）：层条（flex 按字节数，点层切换）+ 字段/值/说明表 + hex 视图（点层高亮字节段）。`src/domain/packetBytes.ts` 纯函数按层字段合成真实包头字节（以太网/ARP/IP/ICMP/TCP/UDP 精确；DHCP/DNS/HTTP 忠实编码标 approx），`src/ui/PacketDissect.tsx` 承载三件套；报文详情悬浮窗整删，`packet.*` i18n 孤儿清除（zh/en 各 +42 `dissect.*`/`desc.*`）。验收：vitest 34/34（含合成器 9 用例）+ e2e 4/4×2 + build ✓ + 浏览器实测层切换/hex 高亮。
- **[路由器连线 = 端口映射连接点]**（WF-21 已决·2026-09-09）——路由器一接口一端口点（左/右/顶 = enp0s3/8/9），连线由所拖端口定接口（`p-<ifaceId>` handle），其余设备维持「第一个空闲接口」；路由器边锚定端口点。显示：已连线端口「端口名+IP」常显；未连线端口点悬停出点级 Tooltip（`IP · 未接线`），连线拖拽中全端口标签铺开；路由器名牌不显示单一 IP（多接口无意义）。验收 tsc+vitest 34/34+e2e 4/4+build+浏览器判别性拖拽两轮全绿。
- **[设备属性面板按设备类型差异化 = 仅裁剪表单]**（WF-22 已决·2026-09-09）——范围仅 UI 裁剪不动语义：路由器 = label+转发+接口(IP/掩码)+路由表；交换机 = label+L2 提示；终端 = label+接口(IP/掩码/网关)+服务；服务区块仅在存在已启用服务时渲染；路由表仅路由器；防火墙区块整删（引擎不消费恒空，连带 4 个 i18n 孤儿 key 清除）。只读域升级可编辑/静态路由手填留待后续点单。
- **[PC DHCP 客户端开关 = 默认关·开关切换·获取手动]**（WF-23 已决·2026-09-09）——PC 类抽屉加「DHCP 客户端」开关（落 `services.dhclient`）：开 = 清静态 IP + 接口字段只读（DORA 后显示租约值，未获取显示提示），关 = IPAM 重分配静态；获取仍手动（演示命令/终端 dhclient），引擎绑定语义零改动。仅 PC 类出开关。表单随开关重挂载。
- **[悬停 × 直删 = 线缆断开 + 设备删除]**（WF-24 已决·2026-09-09）——自定义 `cable` 边（`getStraightPath`+`BaseEdge`，命中区 interactionWidth 36，根因：默认 20px 命中区对斜线极难点中）；线中点 SVG ×（`.react-flow__edge:hover` CSS 显隐，`src/ui/canvas.css`）点击即 `removeConnection`；设备悬停左上角红 × 经 `NodeActions.deleteDevice` 删除并清抽屉；键盘删除保留。
- **[路由器端口随连线数浮动 = 保底 3 口 + 恒留 1 空口 + 尾口回收]**（WF-25 已决·2026-09-12）——用户问「端口只支持 3 个吗、能否随连线数变」。落地：`ROUTER_BASE_PORTS=3` / `ROUTER_MAX_PORTS=8`，端口数 = `clamp(max(3, 已连线数 + 1), …, 8)`（React Flow 须已有 Handle 才能起拖，故不能按需现造 —— 恒留 1 空口，占满即追加 `enp0s10…`）；`syncRouterPorts`（`src/domain/deviceFactory.ts`）在 `addConnection`/`removeConnection`/`removeDevice` 后同步，收缩仅回收「尾部、未连线、未配 IP」的追加口（基础口与手配 IP 的口不回收）；追加口在默认 3 子网池外无自动 IP，待抽屉/终端手配。UI `PORT_POS` 取模 → `portLayout` 环布（左→右→顶→底 轮流，同边多口均分；基础 3 口观感不变），上限提示 `msg.maxPorts`。验收：tsc/vitest 40/40/eslint/build/Playwright 4/4 + 浏览器真实拖拽（3 口→4 口→5 口→断开回落 4 口，几何与截图 `.wayfinder/ui-wf25.png`）。附带修复环境缺 `@playwright/test` + Chromium 未装导致的 tsc/e2e 假红。
- **[路由器抽屉只列已接线端口]**（WF-26 已决·2026-09-12）——用户要求「连接哪些端口显示哪些」。抽屉「网络接口」区对路由器按 `connectedSwitchId !== null` 过滤（非路由器单接口设备不变）；字段名保留接口表原序号 `ip${i}/mask${i}`，保存回填逻辑零改动；空列表显示 `drawer.noWiredIface` 空态提示。未接线端口不可预配 IP —— 与 WF-7 线缆感知语义一致（未接线口本就不参与路由），需配置时先接线。验收：tsc/vitest 40/40/eslint/locale 219=219/Playwright 4/4 + 浏览器实测（0 线 → 空态；3 线且画布另有未接线 enp0s10 → 抽屉恰列 enp0s3/8/9；改 IP 保存后画布标签同步；截图 `.wayfinder/ui-wf26.png`）。

## Not yet specified（fog）
- 「协议数据可视化」扩展：首批首项已落地（包解剖视图，见 Decisions so far 的包解剖条目）；其余扩展（跨设备字段变化对照等）仍待用户点单。
- 自动配置的交互形态细节（实时自动 vs 向导式确认）。
- 状态持久化（存档/读档）**暂缓中**（用户 2026-09-07 决定先不做，WF-13 保持 open；待交互形态/旧档兼容需求明确后再排期）。
- 设备抽屉只读域升级可编辑（DHCP 池 / DNS zone / apache2 vhost / 静态路由手填）——WF-22 拍板本期仅裁剪不做；待点单后立票（需先定自动/手工共存策略）。
- 性能与规模目标（单拓扑设备数 / 并发报文数上限）。
- 终端是否保留全部原命令（apt/nano/realnode 等）还是精简。
- 旧 `.ptt` 存档是否需要一次性导入转换器。

## Out of scope

- **真实网卡桥接（realnode）**：超出 v1 核心目标（更好看/更方便/可扩展/自动配置/中文），留待后续立 ticket。
- **移动端 / 触控适配**：未要求。
- **多人协作 / 云端存档**：未要求。
- **旧 `.ptt` 存档读入兼容**：采用新 JSON 格式，不保证读旧档（如需再立 ticket）。
