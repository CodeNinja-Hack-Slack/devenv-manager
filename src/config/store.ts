import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { DevEnvConfig, InstalledTool, ToolCategory } from '../types.js';
import { CONFIG_DIR, CACHE_DIR, LOGS_DIR, PROFILES_DIR, planCacheDir, normalizeSep } from '../utils/path.js';

export const CONFIG_FILE = 'devenv.yaml';

export function defaultConfig(rootDir: string): DevEnvConfig {
  return {
    version: 1,
    rootDir,
      download: {
        source: 'mirror',
        mirrors: {
          java: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/',
          maven: 'https://archive.apache.org/dist/maven/maven-3/',
          node: 'https://npmmirror.com/mirrors/node/',
          mysql: 'https://mirrors.tuna.tsinghua.edu.cn/mysql/',
          default: 'https://mirrors.aliyun.com/',
        },
        default: 'https://mirrors.aliyun.com/',
        threads: 4,
      },
    tools: [],
    profiles: {},
    language: 'zh',
    // 默认开启系统环境变量写入（正式发布行为）；测试期可在设置中关闭以保护本机环境
    applyEnv: true,
  };
}

/** 配置文件的绝对路径：rootDir/config/devenv.yaml */
export function configPath(rootDir: string): string {
  return path.join(rootDir, CONFIG_DIR, CONFIG_FILE);
}

export async function ensureRootDirs(rootDir: string): Promise<void> {
  const dirs = [
    rootDir,
    path.join(rootDir, CONFIG_DIR),
    planCacheDir(rootDir),
    path.join(rootDir, CONFIG_DIR, LOGS_DIR),
    path.join(rootDir, CONFIG_DIR, PROFILES_DIR),
  ];
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true });
  }
}

/**
 * 仅当用户「显式自定义」了下载/安装目录时才创建对应文件夹（requirement #3）。
 * - downloadDir / installDir 为空（使用默认 <rootDir>/data/download、<rootDir>/data/install）时，
 *   本函数不创建任何目录；默认目录由真实下载/安装操作按需懒创建（递归建出 data 父目录）。
 * - 非空时创建用户指定的目录（让用户的显式选择立即生效）。
 */
export async function ensureCustomDirs(cfg: DevEnvConfig): Promise<void> {
  const dirs: string[] = [];
  if (cfg.downloadDir?.trim()) dirs.push(normalizeSep(cfg.downloadDir.trim()));
  if (cfg.installDir?.trim()) dirs.push(normalizeSep(cfg.installDir.trim()));
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true });
  }
}

export async function loadConfig(rootDir: string): Promise<DevEnvConfig | null> {
  const p = configPath(rootDir);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const cfg = YAML.parse(raw) as Partial<DevEnvConfig> | null;
    if (!cfg || typeof cfg !== 'object') return null;
    // 最小 schema 校验与兜底，避免残缺/被篡改的 YAML 让下游（安装/切换/健康检查）崩溃
    if (typeof cfg.rootDir !== 'string') return null;
    if (!cfg.download || typeof cfg.download !== 'object') cfg.download = defaultConfig(rootDir).download;
    if (!Array.isArray(cfg.tools)) cfg.tools = [];
    if (!cfg.tools.every((t) => t && typeof t.id === 'string')) return null;
    if (typeof cfg.profiles !== 'object' || cfg.profiles === null) cfg.profiles = {};
    if (typeof cfg.applyEnv !== 'boolean') cfg.applyEnv = true;
    if (typeof cfg.pathPromptEnabled !== 'boolean') cfg.pathPromptEnabled = true;
    if (typeof cfg.language !== 'string') cfg.language = 'zh';
    cfg.rootDir = rootDir;
    return cfg as DevEnvConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: DevEnvConfig): Promise<void> {
  await ensureRootDirs(cfg.rootDir);
  const p = configPath(cfg.rootDir);

  // ── 安全网：防止并发写入或异常导致 tools 数组被意外截断 ──
  // 如果磁盘上已有配置文件且当前 cfg 的 tools 数量明显少于磁盘版本，
  // 记录警告但不阻止写入（某些场景如迁移/清理确实会减少工具数）。
  try {
    const existing = await fs.readFile(p, 'utf-8').catch(() => null);
    if (existing) {
      const parsed = YAML.parse(existing) as Partial<DevEnvConfig> | null;
      const existingCount = Array.isArray(parsed?.tools) ? parsed.tools.length : 0;
      const newCount = cfg.tools?.length ?? 0;
      // 阈值：新配置工具数 < 旧配置的 50% 且旧配置有 2+ 个工具 → 可疑截断
      if (existingCount >= 2 && newCount < existingCount * 0.5 && newCount < existingCount - 1) {
        console.warn(
          `[saveConfig] ⚠️ 工具数量异常减少：${existingCount} → ${newCount}。` +
          `可能存在并发写入或数据丢失风险。即将写入的配置仅保留 ${newCount} 个工具。`,
        );
      }
    }
  } catch {
    /* 读取旧文件失败时静默继续 —— 不应阻塞保存 */
  }

  const doc = YAML.stringify(cfg);
  await fs.writeFile(p, doc, 'utf-8');
}

/** 生成一个稳定的工具记录 ID */
export function toolId(category: ToolCategory, tool: string, version: string): string {
  return `${category}/${tool}/${version}`;
}

/** 在配置中新增或更新一条已安装记录 */
export function upsertTool(cfg: DevEnvConfig, t: InstalledTool): DevEnvConfig {
  const idx = cfg.tools.findIndex((x) => x.id === t.id);
  if (idx >= 0) cfg.tools[idx] = t;
  else cfg.tools.push(t);
  return cfg;
}

/** 将某个类别的默认版本切换到指定版本（保证仅一个 active） */
export function setActiveVersion(
  cfg: DevEnvConfig,
  category: ToolCategory,
  version: string,
): DevEnvConfig {
  for (const t of cfg.tools) {
    if (t.category === category) {
      t.active = t.version === version;
    }
  }
  return cfg;
}
