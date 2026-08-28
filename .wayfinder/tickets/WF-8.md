---
id: WF-8
title: i18n 落地与全中文
type: task
status: closed
assignee: "main"
blocked_by: []
blocks: []
labels: wayfinder:task
---

## Question

落地面板/菜单/终端/报错等**全部界面文案为中文（默认）**；抽取原硬编码的西/英文案到 locale 资源；接入 **WF-R1** 选定库。保留可切回英文/多语言的能力。

## Notes

- 原 UI 字符串散落在各 `components/*` 与 `lib/*`，需系统抽取。
- 协议名/命令名（ping、dhcp、arp）等是否翻译需与 WF-9 设计系统统一决策。
## Resolution

i18n 落地完成（2026-08-28，构建 + 无头浏览器实测通过）：

- **文案抽取**：原型全部界面文案（标题栏/设备栏/配置抽屉/报文追踪/报文详情分层字段/演示命令/终端/租约）接入 react-i18next；`zh.json`（默认）+ `en.json` 约 110 个 key。
- **协议名/命令名保留原文**（ARP/ICMP/Ping 等，WF-9 既定）；ping 命令输出保持惯例英文（系统输出），界面框架文案全中文。
- **初始化顺序修复**：`main.tsx` 改为先 `import './i18n'` 再 `import App`，保证模块级 `i18n.t`（种子报文文案）取到译文——浏览器实测 `谁有 192.168.1.1？…` 由 i18n 生成 ✅。
- **用法分层**：组件内 `useTranslation`；模块级/事件处理器 `i18n.t`；插值用 i18next `{{param}}`。
- **多语言能力**：由 i18next `changeLanguage` 原生提供，运行时切换即可生效（`en.json` 已备）；语言切换器 UI 留待正式实现加。

实测：中文渲染 ✅、无裸 key 泄漏 ✅、种子文案 i18n 生成 ✅、构建通过 ✅。
