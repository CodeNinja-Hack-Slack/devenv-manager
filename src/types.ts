// ============================================================================
// DevEnv Manager — 核心类型定义
// 引擎层(src/) 不依赖 Electron，可同时被主进程(Node) 与 Vitest 复用。
// ============================================================================

import type { EnvBackend } from './platform/env.js';
import type { Logger } from './utils/logger.js';
import type { ToolSpec } from './tools/registry.js';

export type Platform = 'win32' | 'darwin' | 'linux';

/** 工具类别 → 统一目录名（与需求规范一致） */
export type ToolCategory =
  | 'java'
  | 'build-tool'
  | 'node'
  | 'ide'
  | 'database'
  | 'container'
  | 'tool'
  | 'go'
  | 'python'
  | 'web-server';

export type InstallMode = 'online' | 'offline' | 'external';

export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar.xz' | 'msi' | 'exe' | 'dmg' | 'unknown';

export type DownloadSource = 'official' | 'mirror';

/** 单个已安装工具在 devenv.yaml 中的记录 */
export interface InstalledTool {
  /** 唯一 ID：category/tool/version，例如 java/jdk/17.0.9 */
  id: string;
  category: ToolCategory;
  /** 工具标识：jdk / maven / node / idea ... */
  tool: string;
  /** 展示名：JDK / Maven ... */
  name: string;
  version: string;
  /** 安装目录（绝对路径，位于 rootDir 之下） */
  path: string;
  /** bin 子目录（拼到 PATH） */
  binPath: string;
  /** 对应的 HOME 变量名，如 JAVA_HOME / MAVEN_HOME */
  homeVar?: string;
  /** 安装来源模式 */
  mode: InstallMode;
  /** 是否为该类别的默认版本 */
  active: boolean;
  /** 是否已加入 PATH */
  addedToPath: boolean;
  /** 安装时间（ISO 字符串） */
  installedAt: string;
  /**
   * 版本固定变量名标签（如 JAVA_HOME17）。
   * 注意（Plan B 起）：该变量仅作为 devenv.yaml 内的展示/迁移标签，
   * 不再写入系统注册表。多版本清单由 devenv.yaml 的 tools[] 承担（文件化 inventory）。
   */
  versionVar?: string;
}

export interface MirrorConfig {
  source: DownloadSource;
  mirrors: Record<string, string>;
  default: string;
  /** 下载并发线程数 */
  threads: number;
}

/** 配置方案（如“公司项目”/“个人项目”） */
export interface ProfileSpec {
  label: string;
  /** tool(如 jdk) -> version(如 17.0.9) */
  tools: Record<string, string>;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

export interface DevEnvConfig {
  version: number;
  rootDir: string;
  download: MirrorConfig;
  /**
   * 用户自定义「下载目录」（可选）。
   * - 为空（默认）：使用 <rootDir>/data/download（位于 data 数据目录下），
   *   且不会在配置初始化/打开设置时预先创建该文件夹，
   *   仅在真实下载/安装操作发生时按需创建（见 requirement #3）。
   * - 非空：用户显式指定的路径，保存设置时立即创建该文件夹。
   */
  downloadDir?: string;
  /**
   * 用户自定义「安装目录」（可选）。
   * - 为空（默认）：使用 <rootDir>/data/install，同样按需懒创建。
   * - 非空：用户显式指定的路径，保存设置时立即创建该文件夹。
   */
  installDir?: string;
  /**
   * 是否将环境变量写入系统（JAVA_HOME / PATH 等）。默认 true。
   * - true（发布/正式使用）：安装、切换、迁移会真正修改系统用户级环境变量。
   * - false（测试期）：所有环境变量操作仅被收集并记录到 <rootDir>/config/env-preview.json，
   *   绝不触碰系统环境变量——用于保护本机已有的 Java 等多版本环境不被改动。
   * 注意：该开关只影响系统环境变量的写入；安装包下载、解压、devenv.yaml 配置注册等仍正常进行。
   */
  applyEnv?: boolean;
  /**
   * 是否启用“下载/安装路径询问弹窗”。默认 true（每次操作都询问）。
   * - true / 未设置（默认）：每次执行下载/安装操作前，软件主动弹出路径选择提示，由用户确认本次路径。
   * - false：用户已在询问弹窗中勾选“以后均使用默认下载路径和默认安装路径”，
   *   后续所有下载/安装操作自动使用 config 中已记录的 downloadDir / installDir
   *   （若为空则回落到系统默认 <rootDir>/data/...），不再弹出询问提示。
   * 该标志随 downloadDir / installDir 一并持久化到 devenv.yaml。
   */
  pathPromptEnabled?: boolean;
  tools: InstalledTool[];
  profiles: Record<string, ProfileSpec>;
  language: 'zh' | 'en';
}

/** 扫描结果（系统已安装的工具） */
export interface ScanResult {
  tool: string;
  name: string;
  category: ToolCategory;
  version: string | null;
  path: string | null;
  inPath: boolean;
}

/** 离线安装包识别结果 */
export interface RecognizedPackage {
  tool: string;
  name: string;
  category: ToolCategory;
  version: string;
  format: ArchiveFormat;
  /** 识别来源：文件名 / 包内 / 手动 */
  source: 'filename' | 'archive' | 'manual';
  confidence: number;
}

/** 下载分片 */
export interface ChunkRange {
  index: number;
  start: number;
  end: number; // 含
  downloaded: number;
}

/** 环境变量操作（供回滚快照） */
export interface EnvOp {
  kind: 'set' | 'appendPath' | 'removePath' | 'unset';
  name: string;
  value?: string;
}

/** 安装进度事件 */
export type InstallPhase = 'validate' | 'plan' | 'fetch' | 'extract' | 'configure' | 'verify' | 'done' | 'rollback' | 'step';

/** 单个安装步骤的运行状态（前端时间线用） */
export type StepStatus = 'pending' | 'running' | 'done' | 'warn' | 'error';

/**
 * 安装步骤的运行上下文（每个 InstallStep.run 收到）。
 * 由安装器在遍历 steps 时组装，step 不直接接触安装器内部局部变量。
 */
export interface StepContext {
  /** 当前工具规格 */
  spec: ToolSpec;
  /** 安装目标目录（已扁平化单层根目录） */
  destDir: string;
  /** 主可执行文件 bin 目录（planBinPath(destDir, binSubdir)） */
  binPath: string;
  /** 已解析的安装版本 */
  version: string;
  /** 运行平台 */
  platform: Platform;
  /** 当前生效配置（步骤可就地修改 tools 数组，由写配置步骤持久化） */
  cfg: DevEnvConfig;
  /** 环境变量后端（仅应用环境变量模式下真实写入系统） */
  env: EnvBackend;
  /** 日志器 */
  logger: Logger;
  /** 是否处于「应用环境变量」模式（true=真实写入系统；false=dryRun） */
  applyEnv: boolean;
  /** 安装模式（在线/离线），供下载步骤判断是下载还是复制本地包 */
  mode: InstallMode;
  /** 离线模式下的本地安装包路径 */
  localPath?: string;
  /** 是否设为该类别默认版本（来自 params.makeActive；未指定时由写配置步骤按「该类别尚无激活版本」推导） */
  makeActive?: boolean;
  /** 运行命令（已据 applyEnv 决定真假执行；dryRun 下返回占位结果，不真正执行） */
  run: (bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 步骤间透传状态（如 node_global 路径供后续步骤使用） */
  state: Record<string, any>;
  /** 回滚计划收集器：configure 步骤写入前填充，安装器在整体失败时据此还原环境 */
  rollback: RollbackPlan;
  /** 当前步骤的可编辑参数值（规划模式由用户设置；执行时透传，run 读取以覆盖默认值） */
  params?: Record<string, any>;
}

/** 安装步骤执行结果 */
export interface StepResult {
  ok: boolean;
  /** 完成/失败的可读信息（前端展示） */
  message?: string;
  /** 是否仅警告（optional 步骤失败时置 true，不阻断后续步骤、不回滚） */
  warning?: boolean;
}

/** 一个可声明的安装步骤（每款软件由通用基底 + 专属步骤组合而成） */
export interface InstallStep {
  /** 步骤唯一 id，如 'fetch' | 'node:globals' | 'mysql:init' */
  id: string;
  /** 展示标题，如 '下载安装包' | '配置 npm 全局目录' */
  title: string;
  /** 补充说明（可选） */
  description?: string;
  /** 是否为可选步骤：失败仅记警告、不回滚、不阻断后续步骤（如服务注册需管理员） */
  optional?: boolean;
  /** 声明可编辑参数（规划模式让用户配置；返回带默认值的参数列表，默认值可据 ctx 派生） */
  computeParams?: (ctx: StepContext) => StepParam[];
  /** 纯函数预览：根据参数值返回该步骤“会做什么”（环境变量/文件/目录/命令），绝不触碰系统 */
  preview?: (ctx: StepContext, values: Record<string, any>) => StepPreview;
  /** 执行体 */
  run: (ctx: StepContext) => Promise<StepResult>;
}

/** 步骤可编辑参数（规划模式 UI 渲染为输入控件） */
export interface StepParam {
  /** 参数键，run 时通过 ctx.params[key] 读取 */
  key: string;
  /** 展示标签，如 'npm 全局目录' */
  label: string;
  /** 控件类型 */
  type: 'text' | 'path' | 'checkbox';
  /** 默认值（也是规划视图初始值） */
  value: string | boolean;
  /** 输入占位符 */
  placeholder?: string;
  /** 补充说明（如“建议保留默认”） */
  hint?: string;
}

/** 步骤预览（规划模式展示“会做什么”，不触碰系统） */
export interface StepPreview {
  /** 将写入/修改的环境变量操作 */
  envOps?: EnvOp[];
  /** 将创建/修改的文件 */
  files?: { path: string; note?: string }[];
  /** 将创建的目录 */
  dirs?: string[];
  /** 将执行的命令（仅展示，不执行） */
  commands?: string[];
  /** 其它提示 */
  notes?: string[];
}

/** 规划模式下单个步骤的计划（含可编辑参数与预览） */
export interface StepPlan {
  id: string;
  title: string;
  description?: string;
  optional?: boolean;
  params: StepParam[];
  preview: StepPreview;
}

/** 安装规划（install:plan 返回，前端规划视图渲染） */
export interface InstallPlan {
  tool: string;
  name: string;
  version: string;
  /** 目标安装目录（已解析） */
  destDir: string;
  /** 完整步骤计划 */
  steps: StepPlan[];
}

/** 回滚计划收集器（installer 持有，configure 步骤填充，失败时还原） */
export interface RollbackPlan {
  pathSnapshot?: string;
  envOpsBefore: Map<string, string | undefined>;
}

export interface InstallProgress {
  phase: InstallPhase;
  percent: number;
  message: string;
  /** 步骤模式（phase==='step'）下携带的步骤元信息 */
  stepId?: string;
  stepTitle?: string;
  /** 步骤的「作用说明」（前端时间线展示，让用户理解这一步在做什么、为什么需要） */
  stepDescription?: string;
  stepIndex?: number;
  totalSteps?: number;
  stepStatus?: StepStatus;
  /** 安装开始前（phase==='plan'）携带完整步骤计划，前端据此先渲染时间线骨架（含每步说明） */
  plan?: { id: string; title: string; description?: string; optional?: boolean }[];
}
