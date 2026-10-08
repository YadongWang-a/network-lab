# NetLab

[English](README.md) · **中文**

## 基于 Web 的网络模拟器（React + TypeScript）

Developed by Amín Pérez | May 2025

> **Fork 说明**：NetLab 是 **PackeTTrino**（作者 José Amín Pérez Alconchel，GPL-3.0）的改名分支，
> 于 2026-09-16 重写为 React + TypeScript。

---

## 项目简介

**NetLab** 是一个纯前端、可交互的网络模拟器，使用 React + TypeScript 构建、由 Vite 驱动。仿真内核（`src/engine`、`src/domain`、`src/parsers`）没有任何运行时依赖 —— 协议行为是自行实现的，而不是从网络库中引入的。你可以在浏览器里实时设计、仿真并分析计算机网络，动手体会网络协议、路由与设备通信的过程。

## 主要功能

- **完整的网络仿真**：用多种网络设备搭建自定义拓扑
- **已实现的协议**：DHCP、DNS、TCP/IP、ICMP、ARP 等
- **动态路由**：实时仿真路由协议
- **报文可视化**：直观跟踪报文在网络中的流动
- **集成工具**：Linux 风格终端、Web 浏览器、抓包分析器
- **可配置防火墙**：编写并应用防火墙规则，实时反馈
- **直观界面**：用于管理设备与服务的控制面板

## 可用的网络组件

- PC 与工作站
- 交换机
- 路由器
- DHCP 服务器
- DHCP 中继代理
- DNS 服务器
- Web 服务器（Apache2）

## 快速开始

### 环境要求

- **Node.js 24.x** —— 构建链的下限。Vite 8 声明 `^20.19.0 || >=22.12.0`，Vitest 5 声明 `^22.12.0 || ^24.0.0 || >=26.0.0`，Node 24 同时满足两者，CI 也用 Node 24。
- **pnpm 10.18.1** —— 由 `package.json` 的 `packageManager` 字段锁定。
- **现代浏览器**（Chromium、Firefox 或 Safari）。
- **需要联网一次**，用于 `pnpm install`；之后全部离线运行。

### 一、安装 Node.js

#### Windows（推荐路径）

Windows 10 1809+ 与 Windows 11 自带 `winget`。在 **PowerShell** 中执行：

```powershell
winget install OpenJS.NodeJS.LTS        # 当前装到 Node.js 24.20.0
```

**关掉再重开终端**（PATH 只对新启动的进程生效），然后验证：

```powershell
node -v      # v24.x
npm -v
where.exe node   # C:\Program Files\nodejs\node.exe
```

另外两种方式：

- **MSI 安装包** —— 从 <https://nodejs.org/> 下载 LTS x64 `.msi`，安装程序会自动写入 PATH，全程无需命令行。
- **版本管理器** —— 需要在多个 Node 版本之间切换时使用：

  ```powershell
  winget install CoreyButler.NVMforWindows   # nvm-windows，机器级安装，安装时会要管理员权限
  winget install Schniz.fnm                  # fnm，用户级，无需管理员
  winget install Volta.Volta
  ```

  用 nvm-windows 时，`nvm use` 同样需要**管理员**终端 —— 它通过目录符号链接把 `C:\Program Files\nodejs` 指到目标版本：

  ```powershell
  nvm install 24.20.0
  nvm use 24.20.0
  ```

  用 fnm 时，先把 shell 钩子写进 PowerShell profile（用 `Invoke-Item $profile` 打开该文件），之后进入项目目录会自动切换版本：

  ```powershell
  fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
  ```

#### macOS

```bash
brew install node@24          # 或者：brew install nvm && nvm install 24
```

#### Linux

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24
```

### 二、安装 pnpm

**方式 A —— Corepack（推荐）。** Corepack 随 Node.js 一起安装，会直接读取 `package.json` 中锁定的版本，因此永远不会偏离 `10.18.1`：

```powershell
corepack enable pnpm
pnpm -v          # 10.18.1
```

`corepack enable` 会把 shim 写在与 `node.exe` 同级的目录（标准安装即 `C:\Program Files\nodejs`），所以需要**一次管理员终端**。没有管理员权限时，可以二选一：

把 shim 装到自己的用户目录：

```powershell
corepack enable --install-directory "$env:LOCALAPPDATA\corepack-shims"
$env:Path += ";$env:LOCALAPPDATA\corepack-shims"     # 仅当前会话；永久生效请到「系统属性 → 环境变量」添加上面这个目录
```

或者干脆不用 shim，每条命令都加前缀：

```powershell
corepack pnpm install
corepack pnpm dev
```

**方式 B —— npm 全局安装。** 无需管理员，并会沿用你已有的 registry 配置：

```powershell
npm install -g pnpm@10.18.1      # 装到 %APPDATA%\npm
```

**方式 C —— `winget install pnpm.pnpm`。** 可用，但目前装的是 **pnpm 12.8.1**，不是锁定的 10.18.1，因此不推荐。

macOS / Linux 上用 `corepack enable pnpm`，或 `brew install pnpm`。

### 三、安装依赖并启动开发服务器

```powershell
pnpm install
pnpm dev
```

然后打开 **<http://127.0.0.1:5273/>**。

开发服务器绑定 `127.0.0.1:5273` 且 `strictPort: true` —— 端口被占用时 Vite 会直接退出，而不会另选端口，所以请释放端口或修改 `vite.config.ts`。

### 四、其他命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Vite 开发服务器，`127.0.0.1:5273`（热更新） |
| `pnpm build` | 类型检查（`tsc --noEmit`）后打包到 `dist/` |
| `pnpm test` | Vitest 单元/集成测试（`tests/**/*.test.ts`） |
| `pnpm test:watch` | Vitest 监听模式 |
| `pnpm e2e` | Playwright 冒烟测试。首次需先执行 `pnpm exec playwright install chromium`；配置会自动拉起 `pnpm dev` |
| `pnpm lint` | ESLint |

## Windows 常见问题与排错

**提示 `pnpm` 不是内部或外部命令** —— PATH 只对新启动的进程生效，请重开终端，并用 `where.exe pnpm` 确认。

**`corepack enable` 报拒绝访问 / EPERM** —— 它要写入 Node.js 安装目录。改用管理员终端，或用「二」中的免管理员方案。

**`pnpm.ps1 cannot be loaded because running scripts is disabled on this system`** —— PowerShell 执行策略拦下了 shim，无需管理员即可修复：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

或者直接用 `pnpm.cmd` 代替 `pnpm`，或在 `cmd.exe` 中执行。

**启动开发服务器时报 `os error 193` / `不是有效的 Win32 应用程序`** —— 有工具在**没有 shell** 的情况下启动了 `pnpm`。npm 安装的是 `pnpm.cmd`/`pnpm.ps1` 包装脚本而非 `.exe`，Windows 无法直接 `CreateProcess`。请从 shell 启动，或绕过 shim：

```powershell
node node_modules/vite/bin/vite.js
```

**端口 5273 被占用** —— `strictPort: true` 是故意让失败暴露出来：

```powershell
netstat -ano | findstr :5273     # 最后一列是 PID
taskkill /PID <pid> /F
```

也可以修改 `vite.config.ts` 里的 `server.port`。

**pnpm store 不在同一个盘符** —— pnpm 会从内容寻址存储硬链接到 `node_modules`，而硬链接不能跨盘符：

```powershell
pnpm store path                              # 例如 D:\.pnpm-store\v11
pnpm config set store-dir D:\.pnpm-store     # 指到仓库所在盘
```

**路径含中文或空格没有问题** —— 全流程（`pnpm install`、`pnpm dev`、`pnpm test`、`pnpm e2e`、`pnpm build`）都已在 `D:\项目开发\network-lab` 下实测通过。

**`pnpm install` 慢或超时** —— 指向国内镜像：

```powershell
pnpm config set registry https://registry.npmmirror.com
```

（`registry.npm.taobao.org` 是淘宝源的老域名，建议改用上面的新域名。）

## 使用说明

1. 启动开发服务器（`pnpm dev`），打开 <http://127.0.0.1:5273/>
2. 从侧边面板把设备拖拽到工作区
3. 用网线连接设备
4. 配置设备属性（IP 地址、子网掩码等）
5. 用动画控制查看报文流动
6. 查看路由表、ARP 表、DNS 表、DHCP 租约等状态表，监控网络状态

![image](https://github.com/user-attachments/assets/0876157d-8527-45b8-bf6f-0bfe4fe8b291)

## 进阶功能

- **报文类型可视化**：不同报文类型（广播、单播、TCP、DNS 等）用颜色区分
- **状态表**：实时查看 ARP 表、MAC 表、路由表、DNS 缓存、DHCP 租约
- **调试工具**：内置终端，支持常用 Linux 网络命令（`ping`、`traceroute`、`ip`、`arp` 等）
- **深色模式**：支持浅色与深色主题

![image](https://github.com/user-attachments/assets/c7e60ec2-6cd7-427c-97ef-9e28f68209d2)

## 关于本项目

本项目最初作为**网络系统管理高级职业培训**的毕业设计完成，原版是一个不依赖任何库的 HTML/CSS/JavaScript 应用。当前版本为重写版：界面使用 React + TypeScript，仿真与协议逻辑仍全部自行实现。

---

## 关键词（SEO）

`网络模拟器`, `network simulator`, `javascript networking`, `typescript network simulator`, `react network simulator`, `vite`, `教学工具`, `packet tracer alternative`, `web-based network lab`, `DHCP DNS TCP IP simulator`, `open source network simulator`, `firewall configuration`, `interactive network tool`
