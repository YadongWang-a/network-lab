# NetLab

**English** · [中文](README.zh-CN.md)

## Web-Based Network Simulator (React + TypeScript)

Developed by Amín Pérez | May 2025

> **Fork notice**: NetLab is a renamed fork of **PackeTTrino** by José Amín Pérez Alconchel
> (GPL-3.0). Renamed and rewritten to React + TypeScript on 2026-09-16.

---

## Description

**NetLab** is a fully interactive network simulator built with React + TypeScript on Vite. The simulation core (`src/engine`, `src/domain`, `src/parsers`) has no runtime dependencies — protocol behaviour is implemented from scratch rather than pulled from a networking library. It allows you to design, simulate, and analyze computer networks in real time. It provides a hands-on experience for learning networking protocols, routing, and device communication.

## Key Features

- **Complete Network Simulation**: Design custom topologies with various network devices  
- **Implemented Protocols**: DHCP, DNS, TCP/IP, ICMP, ARP, and more  
- **Dynamic Routing**: Real-time simulation of routing protocols  
- **Packet Visualization**: Track packet flow through the network visually  
- **Integrated Tools**: Linux-style terminal, web browser, and packet analyzer  
- **Configurable Firewall**: Create and apply firewall rules with live feedback  
- **Intuitive Interface**: Control panel for managing devices and services  

## Available Network Components

- PCs and workstations  
- Switches  
- Routers  
- DHCP servers  
- DHCP relay agents  
- DNS servers  
- Web servers (Apache2)  

## Getting Started

### Requirements

- **Node.js 24.x** — the toolchain floor. Vite 8 declares `^20.19.0 || >=22.12.0`, Vitest 5 declares `^22.12.0 || ^24.0.0 || >=26.0.0`. Node 24 satisfies both, and is what CI runs.
- **pnpm 10.18.1** — pinned by the `packageManager` field in `package.json`.
- **A modern browser** (Chromium, Firefox or Safari).
- **Network access once**, for `pnpm install`. Nothing after that needs it.

### 1. Install Node.js

#### Windows

`winget` ships with Windows 10 1809+ and Windows 11. In **PowerShell**:

```powershell
winget install OpenJS.NodeJS.LTS        # → Node.js 24.20.0 at the time of writing
```

Close and reopen the terminal — PATH is only re-read by new processes — then verify:

```powershell
node -v      # v24.x
npm -v
where.exe node   # C:\Program Files\nodejs\node.exe
```

Two alternatives:

- **MSI installer** — grab the LTS x64 `.msi` from <https://nodejs.org/>. It registers PATH itself and needs no command line.
- **Version manager**, if you need to switch Node versions per project:

  ```powershell
  winget install CoreyButler.NVMforWindows   # nvm-windows; installs machine-wide, expects an Administrator shell
  winget install Schniz.fnm                  # fnm; per-user, no admin
  winget install Volta.Volta
  ```

  With nvm-windows, `nvm use` also needs an Administrator terminal — it repoints `C:\Program Files\nodejs` via a directory symlink:

  ```powershell
  nvm install 24.20.0
  nvm use 24.20.0
  ```

  With fnm, add the shell hook to your PowerShell profile once (`Invoke-Item $profile`) and you get automatic per-directory switching:

  ```powershell
  fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
  ```

#### macOS

```bash
brew install node@24          # or: brew install nvm && nvm install 24
```

#### Linux

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24
```

### 2. Install pnpm

**Route A — Corepack (recommended).** Corepack is bundled with Node.js and reads the pinned version straight out of `package.json`, so you can never drift from `10.18.1`:

```powershell
corepack enable pnpm
pnpm -v          # 10.18.1
```

`corepack enable` drops shims next to `node.exe` — `C:\Program Files\nodejs` for a standard install — so it needs an **Administrator** terminal once. Without admin rights, either install the shims into your own profile:

```powershell
corepack enable --install-directory "$env:LOCALAPPDATA\corepack-shims"
$env:Path += ";$env:LOCALAPPDATA\corepack-shims"     # current session; add it permanently via System Properties → Environment Variables
```

…or skip shims entirely and prefix commands:

```powershell
corepack pnpm install
corepack pnpm dev
```

**Route B — npm global.** Runs without admin and honours your existing registry configuration:

```powershell
npm install -g pnpm@10.18.1      # installs to %APPDATA%\npm
```

**Route C — `winget install pnpm.pnpm`.** Works, but currently ships **pnpm 12.8.1**, not the pinned 10.18.1 — prefer Route A.

On macOS/Linux use `corepack enable pnpm`, or `brew install pnpm`.

### 3. Install dependencies and start the dev server

```powershell
pnpm install
pnpm dev
```

Then open **<http://127.0.0.1:5273/>**.

The dev server binds `127.0.0.1:5273` with `strictPort: true` — if the port is taken, Vite exits instead of picking another one, so free the port or edit `vite.config.ts`.

### 4. Other commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server on `127.0.0.1:5273` (HMR) |
| `pnpm build` | Type-check (`tsc --noEmit`) then build to `dist/` |
| `pnpm test` | Vitest unit/integration tests (`tests/**/*.test.ts`) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm e2e` | Playwright smoke tests. Run `pnpm exec playwright install chromium` once first; the config boots `pnpm dev` itself |
| `pnpm lint` | ESLint |

## Windows Notes & Troubleshooting

**`pnpm` is not recognised** — PATH is only re-read by newly started processes. Reopen the terminal and check `where.exe pnpm`.

**`corepack enable` → access denied / EPERM** — it writes into the Node.js install directory. Use an Administrator terminal, or one of the non-admin routes in step 2.

**`pnpm.ps1 cannot be loaded because running scripts is disabled on this system`** — PowerShell's execution policy blocks the shim. Fix without admin:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Or type `pnpm.cmd` instead of `pnpm`, or run in `cmd.exe`.

**`os error 193` / `不是有效的 Win32 应用程序` when starting the dev server** — a tool spawned `pnpm` without a shell. npm installs a `pnpm.cmd`/`pnpm.ps1` wrapper, not an `.exe`, and Windows cannot `CreateProcess` it directly. Launch it from a shell, or bypass the shim entirely:

```powershell
node node_modules/vite/bin/vite.js
```

**Port 5273 already in use** — `strictPort: true` makes the failure loud on purpose:

```powershell
netstat -ano | findstr :5273     # last column is the PID
taskkill /PID <pid> /F
```

…or change `server.port` in `vite.config.ts`.

**pnpm store on another drive** — pnpm hard-links packages from a content-addressable store into `node_modules`, and hard links cannot cross drive letters.

```powershell
pnpm store path                              # e.g. D:\.pnpm-store\v11
pnpm config set store-dir D:\.pnpm-store     # point it at the repo's drive
```

**Non-ASCII or spaced paths are fine** — the whole flow (`pnpm install`, `pnpm dev`, `pnpm test`, `pnpm e2e`, `pnpm build`) has been run from `D:\项目开发\network-lab`.

**Slow or timing-out `pnpm install`** — point pnpm at a mirror close to you:

```powershell
pnpm config set registry https://registry.npmmirror.com
```

## How to Use

1. Start the dev server (`pnpm dev`) and open <http://127.0.0.1:5273/>  
2. Use the side panel to drag and drop devices into the workspace  
3. Connect devices with cables  
4. Configure device properties (IP addresses, subnet masks, etc.)  
5. Use animation controls to visualize packet traffic  
6. Inspect routing, ARP, DNS, and DHCP tables to monitor the network state  

![image](https://github.com/user-attachments/assets/0876157d-8527-45b8-bf6f-0bfe4fe8b291)

## Advanced Features

- **Packet Type Visualization**: Color-coded display for different packet types (broadcast, unicast, TCP, DNS, etc.)  
- **State Tables**: Live view of ARP, MAC, routing, DNS cache, and DHCP leases  
- **Debugging Tools**: Built-in terminal with common Linux network commands (`ping`, `traceroute`, `ip`, `arp`, etc.)  
- **Dark Mode**: Light and dark theme support  

![image](https://github.com/user-attachments/assets/c7e60ec2-6cd7-427c-97ef-9e28f68209d2)

## About the Project

This project was developed as a final year thesis for the **Advanced Vocational Training in Network Systems Administration**, originally as a dependency-free HTML/CSS/JavaScript application. The current version is a rewrite: React + TypeScript for the UI, with all simulation and protocol logic still self-implemented.

---

## Keywords (for SEO)

`network simulator`, `javascript networking`, `typescript network simulator`, `react network simulator`, `vite`, `educational tool`, `packet tracer alternative`, `web-based network lab`, `DHCP DNS TCP IP simulator`, `open source network simulator`, `firewall configuration`, `interactive network tool`
