---
id: WF-R1
title: i18n 库选型（研究）
type: research
status: closed
assignee: "wayfinder-charting"
resolved: "2026-08-27"
blocked_by: []
blocks: [WF-8, WF-9]
labels: wayfinder:research
---

## Question

对比 React + TypeScript 下的 i18n 方案：**react-i18next / lingui / formatjs(intl)**，在「中文默认、可切多语言、与组件库集成、提取工作流、包体积、运行时动态切换」维度给出推荐。

## Resolution

- **推荐：react-i18next**。
- **理由**：生态最大、文档与插件最全，中文社区资源最多；`i18next.changeLanguage` 支持运行时动态切换；与 Ant Design / Arco 的 `ConfigProvider` locale 可组合；支持插值/复数/嵌套，满足文案提取工作流。
- **取舍**：包体比 lingui 大；建议配合 `i18next-scanner` 或基于 key 的显式资源文件管理，避免散落硬编码。lingui 包体更小、编译期提取更优，但生态与中文资料较少——若后期极重视包体可再评估。
- **落地要点（供 WF-8）**：默认 `lng: 'zh'`，资源文件 `locales/zh.json` / `en.json`；协议名/命令名（ping/dhcp/arp）是否在 UI 翻译需与 WF-9 设计系统统一决策（建议保留命令原名、翻译描述性文案）。
