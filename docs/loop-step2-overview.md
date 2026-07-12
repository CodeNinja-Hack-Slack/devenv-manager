# devenv-manager · Loop Engineering 落地总结

> 以 Loop Engineering（意图 → 上下文 → 行动 → 观察 → 调整 的闭环）驱动项目至"完成"：
> 把 6 款仅骨架、未经验证的工具逐一走完"搜官方教程 → 精炼 ToolSpec → 补前端接线 → 补单测 → 验证绿"的循环。

## 已落地（8/8 工具 ToolSpec 全部按官方 Windows 教程核实）

| 工具 | HOME 变量 | binSubdir | 版本命令 | 安装后动作 | 状态 |
|---|---|---|---|---|---|
| jdk | JAVA_HOME | bin | java -version | — | 已验证（基线） |
| redis | REDIS_HOME | ''（根目录型） | redis-server --version | 不注册服务 | 已验证 |
| maven | MAVEN_HOME | bin | mvn -v | 依赖 JAVA_HOME | ✅ 本轮核实 |
| gradle | GRADLE_HOME | bin | gradle -v | 依赖 JAVA_HOME | ✅ 本轮核实 |
| node | NODE_HOME* | ''（根目录型） | node --version | — | ✅ 本轮修 bug |
| mysql | MYSQL_HOME | bin | mysql -V | my.ini + mysqld --initialize + 服务注册（待增强） | ✅ 本轮核实 |
| git | GIT_HOME* | bin | git --version | — | ✅ 本轮核实 |
| docker | DOCKER_HOME* | ''（检测/纳管型） | docker --version | Docker Desktop 单一安装 | ✅ 本轮修 scanDirs |

\* 无显式 homeVar，切换时由 `getEffectiveHomeVar` 派生。

## 本轮修复的真实 bug

1. **node `binSubdir` 误写 `'bin'`** → Windows 便携版 `node.exe` 在解压根目录，应为 `''`，否则 `%NODE_HOME%\bin` 指向不存在目录。已修正。
2. **mysql `buildUrl` 写死 `MySQL-8.0`** → 8.4.0 链接错误；改为按版本选系列目录（`8.0`/`8.4`）。
3. **docker `scanDirs` 指向错误位置** → 真实二进制在 `Docker\Docker\resources\bin`；已修正。
4. **`readVersion` 路径回退正则跨平台失效** → 原 `[/-]...(\d...)` 在 Windows 上：① 不含反斜杠（node/git 等 `\` 前缀目录名解析失败）；② 不允许版本 `v` 前缀（node 目录名 `node-v18.20.4`）。改为 `/[\\/-](?:apache-)?(maven|mysql|gradle|node|jdk|redis|git|mingit|docker)[-_]?(?:v)?(\d[\d.]*)/i`，并加 `mingit` 关键字。

## 验证结果（全绿）

- `npx tsc --noEmit` → **0 错误**
- `npx vitest run` → **94/94**（基线 69 → +25：maven4 / gradle4 / node4 / mysql5 / git4 / docker4）
- `npm run build:electron` → `out/main.js` 99.1kb + `out/preload.cjs` 4.5kb
- `npm run build` → `dist-ui/` 重建（324kb JS / 15.7kb CSS）

## 前端接线（齐全）

- `Scanner.tsx` `TOOL_META`：含全部 8 工具（name/category/homeVar）。
- `Install.tsx` `homeVarOf`：jdk/maven/gradle/mysql/redis 映射齐全（node/git/docker 无 homeVar，符合设计）。
- `api.ts` mock `listRemote`：8 工具远程版本列表已对齐 registry。

## 草稿循环自动化（Loop 第②步）

- ID `automation-1783612354364`（PAUSED，待用户激活/手动触发）：每天自动挑下一款待验证工具，搜官方教程→精炼→接线→单测→tsc/vitest 绿，仅写源码、不碰系统环境。
- 由于 6 款工具已在本轮手动闭环全部落地，该自动化后续可接管"新增 Go/Python 等"的草稿循环。

## 剩余可增强项（非阻塞，不满足不改也已完成）

- MySQL 安装后自动初始化（my.ini / `mysqld --initialize` / 服务注册）。
- 新增 Go / Python 等更多工具（按"先搜官方教程"纪律）。
- Loop 第③步：上 Maker-Checker 双 Agent 审查。
- Loop 第④步：自主度演进（双 Agent 通过即落地，高风险操作仍人工审批）。
