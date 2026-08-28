---
id: WF-1
title: React 脚手架与状态层集成
type: task
status: closed
assignee: "main"
blocked_by: [WF-R2]
blocks: [WF-6, WF-11]
labels: wayfinder:task
---

## Question

用 Vite 初始化 React + TypeScript 工程；集成经 **WF-R2** 选定的状态管理库；确立 store 切片结构（建议：`devices` / `simulation` / `visualization` / `config` / `ui`）；搭建可运行骨架（dev server、eslint、目录约定 `src/{components,engine,state,lib,i18n}`）。这是所有 UI 与状态相关 ticket 的前置。

## Notes

- 工程基线已有 `vite`，仅作升级/重配置，无需换构建器。
- 仿真引擎（processors）应作为纯函数模块存在，经 store 读写状态，不直接碰 DOM。
- 暗色模式需在新架构中保留（原 localStorage + matchMedia 逻辑迁移）。
## Resolution

React + TypeScript + Vite 脚手架已立起并通过构建验证（`pnpm install` → `tsc --noEmit` 无类型错误 → `vite build` 产出 `dist/`，192 KB / gzip 62 KB）。落地内容：

- **工程**：`package.json`（react/react-dom/zustand/@xyflow/react/i18next/react-i18next + vite/ts/types）、`tsconfig.json`（strict + `@/*` 别名）、`vite.config.ts`、新 `index.html`（React 挂载点 `#root`）。
- **领域类型（WF-2）**：`src/domain/types.ts` — 归一化 `Topology`/`Device`、报文 `Layer` 判别联合 + `Packet.layers` 层栈、防火墙/服务/NAT 类型，全部可序列化。
- **状态层（WF-R2）**：`src/state/store.ts` — Zustand，切片 `devices`/`visualization`/`ui`/`config`；`updateDevice` 等以 selector 友好方式改状态。
- **引擎骨架（WF-3 决策 B）**：`src/engine/SimulationEngine.ts` — 事件队列 + 订阅 + `pending` Map（xid/Promise 关联），六个 processor 待按 WF-3 迁移顺序接入。
- **i18n（WF-R1）**：`src/i18n/`（react-i18next，中文默认 `lng:'zh'`，`locales/zh.json`/`en.json`）。
- **遗留代码隔离**：原 vanilla `src/*`（processors/services/lib/components/...）整体迁入 `src/legacy/`，解决 `app.js` 与 `App.tsx` 在大小写不敏感文件系统上的命名冲突，使 React 工程独占 `src/` 顶层；迁移按 WF-3/WF-14 逐文件端口。

验证：构建通过；`App.tsx` 为占位（i18n 标题），真实界面由 WF-4/9/5 落地。解锁：WF-6（设备级自动配置）、WF-11（终端组件，仍受 WF-3 阻塞现已全解锁）。
