# 安装蓝本（Install Blueprint）

> 本文件是 devenv-manager **安装 / 切换 / 卸载 / 纳管** 逻辑的权威蓝本。
> 后续新增任意软件（Maven、Node、MySQL、Redis、Git、Docker…）均以此为准，
> 与当前代码实现保持一致（最后核对：2026-07-09，Plan B）。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| 作用域 | 所有环境变量只写**系统变量（HKLM）**，**绝不写用户变量（HKCU）**。 |
| 单一真相源 | 多版本清单由 `devenv.yaml` 的 `tools[]` **文件化**持久化；注册表不再写「版本固定变量」（`JAVA_HOME17` 等）。 |
| 激活变量 | `JAVA_HOME` 直接写**绝对路径**；切换时只改这一项。 |
| PATH 引用 | 固定为 `%JAVA_HOME%\bin`（单层展开即到绝对路径，PowerShell/cmd 均正确）。 |
| 相互独立 | 下载目录（`downloadDir`）与安装目录（`installDir`/每工具 `targetDir`）相互独立、各自全局或单次指定。 |

---

## 2. 安装流程（installTool）

```
校验 → 获取安装包(在线下载/离线复制) → 解压 → 配置环境变量 → 验证 → 写配置
```

1. **路径规划**
   - 下载目录：`planDownloadDir(cfg)` = `cfg.downloadDir` 或默认 `<rootDir>/data/download`（按需懒创建）。
   - 安装目录：
     - 若调用方指定 `targetDir`（精确文件夹，需求 #4）→ 直接作为 `destDir`；
     - 否则 `planInstallDir(planInstallBaseDir(cfg), category, tool, version)` = `<installDir>/<类别>/<tool><version>`。
   - 单次路径覆盖（`params.downloadDir/installDir/targetDir`）仅本次生效，**不持久化**到 `devenv.yaml`。
2. **环境变量写入（Plan B）**
   - **活跃版**：`JAVA_HOME = <绝对路径>`；PATH 收敛为唯一 `%JAVA_HOME%\bin`（清理旧绝对 binPath / 遗留 `%JAVA_HOME<ver>%\bin` 引用）。
   - **非活跃版**（多版本共存）：仅写 `devenv.yaml`，**不写** `JAVA_HOME`、**不进** PATH；激活时由切换逻辑自动上 PATH。
3. **回滚**：失败则删除已解压目录 + 恢复环境变量快照（仅还原真实写入过的变量）。

---

## 3. 切换流程（switchVersionRef）

- 设 `JAVA_HOME = <目标版绝对路径>`（仅改这一项）。
- 更新 `devenv.yaml` 的 `active` 标记（路径用「JAVA_HOME 绝对路径与版本 path 匹配」实时校正，不依赖缓存）。
- PATH **永不因切换而重写**（始终 `%JAVA_HOME%\bin`）。
- 多版本清单来自 `devenv.yaml`，不再依赖注册表版本变量。

---

## 4. 卸载流程（uninstallTool，需求 #3）

两步：
1. **更新配置**：从 `devenv.yaml` 的 `tools[]` 移除该记录并保存。
2. **清理文件与目录**：
   - **环境变量**：移除其 PATH 条目（绝对 binPath + 遗留 `%HOME<ver>%\bin` 引用）；若卸载的是**当前活跃版本**，自动把 `JAVA_HOME` 重新指向同类其它版本（Plan B 绝对路径），无其它版本时才清空 `JAVA_HOME`。
   - **删除文件**：受**安全闸门 `isSafeDeletePath`** 约束——
     - ✅ 允许：位于软件数据根目录之下（本软件安装的必然在此）、或用户自选的非禁区目录（如 `E:\Software\...`）。
     - ❌ 拒绝：个人目录（Desktop/Downloads/Documents/…）、系统关键目录（`SystemRoot`、Program Files、ProgramData、盘符根、C:\）。
     - 拒绝自动删除时**仅清记录与环境变量**，文件保留，提示用户手动清理（避免误删不可逆）。
   - **清理空父目录（向上回溯）**：文件删除成功后，从被删目录的父级开始逐级删除**确为空的**目录，直到：
     - 到达**安全底线**（绝不删）：工具路径位于自定义 `installDir` 之下 → 底线即 `installDir`（如 `E:\Software`）；否则位于 `rootDir` 之下 → 底线即 `rootDir`；否则（路径在受控根之外，如 `C:\Apps\...`）**不向上清理任何父级**（外部软件更保守）。
     - 遇到**非空目录**即停（避免误删同级其它工具/数据）。
     - 每层再经 `isSafeDeletePath` 复核（纵深防御）。
     - 该逻辑由 `uninstall.ts` 的 `pruneEmptyParents` 实现，已被单测覆盖（内部工具清理空类别目录但保留安装基、同级非空不误删、受控根之外外部软件不越界）。

> 两类软件均可卸载：本软件安装的（`mode=online/offline`）+ 电脑上已存在被「纳管」的（`mode=external`）。

### 删除边界（用户须知）

卸载时的「文件删除」有严格边界，避免误删不可逆数据：

| 行为 | 规则 |
|---|---|
| **软件自身目录** | 本软件安装的工具（`online/offline`）默认删除；外部纳管工具（`external`）需勾选「同时删除安装目录文件」且通过安全闸门才删。 |
| **空父目录（如空的类别文件夹）** | 卸载成功后，因本次卸载而**变为空**的上层目录会一并清理（例如卸载最后一个 JDK 后，空的 `java/` 类别目录被删）。 |
| **清理上限** | 空目录清理**只到安装基目录为止**（`installDir` 或数据根 `rootDir`），绝不删安装基目录本身。 |
| **绝不删除** | ① 个人目录（Desktop/Downloads/Documents…）② 系统关键目录（`SystemRoot`、Program Files、ProgramData、盘符根、C:\）③ 受控根之外的共享目录（如 `E:\Software` 本身）④ 仍含其它工具的**非空**目录。 |
| **保护目录兜底** | 若软件落在保护目录（如 Program Files、用户目录），**不自动删文件**，仅清配置记录与环境变量，并提示用户手动清理。 |
| **纵深防御** | 每一层待删目录都再经安全闸门 `isSafeDeletePath` 复核，任一不过即停。 |

> 一句话总结：**软件目录必清（受控内默认、外部需确认），空父目录顺手清到安装基为止，个人/系统/共享根永不碰。**

---

## 5. 纳管「电脑上已存在的软件」（需求 #2）

- 扫描引擎 `scanSystem()` 基于 `REGISTRY` 发现系统已装 dev 工具（JDK/Maven/Node…）。
- 用户在「软件管理」页对未纳管的 detected 工具点「纳管」，或「+ 纳管现有软件」手动指定类型/版本/目录。
- 纳管 = 新增一条 `InstalledTool`（`mode:'external'`，`active:false`，`addedToPath:false`）到 `devenv.yaml`，**不写环境变量**。
- 随后可在同一界面「设为默认」（走 `switch:detected` 激活并写环境）或「卸载」。
- `dashboard:tools` 合并 `config.tools`（已纳管，含 external）与扫描缓存（detected），**同一列表集中展示与操作**。

---

## 6. 配置 Schema（devenv.yaml）

```yaml
tools:
  - id: java/jdk/17.0.9
    tool: jdk
    name: JDK
    category: java
    version: 17.0.9
    mode: online | offline | external   # external = 电脑上已存在、被纳管
    path: <安装目录绝对路径>
    binPath: <bin 子目录，拼到 PATH>
    homeVar: JAVA_HOME
    active: true | false
    addedToPath: true | false
    installedAt: ISO
    versionVar: JAVA_HOME17   # 仅展示/迁移标签，不写注册表
downloadDir: <可选，全局下载目录>
installDir:  <可选，全局安装基目录>
applyEnv: true   # 是否写系统环境变量（false=测试模式仅预览）
```

---

## 7. 新增一个软件的步骤（对照范本）

1. 在 `src/tools/registry.ts` 增加 `ToolSpec`（tool/name/category/homeVar/binaries/versionRegex/scanDirs/remoteVersions/buildUrl）。
2. 引擎层 `installTool` / `switchVersionRef` / `uninstallTool` **无需改**（通用）。
3. 前端 `TOOLS` / `TOOL_META` 增加该工具，HOME 变量映射复用 `getEffectiveHomeVar(tool, specHomeVar)`。
4. 运行 `npx tsc --noEmit` → `npx vitest run` → `npm run build:electron` → `npm run build`。
