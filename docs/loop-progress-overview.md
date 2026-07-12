# Loop Engineering 推进总结（第③步 Maker-Checker + 工具补全）

> 以 Loop Engineering「意图→上下文→行动→观察→调整」闭环驱动，本轮完成两件事：
> 1. **第③步 Maker-Checker 双 Agent 审查**——独立校验已落地代码，发现并修复高危 bug；
> 2. **补全 Go / Python 工具**——项目覆盖度达 10/10。

## 一、Maker-Checker 审查修复（独立 Agent 价值凸显）

派独立 `senior-developer` Agent 作 Checker，对照 SKILL.md + MEMORY.md 审查。发现我此前写代码时漏掉的 **根目录型工具（redis/node）激活 PATH 引用硬编码 bug**，以及多个边界问题，全部修复：

| 严重度 | 位置 | 问题 | 修复 |
|---|---|---|---|
| 🔴 High | `handlers.ts` `switch:detected`(~378) | 硬编码 `` `%${homeVar}%\bin` `` → redis/node 激活后 PATH 指向不存在的 `%REDIS_HOME%\bin` | 改用 `planBinRef(homeVar, spec?.binSubdir ?? 'bin')` |
| 🟠 Med | `handlers.ts` `tool:add`(~444) / 返回 | binPath 硬编码 `\\bin`、尾随反斜杠 | 改 `planBinPath(payload.path, getSpec(tool)?.binSubdir ?? '')` |
| 🟠 Med | `installer.ts`(~174) | `if (spec.homeVar && active)` 漏写无 homeVar 工具(node/git/docker) 的 PATH | 改 `getEffectiveHomeVar(spec.tool, spec.homeVar)` 派生后门控 |
| 🟠 Med | `registry.guessHome` | `binSubdir=''` 时 `lastIndexOf('')` 返回整串（exe 当 home） | 改 `path.dirname(binPath)` |
| 🟡 Low | `Install.tsx` `homeVarOf` | 对 node/git/docker 返 '—'（预览误导） | 加 `NODE_HOME`/`GIT_HOME`/`DOCKER_HOME` |

**基线**：修复前 tsc 0 错 / vitest 94/94；修复后均正常。

## 二、Go / Python 落地（覆盖度 8 → 10 款）

按「先搜官方 Windows 教程核实差异化配置」最高优先级纪律落地：

- **Go**：`GOROOT` + `%GOROOT%\bin`（bin 在解压根下 bin 子目录），`go version` → `go version go1.22.5 windows/amd64`。
- **Python**：`PYTHONHOME` + 根目录直装（`binSubdir=''`，embeddable zip 的 python.exe 在根），`python --version` → `Python 3.12.4`。
- 扩展 `ToolCategory` 类型加 `'go'|'python'`（scanner `CATEGORY_LABEL` / path `CATEGORY_DIR` 同步补键）。
- 前端接线：`Install.tsx` TOOLS + homeVarOf、`Scanner.tsx` TOOL_META、`api.ts` listRemote 全部对齐。
- `readVersion` 路径回退正则加 `go|python` 关键词。

## 三、验证（全绿）

- `npx tsc --noEmit`：**0 错**
- `npx vitest run`：**102/102**（94 → 102，+8 例 Go/Python 检测布局 + 回退）
- `npm run build:electron`：`out/main.js` 100.7kb + `out/preload.cjs` 4.5kb ✅
- `npm run build`：`dist-ui` 重建（324.66kb JS / 15.72kb CSS）✅

## 四、当前项目状态

- **10/10 工具全落地**：jdk / redis / maven / gradle / node / mysql / git / docker / go / python，ToolSpec 均按官方教程核实 + 单测覆盖。
- **核心引擎已验证**：安装 / 切换 / 卸载 / 纳管 / 空父目录清理 / 根目录型工具 PATH 引用（经独立审查修复）。
- **Loop Engineering 进度**：① 固化 SKILL ✓｜② 草稿循环自动化(PAUSED) ✓｜③ Maker-Checker 审查 ✓｜④ 自主度演进（双 Agent 通过即落地）可选后续。
- **已知非阻塞增强**：MySQL 安装后自动初始化（my.ini / `mysqld --initialize` / 服务注册）；handler 层 IPC 单测补充。

## 五、踩坑记录

初分 `test_go` / `test_python` 两文件，跨文件并行时「命令失败路径回退」用例诡异失败（单独跑全过）。根因 vitest 同 worker 交错干扰，非代码 bug（debug 测试证明 `detectTool` 正确）。合并为单文件 `test_go_python.test.ts`（同文件内用例串行）解决——**此类检测布局测试建议合并到单文件，避免跨文件并行干扰**。
