import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DevEnvConfig, InstalledTool } from '../types.js';
import { saveConfig } from '../config/store.js';
import { switchVersionRef, versionEnvName } from './switch.js';
import { planInstallBaseDir, planBinRef } from '../utils/path.js';
import { getSpec } from '../tools/registry.js';
import type { EnvBackend } from '../platform/env.js';
import { Logger } from '../utils/logger.js';

// ============================================================================
// 卸载引擎
// ----------------------------------------------------------------------------
// 支持卸载两类工具：
//   (a) 通过本软件安装的（mode=online/offline）：记录移除 + 环境变量清理 + 删除安装目录
//   (b) 电脑上已存在、被「纳管」的（mode=external）：记录移除 + 环境变量清理；
//       文件删除受「安全闸门」约束——仅当路径不在个人/系统禁区时才自动删除，
//       否则仅清理记录与环境变量，文件需用户手动删除（避免误删不可逆）。
//
// 卸载两步（需求 #3）：
//   1. 更新内部配置文件 devenv.yaml，移除已卸载软件记录。
//   2. 清理与该软件相关的文件/目录残留（含因本次卸载而变为空的父目录，
//      但严格限制在 installDir / rootDir 之内，绝不向上越界到共享根）。
// ============================================================================

export interface UninstallOptions {
  /** 是否删除安装目录文件。
   *  - 本软件安装的工具（mode≠external）：默认 true。
   *  - 外部纳管工具（mode=external）：默认 false（受安全闸门保护），
   *    仅当用户在界面确认「删除文件」且路径通过安全闸门时才删除。 */
  deleteFiles?: boolean;
}

export interface UninstallResult {
  ok: boolean;
  error?: string;
  /** 已删除的文件/目录路径（仅当 deleteFiles 且安全通过） */
  deleted?: string[];
  /** 已从 PATH/环境变量清理的条目 */
  removedEnv?: string[];
}

/**
 * 安全闸门：判定某路径是否允许被「自动递归删除」。
 * 规则（与 personal_files_safety 红线对齐）：
 *   - 禁止：用户个人目录（Desktop/Downloads/Documents/Pictures/Videos/AppData/Home 根）
 *   - 禁止：系统关键目录（SystemRoot、Program Files、ProgramData、Windows 目录、盘符根、C:\）
 *   - 允许：位于软件数据根目录之下（本软件安装的工具，必然在此），或用户自选的其它非禁区目录（如 E:\Software\...）
 * 返回 false 时调用方不应自动删文件，仅清理记录与环境变量，并提示用户手动删除。
 */
export function isSafeDeletePath(p: string, rootDir?: string): boolean {
  if (!p) return false;
  const np = path.normalize(p).toLowerCase().replace(/[\\/]+$/, '');

  // 1) 个人目录禁区
  const home = (process.env.USERPROFILE || process.env.HOME || '').toLowerCase().replace(/[\\/]+$/, '');
  if (home) {
    const personalZones = [
      path.join(home, 'desktop'),
      path.join(home, 'downloads'),
      path.join(home, 'documents'),
      path.join(home, 'pictures'),
      path.join(home, 'videos'),
      path.join(home, 'music'),
      path.join(home, 'appdata'),
      home,
    ];
    for (const z of personalZones) {
      const zz = z.toLowerCase();
      if (np === zz || np.startsWith(zz + path.sep)) return false;
    }
  }

  // 2) 系统/磁盘禁区
  const sysroot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase().replace(/[\\/]+$/, '');
  if (np === sysroot || np.startsWith(sysroot + path.sep)) return false;
  if (/^[a-z]:[\\/]?$/.test(np)) return false; // 盘符根（如 c:\）
  if (np.includes('\\program files') || np.includes('\\programdata') || np.includes('\\windows\\')) return false;

  // 3) 软件数据根目录之下：必然允许（本软件安装的工具）
  if (rootDir) {
    const rootN = path.normalize(rootDir).toLowerCase().replace(/[\\/]+$/, '');
    if (np === rootN || np.startsWith(rootN + path.sep)) return true;
  }

  // 4) 其它非禁区目录（如 E:\Software\Java\...）：允许
  return true;
}

/**
 * 判定 child 是否为 ancestor 的「严格后代目录」（不含 ancestor 自身）。
 * 用于安全底线：仅当工具路径位于受控根（installDir / rootDir）之下，才允许向上清理父级。
 */
function isStrictDescendant(child: string, ancestor: string): boolean {
  const c = path.normalize(child).toLowerCase().replace(/[\\/]+$/, '');
  const a = path.normalize(ancestor).toLowerCase().replace(/[\\/]+$/, '');
  return c !== a && c.startsWith(a + path.sep);
}

/**
 * 解析「向上清理空目录」的安全底线（该目录本身绝不删除）：
 *   - 工具路径位于自定义 installDir 之下 → 底线 = installDir
 *     （最典型：外部纳管软件落在 E:\Software 之下，底线即 E:\Software，绝不会删到这个共享根）
 *   - 否则位于数据根 rootDir 之下 → 底线 = rootDir
 *   - 否则（路径在受控根之外，如 C:\Apps\...）→ 返回工具自身路径，
 *     使循环条件令其父级一律不被清理（外部软件更保守，避免误删共享目录）
 */
function resolvePruneFloor(toolPath: string, cfg: DevEnvConfig): string {
  const base = planInstallBaseDir(cfg);
  if (base && isStrictDescendant(toolPath, base)) return base;
  if (cfg.rootDir && isStrictDescendant(toolPath, cfg.rootDir)) return cfg.rootDir;
  return toolPath;
}

/**
 * 向上回溯清理「空目录」：
 * 从被删工具目录的父目录开始，逐级删除确为空的目录，遇到以下任一情况即停止——
 *   - 到达安全底线 floorDir（绝不删）；
 *   - 当前目录不为 floorDir 的后代（防越界到共享根）；
 *   - 当前目录非空（可能含同级其它工具/数据）；
 *   - 当前目录未通过安全闸门 isSafeDeletePath（纵深防御）；
 *   - 读目录/删除失败。
 * 仅当工具目录真正被删除（startDir 已不存在）后调用才有意义。
 */
async function pruneEmptyParents(
  startDir: string,
  floorDir: string,
  rootDir: string | undefined,
  logger: Logger,
): Promise<string[]> {
  const removed: string[] = [];
  const floor = path.normalize(floorDir).toLowerCase().replace(/[\\/]+$/, '');
  if (!floor) return removed;
  let cur = path.dirname(path.normalize(startDir));
  while (cur && cur.toLowerCase() !== floor) {
    // 仅清理 floor 的严格后代，杜绝越界到共享根
    if (!cur.toLowerCase().startsWith(floor + path.sep)) break;
    // 纵深防御：每个目录都要通过安全闸门
    if (!isSafeDeletePath(cur, rootDir)) break;
    let entries: string[];
    try {
      entries = await fsp.readdir(cur);
    } catch {
      break; // 读不到（可能已删/无权限）→ 停止
    }
    if (entries.length > 0) break; // 非空 → 停止（保留同级内容）
    try {
      await fsp.rmdir(cur);
      removed.push(cur);
    } catch (e: any) {
      logger.warn(`[uninstall] 清理空目录失败：${e?.message ?? e}`);
      break;
    }
    cur = path.dirname(cur);
  }
  return removed;
}

export async function uninstallTool(
  ctx: { cfg: DevEnvConfig; env: EnvBackend; logger: Logger },
  id: string,
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const { cfg, env, logger } = ctx;
  const idx = cfg.tools.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: '未找到该工具的纳管记录，可能已被卸载' };
  const tool = cfg.tools[idx];
  const removedEnv: string[] = [];

  // ---- 1) 环境变量清理（核心，尽力执行）----
  try {
    // 移除 PATH 中的 bin 目录（绝对路径 + 遗留引用 %HOME<ver>%\bin）
    if (tool.addedToPath && tool.binPath) {
      await env.removePath(tool.binPath).catch(() => {});
      removedEnv.push(tool.binPath);
    }
    if (tool.homeVar) {
      // 遗留引用按 binSubdir 动态拼接：JDK 为 %JAVA_HOME17%\bin，Redis(binSubdir='')为 %REDIS_HOME5%
      const legacyRef = planBinRef(versionEnvName(tool.homeVar, tool.version), getSpec(tool.tool)?.binSubdir ?? 'bin');
      await env.removePath(legacyRef).catch(() => {});
    }

    // 若卸载的是「当前活跃版本」，需把 homeVar 重新指向同类其它版本（Plan B：绝对路径）
    if (tool.active && tool.homeVar) {
      const others = cfg.tools.filter((t) => t.category === tool.category && t.id !== tool.id);
      if (others.length > 0) {
        // 重新指向第一个其它版本（保持单活跃，PATH 自动跟随 %JAVA_HOME%\bin）
        await switchVersionRef(cfg, tool.category, others[0].version, env);
      } else {
        // 同类无其它版本：仅当 JAVA_HOME 当前指向本工具路径时才清空（避免误清用户其它设置）
        const cur = await env.get(tool.homeVar).catch(() => undefined);
        const norm = (s?: string) => (s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (cur && norm(cur) === norm(tool.path)) {
          await env.unset(tool.homeVar).catch(() => {});
          removedEnv.push(tool.homeVar);
        }
      }
    }
  } catch (e: any) {
    logger.warn(`[uninstall] 环境变量清理部分失败（继续移除配置记录）：${e?.message ?? e}`);
  }

  // ---- 2) 从配置移除记录并持久化（需求 #3 步骤 1）----
  cfg.tools.splice(idx, 1);
  try {
    await saveConfig(cfg);
  } catch (e: any) {
    return { ok: false, error: `配置保存失败：${e?.message ?? e}` };
  }

  // ---- 3) 删除文件（需求 #3 步骤 2，受安全闸门约束）----
  const deleted: string[] = [];
  const wantDelete = opts.deleteFiles ?? tool.mode !== 'external';
  if (wantDelete && tool.path) {
    if (isSafeDeletePath(tool.path, cfg.rootDir)) {
      const floor = resolvePruneFloor(tool.path, cfg);
      await fsp
        .rm(tool.path, { recursive: true, force: true })
        .then(async () => {
          deleted.push(tool.path);
          // 向上清理因本次卸载而变为空的父目录（严格受控于 floor，绝不越界到共享根）
          const pruned = await pruneEmptyParents(tool.path, floor, cfg.rootDir, logger);
          deleted.push(...pruned);
        })
        .catch((err) => logger.warn(`[uninstall] 删除文件失败：${err?.message ?? err}`));
    } else {
      logger.warn(`[uninstall] 路径 ${tool.path} 位于受保护位置，未自动删除（请手动清理文件）`);
    }
  }

  return { ok: true, deleted, removedEnv };
}
