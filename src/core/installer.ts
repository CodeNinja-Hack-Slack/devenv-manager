import fsp from 'node:fs/promises';
import type { DevEnvConfig, InstalledTool, InstallMode, InstallProgress, Platform, StepPlan, InstallPlan } from '../types.js';
import { getSpec } from '../tools/registry.js';
import { planInstallDir, planBinPath, planInstallBaseDir, join, normalizeSep } from '../utils/path.js';
import { toolId } from '../config/store.js';
import { recognizePackage } from './recognizer.js';
import type { DownloadOptions, DownloadResult } from './downloader.js';
import { Logger } from '../utils/logger.js';
import type { EnvBackend } from '../platform/env.js';
import { createEnvBackend, writeEnvPreview } from '../platform/env.js';
import { ensureRegistrySteps, buildBaseSteps } from './steps.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细安装日志，避免生产环境刷屏。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

// ============================================================================
// 安装流水线（在线/离线两种模式统一在此编排）
// 步骤管线：spec.steps（由 buildBaseSteps 通用基底 + 各软件专属步骤组合而成）。
// 每步 emit 真实进度（phase:'step'，携带 stepId/title/index/total/status）给前端时间线。
// 任一步失败：清理已解压目录 + 恢复环境变量快照 → 回滚。
// ============================================================================

export interface InstallParams {
  tool: string;
  /**
   * 精确版本（如 17.0.9）。
   * - 在线安装：必填。
   * - 离线安装：可选。未提供时由文件名识别（recognizePackage）兜底，
   *   仍识别不出则回退到 majorVersion（用户选的“大版本”，如 17）。
   */
  version?: string;
  /** 离线兜底用的“大版本”（如 17 / 20 / 3）；仅在无法从文件名识别版本时生效 */
  majorVersion?: string;
  mode: InstallMode;
  /** 离线模式：本地安装包路径 */
  localPath?: string;
  /** 是否设为该类别默认版本（默认：该类别尚无激活版本时设为默认） */
  makeActive?: boolean;
  /**
   * 本次安装「精确指定的目标文件夹」（可选，单次生效、不持久化）。
   * - 提供时：工具直接安装到该文件夹（destDir = targetDir），不再派生 {base}/{类别}/{tool}{version} 子目录结构。
   * - 不提供时：回退到 planInstallDir（全局 installDir 或默认 <rootDir>/data/install 之下的规范化子目录）。
   * 该参数实现需求 #4「让用户指定软件的安装目标文件夹路径」，与全局下载目录(downloadDir)相互独立。
   */
  targetDir?: string;
  /**
   * 本次安装「临时」指定的下载/安装目录（可选，单次生效、不持久化）。
   * - 提供时仅对本次安装生效，不会写入 devenv.yaml 的 downloadDir / installDir 默认配置
   *   （与询问弹窗中“记住默认路径”的持久化行为区分开）。
   * - 不提供时回退到 cfg.downloadDir / cfg.installDir（或系统默认 <rootDir>/data/...）。
   */
  downloadDir?: string;
  installDir?: string;
  /** 注入：下载实现（测试用），签名与 downloadFile 一致：接收单个 options 对象 */
  downloader?: (opts: DownloadOptions) => Promise<DownloadResult>;
  /** 注入：解压实现（测试用） */
  extractor?: (archive: string, dest: string, opts: any) => Promise<void>;
  /** 是否使用国内镜像（Maven/Gradle 安装时由界面勾选；为 true 时追加 mirrorStep 到管线） */
  useMirror?: boolean;
  /**
   * 规划模式透传的步骤参数（stepId → 参数键 → 值）。
   * 用户在规划视图编辑后随安装请求带回；installTool 逐步骤注入 ctx.params，
   * 使 run(ctx) 使用用户设置的值覆盖默认（如 node_global / node_cache 自定义目录）。
   */
  stepParams?: Record<string, Record<string, any>>;
}

export interface InstallContext {
  cfg: DevEnvConfig;
  env: EnvBackend;
  logger: Logger;
  platform?: Platform;
  onProgress?: (p: InstallProgress) => void;
}

export async function installTool(
  ctx: InstallContext,
  params: InstallParams,
): Promise<{ ok: boolean; installed?: InstalledTool; error?: string; warnings?: string[] }> {
  // 首次调用时挂载带专属步骤的工具 steps（避免模块循环加载）
  ensureRegistrySteps();
  const platform = ctx.platform ?? (process.platform as Platform);
  const spec = getSpec(params.tool);
  if (!spec) return { ok: false, error: `未知工具：${params.tool}` };
  // 仅纳管型工具（如 Docker Desktop 无便携包）不支持自动安装，直接拒绝并引导用户用扫描功能纳管
  if (spec.managedOnly) {
    return {
      ok: false,
      error: `${spec.name} 为「仅纳管」工具：请先安装 ${spec.name}，再使用「扫描」功能发现并纳管，本软件不提供自动安装`,
    };
  }

  // 路径规划：若本次调用显式指定了下载/安装目录，仅对本次安装生效（不持久化到配置）。
  // effCfg 是 ctx.cfg 的浅拷贝，仅覆盖 downloadDir/installDir；其余字段（含 tools 数组引用）保持共享。
  const effCfg =
    params.downloadDir || params.installDir
      ? {
          ...ctx.cfg,
          downloadDir: params.downloadDir ?? ctx.cfg.downloadDir,
          installDir: params.installDir ?? ctx.cfg.installDir,
        }
      : ctx.cfg;

  let destDir = '';
  let binPath = '';
  // 可选步骤（optional）失败产生的非致命提示（如 MySQL 服务注册需管理员权限而被跳过）
  const warnings: string[] = [];
  // 最终安装版本：在线必须指定；离线可留空，由文件名识别或用户选“大版本”兜底
  let resolvedVersion = params.version ?? '';
  // 回滚计划收集器：configure 步骤写入前填充，失败时据此还原环境（避免旧版本 PATH 条目丢失）
  const rollback = {
    pathSnapshot: undefined as string | undefined,
    envOpsBefore: new Map<string, string | undefined>(),
  };

  const emit = (phase: InstallProgress['phase'], percent: number, message: string) =>
    ctx.onProgress?.({ phase, percent, message });

  try {
    // 1) 校验 + 解析版本 + 确定目标目录（所有工具共用的预处理，不建模为 step）
    emit('validate', 5, '校验安装前置条件');
    const fileName = params.localPath ? params.localPath.split(/[\\/]/).pop()! : '';
    const rec = fileName ? recognizePackage(fileName) : null;
    if (params.mode === 'offline') {
      resolvedVersion = params.version ?? rec?.version ?? params.majorVersion ?? '';
      if (rec && rec.tool && rec.tool !== params.tool) {
        ctx.logger.warn(`离线包识别为 ${rec.name} ${rec.version}，与所选 ${spec.name} 不一致，以所选工具为准`);
      }
      if (!resolvedVersion) {
        return { ok: false, error: '无法识别版本：请确认文件名包含版本号（如 jdk-17.0.9），或在界面选择“大版本”' };
      }
    } else {
      if (!params.version) return { ok: false, error: '在线安装需要指定版本' };
      resolvedVersion = params.version;
    }

    destDir = params.targetDir
      ? normalizeSep(params.targetDir)
      : planInstallDir(planInstallBaseDir(effCfg), spec.category, spec.tool, resolvedVersion);
    // binPath 按 spec.binSubdir 派生：Redis 等根目录型工具 binSubdir='' → 即 destDir 根目录
    binPath = planBinPath(destDir, spec.binSubdir);
    try {
      await fsp.access(destDir);
      return { ok: false, error: `目标目录已存在：${destDir}（请先卸载或选择其他版本）` };
    } catch {
      /* 不存在，继续 */
    }

    // 2) 组装步骤管线并逐步执行（每步 emit 真实进度，前端按 step 渲染时间线）
    let steps = spec.steps ?? buildBaseSteps(spec);
    // 用户勾选「使用国内镜像」时，把该工具的 mirrorStep 追加到管线末尾（Maven/Gradle 支持）
    if (spec.mirrorStep && params.useMirror) steps = [...steps, spec.mirrorStep];
    const total = steps.length;
    // 安装开始前，先 emit 完整步骤计划（含每步标题/作用说明/是否可选），前端据此先渲染时间线骨架
    ctx.onProgress?.({
      phase: 'plan',
      percent: 2,
      message: `准备安装 ${spec.name} ${resolvedVersion}，共 ${total} 个步骤`,
      totalSteps: total,
      plan: steps.map((s) => ({ id: s.id, title: s.title, description: s.description, optional: !!s.optional })),
    });
    const applyEnv = !!ctx.cfg.applyEnv;
    const run: (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = applyEnv
      ? (bin, args) => runBinaryReal(bin, args)
      : async (bin, args) => ({ code: 0, stdout: `[dryRun] ${bin} ${args.join(' ')}`, stderr: '' });
    const stepCtx = {
      spec,
      destDir,
      binPath,
      version: resolvedVersion,
      platform,
      cfg: ctx.cfg,
      env: ctx.env,
      logger: ctx.logger,
      applyEnv,
      mode: params.mode,
      localPath: params.localPath,
      makeActive: params.makeActive,
      run,
      state: { downloader: params.downloader, extractor: params.extractor },
      rollback,
      params: {},
    } as any;

    for (let i = 0; i < total; i++) {
      const step = steps[i];
      // 注入本步骤的用户编辑参数（规划模式带回；缺省为空，run 内回退默认）
      stepCtx.params = params.stepParams?.[step.id] ?? {};
      ctx.onProgress?.({
        phase: 'step',
        stepId: step.id,
        stepTitle: step.title,
        stepDescription: step.description,
        stepIndex: i,
        totalSteps: total,
        percent: Math.round((i / total) * 100),
        message: `执行：${step.title}`,
        stepStatus: 'running',
      });
      const r = await step.run(stepCtx);
      if (!r.ok) {
        if (step.optional) {
          // 可选步骤失败：仅记警告、不回滚、不阻断后续步骤
          warnings.push(r.message ?? '步骤失败');
          ctx.onProgress?.({
            phase: 'step',
            stepId: step.id,
            stepTitle: step.title,
            stepDescription: step.description,
            stepIndex: i,
            totalSteps: total,
            percent: Math.round(((i + 1) / total) * 100),
            message: r.message ?? '步骤失败（可忽略）',
            stepStatus: 'warn',
          });
          continue;
        }
        throw new Error(r.message ?? `步骤「${step.title}」失败`);
      }
      ctx.onProgress?.({
        phase: 'step',
        stepId: step.id,
        stepTitle: step.title,
        stepDescription: step.description,
        stepIndex: i,
        totalSteps: total,
        percent: Math.round(((i + 1) / total) * 100),
        message: r.message ?? `${step.title} 完成`,
        stepStatus: 'done',
      });
    }

    emit('done', 100, `安装完成：${spec.name} ${resolvedVersion}`);
    ctx.logger.info(`[${params.mode}] 安装 ${spec.name} ${resolvedVersion} -> ${destDir}`);
    const inst = ctx.cfg.tools.find((t) => t.id === toolId(spec.category, spec.tool, resolvedVersion));
    return { ok: true, installed: inst, warnings: warnings.length ? warnings : undefined };
  } catch (e: any) {
    // 回滚：清理已解压目录 + 恢复环境变量
    if (destDir) await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    // 环境变量还原：仅当 configure 步骤已执行过才还原（rollback 收集器已被填充）
    try {
      // PATH 整体还原快照：覆盖式写回安装前的值，避免「安装第二个版本时移除旧版本
      // PATH 条目、仅增量 removePath(pathAdded)」导致旧条目永久丢失、PATH 变空。
      if (rollback.pathSnapshot !== undefined) await ctx.env.restorePath(rollback.pathSnapshot);
      // 非 PATH 变量（如 JAVA_HOME）精确还原到修改前的值（或删除未修改过的变量）
      for (const [name, before] of rollback.envOpsBefore) {
        if (before === undefined) await ctx.env.unset(name);
        else await ctx.env.set(name, before);
      }
      if (!ctx.cfg.applyEnv) await writeEnvPreview(ctx.cfg.rootDir, ctx.env.preview());
    } catch {
      /* 还原失败不阻断主回滚流程 */
    }
    emit('rollback', 0, `安装失败，已回滚：${e.message}`);
    ctx.logger.error(`安装失败 ${params.tool} ${resolvedVersion}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export { createEnvBackend };

/**
 * 安装「规划模式」：组装完整步骤管线并返回每步的可编辑参数与预览，
 * **绝不触碰系统**（dryRun 上下文，run 为占位）。供前端「先规划后执行」视图在用户确认前展示。
 * 与 installTool 共用版本解析 / 目标目录规划逻辑，保证预览与实际执行一致。
 */
export function planInstall(ctx: InstallContext, params: InstallParams): InstallPlan {
  ensureRegistrySteps();
  const platform = ctx.platform ?? (process.platform as Platform);
  const spec = getSpec(params.tool);
  if (!spec) throw new Error(`未知工具：${params.tool}`);
  if (spec.managedOnly) {
    throw new Error(`${spec.name} 为「仅纳管」工具，请使用「扫描」纳管，不支持自动安装规划`);
  }

  // 1) 解析版本（与 installTool 一致）
  let resolvedVersion = params.version ?? '';
  if (params.mode === 'offline') {
    const fileName = params.localPath ? params.localPath.split(/[\\/]/).pop()! : '';
    const rec = fileName ? recognizePackage(fileName) : null;
    resolvedVersion = params.version ?? rec?.version ?? params.majorVersion ?? '';
    if (!resolvedVersion) throw new Error('无法识别版本：请提供版本或本地包文件名包含版本号');
  } else if (!resolvedVersion) {
    throw new Error('在线安装需要指定版本');
  }

  // 2) 解析目标目录（与 installTool 一致）
  const effCfg =
    params.downloadDir || params.installDir
      ? { ...ctx.cfg, downloadDir: params.downloadDir ?? ctx.cfg.downloadDir, installDir: params.installDir ?? ctx.cfg.installDir }
      : ctx.cfg;
  const destDir = params.targetDir
    ? normalizeSep(params.targetDir)
    : planInstallDir(planInstallBaseDir(effCfg), spec.category, spec.tool, resolvedVersion);
  const binPath = planBinPath(destDir, spec.binSubdir);

  // 3) 构造规划上下文（dryRun：applyEnv=false，run 为占位，绝不触碰系统）
  const planCtx = {
    spec,
    destDir,
    binPath,
    version: resolvedVersion,
    platform,
    cfg: ctx.cfg,
    env: ctx.env,
    logger: ctx.logger,
    applyEnv: false,
    mode: params.mode,
    localPath: params.localPath,
    makeActive: params.makeActive,
    run: async (_bin: string, _args: string[]) => ({ code: 0, stdout: '', stderr: '' }),
    state: { downloader: params.downloader, extractor: params.extractor },
    rollback: { envOpsBefore: new Map<string, string | undefined>() },
    params: {},
  } as any;

  // 4) 组装步骤管线（含国内镜像追加）
  let steps = spec.steps ?? buildBaseSteps(spec);
  if (spec.mirrorStep && params.useMirror) steps = [...steps, spec.mirrorStep];

  // 5) 每步计算默认参数 + 预览，组装 StepPlan（合并用户在规划阶段已编辑的 stepParams，使预览所见即所得）
  const planSteps: StepPlan[] = steps.map((s) => {
    const paramsDef = s.computeParams ? s.computeParams(planCtx) : [];
    const overrides = (params.stepParams?.[s.id] as Record<string, any>) ?? {};
    const merged = paramsDef.map((p) =>
      overrides[p.key] !== undefined ? { ...p, value: overrides[p.key] as string | boolean } : p,
    );
    const values = Object.fromEntries(merged.map((p) => [p.key, p.value]));
    const preview = s.preview ? s.preview(planCtx, values) : { notes: ['执行该步骤'] };
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      optional: !!s.optional,
      params: merged,
      preview,
    };
  });

  return { tool: spec.tool, name: spec.name, version: resolvedVersion, destDir, steps: planSteps };
}

/**
 * 真实执行一个可执行文件（安装后钩子用来跑 mysqld / net / node 等系统命令）。
 * 失败时不抛出，而是返回非零退出码 + 捕获的 stdout/stderr，交给调用方决定如何反馈。
 */
async function runBinaryReal(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileP(bin, args, { windowsHide: true });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e: any) {
    return { code: e?.code ?? e?.exitCode ?? 1, stdout: e?.stdout ?? '', stderr: e?.stderr ?? '' };
  }
}
