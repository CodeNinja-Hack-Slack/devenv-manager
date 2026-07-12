import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstallStep, StepContext, StepResult, InstalledTool, StepPreview, StepParam } from '../types.js';
import { getSpec, type ToolSpec } from '../tools/registry.js';
import { planDownloadDir, join, planBinRef, normalizePath } from '../utils/path.js';
import { getEffectiveHomeVar, versionEnvName } from './switch.js';
import { downloadFile } from './downloader.js';
import { extract, verifyInstall } from './extractor.js';
import { writeEnvPreview } from '../platform/env.js';
import { toolId, upsertTool, saveConfig } from '../config/store.js';
import { mysqlMyIniStep, mysqlInitStep, mysqlServiceStep } from './postinstall/mysql.js';
import { pythonSiteStep, pythonPipStep } from './postinstall/python.js';
import { redisServiceStep } from './postinstall/redis.js';
import { mavenMirrorStep, gradleMirrorStep } from './postinstall/mirror.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细安装日志，避免生产环境刷屏。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

/** 轻量存在性探测（异步），用于运行时定位 npm-cli.js 等真实路径 */
const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// 基底步骤「规划预览」函数（纯函数，绝不触碰系统；规划视图据此展示“会做什么”）
// ============================================================================
const fetchPreview = (ctx: StepContext): StepPreview => {
  const cacheDir = planDownloadDir(ctx.cfg);
  const notes =
    ctx.mode === 'online'
      ? [`下载：${ctx.spec.buildUrl(ctx.version, ctx.platform)}`]
      : [`复制本地离线包：${ctx.localPath ?? '(未指定)'}`];
  return { dirs: [cacheDir], notes };
};
const extractPreview = (ctx: StepContext): StepPreview => ({
  dirs: [ctx.destDir],
  notes: ['按归档格式解压到目标目录'],
});
const configureEnvPreview = (ctx: StepContext): StepPreview => {
  const effHome = getEffectiveHomeVar(ctx.spec.tool, ctx.spec.homeVar);
  if (!effHome) return { notes: ['该工具无需设置 HOME 变量'] };
  return { envOps: [{ kind: 'set', name: effHome, value: ctx.destDir }], notes: ['写入主目录变量'] };
};
const configurePathPreview = (ctx: StepContext): StepPreview => {
  const effHome = getEffectiveHomeVar(ctx.spec.tool, ctx.spec.homeVar);
  if (!effHome) return { notes: ['该工具无需追加 PATH'] };
  return {
    envOps: [{ kind: 'appendPath', name: 'PATH', value: planBinRef(effHome, ctx.spec.binSubdir) }],
    notes: ['追加 bin 目录到 PATH'],
  };
};
const verifyFilesPreview = (ctx: StepContext): StepPreview => {
  const binName = ctx.spec.binaries[0].replace(/\.exe$/, '').replace(/\.cmd$/, '').replace(/\.bat$/, '');
  return { notes: [`校验关键文件 ${binName} 是否存在于 ${ctx.destDir}`] };
};
const verifyEnvPreview = (): StepPreview => ({
  notes: ['回读 HOME 变量与 PATH 确认已生效（可能需重启终端）'],
});
const writeConfigPreview = (ctx: StepContext): StepPreview => ({
  files: [{ path: path.join(ctx.cfg.rootDir, 'config', 'devenv.yaml'), note: '登记本次安装（多版本清单单一真相源）' }],
});

// ============================================================================
// 通用安装步骤工厂（buildBaseSteps）
// ----------------------------------------------------------------------------
// 把「下载 → 解压 → 配置环境变量 → 验证 → 写配置」建模为可读步骤序列。
// 各软件通过 `[...buildBaseSteps(spec), 专属步骤...]` 组合出完整步骤管线；
// 安装器遍历 spec.steps（未定义时回退到本工厂）逐步执行并 emit 真实进度。
// 本模块只 type-import registry，运行时组合（ensureRegistrySteps）由 installTool 启动时触发，
// 避免与 registry 形成循环加载。
// ============================================================================

/** 1) 获取安装包（在线下载 / 离线复制） */
const fetchStep: InstallStep = {
  id: 'fetch',
  title: '获取安装包',
  description: '在线下载（支持多线程/断点续传）或复制本地离线包到统一缓存目录，供后续解压使用',
  preview: fetchPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { cfg, version, mode, localPath, spec, platform, state } = ctx;
    const cacheDir = planDownloadDir(cfg);
    const dl = (state.downloader as typeof downloadFile) ?? downloadFile;
    await fsp.mkdir(cacheDir, { recursive: true });
    if (mode === 'online') {
      const url = spec.buildUrl(version, platform);
      const extMatch = url.split('?')[0].split('#')[0].match(/\.(zip|tar\.gz|tgz|tar\.xz|txz|tar|msi|exe|dmg)$/i);
      const ext = extMatch ? extMatch[0] : '.bin';
      const fname = `${spec.tool}-${version}-${platform}${ext}`;
      const cacheFile = join(cacheDir, fname);
      if (DEBUG) ctx.logger.info(`[fetch] 下载 ${url} -> ${cacheFile}`);
      await dl({ url, dest: cacheFile, threads: cfg.download.threads, expectedSha256: spec.checksum });
      state.cacheFile = cacheFile;
      return { ok: true, message: `已下载到 ${cacheFile}` };
    }
    if (!localPath) return { ok: false, message: '离线模式需要提供 localPath' };
    const fname = localPath.split(/[\\/]/).pop()!;
    const cacheFile = join(cacheDir, fname);
    await fsp.copyFile(localPath, cacheFile);
    state.cacheFile = cacheFile;
    return { ok: true, message: `已复制离线包到 ${cacheFile}` };
  },
};

/** 2) 解压 / 安装 */
const extractStep: InstallStep = {
  id: 'extract',
  title: '解压到统一目录',
  description: '按归档格式解压到规划好的安装目录，并整理出可执行文件所在的 bin 子目录',
  preview: extractPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { destDir, state } = ctx;
    const ex = (state.extractor as typeof extract) ?? extract;
    const cacheFile = state.cacheFile as string | undefined;
    if (!cacheFile) return { ok: false, message: '找不到安装包缓存路径' };
    await ex(cacheFile, destDir, { format: undefined });
    return { ok: true, message: `已解压到 ${destDir}` };
  },
};

/** 3a) 写入 HOME 变量（如 JAVA_HOME / NODE_HOME），指向本次安装目录 */
const configureEnvStep: InstallStep = {
  id: 'configure-env',
  title: '写入 HOME 环境变量',
  description: '设置主目录变量（如 JAVA_HOME），指向本次安装目录；多版本切换时只改此变量、PATH 不变',
  preview: configureEnvPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { spec, destDir, cfg, env, rollback, state } = ctx;
    const effHome = getEffectiveHomeVar(spec.tool, spec.homeVar);
    const isFirst = !cfg.tools.some((t) => t.category === spec.category);
    const active = state.makeActive ?? isFirst;
    state.active = active;
    if (effHome && active) {
      // 首次写入环境变量前快照 PATH（用于失败回滚时整体还原）
      if (rollback.pathSnapshot === undefined) rollback.pathSnapshot = await env.snapshotPath();
      // 记录修改前的值，失败回滚时精确还原（或删除未修改过的变量）
      rollback.envOpsBefore.set(effHome, await env.get(effHome));
      await env.set(effHome, destDir);
      return { ok: true, message: `已写入 ${effHome} = ${destDir}` };
    }
    return { ok: true, message: '未激活：HOME 变量保持现状（不写环境变量）' };
  },
};

/** 3b) 追加 bin 目录到 PATH（清理同类旧版本遗留条目） */
const configurePathStep: InstallStep = {
  id: 'configure-path',
  title: '追加 bin 目录到 PATH',
  description: '将 %HOME_VAR%\\bin（按 binSubdir 动态拼接）加入系统 PATH，使命令在任意终端可用；并清理同类旧版本的 PATH 条目',
  preview: configurePathPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { spec, cfg, env, applyEnv, state } = ctx;
    const effHome = getEffectiveHomeVar(spec.tool, spec.homeVar);
    const active = (state.active as boolean) ?? false;
    if (effHome && active) {
      const refBinPath = planBinRef(effHome, spec.binSubdir);
      // 清理同类其它已装版本的遗留 PATH 条目（绝对 binPath 与 %HOME_VAR<ver>%[\\binSubdir] 引用）
      for (const t of cfg.tools.filter((t) => t.category === spec.category)) {
        if (t.binPath) await env.removePath(t.binPath);
        const legacyRef = planBinRef(
          versionEnvName(t.homeVar ?? effHome, t.version),
          getSpec(t.tool)?.binSubdir ?? 'bin',
        );
        await env.removePath(legacyRef);
      }
      await env.appendPath(refBinPath);
    }
    // 测试模式（applyEnv=false）：仅记录将要写入的 env 操作，不碰系统环境变量
    if (!applyEnv) {
      await writeEnvPreview(cfg.rootDir, env.preview());
    }
    return {
      ok: true,
      message: active ? '已将 bin 目录加入 PATH' : '未激活：PATH 保持不变',
    };
  },
};

/** 4a) 校验关键可执行文件是否完整（硬校验：缺失即安装失败） */
const verifyFilesStep: InstallStep = {
  id: 'verify-files',
  title: '校验主程序文件完整性',
  description: '确认解压目录中存在关键可执行文件（如 java / mvn / node / redis-server），缺失即判定安装失败',
  preview: verifyFilesPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { destDir, spec } = ctx;
    const binName = spec.binaries[0].replace(/\.exe$/, '').replace(/\.cmd$/, '').replace(/\.bat$/, '');
    const ok = await verifyInstall(destDir, [binName], spec.binSubdir ?? 'bin');
    if (!ok) return { ok: false, message: '安装验证失败：关键可执行文件缺失' };
    return { ok: true, message: '关键可执行文件校验通过' };
  },
};

/** 4b) 回读环境变量确认已生效（自检：未生效仅提示，不阻断安装） */
const verifyEnvStep: InstallStep = {
  id: 'verify-env',
  title: '校验环境变量已生效',
  description: '回读刚写入的 HOME 变量与 PATH，确认环境变量真实落盘；若读取不到仅提示（可能需重启终端生效），不阻断安装',
  preview: verifyEnvPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { spec, destDir, env, state } = ctx;
    const effHome = getEffectiveHomeVar(spec.tool, spec.homeVar);
    const active = (state.active as boolean) ?? false;
    if (!effHome || !active) return { ok: true, message: '未激活，跳过环境变量回读校验' };
    const read = await env.get(effHome);
    const refBinPath = planBinRef(effHome, spec.binSubdir);
    const pathVal = await env.snapshotPath();
    const homeOk = !!read && normalizePath(String(read)).toLowerCase() === normalizePath(destDir).toLowerCase();
    const pathOk = !!pathVal && pathVal.toLowerCase().includes(refBinPath.toLowerCase());
    if (homeOk && pathOk) return { ok: true, message: 'HOME 与 PATH 均已正确写入' };
    return {
      ok: true,
      message: `环境变量自检：HOME ${homeOk ? '✓ 已生效' : '未在预期位置'} / PATH ${pathOk ? '✓ 已包含' : '未包含 bin 目录（可能需重启终端生效）'}`,
    };
  },
};

/** 5) 写入 devenv.yaml 配置 */
const writeConfigStep: InstallStep = {
  id: 'writeConfig',
  title: '写入配置并激活',
  description: '将本次安装登记到 devenv.yaml（多版本清单单一真相源），并设为该类别的默认/激活版本',
  preview: writeConfigPreview,
  run: async (ctx: StepContext): Promise<StepResult> => {
    const { spec, destDir, binPath, version, cfg, state, logger } = ctx;
    const active = (state.active as boolean) ?? false;
    if (active) {
      for (const t of cfg.tools) if (t.category === spec.category) t.active = false;
    }
    const inst: InstalledTool = {
      id: toolId(spec.category, spec.tool, version),
      category: spec.category,
      tool: spec.tool,
      name: spec.name,
      version,
      path: destDir,
      binPath,
      homeVar: spec.homeVar,
      mode: ctx.mode,
      active,
      addedToPath: active,
      installedAt: new Date().toISOString(),
    };
    upsertTool(cfg, inst);
    await saveConfig(cfg);
    logger.info(`[${ctx.mode}] 记录 ${spec.name} ${version} -> ${destDir}`);
    return { ok: true, message: `已记录 ${spec.name} ${version}` };
  },
};

/**
 * 生成通用基底步骤序列（获取包/解压/写HOME变量/加PATH/校验文件/校验环境/写配置）。
 * 各软件据此追加自己的专属步骤；未声明 steps 的 spec 由安装器回退到本工厂。
 */
export function buildBaseSteps(_spec: ToolSpec): InstallStep[] {
  return [fetchStep, extractStep, configureEnvStep, configurePathStep, verifyFilesStep, verifyEnvStep, writeConfigStep];
}

/**
 * Node.js 专属步骤：设置 npm 全局目录（node_global / node_cache），避免污染系统目录。
 * 通过 node 运行 npm-cli.js，跨平台一致，且不依赖 PATH 是否已生效。
 */
export const nodeGlobalsStep: InstallStep = {
  id: 'node:globals',
  title: '配置 npm 全局目录',
  description: '设置 node_global / node_cache，避免污染系统目录',
  optional: true,
  computeParams: (ctx: StepContext): StepParam[] => [
    {
      key: 'nodeGlobal',
      label: 'npm 全局目录 (node_global)',
      type: 'path',
      value: path.join(ctx.destDir, 'node_global'),
      hint: 'npm install -g 全局包的安装位置，建议保留默认',
    },
    {
      key: 'nodeCache',
      label: 'npm 缓存目录 (node_cache)',
      type: 'path',
      value: path.join(ctx.destDir, 'node_cache'),
      hint: 'npm 下载缓存目录',
    },
  ],
  preview: (ctx: StepContext, v: Record<string, any>): StepPreview => {
    const nodeGlobal = (v.nodeGlobal as string) || path.join(ctx.destDir, 'node_global');
    const nodeCache = (v.nodeCache as string) || path.join(ctx.destDir, 'node_cache');
    const refGlobal = planBinRef(getEffectiveHomeVar(ctx.spec.tool, ctx.spec.homeVar), 'node_global');
    return {
      dirs: [nodeGlobal, nodeCache],
      commands: [`npm config set prefix ${nodeGlobal}`, `npm config set cache ${nodeCache}`],
      envOps: [{ kind: 'appendPath', name: 'PATH', value: refGlobal }],
      notes: ['将 %NODE_HOME%\\node_global 加入 PATH，使全局命令可用'],
    };
  },
  run: async (ctx: StepContext): Promise<StepResult> => {
    const nodeExt = process.platform === 'win32' ? '.exe' : '';
    const nodeBin = path.join(ctx.binPath, `node${nodeExt}`);
    // npm-cli.js 位于 Node 官方分发包的 node_modules/npm/bin/（而非 binPath 根目录）。
    // 先用真实文件探测，再兜底回退到旧路径，增强鲁棒性。
    // 修复：原硬编码 path.join(binPath, 'npm-cli.js') 在 Node zip 解压结构下不存在，
    // 导致真实安装时 npm prefix/cache 配置步骤执行失败（dryRun 测试用 mock 掩盖了此问题）。
    const npmCliCandidates = [
      path.join(ctx.binPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(ctx.binPath, 'npm-cli.js'),
    ];
    const npmCli = (await pathExists(npmCliCandidates[0])) ? npmCliCandidates[0] : npmCliCandidates[1];
    const nodeGlobal = (ctx.params?.nodeGlobal as string) || path.join(ctx.destDir, 'node_global');
    const nodeCache = (ctx.params?.nodeCache as string) || path.join(ctx.destDir, 'node_cache');
    await fsp.mkdir(nodeGlobal, { recursive: true });
    await fsp.mkdir(nodeCache, { recursive: true });
    const r1 = await ctx.run(nodeBin, [npmCli, 'config', 'set', 'prefix', nodeGlobal]);
    if (r1.code !== 0) {
      return { ok: false, warning: true, message: `设置 npm prefix 失败：${r1.stderr || r1.stdout || '无输出'}` };
    }
    const r2 = await ctx.run(nodeBin, [npmCli, 'config', 'set', 'cache', nodeCache]);
    if (r2.code !== 0) {
      return { ok: false, warning: true, message: `设置 npm cache 失败：${r2.stderr || r2.stdout || '无输出'}` };
    }
    // 把 npm 全局命令目录（%NODE_HOME%\node_global）加入 PATH，否则 npm install -g 装的命令找不到。
    // 用 %NODE_HOME% 引用，随 NODE_HOME 切换自动跟随（与切换时 PATH 引用 %NODE_HOME% 一致）。
    try {
      const refGlobal = planBinRef(getEffectiveHomeVar(ctx.spec.tool, ctx.spec.homeVar), 'node_global');
      await ctx.env.appendPath(refGlobal);
    } catch (e: any) {
      if (DEBUG) ctx.logger.warn(`[node:globals] 追加 node_global 到 PATH 失败：${e?.message ?? e}`);
    }
    return { ok: true, message: `node_global=${nodeGlobal}；node_cache=${nodeCache}（已加入 PATH）` };
  },
};

/**
 * Go 专属步骤（可选）：把 GOPATH/bin 加入 PATH，使 `go install` 装的全局命令可用。
 * GOPATH 默认 %USERPROFILE%/go；未显式设置 GOPATH 时按默认目录处理。
 */
/**
 * 计算加入 PATH 的 GOPATH/bin 条目：
 * - GOPATH 环境变量已设置且用户未自定义（使用默认位置）→ 用 %GOPATH%\bin 引用，与版本切换的引用式 PATH 风格一致；
 * - 否则（未设 GOPATH 或用户自定义了目录）→ 用绝对路径，可靠且支持自定义位置。
 */
const goPathEntry = (override?: string): string => {
  const defaultBin = process.env.GOPATH
    ? path.join(process.env.GOPATH, 'bin')
    : path.join(os.homedir(), 'go', 'bin');
  const goPathBin = override || defaultBin;
  if (process.env.GOPATH && normalizePath(goPathBin) === normalizePath(defaultBin)) {
    return '%GOPATH%\\bin';
  }
  return goPathBin;
};

export const goPathStep: InstallStep = {
  id: 'go:gopath',
  title: '配置 GOPATH 全局命令路径',
  description: '将 GOPATH/bin 加入 PATH，使 go install 安装的命令可用',
  optional: true,
  computeParams: (ctx: StepContext): StepParam[] => [
    {
      key: 'goPathBin',
      label: 'GOPATH/bin 目录',
      type: 'path',
      value: process.env.GOPATH
        ? path.join(process.env.GOPATH, 'bin')
        : path.join(os.homedir(), 'go', 'bin'),
      hint: 'go install 全局命令所在目录（GOPATH 环境变量已设置时将以 %GOPATH%\\bin 引用加入 PATH）',
    },
  ],
  preview: (_ctx: StepContext, v: Record<string, any>): StepPreview => {
    const entry = goPathEntry(v.goPathBin as string | undefined);
    return {
      envOps: [{ kind: 'appendPath', name: 'PATH', value: entry }],
      notes: [entry.includes('%') ? '以 %GOPATH%\\bin 引用加入 PATH（随 GOPATH 自动跟随）' : '将 GOPATH/bin 加入 PATH'],
    };
  },
  run: async (ctx: StepContext): Promise<StepResult> => {
    const entry = goPathEntry(ctx.params?.goPathBin as string | undefined);
    try {
      await ctx.env.appendPath(entry);
    } catch (e: any) {
      return { ok: false, warning: true, message: `追加 GOPATH/bin 到 PATH 失败：${e?.message ?? e}` };
    }
    return { ok: true, message: `已将 ${entry} 加入 PATH` };
  },
};

let _stepsInitialized = false;

/**
 * 为带专属步骤的工具挂载完整 steps（对象字面量内无法引用自身 spec，故在此统一组合）。
 * 由 installTool 首次调用时触发一次，确保所有模块已加载完毕、无循环加载问题。
 */
export function ensureRegistrySteps(): void {
  if (_stepsInitialized) return;
  _stepsInitialized = true;
  const node = getSpec('node');
  if (node) node.steps = [...buildBaseSteps(node), nodeGlobalsStep];
  const mysql = getSpec('mysql');
  if (mysql) mysql.steps = [...buildBaseSteps(mysql), mysqlMyIniStep, mysqlInitStep, mysqlServiceStep];
  // Python（embeddable zip）：通用 5 步后追加「启用 site-packages」+「安装 pip（可选/需联网）」
  const python = getSpec('python');
  if (python) python.steps = [...buildBaseSteps(python), pythonSiteStep, pythonPipStep];
  // Go：通用 5 步后追加「GOPATH/bin 进 PATH（可选）」
  const go = getSpec('go');
  if (go) go.steps = [...buildBaseSteps(go), goPathStep];
  // Redis：通用 5 步后追加「注册并启动 Windows 服务（可选）」
  const redis = getSpec('redis');
  if (redis) redis.steps = [...buildBaseSteps(redis), redisServiceStep];
  // Maven / Gradle：声明国内镜像步骤（仅当用户勾选「使用国内镜像」时由 installer 追加到管线）
  const maven = getSpec('maven');
  if (maven) maven.mirrorStep = mavenMirrorStep;
  const gradle = getSpec('gradle');
  if (gradle) gradle.mirrorStep = gradleMirrorStep;
}
