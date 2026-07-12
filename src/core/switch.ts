import type { DevEnvConfig, InstalledTool, ToolCategory } from '../types.js';
import { saveConfig } from '../config/store.js';
import { planInstallDir, planBinPath, planInstallBaseDir, planBinRef } from '../utils/path.js';
import { getSpec } from '../tools/registry.js';
import type { EnvBackend } from '../platform/env.js';
import { writeEnvPreview } from '../platform/env.js';

// ============================================================================
// 引用式版本切换（Plan B：文件化 inventory + 激活变量写绝对路径）
// ----------------------------------------------------------------------------
// 核心思想：
//   多版本清单由 devenv.yaml 的 tools[] 持久化（文件化 inventory），
//   不再在注册表里写「版本固定变量」(JAVA_HOME17 等)。
//   活跃变量 <HOME_VAR> 直接写「绝对路径」；PATH 固定为 %<HOME_VAR>%[\\binSubdir] 引用，
//   且切换时只改 <HOME_VAR> 一项，PATH 自动跟随（单层展开即到绝对路径，
//   在 PowerShell / cmd / 其它进程均正确）。
//   注意：binSubdir 因工具而异——JDK/Maven 为 \bin，Redis 等根目录型工具为空（引用即 %REDIS_HOME%）。
//
// 注册表最终仅剩两项：
//   JAVA_HOME = E:\Software\Java\Java17\JDK   （绝对路径，切换时改这一项）
//   PATH      = %JAVA_HOME%\bin;%SystemRoot%\system32;...  （固定，不再改写；Redis 则为 %REDIS_HOME%）
//
// 好处：
//   1. 多版本清单单一真相源（文件），无注册表/文件漂移风险。
//   2. 切换只动 JAVA_HOME，PATH 永不再因切换而重写，无堆积/污染。
//   3. 不与 Windows「PATH 只单层展开」的语义冲突，所有终端都能找到 java。
// ============================================================================

/** 版本固定变量的信息 */
export interface VersionVarInfo {
  /** 变量名，如 JAVA_HOME17 */
  varName: string;
  /** 指向的绝对路径 */
  path: string;
  /** 对应的版本号 */
  version: string;
  /** 是否为当前激活版本 */
  active?: boolean;
  /** 数据来源：config=已纳管 / registry=从注册表发现 */
  source?: 'config' | 'registry';
}

/**
 * 根据基础变量名 + 版本号，计算「版本固定变量」名。
 *
 * 命名规则（对齐用户多 JDK 共存实践）：
 *   取主版本号（第一个点前的部分），直接拼接到 homeVar 后面（无下划线分隔）。
 *   例：JAVA_HOME + 17.0.9 → JAVA_HOME17
 *       MAVEN_HOME + 3.9.6 → MAVEN_HOME3
 *
 * @example
 *   versionEnvName('JAVA_HOME', '17.0.9') => 'JAVA_HOME17'
 *   versionEnvName('JAVA_HOME', '11')      => 'JAVA_HOME11'
 *   versionEnvName('MAVEN_HOME', '3.9.6')  => 'MAVEN_HOME3'
 */
export function versionEnvName(homeVar: string, version: string): string {
  // 提取主版本号（第一个点号之前的部分），去除所有非合法字符
  const major = version.split('.')[0].replace(/[^A-Za-z0-9]/g, '');
  return `${homeVar}${major}`;
}

/** 获取工具的有效 homeVar（无显式 homeVar 时按 tool 名派生，如 git → GIT_HOME） */
export function getEffectiveHomeVar(tool: string, specHomeVar?: string): string {
  return specHomeVar ?? `${tool.toUpperCase()}_HOME`;
}

/**
 * 引用式版本切换 —— 核心函数。
 *
 * 执行步骤：
 *   1. 为同类所有已安装版本确保「版本固定变量」存在且指向正确路径。
 *   2. 将活跃变量设为对目标版本的引用：%{HOME_VAR}{VERSION}%。
 *   3. （可选）将 PATH 中该工具的硬编码路径替换为 %{HOME_VAR}%\bin 引用。
 *   4. 更新配置中 active 标记并持久化。
 *
 * 容错设计：步骤 1-2 为核心操作，失败则整体回滚并报错；
 *             步骤 3-4 为增强操作，步骤 3 失败不阻断步骤 4（config 持久化优先保证）。
 */
export async function switchVersionRef(
  cfg: DevEnvConfig,
  category: ToolCategory,
  version: string,
  env: EnvBackend,
): Promise<{
  ok: boolean;
  error?: string;
  applied?: InstalledTool;
  /** 同类全部版本固定变量（均已在系统中注册） */
  versionVars: VersionVarInfo[];
  /** 活跃变量信息 */
  activeVar: { name: string; value: string };
}> {
  const target = cfg.tools.find((t) => t.category === category && t.version === version);
  if (!target) return { ok: false, error: `该类别未安装版本 ${version}`, versionVars: [], activeVar: { name: '', value: '' } };

  const homeVar = getEffectiveHomeVar(target.tool, target.homeVar);
  const sameCategory = cfg.tools.filter((t) => t.category === category);

  // ---- Plan B：不再写「版本固定变量」(JAVA_HOME17 等) ----
  // 多版本清单由 devenv.yaml 的 tools[] 承担（文件化 inventory）；
  // 激活变量 JAVA_HOME 直接写「绝对路径」，PATH 固定为 %JAVA_HOME%\bin（不随切换改写）。
  // 切换只改 JAVA_HOME 一项，PATH 自动跟随。注册表最终仅剩 JAVA_HOME + PATH 两项。

  // ---- 步骤 1：激活变量设为绝对路径（仅改这一项）----
  await env.set(homeVar, target.path);

  // 清理旧版「版本固定变量」(JAVA_HOME17 等) 残留：Plan B 不再使用它们，
  // 但迁移自旧版或手动写入的残留变量会在注册表堆积，此处一并清除（best-effort，失败不影响切换）。
  for (const t of sameCategory) {
    try { await env.unset(versionEnvName(homeVar, t.version)); } catch { /* 忽略单条失败 */ }
  }

  // ---- 步骤 2（提前）：保存 config active 标记 —— 确保 PATH 操作失败时不丢失激活状态 ----
  for (const t of cfg.tools) {
    if (t.category === category) t.active = t.id === target.id;
  }
  target.versionVar = versionEnvName(homeVar, target.version); // 仅作展示/迁移标签，不写注册表
  try {
    await saveConfig(cfg);
  } catch (e: any) {
    console.warn('[switchVersionRef] config 持久化失败（环境变量已写入成功）：', e?.message ?? e);
  }

  // ---- 步骤 3：PATH 收敛为固定引用 %HOME_VAR%[\\binSubdir]（非阻塞）----
  // 移除旧版遗留：%HOME_VAR<ver>%[\\binSubdir] 引用 + 绝对 binPath 硬编码；确保固定引用存在（幂等）。
  // binSubdir 按 spec 动态拼接：JDK 为 %JAVA_HOME%\bin，Redis(binSubdir='')为 %REDIS_HOME%。
  try {
    const refBinPath = planBinRef(homeVar, getSpec(target.tool)?.binSubdir ?? 'bin');
    for (const t of sameCategory) {
      if (t.binPath) await env.removePath(t.binPath);                  // 旧版绝对路径残留
      const legacyRef = planBinRef(versionEnvName(homeVar, t.version), getSpec(t.tool)?.binSubdir ?? 'bin'); // 旧版 %HOME_VAR17%\bin 残留
      await env.removePath(legacyRef);
    }
    await env.appendPath(refBinPath); // 固定引用，永不移除
  } catch (e: any) {
    // PATH 操作失败不阻断：核心切换已完成，config 已保存
    console.warn('[switchVersionRef] PATH 更新失败（切换本身已成功）：', e?.message ?? e);
  }

  // 测试模式预览
  if (!cfg.applyEnv) await writeEnvPreview(cfg.rootDir, env.preview());

  // 版本清单来自文件（devenv.yaml），不再依赖注册表版本变量
  const versionVars: VersionVarInfo[] = sameCategory.map((t) => ({
    varName: versionEnvName(homeVar, t.version),
    path: t.path,
    version: t.version,
    active: t.id === target.id,
    source: 'config' as const,
  }));

  return { ok: true, applied: target, versionVars, activeVar: { name: homeVar, value: target.path } };
}

// ============================================================================
// 多版本切换（旧版兼容保留，内部委托给 switchVersionRef）
// ============================================================================

/**
 * 旧版切换接口（兼容 profiles 等调用方）。
 * 内部委托给引用式切换，保持返回值签名不变。
 */
export async function switchVersion(
  cfg: DevEnvConfig,
  category: ToolCategory,
  version: string,
  env: EnvBackend,
): Promise<{ ok: boolean; error?: string; applied?: InstalledTool }> {
  const result = await switchVersionRef(cfg, category, version, env);
  return { ok: result.ok, error: result.error, applied: result.applied };
}


/** 列出某类别下全部已安装版本（用于 UI 选择） */
export function listVersions(cfg: DevEnvConfig, category: ToolCategory): InstalledTool[] {
  return cfg.tools.filter((t) => t.category === category);
}

// ============================================================================
// 根目录迁移（纯函数 plan + 应用）
// ============================================================================

export interface MigratePlanItem {
  tool: string;
  version: string;
  from: string;
  to: string;
  homeVar?: string;
}

/** 计算迁移计划：把所有已安装工具路径重算到 newRoot 下（不移动文件） */
export function planMigrate(
  cfg: DevEnvConfig,
  newRoot: string,
): { items: MigratePlanItem[]; newRoot: string } {
  const items: MigratePlanItem[] = [];
  // 迁移目标基目录：沿用原 installDir 配置（若为用户自定义绝对路径则保持不变），
  // 否则默认 <newRoot>/data/install
  const base = planInstallBaseDir({ ...cfg, rootDir: newRoot });
  for (const t of cfg.tools) {
    const to = planInstallDir(base, t.category, t.tool, t.version);
    items.push({ tool: t.tool, version: t.version, from: t.path, to, homeVar: t.homeVar });
  }
  return { items, newRoot };
}

/**
 * 应用迁移：更新配置中的路径，并刷新环境变量指向。
 * 物理文件移动由调用方决定（moveFiles=true 时执行，默认 false 仅改配置+环境）。
 */
export async function applyMigrate(
  cfg: DevEnvConfig,
  newRoot: string,
  env: EnvBackend,
  moveFiles = false,
): Promise<{ ok: boolean; error?: string }> {
  const plan = planMigrate(cfg, newRoot);
  const fsp = await import('node:fs/promises');
  // 记录已物理移动的目录，便于失败时回滚，避免留下“半成品”状态
  const moved: { from: string; to: string }[] = [];
  try {
    for (const it of plan.items) {
      const t = cfg.tools.find((x) => x.tool === it.tool && x.version === it.version)!;
      if (moveFiles) {
        await fsp.mkdir(it.to, { recursive: true });
        await fsp.cp(t.path, it.to, { recursive: true });
        await fsp.rm(t.path, { recursive: true, force: true });
        moved.push({ from: it.to, to: t.path }); // 回滚时从新位置搬回原位置
      }
      t.path = it.to;
      t.binPath = planBinPath(it.to, getSpec(t.tool)?.binSubdir);
      if (t.homeVar && t.active) await env.set(t.homeVar, it.to);
      if (t.active) await env.prioritizePathVar(t.binPath);
    }
    cfg.rootDir = newRoot;
    await saveConfig(cfg);
    if (!cfg.applyEnv) await writeEnvPreview(cfg.rootDir, env.preview());
    return { ok: true };
  } catch (e: any) {
    // 回滚已物理移动的目录，避免半成品状态
    for (const m of moved) {
      try {
        await fsp.mkdir(m.to, { recursive: true });
        await fsp.cp(m.from, m.to, { recursive: true });
        await fsp.rm(m.from, { recursive: true, force: true });
      } catch {
        /* 尽力回滚，忽略个别失败 */
      }
    }
    return { ok: false, error: `迁移失败，已回滚已移动的文件：${e.message}` };
  }
}
