import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Platform, ScanResult, InstalledTool, ToolCategory, InstallMode } from '../types.js';
import { REGISTRY, detectTool, type Runner } from '../tools/registry.js';
import { normalizePath } from '../utils/path.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细扫描日志，避免生产环境刷屏。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

// ============================================================================
// Dashboard 合并展示类型
// 将「通过本软件安装」(InstalledTool) 与「系统已存在但未纳管」(ScanResult)
// 合并为统一的 DashboardTool 列表，供概览页按类别分组展示。
// ============================================================================

/** 概览页统一工具条目 */
export interface DashboardTool {
  name: string;
  version: string;
  category: ToolCategory;
  tool: string;
  /** 数据来源：installed=本软件安装并纳管 / detected=系统已有未纳管 */
  source: 'installed' | 'detected';
  /** 安装目录绝对路径 */
  path: string;
  /** 已纳管工具的唯一 ID（source=installed 时有值；detected 待纳管时为空） */
  id?: string;

  // -- 以下字段根据 source 不同各有意义 --
  /** 安装模式 online|offline（仅 source=installed） */
  mode?: InstallMode;
  /** 是否该类别默认版本（仅 source=installed） */
  active?: boolean;
  /** 是否在系统 PATH 中（仅 source=detected） */
  inPath?: boolean;

  // -- 以下字段由 pickCurrentTools 标注 --
  /** 是否为「当前正在使用」的版本（概览去重后每工具仅一个） */
  current?: boolean;
  /** 当前使用来源：managed=本软件默认 / system=系统 PATH 解析 */
  using?: 'managed' | 'system';
}

// ============================================================================
// 环境扫描器
// 默认使用真实系统 runner（which + 执行版本命令），可注入假 runner 用于单测。
// ============================================================================

const execFileP = promisify(execFile);

/**
 * 解析系统自带命令的全路径。
 * 关键：Electron 主进程在部分启动方式下，PATH 不含 System32，裸命令名（where/which）
 * 会触发 `spawn where ENOENT`，导致 scanSystem() 完全找不到任何工具。
 * 故统一用全路径调用（与 src/platform/env.ts 的 resolveWinExe 同源思路）。
 */
function resolveSystemCmd(name: string): string {
  if (process.platform === 'win32') {
    const sysroot = process.env.SystemRoot || 'C:\\Windows';
    return path.join(sysroot, 'System32', name);
  }
  return name; // Unix 交由下方 shell 兜底解析
}

/**
 * 确保子进程 PATH 含 System32/System/SysWOW64。
 * 否则 java/mvn 等工具即便以绝对路径启动，也会因缺少系统 DLL 而无法运行（ENOENT）。
 * 仅“补齐”绝不“删减”，对正常环境为幂等操作。
 */
function withSystemPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env;
  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  const extra = [
    path.join(sysroot, 'System32'),
    path.join(sysroot, 'System'),
    path.join(sysroot, 'SysWOW64'),
  ];
  const cur = (env.PATH ?? env.Path ?? '') as string;
  const parts = cur.split(path.delimiter).filter(Boolean);
  for (const e of extra) {
    if (!parts.some((p) => p.toLowerCase() === e.toLowerCase())) parts.unshift(e);
  }
  return { ...env, PATH: parts.join(path.delimiter) };
}

/** 真实系统 runner：基于 child_process 的 which/执行 */
export function createSystemRunner(platform: Platform = process.platform as Platform): Runner {
  return {
    async which(bin: string): Promise<string | null> {
      const cmd = platform === 'win32' ? resolveSystemCmd('where.exe') : 'which';
      const opts: any = { windowsHide: true, encoding: 'utf8' as const };
      // Unix 下 which 通常不在默认可执行搜索范围，用 shell 兜底解析
      if (platform !== 'win32') opts.shell = true;
      try {
        const { stdout } = (await execFileP(cmd, [bin], opts)) as unknown as { stdout: string };
        const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first ?? null;
      } catch {
        return null;
      }
    },
    async whichAll(bin: string): Promise<string[]> {
      const cmd = platform === 'win32' ? resolveSystemCmd('where.exe') : 'which';
      const opts: any = { windowsHide: true, encoding: 'utf8' as const };
      if (platform !== 'win32') opts.shell = true;
      try {
        const args = platform === 'win32' ? [bin] : ['-a', bin];
        const { stdout } = (await execFileP(cmd, args, opts)) as unknown as { stdout: string };
        return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
    async run(binPath: string, args: string[]): Promise<{ stdout: string; code: number }> {
      try {
        const { stdout, stderr } = (await execFileP(binPath, args, {
          windowsHide: true,
          encoding: 'utf8' as const,
          // 补齐系统路径，保证 java/mvn 等能加载 System32 下的依赖 DLL
          env: withSystemPath(process.env),
        })) as unknown as { stdout: string; stderr: string };
        // java -version 等工具将版本信息写到 stderr，必须合并
        return { stdout: (stdout + stderr).trim(), code: 0 };
      } catch (e: any) {
        return { stdout: ((e.stdout ?? '') + (e.stderr ?? '')).trim(), code: e.code ?? 1 };
      }
    },
    async exists(p: string): Promise<boolean> {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  };
}

/** 扫描系统中全部已安装开发工具（跨注册表） */
export async function scanSystem(
  runner: Runner = createSystemRunner(),
  specs = REGISTRY,
): Promise<ScanResult[]> {
  const out: ScanResult[] = [];
  for (const spec of specs) {
    try {
      const r = await detectTool(spec, runner);
      if (DEBUG) {
        if (r.length > 0) {
          console.log(`[scanSystem] ${spec.tool}: found ${r.length} version(s):`, r.map((x) => `${x.version}@${x.path}`).join(', '));
        } else {
          console.log(`[scanSystem] ${spec.tool}: not found`);
        }
      }
      out.push(...r);
    } catch (e: any) {
      // 单个工具检测失败不应阻断其余工具的扫描
      console.error(`[scanSystem] ${spec.tool} detection threw:`, e?.message ?? e);
    }
  }
  return out;
}

// 类别展示顺序（概览分组时优先按此排序，未列出的排在后面）
const CATEGORY_ORDER: ToolCategory[] = ['java', 'build-tool', 'node', 'database', 'web-server', 'container', 'ide', 'tool'];
const CATEGORY_LABEL: Record<ToolCategory, string> = {
  java: 'Java',
  'build-tool': '构建工具',
  node: 'Node.js',
  database: '数据库',
  'web-server': 'Web 服务',
  container: '容器',
  ide: 'IDE',
  tool: '其他工具',
  go: 'Go',
  python: 'Python',
};

/** 类别展示名（供 UI 直接使用，避免前端硬编码中文映射） */
export function categoryLabel(c: ToolCategory): string {
  return CATEGORY_LABEL[c] ?? c;
}

/** 按类别顺序排序的比较器 */
function byCategory(a: DashboardTool, b: DashboardTool): number {
  const ia = CATEGORY_ORDER.indexOf(a.category);
  const ib = CATEGORY_ORDER.indexOf(b.category);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  // 同类内：已纳管优先，其次按名称
  if (a.source !== b.source) return a.source === 'installed' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * 合并「本软件安装的」与「系统已存在但未纳管的」工具，供概览页分组展示。
 * - config.tools 视为 source='installed'（带 mode/active）
 * - scanSystem() 结果视为 source='detected'（带 inPath）
 * - 去重：若某检测结果与已纳管条目 tool+version 相同或路径相同，则只展示 installed 版本，
 *   避免同一条工具在概览里出现两次。
 *
 * @param installed 已纳管工具（来自 config.tools，可为 null）
 * @param detected  系统检测结果（来自 scanSystem），不传则只返回已纳管工具
 */
export function mergeDashboardTools(
  installed: InstalledTool[] | null | undefined,
  detected: ScanResult[] | null | undefined,
): DashboardTool[] {
  const out: DashboardTool[] = [];
  const seen = new Set<string>(); // 已覆盖的 detected key（tool|version 或 path）

  for (const t of installed ?? []) {
    out.push({
      name: t.name,
      version: t.version,
      category: t.category,
      tool: t.tool,
      source: 'installed',
      path: t.path,
      id: t.id,
      mode: t.mode,
      active: t.active,
    });
    // 标记被覆盖的检测项（路径键统一归一化，避免 config 正斜杠小写 vs 系统扫描反斜杠导致重复）
    seen.add(`${t.tool}|${t.version}`);
    if (t.path) seen.add(`path:${normalizePath(t.path)}`);
  }

  for (const d of detected ?? []) {
    const key = `${d.tool}|${d.version ?? ''}`;
    const pathKey = d.path ? `path:${normalizePath(d.path)}` : '';
    if (seen.has(key) || (pathKey && seen.has(pathKey))) continue; // 已被 installed 覆盖
    out.push({
      name: d.name,
      version: d.version ?? '未知',
      category: d.category,
      tool: d.tool,
      source: 'detected',
      path: d.path ?? '',
      inPath: d.inPath,
    });
    seen.add(key);
    if (pathKey) seen.add(pathKey);
  }

  return out.sort(byCategory);
}

/**
 * 从合并列表中挑出「当前正在使用」的工具：每个 tool 仅保留一个版本。
 * 优先级：已纳管且默认(active) > 系统 PATH 命中(inPath) > 已纳管任意 > 系统任意。
 * 返回的条目带 current:true 与 using 字段，供概览页展示「当前使用中」。
 */
export function pickCurrentTools(all: DashboardTool[]): DashboardTool[] {
  const byTool = new Map<string, DashboardTool[]>();
  for (const t of all) {
    if (!byTool.has(t.tool)) byTool.set(t.tool, []);
    byTool.get(t.tool)!.push(t);
  }

  const rank = (t: DashboardTool): number =>
    t.source === 'installed' && t.active ? 0 :
    t.source === 'detected' && t.inPath ? 1 :
    t.source === 'installed' ? 2 : 3;

  const compareVersion = (a: string, b: string): number => {
    const pa = a.split(/[.u_-]/).map(Number).filter((n) => !isNaN(n));
    const pb = b.split(/[.u_-]/).map(Number).filter((n) => !isNaN(n));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] ?? 0, vb = pb[i] ?? 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  };

  const out: DashboardTool[] = [];
  for (const list of byTool.values()) {
    list.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return compareVersion(b.version, a.version);
    });
    const chosen = list[0];
    out.push({ ...chosen, current: true, using: chosen.source === 'installed' ? 'managed' : 'system' });
  }
  return out.sort(byCategory);
}

/** 把扫描结果导出为 Markdown 报告 */
export function toMarkdown(report: ScanResult[]): string {
  const lines = ['# DevEnv 扫描报告', '', `> 生成时间：${new Date().toISOString()}`, ''];
  lines.push('| 工具 | 版本 | 安装路径 | 是否在 PATH |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of report) {
    lines.push(`| ${r.name} | ${r.version ?? '未知'} | ${r.path ?? '-'} | ${r.inPath ? '✅' : '❌'} |`);
  }
  return lines.join('\n');
}

/** 把扫描结果导出为 JSON 字符串 */
export function toJson(report: ScanResult[]): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), tools: report }, null, 2);
}

export { path };
