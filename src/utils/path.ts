import type { DevEnvConfig, ToolCategory } from '../types.js';

/**
 * 类别 → 目录名 映射（与需求规范中的目录树完全一致）。
 *   java / build-tool / node / ide / database / container / tool / config
 */
export const CATEGORY_DIR: Record<ToolCategory, string> = {
  java: 'java',
  'build-tool': 'build-tool',
  node: 'node',
  ide: 'ide',
  database: 'database',
  container: 'container',
  tool: 'tool',
  go: 'go',
  python: 'python',
  'web-server': 'web-server',
};

/** config 目录固定名为 config */
export const CONFIG_DIR = 'config';
export const CACHE_DIR = 'cache';
export const LOGS_DIR = 'logs';
export const PROFILES_DIR = 'profiles';
/**
 * 数据目录：所有运行时产生的数据（下载缓存 download、工具安装 install）统一收纳于此，
 * 与源码/配置目录（config）隔离，保持项目根目录整洁。
 *   <rootDir>/data/download  ← 安装包缓存
 *   <rootDir>/data/install   ← 工具实际安装
 */
export const DATA_DIR = 'data';

/**
 * 解析「安装基目录」：用户自定义 installDir（非空）优先，否则默认 <rootDir>/data/install。
 * 该目录按需懒创建（用户未自定义时不会预先生成，见 requirement #3）。
 */
export function planInstallBaseDir(cfg: DevEnvConfig): string {
  const custom = cfg.installDir?.trim();
  return custom ? normalizeSep(custom) : join(cfg.rootDir, DATA_DIR, 'install');
}

/**
 * 解析「下载目录」：用户自定义 downloadDir（非空）优先，否则默认 <rootDir>/data/download。
 * 该目录按需懒创建（用户未自定义时不会预先生成，见 requirement #3）。
 */
export function planDownloadDir(cfg: DevEnvConfig): string {
  const custom = cfg.downloadDir?.trim();
  return custom ? normalizeSep(custom) : join(cfg.rootDir, DATA_DIR, 'download');
}

/**
 * 规范化子目录命名：{installBase}/{类别目录}/{tool}{version}
 * 例：installBase=E:\a\data\install, java/jdk/17.0.9 → E:\a\data\install\java\jdk17.0.9
 *
 * 版本号中的点在某些场景需要保留（如 mysql8.0.35），
 * 故直接拼接 tool + version（version 中的 '.' 保留）。
 * 工具名本身已含语义（jdk/maven/node...），避免与版本混淆。
 *
 * @param installBase 安装基目录（来自 planInstallBaseDir）
 */
export function planInstallDir(
  installBase: string,
  category: ToolCategory,
  tool: string,
  version: string,
): string {
  const sep = installBase.includes('\\') ? '\\' : '/';
  const dir = `${installBase}${sep}${CATEGORY_DIR[category]}${sep}${tool}${version}`;
  return normalizeSep(dir);
}

/** cache 目录：rootDir/config/cache */
export function planCacheDir(rootDir: string): string {
  return join(rootDir, CONFIG_DIR, CACHE_DIR);
}

/** 任意层级拼接（跨平台分隔符） */
export function join(...parts: string[]): string {
  const sep = parts[0]?.includes('\\') ? '\\' : '/';
  return normalizeSep(parts.join(sep));
}

export function normalizeSep(p: string): string {
  return p.replace(/[/\\]+/g, (m) => (p.includes('\\') ? '\\' : '/'));
}

/**
 * 路径归一化（用于去重 / 对比）：反斜杠统一为正斜杠 + 去尾斜杠 + Windows 大小写不敏感转小写。
 * 与 handlers.ts 的 normPathForActive 语义一致，抽到引擎层供 scanner 等复用，
 * 确保多来源路径（config 存的正斜杠小写 vs 系统扫描 where 返回的反斜杠）可正确去重。
 * **新增软件（redis/maven 等）做路径去重 / active 路径比对时务必使用本函数**，避免大小写/分隔符差异导致重复条目。
 */
export function normalizePath(p?: string): string {
  return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 计算工具的可执行目录（bin 路径）：
 *   - binSubdir 为空字符串 '' → 可执行文件就在安装根目录（如 Redis 的 redis-server.exe 在解压根目录）
 *   - 未提供 → 默认 'bin'（如 JDK/Maven）
 *   - 其它值 → 安装根目录 + 该子目录
 * **新增软件务必传 spec.binSubdir**，不要写死 join(installDir, 'bin')，否则 Redis 这类根目录型工具会得到错误路径。
 */
export function planBinPath(installDir: string, binSubdir?: string): string {
  // 注意：`?? 'bin'` 而非 `|| 'bin'`，否则 '' 会被误转成 'bin'
  const sub = binSubdir === undefined ? 'bin' : binSubdir;
  return sub ? join(installDir, sub) : installDir;
}

/**
 * 计算写入 PATH 的「引用式条目」：%HOME_VAR%[\\binSubdir]。
 *   - binSubdir 为空（如 Redis）→ %REDIS_HOME%
 *   - 否则（如 JDK）→ %JAVA_HOME%\bin
 * PATH 引用必须按 binSubdir 动态拼接，**绝不能硬编码 '\bin'**，否则 Redis 这类根目录型工具会被拼成无效路径，
 * 导致 `where redis-server` 在命令行找不到。
 * **新增软件务必通过本函数生成 PATH 引用**，不要手写 `%VAR%\bin`。
 */
export function planBinRef(homeVar: string, binSubdir: string): string {
  const suffix = binSubdir ? `\\${binSubdir}` : '';
  return `%${homeVar}%${suffix}`;
}
