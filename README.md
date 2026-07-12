# DevEnv Manager · 开发环境管理器

> 统一开发环境管理工具，解决换工作 / 换电脑时反复手动安装配置开发环境的痛点。
> A unified dev-environment manager that removes the pain of re-installing and re-configuring toolchains when switching jobs or machines.

> 支持**在线自动下载**或**离线本地安装包**两种模式，所有工具落入统一目录并自动联动环境变量，支持多版本共存与一键切换。
> Supports **online auto-download** and **offline package** modes. Every tool lands in one root directory with auto-wired env vars, multi-version coexistence, and one-click switching.

---

## 技术栈 / Tech Stack

| 层 / Layer | 选型 / Choice | 理由 / Why |
|---|---|---|
| 桌面壳 / Shell | **Electron** | 跨平台桌面应用，UI 与引擎同语言（TypeScript），本环境可直接构建验证 |
| 渲染层 / Renderer | **React 18 + TypeScript + Vite** | 组件化、热更新、构建快 |
| 样式 / Styling | 手写 **Premium CSS**（玻璃拟态 / 渐变 / 磁吸 / 流畅过渡） | 不依赖 Tailwind，完全可控的高级质感 |
| 动画 / Animation | **Framer Motion** | 页面过渡、磁吸按钮、Toast |
| 引擎 / Engine | **纯 TypeScript（Node 内置 API）** | 零 Electron 依赖，`src/` 可被主进程与 Vitest 直接复用 |

> 若更看重分发体积，可平滑迁移到 Tauri（UI 代码完全复用，仅替换壳）。
> Can migrate to Tauri later (UI fully reusable, only the shell changes) if bundle size matters.

---

## 核心能力 / Core Capabilities

- [x] **环境扫描 / Environment Scan** — 检测 JDK / Maven / Gradle / Node / IDE / DB / Docker / Git / CLI 工具，展示名称·版本·路径·PATH 状态，可导出 JSON / Markdown
- [x] **统一目录管理 / Unified Layout** — 首次指定根目录，所有工具安装到 `{root}/{类别}/{工具}{版本}`，环境变量自动联动（JAVA_HOME / MAVEN_HOME / PATH）
- [x] **多版本共存与切换 / Multi-version & Switch** — 同类别多版本并存，一键切换默认版本
- [x] **根目录迁移 / Root Migration** — 修改根目录并批量更新环境变量指向
- [x] **双模式安装 / Dual-mode Install** — 在线（断点续传 + 多线程 + SHA256/MD5 校验）/ 离线（识别类型与版本），统一 cache 目录
- [x] **安装流水线 + 回滚 / Pipeline + Rollback** — 校验 → 获取 → 解压/安装 → 配环境 → 验证，失败自动回滚
- [x] **环境变量检视 / Env Var Inspector**（只读）— 聚焦展示各工具相关的 HOME 变量与 PATH 注入段，纯只读、零写操作
- [x] **配置方案 / Profiles**（规划中 WIP）— 把「工具→版本」组合存为命名方案、一键套用；创建 UI 待开发
- [x] **配置导入/导出 / Config I/O** — `devenv.yaml` 导入导出，换机快速重建
- [ ] **团队共享 / 插件扩展 / CI 同步** — 接口已预留，后续迭代

> 说明：早期规划的「环境健康检查」功能已移除，改为仅只读展示环境变量，避免自动改写 PATH / HOME。
> Note: the earlier "health check" feature was removed; the app now only inspects env vars read-only and never auto-modifies PATH/HOME.

---

## 目录结构 / Project Structure

```
devenv-manager/
├── package.json
├── vite.config.ts          # .js→.ts 解析插件，兼容 Vite/Vitest
├── electron/
│   ├── main.ts             # 主进程
│   ├── preload.ts          # 安全 IPC 桥 (window.devenv)
│   └── ipc/handlers.ts     # IPC → 引擎
├── src/                    # 引擎（纯 TS，可单测）
│   ├── types.ts
│   ├── config/store.ts     # devenv.yaml 读写 + 路径规划
│   ├── utils/              # version / checksum / logger / path
│   ├── platform/env.ts     # 环境变量抽象（Windows/Unix + DryRun）
│   ├── tools/registry.ts   # 工具注册表 + 检测
│   └── core/               # scanner / downloader / extractor /
│                           # installer / switch / profiles / recognizer
├── src-ui/                 # React 渲染层
│   ├── api.ts              # 桥接（桌面端 IPC / 浏览器 mock）
│   ├── store/useStore.ts   # zustand 状态
│   ├── components/         # GlassCard / MagneticButton / Sidebar / Toast / AmbientBackground
│   └── pages/              # Dashboard / Scanner / Install / Switch / Env / Profiles / Settings
└── tests/                  # Vitest 单元测试
```

---

## 快速开始 / Quick Start

```bash
# 1. 安装依赖 / Install dependencies
npm install

# 2. 运行桌面端 / Run the desktop app
npm run dev            # 浏览器预览 UI（使用 mock 数据，界面完全可演示）
                       # Browser preview with mock data — fully interactive UI
npm run electron:dev   # 构建 UI + 主进程并启动 Electron 桌面端（完整系统能力）
                       # Build UI + main process, launch Electron (full system access)

# 3. 运行测试 / Run tests
npm test               # 146 个 Vitest 单测 / 146 Vitest unit tests
```

### 从源码克隆 / Clone from source

```bash
git clone https://github.com/<your-github-username>/devenv-manager.git
cd devenv-manager
npm install
```

### CLI 用法（规划）/ CLI Usage (Planned)

```bash
devenv scan                 # 扫描已安装环境
devenv scan --export md     # 导出报告
devenv install jdk 17.0.9 --online --mirror java
devenv install jdk 17.0.9 --offline ./jdk-17.0.9.zip
devenv list --remote jdk    # 查看可下载版本
devenv switch java 17.0.9   # 切换默认版本
```

---

## 设计要点 / Design Highlights

- **工具注册表模式 / Tool Registry** — 每个工具一个 `ToolSpec`（类别 / HOME 变量 / 检测命令 / 下载模板 / 内置版本），新增工具只加一个声明。
- **安装流水线 + 回滚 / Pipeline + Rollback** — 每步失败清理已解压目录并恢复环境变量快照。
- **下载器 / Downloader** — `HEAD` 取大小 → 按线程切分 `Range` 并发下载 → 合并 → SHA256/MD5 校验；支持断点续传。
- **环境变量平台抽象 / Env Platform Abstraction** — Windows 用 `setx`（默认用户级，免管理员）/ Unix 写 shell rc；`DryRunEnv` 仅收集操作不落地，便于测试与回滚。
- **离线识别 / Offline Recognition** — 文件名正则优先，失败后读取包内版本文件，再失败弹窗手动指定。

---

## 测试覆盖 / Testing

`tests/` 下覆盖（共 146 例 Vitest）：版本解析/比较、路径规划、环境变量纯函数与 DryRun、离线包识别、下载分片与真实下载校验、解压扁平化、安装流水线（成功 + 回滚）、多版本切换与迁移计划、配置读写、注册表检测。

```bash
npm test          # 运行全部 146 例 / run all 146 cases
npx vitest watch  # 监听模式 / watch mode
```

---

## 开发与调试 / Development & Debugging

### 目录说明 / Layout notes
- **引擎层 `src/`**：纯 TypeScript，零 Electron 依赖，被主进程（Node）和 Vitest 复用。绝大多数逻辑 bug 在单测层暴露。
- **渲染层 `src-ui/`**：React UI，通过 `src-ui/api.ts` 调用能力。在浏览器里运行时 `window.devenv` 不存在，自动回退到 **Mock 数据**，界面完全可点可调试。
- **主进程 `electron/`**：打包后输出到 `out/`，加载 `dist-ui/index.html`（或设了 `VITE_DEV_SERVER_URL` 时加载 Vite 开发服务器）。

### 方式一：浏览器预览（最快，无需 Electron）/ Browser preview (fastest)
```bash
npm run dev          # 启动 Vite，自动打开 http://localhost:5173
```
- 支持热更新（HMR），改完即所见。调试 UI：浏览器按 F12 打开 DevTools。
- 适合：调 React 组件、Premium CSS、页面交互。

### 方式二：Electron 桌面端（真实系统能力）/ Electron desktop (real system access)
```bash
npm run electron:dev   # 构建 UI + 主进程，启动桌面端（加载 dist-ui，无 HMR）
```
- 首次需确保 `electron` 二进制已下载（正常 `npm install` 会下载）。**国内网络若卡在 "downloading electron..."**：二进制默认从 GitHub Releases 拉，常被墙/超时。`start.ps1` 已默认设置 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` 并强制重跑安装脚本；若仍失败，手动执行 `set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ && npm install electron`，或配置 `HTTP_PROXY/HTTPS_PROXY` 走代理后重跑脚本。
- 调试主进程：用 VSCode 「Debug Electron Main」配置（F5），断点可打在 `electron/main.ts`、`electron/ipc/handlers.ts`。
- 调试渲染进程：在桌面端窗口内按 **Ctrl+Shift+I** 打开 DevTools。

### 方式三：Electron + HMR（开发首选）/ Electron + HMR (recommended)
同时跑 Vite 开发服务器与 Electron，兼顾真实系统 API 与热更新：
```bash
.\start.ps1 -Mode hmr     # 或：先 npm run dev，再设 VITE_DEV_SERVER_URL 后 npm run electron:hmr
```

### 一键启动脚本 `start.ps1` / One-shot launcher
| 命令 / Command | 作用 / Purpose |
|---|---|
| `.\start.ps1` | **默认直接启动 Electron 桌面端（真实测试）** |
| `.\start.ps1 -NoBuild` | 跳过构建直接启动桌面端（产物已存在时，迭代真测更快） |
| `.\start.ps1 -Mode ui` | 浏览器预览（mock 数据） |
| `.\start.ps1 -Mode hmr` | Vite + Electron 热更新调试 |
| `.\start.ps1 -Mode test` | 跑 Vitest 引擎单测 |
| `.\start.ps1 -Mode build` | 生产构建 |

> 若 PowerShell 禁止运行脚本：`powershell -ExecutionPolicy Bypass -File .\start.ps1`

### 常见问题 / FAQ
- **双击 `start.ps1` 后窗口闪退**：脚本已用本地 `node_modules/.bin/electron.cmd` 启动（双击时 `node_modules/.bin` 不在 PATH，裸 `electron` 会找不到导致立即报错退出）；并在双击场景下自动停留窗口（`按回车键退出`）以便查看报错。若仍一闪而过，请改在已打开的终端里执行 `.\start.ps1`，或在资源管理器里右键该文件「用 PowerShell 运行」，错误会保留在窗口中。
- **卡在 "downloading electron..."**：见上方「方式二」镜像说明。

### VSCode 调试 / VSCode debugging
`.vscode/launch.json` 已内置「Debug Electron Main」：F5 自动 `build-electron` 并 `--inspect-brk` 启动，可在主进程打断点。渲染进程用窗口内 DevTools。

### 纯引擎验证（不看界面）/ Engine-only check
```bash
npm test               # 146 个引擎单测 / 146 engine tests
npx vitest watch       # 监听模式 / watch mode
```

---

## 许可证 / License

[MIT](LICENSE) © 2026 DevEnv Manager
