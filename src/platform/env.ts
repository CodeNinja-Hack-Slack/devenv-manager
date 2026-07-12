import { Platform } from '../types.js';

// ============================================================================
// 环境变量抽象层
// ----------------------------------------------------------------------------
// 设计目标：
//  1) 纯函数（splitPath / addToPath / removeFromPath / prioritizePath）可单测，
//     不触碰真实系统。
//  2) WindowsEnv / UnixEnv 实现 EnvBackend，真正写系统时用 setx / 写 shell rc；
//     提供 dryRun 模式，仅收集 EnvOp 不落地，便于测试与回滚快照。
//  3) 默认采用“用户级”环境变量，避免需要管理员权限。
// ============================================================================

export const PATH_VAR = 'PATH';

/** 把 PATH 字符串拆成数组（跨平台分隔符 ; 或 :） */
export function splitPath(pathStr: string | undefined | null): string[] {
  if (!pathStr) return [];
  // 优先按 ';'（Windows）拆分；无 ';' 时退回 ':'（兼容 Unix 路径，
  // 或历史上被错误用 ':' 拼接的 Windows Path，便于纠错时正确解析）。
  const sep = pathStr.includes(';') ? ';' : ':';
  return pathStr
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把数组拼回 PATH 字符串 */
export function joinPath(arr: string[]): string {
  // 按当前平台选择分隔符：Windows 永远用 ';'。
  // 旧实现靠“数组里是否含盘符路径”推断，但 %JAVA_HOME%\bin 这类环境变量引用
  // 不含盘符，会被误判为 Unix 而用 ':' 拼接，生成非法 Path
  // （如 %JAVA_HOME%\bin:%JAVA_HOME17%\bin），导致命令行找不到 java 等工具。
  return arr.join(process.platform === 'win32' ? ';' : ':');
}

/** 向 PATH 追加目录（已存在则不动），返回新数组 */
export function addToPath(pathArr: string[], dir: string): string[] {
  const norm = normalize(dir);
  if (pathArr.some((p) => normalize(p) === norm)) return [...pathArr];
  return [...pathArr, dir];
}

/** 从 PATH 移除目录（精确或大小写不敏感匹配），返回新数组 */
export function removeFromPath(pathArr: string[], dir: string): string[] {
  const norm = normalize(dir);
  return pathArr.filter((p) => normalize(p) !== norm);
}

/** 把某目录提升为 PATH 最高优先级（用于切换默认版本） */
export function prioritizePath(pathArr: string[], dir: string): string[] {
  const rest = removeFromPath(pathArr, dir);
  return [dir, ...rest];
}

function normalize(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  // 仅 Windows 路径大小写不敏感才做小写归一；Linux/macOS 路径大小写敏感，
  // 小写会把 /A/B 与 /a/b 错误视为重复（PATH 去重误伤），故保持原样。
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// ---------------------------------------------------------------------------
// EnvBackend 接口
// ---------------------------------------------------------------------------
export interface EnvBackend {
  readonly platform: Platform;
  /** 读取当前环境变量值 */
  get(name: string): Promise<string | undefined>;
  /** 设置变量（持久化到用户级） */
  set(name: string, value: string): Promise<void>;
  /** 取消设置 */
  unset(name: string): Promise<void>;
  /** 追加到 PATH */
  appendPath(dir: string): Promise<void>;
  /** 从 PATH 移除 */
  removePath(dir: string): Promise<void>;
  /** 把 dir 提升为 PATH 最高优先级 */
  prioritizePathVar(dir: string): Promise<void>;
  /** 预览将要执行的 EnvOp（dryRun 收集） */
  preview(): EnvOp[];
  /**
   * 安装前快照当前 PATH 字符串（用于失败回滚的整体还原）。
   * 关键：返回的是「本作用域真实 PATH」（Windows 取注册表 HKLM，不走 process.env 合并值），
   * 回滚时整体写回，避免「安装第二个版本时移除旧版本 PATH 条目、仅增量 removePath 新条目」
   * 导致旧条目永久丢失、PATH 变空。
   */
  snapshotPath(): Promise<string>;
  /** 把 PATH 整体还原为快照值（覆盖式写入；dryRun 仅重置内存模型） */
  restorePath(snap: string): Promise<void>;
}

import type { EnvOp } from '../types.js';

// ---------------------------------------------------------------------------
// DryRunEnv：仅记录操作，不落地。用于测试与安装前快照（回滚用）
// ---------------------------------------------------------------------------
export class DryRunEnv implements EnvBackend {
  readonly platform: Platform;
  private ops: EnvOp[] = [];
  private store = new Map<string, string>();
  private pathArr: string[];

  constructor(platform: Platform, initialPath = '') {
    this.platform = platform;
    this.pathArr = splitPath(initialPath);
  }

  async get(name: string) {
    if (name === PATH_VAR) return joinPath(this.pathArr);
    return this.store.get(name);
  }
  async set(name: string, value: string) {
    this.ops.push({ kind: 'set', name, value });
    this.store.set(name, value);
  }
  async unset(name: string) {
    this.ops.push({ kind: 'unset', name });
    this.store.delete(name);
  }
  async appendPath(dir: string) {
    this.ops.push({ kind: 'appendPath', name: PATH_VAR, value: dir });
    this.pathArr = addToPath(this.pathArr, dir);
  }
  async removePath(dir: string) {
    this.ops.push({ kind: 'removePath', name: PATH_VAR, value: dir });
    this.pathArr = removeFromPath(this.pathArr, dir);
  }
  async prioritizePathVar(dir: string) {
    this.ops.push({ kind: 'appendPath', name: PATH_VAR, value: dir });
    this.pathArr = prioritizePath(this.pathArr, dir);
  }
  preview(): EnvOp[] {
    return [...this.ops];
  }
  async snapshotPath(): Promise<string> {
    return joinPath(this.pathArr);
  }
  async restorePath(snap: string): Promise<void> {
    this.pathArr = splitPath(snap);
  }
}

// ---------------------------------------------------------------------------
// PATH 读写串行锁
// ---------------------------------------------------------------------------
// Windows PATH 是注册表单值项，appendPath/removePath/prioritizePath/snapshotPath/restorePath
// 都是「读 PATH → 改 → 写回」的 read-modify-write。多个 IPC 调用并发时各起一个 reg.exe
// 子进程读到相同旧值会相互覆盖（丢更新）。用一条模块级 promise 链串行化所有 PATH 操作，
// 避免并发写竞争。dryRun 模式跳过锁（仅内存模型，无系统竞争）。
let pathLockChain: Promise<unknown> = Promise.resolve();
function withPathLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pathLockChain.then(fn, fn);
  // 无论成功失败都推进链条，避免单点异常卡死后续操作
  pathLockChain = next.then(() => undefined, () => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// WindowsEnv：使用 setx 写环境变量；读取 PATH 结合 process.env 与注册表
// ---------------------------------------------------------------------------
export class WindowsEnv implements EnvBackend {
  readonly platform: Platform = 'win32';
  private dry: DryRunEnv;
  private dryRun: boolean;
  /** 变量写入作用域：'user'=HKCU(用户变量) / 'system'=HKLM(系统变量) */
  private scope: 'user' | 'system';

  // 默认作用域改为 'system'（HKLM 系统变量）：
  // 用户明确要求“所有变量只写在系统变量里，禁止在用户变量(HKCU)做任何操作”。
  // 此前默认 'user' 导致 install/switch 等写入落到 HKCU，污染用户变量（如 Java8 被写进用户 Path）。
  constructor(initialPath = process.env.PATH ?? '', dryRun = false, scope: 'user' | 'system' = 'system') {
    this.dryRun = dryRun;
    this.dry = new DryRunEnv('win32', initialPath);
    // 硬性守卫：真实写入（非 dryRun）绝不允许落到用户变量(HKCU)。
    // 即便将来有人漏传 scope='system'，也会被强制纠正为 system 并告警，
    // 避免再次出现“Java8 被写进用户 Path”这类污染问题。dryRun 仅收集操作，不落地，不受影响。
    if (!dryRun && scope === 'user') {
      console.warn('[WindowsEnv] 检测到真实写入请求落到 user 作用域，已强制改为 system（禁止写用户变量）。');
      scope = 'system';
    }
    this.scope = scope;
  }

  async get(name: string): Promise<string | undefined> {
    if (this.dryRun) return this.dry.get(name);
    return process.env[name];
  }
  async set(name: string, value: string) {
    if (this.dryRun) return this.dry.set(name, value);
    await setx([name, value], this.scope);
    // setx 写入注册表后，当前进程 process.env 不会自动刷新；
    // 同步刷新，避免同进程内后续健康检查误报 HOME_MISMATCH / 读取到旧值。
    process.env[name] = value;
  }
  async unset(name: string) {
    if (this.dryRun) return this.dry.unset(name);
    await regDelete(name, this.scope);
    delete process.env[name];
  }
  async appendPath(dir: string) {
    if (this.dryRun) return this.dry.appendPath(dir);
    return withPathLock(async () => {
      // 根据作用域读写对应注册表中的 PATH（避免跨域复制造成重复膨胀）
      const cur = splitPath(await getPathForScope(this.scope));
      const next = addToPath(cur, dir);
      // PATH 使用 reg add 写入，绕过 setx 的 1024 字符单值上限
      // （系统 PATH 通常很长，setx 重写整条 PATH 易超长失败/截断）
      await setPathReg(this.scope, joinPath(next));
      process.env.PATH = joinPath(next);
    });
  }
  async removePath(dir: string) {
    if (this.dryRun) return this.dry.removePath(dir);
    return withPathLock(async () => {
      const cur = splitPath(await getPathForScope(this.scope));
      const next = removeFromPath(cur, dir);
      // PATH 使用 reg add 写入，绕过 setx 的 1024 字符单值上限
      // （系统 PATH 通常很长，setx 重写整条 PATH 易超长失败/截断）
      await setPathReg(this.scope, joinPath(next));
      process.env.PATH = joinPath(next);
    });
  }
  async prioritizePathVar(dir: string) {
    if (this.dryRun) return this.dry.prioritizePathVar(dir);
    return withPathLock(async () => {
      const cur = splitPath(await getPathForScope(this.scope));
      const next = prioritizePath(cur, dir);
      // PATH 使用 reg add 写入，绕过 setx 的 1024 字符单值上限
      // （系统 PATH 通常很长，setx 重写整条 PATH 易超长失败/截断）
      await setPathReg(this.scope, joinPath(next));
      process.env.PATH = joinPath(next);
    });
  }
  async snapshotPath(): Promise<string> {
    if (this.dryRun) return this.dry.snapshotPath();
    return withPathLock(() => getPathForScope(this.scope));
  }
  async restorePath(snap: string): Promise<void> {
    if (this.dryRun) return this.dry.restorePath(snap);
    return withPathLock(async () => {
      await setPathReg(this.scope, snap);
      process.env.PATH = snap;
    });
  }
  preview() {
    return this.dry.preview();
  }
}

// ---------------------------------------------------------------------------
// UnixEnv：维护 ~/.zshrc / ~/.bashrc 中一个由本软件托管的块
// （# >>> devenv-manager >>> … # <<< devenv-manager <<<），所有写操作均在该块内
// 重写，避免每次安装/切换都 append 一行导致 PATH 无限累积，且 unset/removePath
// 真正生效（修复：Unix 环境变量只增不减）。
// ---------------------------------------------------------------------------
export class UnixEnv implements EnvBackend {
  readonly platform: Platform;
  private dry: DryRunEnv;
  private dryRun: boolean;
  private rcFile: string;
  private vars = new Map<string, string>();
  private pathDirs: string[] = [];
  private loaded = false;

  constructor(platform: 'darwin' | 'linux', initialPath = process.env.PATH ?? '', dryRun = false) {
    this.platform = platform;
    this.dryRun = dryRun;
    this.rcFile = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
    this.dry = new DryRunEnv(platform, initialPath);
  }

  /** 懒加载：解析 rc 中已有的托管块到内存模型（仅真实写入时执行一次） */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded || this.dryRun) return;
    this.loaded = true;
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const file = this.rcFile.replace('~', os.homedir());
    try {
      const text = await fs.readFile(file, 'utf8');
      this.parseManaged(text);
    } catch {
      /* rc 尚不存在，从空模型开始 */
    }
  }

  private parseManaged(text: string): void {
    const START = '# >>> devenv-manager >>>';
    const END = '# <<< devenv-manager <<<';
    const s = text.indexOf(START);
    const e = text.indexOf(END);
    if (s < 0 || e < 0) return;
    const block = text.slice(s + START.length, e);
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))$/.exec(line);
      if (!m) continue;
      const name = m[1];
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      if (name === 'PATH') {
        let p = val;
        if (p.endsWith(':$PATH')) p = p.slice(0, -':$PATH'.length);
        else if (p.startsWith('$PATH:')) p = p.slice('$PATH:'.length);
        this.pathDirs = splitPath(p).filter((d) => d && d !== '$PATH');
      } else {
        this.vars.set(name, val);
      }
    }
  }

  /** 把内存模型整体重写回 rc 的托管块 */
  private async flush(): Promise<void> {
    if (this.dryRun) return;
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const file = this.rcFile.replace('~', os.homedir());
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      text = '';
    }
    const START = '# >>> devenv-manager >>>';
    const END = '# <<< devenv-manager <<<';
    const s = text.indexOf(START);
    const e = text.indexOf(END);
    let before = text;
    let after = '';
    if (s >= 0 && e >= 0) {
      before = text.slice(0, s);
      after = text.slice(e + END.length);
    }
    const lines = [START];
    for (const [name, val] of this.vars) lines.push(`export ${name}="${val}"`);
    if (this.pathDirs.length) lines.push(`export PATH="${this.pathDirs.join(':')}:$PATH"`);
    lines.push(END);
    const block = lines.join('\n') + '\n';
    const newText = before + block + after;
    // 仅在确实存在变化时才写盘（避免无谓的 rc 重写）
    if (newText !== text) await fs.writeFile(file, newText, 'utf8');
  }

  async get(name: string) {
    if (this.dryRun) return this.dry.get(name);
    return process.env[name];
  }
  async set(name: string, value: string) {
    if (this.dryRun) return this.dry.set(name, value);
    await this.ensureLoaded();
    this.vars.set(name, value);
    await this.flush();
  }
  async unset(name: string) {
    if (this.dryRun) return this.dry.unset(name);
    await this.ensureLoaded();
    this.vars.delete(name);
    await this.flush();
  }
  async appendPath(dir: string) {
    if (this.dryRun) return this.dry.appendPath(dir);
    return withPathLock(async () => {
      await this.ensureLoaded();
      this.pathDirs = addToPath(this.pathDirs, dir);
      await this.flush();
    });
  }
  async removePath(dir: string) {
    if (this.dryRun) return this.dry.removePath(dir);
    return withPathLock(async () => {
      await this.ensureLoaded();
      this.pathDirs = removeFromPath(this.pathDirs, dir);
      await this.flush();
    });
  }
  async prioritizePathVar(dir: string) {
    if (this.dryRun) return this.dry.prioritizePathVar(dir);
    return withPathLock(async () => {
      await this.ensureLoaded();
      this.pathDirs = prioritizePath(this.pathDirs, dir);
      await this.flush();
    });
  }
  async snapshotPath(): Promise<string> {
    if (this.dryRun) return this.dry.snapshotPath();
    await this.ensureLoaded();
    return joinPath(this.pathDirs);
  }
  async restorePath(snap: string): Promise<void> {
    if (this.dryRun) return this.dry.restorePath(snap);
    return withPathLock(async () => {
      await this.ensureLoaded();
      this.pathDirs = splitPath(snap);
      await this.flush();
    });
  }
  preview() {
    return this.dry.preview();
  }
}

// ---------------------------------------------------------------------------
// 工厂：根据当前平台创建合适的 backend
// ---------------------------------------------------------------------------

/**
 * 读取指定作用域的 PATH 值（避免读取 process.env.PATH——那是系统+用户合并值，
 * 直接写回会把另一侧 PATH 复制进来造成重复膨胀）。
 */
async function getPathForScope(scope: 'user' | 'system'): Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const util = await import('node:util');
    const execFileP = util.promisify(execFile);
    const hive = scope === 'system'
      ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
      : 'HKCU\\Environment';
    const { stdout } = await execFileP(resolveWinExe('reg.exe'), ['query', hive, '/v', 'PATH'], {
      windowsHide: true,
    });
    // reg query 输出形如：
    //   HKEY_...\Environment
    //       PATH    REG_EXPAND_SZ    %JAVA_HOME%\bin;C:\Windows\system32;...
    // 值在同一行 REG_EXPAND_SZ 之后，故按行正则提取（切勿跳到换行后，否则拿到空串）。
    for (const raw of stdout.split(/\r?\n/)) {
      const m = raw.replace(/\r$/, '').match(/^\s*PATH\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.*)$/);
      if (m) return m[1].trim();
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 测试模式（applyEnv=false）下，把「本应写入系统」的 env 操作落盘为预览文件，
 * 便于审计与确认，而绝不触碰真实系统环境变量。
 */
export async function writeEnvPreview(rootDir: string, ops: EnvOp[]): Promise<void> {
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.join(rootDir, 'config');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'env-preview.json');
    const payload = {
      generatedAt: new Date().toISOString(),
      note: '预览文件：applyEnv=false（测试模式）时未写入系统环境变量，以下仅为将要执行的操作。',
      ops,
    };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* best-effort，预览失败不影响主流程 */
  }
}

// 默认作用域 'system'：所有变量写入系统变量(HKLM)，禁止写用户变量(HKCU)。
// 见 WindowsEnv 构造函数的说明（用户明确要求）。
export function createEnvBackend(dryRun = false, scope: 'user' | 'system' = 'system'): EnvBackend {
  const p = process.platform as Platform;
  if (p === 'win32') return new WindowsEnv(process.env.PATH, dryRun, scope);
  return new UnixEnv(p as 'darwin' | 'linux', process.env.PATH, dryRun);
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/**
 * 解析 Windows 系统命令的完整路径（含 .exe 后缀）。
 *
 * 关键点：execFile 默认不走 shell，不会自动补 `.exe`、也不会依赖 PATH 解析可执行文件，
 * 在部分运行环境下直接 `execFileP('reg', ...)` 会触发 `spawn reg ENOENT`。
 * 改为指向 `%SystemRoot%\System32\<name>`：
 *   - 32 位进程下文件系统重定向器会自动映射到 SysWOW64，reg/setx/whoami 在两处均存在；
 *   - 使用全路径还可避免 cmd 对 `%VAR%` 的展开，从而保留字面引用（如 `%JAVA_HOME%\bin`）。
 */
export function resolveWinExe(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return `${root}\\System32\\${name}`;
}

// 直接以参数数组调用 setx（避免 cmd /c 对引号/反斜杠的二次解析导致路径被截断）
// scope='system' 时追加 /M 标志写入系统变量（HKLM），需管理员权限
async function setx(args: string[], scope: 'user' | 'system' = 'user'): Promise<void> {
  const { execFile } = await import('node:child_process');
  const util = await import('node:util');
  const execFileP = util.promisify(execFile);
  const fullArgs = scope === 'system' ? ['/M', ...args] : args;
  await execFileP(resolveWinExe('setx.exe'), fullArgs, { windowsHide: true });
}

// 删除环境变量（unset 用，比 setx 置空更干净）
async function regDelete(name: string, scope: 'user' | 'system' = 'user'): Promise<void> {
  const { execFile } = await import('node:child_process');
  const util = await import('node:util');
  const execFileP = util.promisify(execFile);
  const hive = scope === 'system'
    ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    : 'HKCU\\Environment';
  await execFileP(resolveWinExe('reg.exe'), ['delete', hive, '/v', name, '/f'], { windowsHide: true });
}

/**
 * 写入 PATH（绕过 setx 的 1024 字符上限）。
 * 使用 reg add 直接写注册表，类型为 REG_EXPAND_SZ（PATH 在 HKCU/HKLM 中均为该类型，
 * 可正确保留 %VAR% 展开语义）。setx 在 PATH 超长时会静默失败或截断，故 PATH 一律走此路径。
 */
async function setPathReg(scope: 'user' | 'system', value: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const util = await import('node:util');
  const execFileP = util.promisify(execFile);
  const hive = scope === 'system'
    ? 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    : 'HKCU\\Environment';
  await execFileP(resolveWinExe('reg.exe'), ['add', hive, '/v', 'PATH', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { windowsHide: true });
}

/**
 * 当前进程是否以管理员权限运行（Windows 系统变量 HKLM 写入需要）。
 * 通过 whoami /groups 检测「高完整性级别」SID（S-1-16-12288）判断。
 * 采用 fail-open 策略：除非明确检测到「中完整性（未提权）」才返回 false，
 * 其它情况（含命令异常）一律返回 true，交由实际写入时的 try/catch 兜底，
 * 避免误伤真实管理员。非 Windows 平台视为无需提权，返回 true。
 */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  try {
    const { execFile } = await import('node:child_process');
    const util = await import('node:util');
    const execFileP = util.promisify(execFile);
    const { stdout } = await execFileP(resolveWinExe('whoami.exe'), ['/groups'], { windowsHide: true });
    if (/S-1-16-12288/.test(stdout)) return true; // 高完整性 = 已提权
    if (/S-1-16-8192/.test(stdout)) return false; // 中完整性且未提权 = 非管理员
    return true; // 无法判定 → fail-open
  } catch {
    return true; // 检测失败 → fail-open，避免误阻断管理员
  }
}

/**
 * 广播 WM_SETTINGCHANGE(Environment)，使 Explorer 及其它进程感知环境变量变更。
 * 注意：setx 与 reg add 均不会自动广播，必须手动触发，否则其它进程需重启才能读到新值。
 * best-effort：失败不影响主流程（仅刷新延迟）。
 */
export async function broadcastEnvChange(): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const { execFile } = await import('node:child_process');
    const util = await import('node:util');
    const execFileP = util.promisify(execFile);
    // 通过 PowerShell 调用 SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment")
    const ps = `$code = @'\n[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]\npublic static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\n'@\nAdd-Type -Namespace Win32 -Name NM -MemberDefinition \$code\n[Win32.NM]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0, 5000, [UIntPtr]::Zero)`;
    await execFileP(resolveWinExe('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  } catch {
    /* best-effort */
  }
}
