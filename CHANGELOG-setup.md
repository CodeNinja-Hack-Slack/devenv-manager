# 安装根目录去硬编码（2026-07-07）

## 用户诉求
> 默认安装目录不要写死，这个安装目录应该由用户自己进行配置。

## 改动清单

### 1. Mock 层不再写死根目录（`src-ui/api.ts`）
- 原：`initRoot()` 硬编码 `configured: true, rootDir: 'E:\\a'`，且 `getConfig/scan/envList` 全部写死 `E:\a`。
- 改：Mock 根目录改为存 `localStorage`（key `devenv.mock.root`）；`initRoot()` 默认 `configured: false`。
  所有 Mock 数据（已安装工具路径、扫描结果、环境变量 `JAVA_HOME/MAVEN_HOME/PATH`）均通过 `withRoot(parts)` 基于用户配置的根目录**动态拼接**，不再出现任何硬编码盘符/目录。

### 2. 新增首次配置引导（`src-ui/components/SetupWizard.tsx` + `src-ui/App.tsx`）
- 当 `configured === false` 时，App 不再直接进入主界面，而是渲染全屏 `SetupWizard`：
  - 文案明确「该目录完全由你决定，软件不会使用任何预设默认路径」
  - 输入框（placeholder 仅为示例提示，非默认值）+ 桌面端「浏览…」按钮调用 `api.pickFolder()`
  - 确认后 `api.setRoot(root)` → `store.init()`，`configured` 置真后自动进入主界面
- 预览模式下用户配置一次后存 `localStorage`，刷新仍有效。

### 3. 真实层补充文件夹选择器（`electron/ipc/handlers.ts` + `electron/preload.ts`）
- 新增 `dialog:pickFolder`：桌面端调用系统文件夹选择器（`openDirectory` + `createDirectory`）。
- `preload.ts` 暴露 `pickFolder()` 桥接。

### 4. 环境变量页改用统一 API（`src-ui/pages/EnvManager.tsx`）
- 原：`EnvManager` 自己写死一份假环境变量（`E:\a\...`），绕过了 `api.envList()`。
- 改：统一走 `api.envList()`（桌面端返回真实系统变量，预览端返回基于用户根目录的 Mock）。

### 5. 引导页样式（`src-ui/styles/premium.css`）
- 补充 `.setup-screen / .setup-card / .logo` 等玻璃拟态卡片样式。

## 行为对比

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 浏览器预览启动 | 直接显示假 `E:\a` 数据 | 显示「请指定根目录」引导，配置后显示该目录下的 Mock 数据 |
| 桌面端首次启动 | 同上（若未建 root 文件也显示假数据） | `config:init` 返回 `configured:false` → 引导用户选目录 |
| 根目录来源 | 代码写死 `E:\a` | 仅由用户配置（存 `devenv-root.txt` / `localStorage`） |
| 环境变量页 | 写死假值 | 真实系统变量 / 基于用户根目录的 Mock |

## 验证
- `vite build`（UI）✅
- `npm run build:electron`（主进程 + 预加载打包）✅
- `vitest` 39/39 通过 ✅
