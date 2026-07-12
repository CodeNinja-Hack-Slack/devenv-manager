// ============================================================================
// UI 与引擎的桥接层
// - Electron 桌面端：使用 preload 暴露的 window.devenv（真实系统操作）
// - 浏览器预览（npm run dev）：降级到 mockApi
//   重要：mockApi 的根目录由用户在“首次配置引导”界面自行指定（存 localStorage），
//   不写死任何默认值；所有 mock 数据均基于用户配置的根目录动态拼接，
//   因此预览模式下的路径与用户真实配置保持一致，不会暴露硬编码目录。
// ============================================================================

export interface ScanResult {
  tool: string;
  name: string;
  category: string;
  version: string | null;
  path: string | null;
  inPath: boolean;
}
export interface InstalledTool {
  id: string;
  category: string;
  tool: string;
  name: string;
  version: string;
  path: string;
  binPath: string;
  homeVar?: string;
  mode: 'online' | 'offline' | 'external';
  active: boolean;
  addedToPath: boolean;
  installedAt: string;
}
export interface ProfileSpec {
  label: string;
  tools: Record<string, string>;
  env?: Record<string, string>;
}

/** 离线安装包识别结果（与引擎 types.ts 对齐） */
export interface RecognizedPackage {
  tool: string;
  name: string;
  category: string;
  version: string;
  format: string;
  source: 'filename' | 'archive' | 'manual';
  confidence: number;
}

/** 概览页统一工具条目（引擎 scanner.DashboardTool 的 UI 镜像） */
export interface DashboardTool {
  name: string;
  version: string;
  category: string;
  tool: string;
  /** installed=本软件安装并纳管 / detected=系统已有未纳管 */
  source: 'installed' | 'detected';
  path: string;
  /** 已纳管工具的唯一 ID（source=installed 时有值；detected 待纳管时为空） */
  id?: string;
  mode?: 'online' | 'offline' | 'external';
  active?: boolean;
  inPath?: boolean;
  /** 是否为「当前正在使用」的版本（概览去重后每工具仅一个） */
  current?: boolean;
  /** 当前使用来源：managed=本软件默认 / system=系统 PATH 解析 */
  using?: 'managed' | 'system';
}

/** 版本固定变量信息（引用式切换的变量体系） */
export interface VersionVarInfo {
  /** 版本号，如 '17.0.9' */
  version: string;
  /** 指向的绝对路径 */
  path: string;
  /** 版本固定变量名，如 'JAVA_HOME_17_0_9' */
  varName: string;
  /** 是否为当前激活版本 */
  active: boolean;
  /** 数据来源：config=已纳管 / registry=从注册表发现 */
  source?: 'config' | 'registry';
}

/** 环境变量检视：单个变量的条目（聚焦版，仅含 devenv 管理的开发工具相关变量） */
export interface EnvVarEntry {
  /** 变量名，如 JAVA_HOME */
  key: string;
  /** 生效值（用户级优先于系统级，再回退进程/无） */
  effective?: string;
  /** 用户级（HKCU）值，未设置则为 undefined */
  user?: string;
  /** 系统级（HKLM）值，未设置则为 undefined */
  system?: string;
  /** 生效值来源层级 */
  source: 'user' | 'system' | 'process' | 'none';
  /** 展开 %VAR% 后的可读值（与 effective 可能不同，用于展示真实路径） */
  expanded?: string;
  /** 是否为遗留版本固定变量（如 JAVA_HOME17） */
  isVersionVar?: boolean;
  /** 归属工具 key（jdk/maven/...），用于分组与图标 */
  tool?: string;
}

/** PATH 中由本软件注入的段 */
export interface EnvPathSegment {
  /** 原始段，如 %JAVA_HOME%\bin */
  raw: string;
  /** 是否由 devenv 注入（引用某个 HOME 变量） */
  ours: boolean;
  /** 对应的 HOME 变量名 */
  homeVar?: string;
  /** 展开后的路径 */
  expanded?: string;
}

/** 单款工具的 HOME 变量及其遗留版本变量 */
export interface EnvToolVar {
  /** 工具 key */
  tool: string;
  /** 工具显示名，如 JDK */
  name: string;
  /** HOME 变量名，如 JAVA_HOME */
  homeVar: string;
  /** HOME 变量条目 */
  entry: EnvVarEntry;
  /** 遗留版本固定变量条目（Plan B 架构下通常为空） */
  versionEntries: EnvVarEntry[];
}

/** env:inspect 返回结果 */
export interface EnvInspectResult {
  /** 每款工具的 HOME 变量（含无显式 homeVar 的工具派生，如 git→GIT_HOME） */
  tools: EnvToolVar[];
  /** PATH：仅含由 devenv 注入的段，其余系统段不返回 */
  path: {
    /** 完整 PATH 原文 */
    effective: string;
    /** 展开 %VAR% 后的 PATH */
    expanded: string;
    /** PATH 总段数（含系统段，仅用于提示） */
    total: number;
    /** 由 devenv 注入的段数 */
    oursCount: number;
    /** 由 devenv 注入的段列表 */
    segments: EnvPathSegment[];
  };
}

/** 安装真实进度事件（引擎步骤管线透传，前端渲染竖向时间线） */
export interface InstallProgressEvent {
  phase: 'validate' | 'plan' | 'step' | 'done' | 'rollback';
  percent: number;
  message: string;
  /** step 阶段携带的元信息 */
  stepId?: string;
  stepTitle?: string;
  /** 步骤的「作用说明」 */
  stepDescription?: string;
  stepIndex?: number;
  totalSteps?: number;
  stepStatus?: 'pending' | 'running' | 'done' | 'warn' | 'error';
  /** plan 阶段：完整步骤计划（前端先渲染时间线骨架） */
  plan?: { id: string; title: string; description?: string; optional?: boolean }[];
}

/** 规划模式：步骤可编辑参数（UI 渲染为输入控件） */
export interface StepParamUI {
  key: string;
  label: string;
  type: 'text' | 'path' | 'checkbox';
  value: string | boolean;
  placeholder?: string;
  hint?: string;
}

/** 规划模式：步骤预览（展示“会做什么”，不触碰系统） */
export interface StepPreviewUI {
  envOps?: { kind: string; name: string; value?: string }[];
  files?: { path: string; note?: string }[];
  dirs?: string[];
  commands?: string[];
  notes?: string[];
}

/** 规划模式：单个步骤计划 */
export interface StepPlanUI {
  id: string;
  title: string;
  description?: string;
  optional?: boolean;
  params: StepParamUI[];
  preview: StepPreviewUI;
}

/** 规划模式：完整安装计划（install:plan 返回，前端规划视图渲染） */
export interface InstallPlanUI {
  tool: string;
  name: string;
  version: string;
  destDir: string;
  steps: StepPlanUI[];
}

export interface DevEnvApi {
  initRoot(): Promise<{ rootDir: string; configured: boolean }>;
  setRoot(root: string): Promise<{ ok: boolean; error?: string }>;
  getConfig(): Promise<any>;
  saveConfig(cfg: any): Promise<{ ok: boolean; error?: string }>;
  scan(): Promise<ScanResult[]>;
  /** 读取缓存的扫描结果（不重新扫描，启动时快速展示用） */
  getScanCache(): Promise<ScanResult[]>;
  exportReport(fmt: 'json' | 'md'): Promise<string>;
  /** 概览「已安装工具」：合并已纳管 + 系统已检测，供分组展示 */
  getDashboardTools(): Promise<DashboardTool[]>;
  /** 概览「当前使用中的工具」：每个工具仅挑出正在用的那一版 */
  getCurrentTools(): Promise<DashboardTool[]>;
  listRemote(tool: string): Promise<string[]>;
  installOnline(
    tool: string,
    version: string,
    opts?: { downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean },
  ): Promise<any>;
  installOffline(
    tool: string,
    opts: { version?: string; majorVersion?: string; localPath: string; downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean },
  ): Promise<any>;
  /** 安装规划（先规划后执行）：返回完整步骤计划（每步可编辑参数 + 环境/文件变更预览），不触碰系统 */
  planInstall(
    tool: string,
    version: string,
    opts?: { mode?: string; downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean; majorVersion?: string; localPath?: string; stepParams?: Record<string, Record<string, any>> },
  ): Promise<{ ok: boolean; plan?: InstallPlanUI; error?: string }>;
  /** 订阅安装真实进度事件（步骤时间线）；返回取消订阅函数。预览模式(mock)下由 mock 合成步骤进度 */
  onInstallProgress(cb: (p: InstallProgressEvent) => void): () => void;
  /** 离线安装前识别本地包：工具/版本/格式（来自文件名） */
  recognize(localPath: string): Promise<RecognizedPackage | null>;
  pickFile(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  switchVersion(category: string, version: string): Promise<any>;
  /** 切换前校验：工具路径是否存在 */
  switchVerify(toolPath: string, binPath?: string): Promise<{ exists: boolean; reason?: string }>;
  /** 激活系统检测到的工具为默认版本 */
  activateDetectedTool(payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }): Promise<any>;
  /** 纳管「电脑上已存在的开发软件」：登记到统一配置（不激活） */
  addExistingTool(payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }): Promise<any>;
  /** 移除纳管：仅删除「外部纳管」记录，不删文件、不改环境变量 */
  removeExistingTool(payload: { id?: string; tool?: string; version?: string; path?: string }): Promise<any>;
  /** 卸载工具（本软件安装的 + 已纳管的外部软件）；deleteFiles 控制是否删除安装目录文件 */
  uninstallTool(id: string, opts?: { deleteFiles?: boolean }): Promise<any>;
  /** 在文件资源管理器中定位「安装目录所在文件夹」位置（每个软件工具行通用） */
  openFolder(folderPath: string): Promise<{ ok: boolean; error?: string; note?: string }>;
  /** 列出某工具的所有版本固定变量（引用式切换的变量体系） */
  listVersionVars(tool: string): Promise<VersionVarInfo[]>;
  migrate(newRoot: string, move?: boolean): Promise<any>;
  /** 只读检视环境变量：仅返回 devenv 管理的开发工具相关变量（HOME 变量 + PATH 注入段） */
  envInspect(): Promise<EnvInspectResult>;
  profiles(): Promise<Record<string, ProfileSpec>>;
  applyProfile(id: string): Promise<any>;
}

declare global {
  interface Window {
    devenv?: DevEnvApi;
  }
}

// ------------------------- 浏览器预览用 Mock -------------------------
// 根目录完全由用户配置，存 localStorage；未配置则为空，UI 会显示配置引导。
const LS_ROOT = 'devenv.mock.root';

function readMockRoot(): string {
  try {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(LS_ROOT) : null) || '';
  } catch {
    return '';
  }
}
function writeMockRoot(root: string) {
  try {
    localStorage.setItem(LS_ROOT, root);
  } catch {
    /* ignore */
  }
}

let mockRoot = readMockRoot();
/** 浏览器预览模式下，保存的设置仅在本会话内有效（用于演示“记住默认路径”等行为） */
let mockSaved: any = null;

/** 基于用户配置的根目录拼接路径（不写死盘符/目录名） */
function withRoot(parts: string[]): string {
  const base = mockRoot.replace(/[\\/]+$/, '');
  return [base, ...parts].filter(Boolean).join('/');
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 浏览器预览模式下，安装进度订阅回调（由 mock 安装流程合成步骤进度后回调用） */
let mockProgressCb: ((p: InstallProgressEvent) => void) | null = null;
/** 通用基底步骤序列（大多数工具的安装管线），用于预览模式合成时间线（含作用说明） */
const MOCK_BASE_STEPS: { id: string; title: string; description: string; optional?: boolean }[] = [
  { id: 'fetch', title: '获取安装包', description: '在线下载（支持多线程/断点续传）或复制本地离线包到统一缓存目录' },
  { id: 'extract', title: '解压到统一目录', description: '按归档格式解压到规划好的安装目录，并整理出可执行文件所在的 bin 子目录' },
  { id: 'configure-env', title: '写入 HOME 环境变量', description: '设置主目录变量（如 JAVA_HOME），指向本次安装目录；多版本切换时只改此变量、PATH 不变' },
  { id: 'configure-path', title: '追加 bin 目录到 PATH', description: '将 %HOME_VAR%\\bin 加入系统 PATH，使命令在任意终端可用；并清理同类旧版本遗留条目' },
  { id: 'verify-files', title: '校验主程序文件完整性', description: '确认解压目录中存在关键可执行文件（如 java / mvn / node），缺失即判定安装失败' },
  { id: 'verify-env', title: '校验环境变量已生效', description: '回读刚写入的 HOME 变量与 PATH，确认已落盘；读取不到仅提示，不阻断安装' },
  { id: 'writeConfig', title: '写入配置并激活', description: '将本次安装登记到 devenv.yaml（多版本清单单一真相源），并设为该类别的默认版本' },
];
/** 预览模式：先 emit 完整步骤计划骨架（含作用说明），再逐步 emit 合成步骤进度 */
async function emitMockSteps(extra: { id: string; title: string; description: string; optional?: boolean }[] = [], delayMs = 150): Promise<void> {
  const all = [...MOCK_BASE_STEPS, ...extra];
  const total = all.length;
  // 安装开始前先渲染完整步骤计划骨架（含每步标题/作用说明/是否可选）
  mockProgressCb?.({
    phase: 'plan', percent: 2, message: `准备安装，共 ${total} 个步骤`,
    totalSteps: total,
    plan: all.map((s) => ({ id: s.id, title: s.title, description: s.description, optional: !!s.optional })),
  });
  await delay(delayMs);
  for (let i = 0; i < total; i++) {
    const s = all[i];
    mockProgressCb?.({ phase: 'step', stepId: s.id, stepTitle: s.title, stepDescription: s.description, stepIndex: i, totalSteps: total, percent: Math.round((i / total) * 100), message: `执行：${s.title}`, stepStatus: 'running' });
    await delay(delayMs);
    mockProgressCb?.({ phase: 'step', stepId: s.id, stepTitle: s.title, stepDescription: s.description, stepIndex: i, totalSteps: total, percent: Math.round(((i + 1) / total) * 100), message: `${s.title} 完成`, stepStatus: 'done' });
  }
  mockProgressCb?.({ phase: 'done', percent: 100, message: '安装完成' });
}

/** 预览模式：根据工具与「国内镜像」选项，合成额外的步骤（npm 全局目录 / 服务注册 / 镜像配置），含可编辑参数与预览 */
type MockExtra = { id: string; title: string; description: string; optional?: boolean; params?: StepParamUI[]; preview?: StepPreviewUI };
function mockExtras(tool: string, opts?: any): MockExtra[] {
  const extras: MockExtra[] = [];
  if (tool === 'node') {
    const g = withRoot(['data', 'install', 'node', 'node' + (opts?.version ?? '20.11.1'), 'node_global']);
    const c = withRoot(['data', 'install', 'node', 'node' + (opts?.version ?? '20.11.1'), 'node_cache']);
    extras.push({
      id: 'node:globals', title: '配置 npm 全局目录', description: '设置 node_global / node_cache，避免污染系统目录',
      optional: true,
      params: [
        { key: 'nodeGlobal', label: 'npm 全局目录 (node_global)', type: 'path', value: g, hint: 'npm install -g 全局包的安装位置' },
        { key: 'nodeCache', label: 'npm 缓存目录 (node_cache)', type: 'path', value: c, hint: 'npm 下载缓存目录' },
      ],
      preview: { dirs: [g, c], commands: [`npm config set prefix ${g}`, `npm config set cache ${c}`], envOps: [{ kind: 'appendPath', name: 'PATH', value: '%NODE_HOME%\\node_global' }] },
    });
  }
  if (tool === 'redis') extras.push({
    id: 'redis:service', title: '注册并启动 Windows 服务', description: '将 Redis 注册为 Windows 服务并启动，使其后台常驻（失败仅警告）',
    optional: true,
    params: [{ key: 'serviceName', label: 'Windows 服务名', type: 'text', value: 'Redis' }],
    preview: { commands: ['redis-server --service-install redis.windows.conf --loglevel verbose', 'redis-server --service-start'] },
  });
  if ((tool === 'maven' || tool === 'gradle') && opts?.useMirror) {
    extras.push({
      id: `${tool}:mirror`, title: '配置国内镜像（阿里云）', description: '写入阿里云镜像配置，加速依赖下载',
      optional: true,
      params: [{ key: 'mirrorUrl', label: '镜像仓库地址', type: 'text', value: 'https://maven.aliyun.com/repository/public', hint: '可改为其它镜像源' }],
      preview: { files: [{ path: tool === 'maven' ? '~/.m2/settings.xml' : '~/.gradle/init.gradle', note: '写入阿里云镜像' }] },
    });
  }
  return extras;
}

const mockApi: DevEnvApi = {
  async initRoot() {
    mockRoot = readMockRoot();
    return { rootDir: mockRoot, configured: !!mockRoot };
  },
  async setRoot(root: string) {
    mockRoot = root;
    writeMockRoot(root);
    return { ok: true };
  },
  async saveConfig(cfg: any) {
    mockSaved = cfg;
    return { ok: true };
  },
  async getConfig() {
    const cfg: any = {
      rootDir: mockRoot,
      download: { source: 'mirror', threads: 4 },
      downloadDir: '',
      installDir: '',
      applyEnv: true,
      pathPromptEnabled: true,
      tools: mockRoot
        ? [
            {
              id: 'java/jdk/17.0.9', category: 'java', tool: 'jdk', name: 'JDK', version: '17.0.9',
              path: withRoot(['data', 'install', 'java', 'jdk17.0.9']), binPath: withRoot(['data', 'install', 'java', 'jdk17.0.9', 'bin']),
              homeVar: 'JAVA_HOME', mode: 'online', active: true, addedToPath: true, installedAt: '2026-07-01',
            },
            {
              id: 'java/jdk/8.0', category: 'java', tool: 'jdk', name: 'JDK', version: '8.0',
              path: withRoot(['data', 'install', 'java', 'jdk8.0']), binPath: withRoot(['data', 'install', 'java', 'jdk8.0', 'bin']),
              homeVar: 'JAVA_HOME', mode: 'offline', active: false, addedToPath: true, installedAt: '2026-07-02',
            },
            {
              id: 'build-tool/maven/3.9.6', category: 'build-tool', tool: 'maven', name: 'Maven', version: '3.9.6',
              path: withRoot(['data', 'install', 'build-tool', 'maven3.9.6']), binPath: withRoot(['data', 'install', 'build-tool', 'maven3.9.6', 'bin']),
              homeVar: 'MAVEN_HOME', mode: 'online', active: true, addedToPath: true, installedAt: '2026-07-01',
            },
            {
              id: 'node/node/20.11.1', category: 'node', tool: 'node', name: 'Node.js', version: '20.11.1',
              path: withRoot(['data', 'install', 'node', 'node20.11.1']), binPath: withRoot(['data', 'install', 'node', 'node20.11.1']),
              mode: 'online', active: true, addedToPath: true, installedAt: '2026-07-03',
            },
          ]
        : [],
      profiles: {
        company: { label: '公司项目', tools: { jdk: '8.0', maven: '3.9.6' } },
        personal: { label: '个人项目', tools: { jdk: '17.0.9', node: '20.11.1' } },
      },
    };
    // 合并会话内已保存的路径相关设置（演示“记住默认路径”等行为）
    if (mockSaved) {
      if (mockSaved.downloadDir != null) cfg.downloadDir = mockSaved.downloadDir;
      if (mockSaved.installDir != null) cfg.installDir = mockSaved.installDir;
      if (mockSaved.pathPromptEnabled != null) cfg.pathPromptEnabled = mockSaved.pathPromptEnabled;
      if (mockSaved.applyEnv != null) cfg.applyEnv = mockSaved.applyEnv;
    }
    return cfg;
  },
  async scan() {
    if (!mockRoot) return [];
    const results = [
      { tool: 'jdk', name: 'JDK', category: 'java', version: '17.0.9', path: withRoot(['data', 'install', 'java', 'jdk17.0.9']), inPath: true },
      { tool: 'jdk', name: 'JDK', category: 'java', version: '8.0', path: 'C:\\Program Files\\Java\\jdk8', inPath: false },
      { tool: 'maven', name: 'Maven', category: 'build-tool', version: '3.9.6', path: withRoot(['data', 'install', 'build-tool', 'maven3.9.6']), inPath: true },
      { tool: 'node', name: 'Node.js', category: 'node', version: '20.11.1', path: withRoot(['data', 'install', 'node', 'node20.11.1']), inPath: true },
      { tool: 'git', name: 'Git', category: 'tool', version: '2.45.2', path: 'C:\\Program Files\\Git', inPath: true },
      { tool: 'python', name: 'Python', category: 'python', version: '3.12.4', path: 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312', inPath: true },
      { tool: 'go', name: 'Go', category: 'go', version: '1.22.5', path: 'C:\\Program Files\\Go', inPath: true },
    ];
    // 浏览器端也缓存到 localStorage
    try { localStorage.setItem('devenv.scan.cache', JSON.stringify(results)); } catch {}
    return results;
  },
  async getScanCache(): Promise<ScanResult[]> {
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem('devenv.scan.cache') : null;
      if (cached) return JSON.parse(cached);
    } catch {}
    // 无缓存时回退到一次扫描
    return this.scan();
  },
  async exportReport(fmt: 'json' | 'md') {
    return fmt === 'md' ? '# 扫描报告\n| 工具 | 版本 |\n| --- | --- |\n| JDK | 17.0.9 |' : '{"tools":[]}';
  },
  async getDashboardTools(): Promise<DashboardTool[]> {
    const cfg = await mockApi.getConfig();
    const detected = (await mockApi.scan()) as any[];
    const installed = (cfg?.tools ?? []) as any[];
    const CAT_ORDER = ['java', 'build-tool', 'node', 'python', 'go', 'database', 'web-server', 'container', 'ide', 'tool'];
    const out: DashboardTool[] = [];
    const seen = new Set<string>();
    const pushInstalled = (t: any) => {
      out.push({
        name: t.name, version: t.version, category: t.category, tool: t.tool,
        source: 'installed', path: t.path, mode: t.mode, active: t.active,
      });
      seen.add(`${t.tool}|${t.version}`);
      if (t.path) seen.add(`path:${t.path}`);
    };
    const pushDetected = (d: any) => {
      const key = `${d.tool}|${d.version ?? ''}`;
      const pathKey = d.path ? `path:${d.path}` : '';
      if (seen.has(key) || (pathKey && seen.has(pathKey))) return;
      out.push({
        name: d.name, version: d.version ?? '未知', category: d.category, tool: d.tool,
        source: 'detected', path: d.path ?? '', inPath: d.inPath,
      });
      seen.add(key);
      if (pathKey) seen.add(pathKey);
    };
    installed.forEach(pushInstalled);
    detected.forEach(pushDetected);
    out.sort((a: any, b: any) => {
      const ia = CAT_ORDER.indexOf(a.category), ib = CAT_ORDER.indexOf(b.category);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      if (a.source !== b.source) return a.source === 'installed' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  },
  async getCurrentTools(): Promise<DashboardTool[]> {
    const all = (await mockApi.getDashboardTools()) as DashboardTool[];
    const byTool = new Map<string, DashboardTool[]>();
    for (const t of all) {
      if (!byTool.has(t.tool)) byTool.set(t.tool, []);
      byTool.get(t.tool)!.push(t);
    }
    const rank = (t: DashboardTool) =>
      (t.source === 'installed' && t.active) ? 0 :
      (t.source === 'detected' && t.inPath) ? 1 :
      (t.source === 'installed') ? 2 : 3;
    const out: DashboardTool[] = [];
    for (const list of byTool.values()) {
      list.sort((a, b) => rank(a) - rank(b));
      const chosen = list[0];
      out.push({ ...chosen, current: true, using: chosen.source === 'installed' ? 'managed' : 'system' });
    }
    out.sort((a, b) => {
      const CAT_ORDER = ['java', 'build-tool', 'node', 'python', 'go', 'database', 'web-server', 'container', 'ide', 'tool'];
      const ia = CAT_ORDER.indexOf(a.category), ib = CAT_ORDER.indexOf(b.category);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      if (a.source !== b.source) return a.source === 'installed' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  },
  async listRemote(tool: string) {
    const map: Record<string, string[]> = {
      jdk: ['8u392', '11.0.21', '17.0.9', '17.0.13', '21.0.2'],
      maven: ['3.9.6', '3.9.9', '3.9.16'],
      node: ['18.20.4', '20.11.1', '22.11.0'],
      gradle: ['8.5', '8.7', '8.10'],
      mysql: ['8.0.35', '8.0.39', '8.4.0'],
      redis: ['5.0.14', '5.0.10', '5.0.9'],
      git: ['2.45.2', '2.46.0'],
      docker: ['27.0.3', '26.1.4'],
      go: ['1.21.13', '1.22.5', '1.23.0'],
      python: ['3.11.9', '3.12.4', '3.13.0'],
    };
    return map[tool] ?? ['1.0.0'];
  },
  async installOnline(tool: string, version: string, opts?: any) {
    await emitMockSteps(mockExtras(tool, opts));
    return { ok: true, installed: { version: version || '17.0.9' } };
  },
  async installOffline(tool: string, opts?: any) {
    await emitMockSteps(mockExtras(tool, opts));
    return { ok: true };
  },
  /** 预览模式：合成一份安装计划（每步参数 + 预览），不触碰系统 */
  async planInstall(tool: string, version: string, opts?: any): Promise<{ ok: boolean; plan?: InstallPlanUI; error?: string }> {
    const steps: StepPlanUI[] = MOCK_BASE_STEPS.map((s) => ({
      id: s.id, title: s.title, description: s.description, optional: !!s.optional,
      params: [],
      preview: { notes: [s.description] },
    }));
    for (const e of mockExtras(tool, opts)) {
      const overrides = opts?.stepParams?.[e.id] ?? {};
      const params = (e.params ?? []).map((p: any) =>
        overrides[p.key] !== undefined ? { ...p, value: overrides[p.key] } : p,
      );
      steps.push({
        id: e.id, title: e.title, description: e.description, optional: !!e.optional,
        params, preview: e.preview ?? { notes: ['执行该步骤'] },
      });
    }
    const destDir = opts?.targetDir || withRoot(['data', 'install', tool, `${tool}${version || 'latest'}`]);
    return { ok: true, plan: { tool, name: tool.toUpperCase(), version: version || 'latest', destDir, steps } };
  },
  onInstallProgress(cb: (p: InstallProgressEvent) => void) {
    mockProgressCb = cb;
    return () => {
      mockProgressCb = null;
    };
  },
  async recognize(localPath: string) {
    if (!localPath) return null;
    const name = localPath.split(/[\\/]/).pop() ?? '';
    const ver = name.match(/(\d+\.\d+(?:\.\d+)?(?:u\d+)?|v?\d+\.\d+\.\d+)/);
    const toolMap: Record<string, string> = {
      jdk: 'jdk', java: 'jdk', openjdk: 'jdk', maven: 'maven', gradle: 'gradle',
      node: 'node', mysql: 'mysql', redis: 'redis', git: 'git', docker: 'docker',
    };
    let tool = 'unknown';
    for (const k of Object.keys(toolMap)) if (new RegExp(k, 'i').test(name)) { tool = toolMap[k]; break; }
    const format = /\.zip$/i.test(name) ? 'zip' : /\.tar\.gz$/i.test(name) ? 'tar.gz' : /\.msi$/i.test(name) ? 'msi' : /\.exe$/i.test(name) ? 'exe' : 'unknown';
    if (!ver && tool === 'unknown') return null;
    return {
      tool, name: tool.toUpperCase(), category: 'tool', version: ver ? ver[1].replace(/^v/, '') : 'unknown',
      format, source: 'filename', confidence: 0.9,
    };
  },
  async pickFile() {
    return 'C:\\Users\\me\\Downloads\\jdk-17.0.9_windows-x64_bin.zip';
  },
  async pickFolder() {
    return null;
  },
  async switchVersion() {
    return { ok: true };
  },
  async switchVerify() {
    // mock：假设路径都存在
    return { exists: true };
  },
  async activateDetectedTool() {
    return { ok: true, activated: {} };
  },
  async addExistingTool(payload: any) {
    // 浏览器预览：仅返回成功（真实登记在桌面端执行）
    return { ok: true, id: `${payload?.tool}@${payload?.version}@external`, added: payload };
  },
  async removeExistingTool() {
    // 浏览器预览：仅返回成功（真实移除在桌面端执行）
    return { ok: true };
  },
  async uninstallTool() {
    return { ok: true, deleted: [], removedEnv: [] };
  },
  async openFolder(folderPath: string) {
    // 浏览器预览：无真实文件系统，仅打印路径（安全空操作，不报错）
    console.log(`[mock] openFolder: ${folderPath}`);
    return { ok: true, note: '浏览器预览模式：无法打开系统文件管理器' };
  },
  async listVersionVars(tool: string): Promise<VersionVarInfo[]> {
    const cfg = await mockApi.getConfig();
    const tools = (cfg?.tools ?? []).filter((t: any) => t.tool === tool);
    const homeVar = tools[0]?.homeVar ?? `${tool.toUpperCase()}_HOME`;

    // 来源 1：config.tools 已纳管版本（varName = homeVar + 主版本号）
    const fromConfig: VersionVarInfo[] = tools.map((t: any) => ({
      version: t.version,
      path: t.path,
      varName: `${homeVar}${t.version.split('.')[0]}`,
      active: t.active ?? false,
      source: 'config' as const,
    }));

    // 来源 2：模拟注册表中发现的额外版本固定变量
    // （真实环境中这些来自 readRegEnv 匹配 {HOME_VAR}{VERSION} 模式，无下划线分隔）
    const fromReg: VersionVarInfo[] = [];
    if (tool === 'jdk') {
      // 模拟用户手动创建的 3 个额外 JDK 版本变量（对齐截图中的实际命名）
      fromReg.push(
        { version: '8', path: 'E:\\Software\\Java\\Java8\\JDK', varName: 'JAVA_HOME8', active: false, source: 'registry' },
        { version: '11', path: 'E:\\Software\\Java\\Java11\\JDK', varName: 'JAVA_HOME11', active: false, source: 'registry' },
        { version: '21', path: 'E:\\Software\\Java\\Java21\\JDK', varName: 'JAVA_HOME21', active: false, source: 'registry' },
      );
    }

    const all = [...fromConfig, ...fromReg];
    if (all.length === 0) return [];

    // 模拟判定 active：检查活跃变量引用目标（演示数据以 JAVA_HOME17 为激活）
    return all.map((v) => ({
      ...v,
      active: v.active || v.varName === 'JAVA_HOME17',
    }));
  },
  async migrate() {
    return { ok: true };
  },
  async profiles() {
    return {
      company: { label: '公司项目', tools: { jdk: '8.0', maven: '3.9.6' } },
      personal: { label: '个人项目', tools: { jdk: '17.0.9', node: '20.11.1' } },
    };
  },
  async applyProfile() {
    return { ok: true, switched: ['jdk@8.0', 'maven@3.9.6'] };
  },
  async envInspect(): Promise<EnvInspectResult> {
    if (!mockRoot) return { tools: [], path: { effective: '', expanded: '', total: 0, oursCount: 0, segments: [] } };
    const jdk = withRoot(['data', 'install', 'java', 'jdk17.0.9']);
    const maven = withRoot(['data', 'install', 'build-tool', 'maven3.9.6']);
    const node = withRoot(['data', 'install', 'node', 'node20.11.1']);
    const mkEntry = (key: string, val: string | undefined): EnvVarEntry => ({
      key,
      effective: val,
      user: undefined,
      system: val,
      source: val ? 'system' : 'none',
      expanded: val,
    });
    const tools: EnvToolVar[] = [
      { tool: 'jdk', name: 'JDK', homeVar: 'JAVA_HOME', entry: mkEntry('JAVA_HOME', jdk), versionEntries: [] },
      { tool: 'maven', name: 'Maven', homeVar: 'MAVEN_HOME', entry: mkEntry('MAVEN_HOME', maven), versionEntries: [] },
      { tool: 'node', name: 'Node.js', homeVar: 'NODE_HOME', entry: mkEntry('NODE_HOME', node), versionEntries: [] },
      { tool: 'gradle', name: 'Gradle', homeVar: 'GRADLE_HOME', entry: mkEntry('GRADLE_HOME', undefined), versionEntries: [] },
      { tool: 'go', name: 'Go', homeVar: 'GOROOT', entry: mkEntry('GOROOT', undefined), versionEntries: [] },
      { tool: 'python', name: 'Python', homeVar: 'PYTHONHOME', entry: mkEntry('PYTHONHOME', undefined), versionEntries: [] },
      { tool: 'git', name: 'Git', homeVar: 'GIT_HOME', entry: mkEntry('GIT_HOME', undefined), versionEntries: [] },
      { tool: 'mysql', name: 'MySQL', homeVar: 'MYSQL_HOME', entry: mkEntry('MYSQL_HOME', undefined), versionEntries: [] },
      { tool: 'redis', name: 'Redis', homeVar: 'REDIS_HOME', entry: mkEntry('REDIS_HOME', undefined), versionEntries: [] },
      { tool: 'docker', name: 'Docker', homeVar: 'DOCKER_HOME', entry: mkEntry('DOCKER_HOME', undefined), versionEntries: [] },
      { tool: 'nginx', name: 'Nginx', homeVar: 'NGINX_HOME', entry: mkEntry('NGINX_HOME', undefined), versionEntries: [] },
    ];
    const pathRaw = `%JAVA_HOME%\\bin;%MAVEN_HOME%\\bin;%NODE_HOME%;C:\\Windows\\system32;${jdk}\\bin`;
    const segments: EnvPathSegment[] = [
      { raw: '%JAVA_HOME%\\bin', ours: true, homeVar: 'JAVA_HOME', expanded: `${jdk}\\bin` },
      { raw: '%MAVEN_HOME%\\bin', ours: true, homeVar: 'MAVEN_HOME', expanded: `${maven}\\bin` },
      { raw: '%NODE_HOME%', ours: true, homeVar: 'NODE_HOME', expanded: node },
    ];
    return {
      tools,
      path: { effective: pathRaw, expanded: pathRaw, total: 5, oursCount: 3, segments },
    };
  },
};

/**
 * 运行时 API 代理：每次属性访问都重新检查 window.devenv 是否可用。
 * 解决 Vite 生产构建下模块加载时 preload 尚未注入、导致永久降级到 mockApi 的问题。
 */
function getReal(): DevEnvApi | null {
  try {
    return typeof window !== 'undefined' && (window as any).devenv ? (window as any).devenv : null;
  } catch {
    return null;
  }
}

/** 始终可用的 API 入口 —— 运行时自动选择真实桥接或 mock */
export const api: DevEnvApi = new Proxy(mockApi, {
  get(_target, prop: string) {
    const real = getReal();
    if (real && prop in real) {
      console.log(`[api] "${prop}" → REAL IPC`);
      return (real as any)[prop];
    }
    console.log(`[api] "${prop}" → MOCK FALLBACK (window.devenv ${real ? 'missing method' : 'unavailable'})`);
    return (mockApi as any)[prop];
  },
});

export function isDesktop(): boolean {
  return !!getReal();
}
