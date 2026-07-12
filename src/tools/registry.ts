import path from 'node:path';
import type { Platform, ScanResult, ToolCategory, InstallStep } from '../types.js';
import type { Logger } from '../utils/logger.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细检测日志，避免生产环境刷屏。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

// ============================================================================
// 工具注册表（Registry）
// ----------------------------------------------------------------------------
// 每个工具一个 ToolSpec，声明：类别 / HOME 变量 / 可执行文件名 / 版本命令 /
// 常见安装目录（用于多版本扫描）/ 内置可下载版本（list --remote）。
// 检测逻辑与“运行器(runner)”解耦，便于单测时注入假 runner。
// ============================================================================

export interface Runner {
  /** 查找可执行文件路径（类似 which/where），找不到返回 null */
  which(bin: string): Promise<string | null>;
  /** 查找 PATH 中所有匹配的可执行文件路径（可选；用于发现多版本共存） */
  whichAll?(bin: string): Promise<string[]>;
  /** 运行命令，返回 stdout */
  run(binPath: string, args: string[]): Promise<{ stdout: string; code: number }>;
  /** 判断路径是否存在 */
  exists(p: string): Promise<boolean>;
}

export interface ToolSpec {
  tool: string;
  name: string;
  category: ToolCategory;
  homeVar?: string;
  binSubdir: string;
  binaries: string[];
  versionArgs: string[];
  versionRegex: RegExp;
  /** 常见安装目录（跨平台），用于扫描多版本。Windows 用 C:\...，Unix 用 /... */
  scanDirs: string[];
  /** 内置可下载版本（list --remote 数据来源） */
  remoteVersions: string[];
  /**
   * 根据版本与平台拼接下载 URL（各工具的规范下载源，已逐一验证 200）。
   * 可选 checksum：若提供，安装时会校验下载包 SHA256/MD5，确保完整性。
   */
  buildUrl(version: string, platform: Platform): string;
  /** 下载包校验和（SHA256/MD5 hex）；可选，提供后安装器会校验 */
  checksum?: string;
  /**
   * 把工具自身上报的版本号规范化为本软件统一格式（用于去重 / 激活匹配）。
   * 例：JDK8 的 `java -version` 报 "1.8.0_392"，统一规范为 Adoptium 风格 "8u392"，
   * 与 remoteVersions / 安装记录保持一致。可选；不提供则原样使用。
   * **新增软件（redis/maven 等）若版本命令输出与安装记录格式不一致，务必提供此函数**，否则去重与 active 判定会错位。
   */
  normalizeVersion?: (raw: string) => string;
  /**
   * 安装步骤管线（可选，彻底声明式）。
   * 提供则完全替代默认通用基底；不提供时安装器回退到 buildBaseSteps(spec) 生成的通用步骤。
   * 各软件通过 `[...buildBaseSteps(spec), 专属步骤...]` 组合，把差异化安装流程显式建模为可见步骤。
   */
  steps?: InstallStep[];
  /**
   * 仅纳管标记：为 true 时该工具不通过安装流程自动安装（通常因为没有可行的便携包，
   * 如 Docker Desktop 是独立 exe 安装器，二进制不在解压目录内）。安装流程会直接拒绝并提示
   * 用户「先安装后再用扫描功能纳管」。避免把 exe 安装器当 zip 解压导致安装必败。
   */
  managedOnly?: boolean;
  /**
   * 国内镜像步骤（可选，仅对 Maven/Gradle 有意义）。
   * 仅当用户在界面勾选「使用国内镜像」安装时，installer 才会把该步骤追加到步骤管线末尾。
   */
  mirrorStep?: InstallStep;
}

function win(p: string): string {
  return p;
}

export const REGISTRY: ToolSpec[] = [
  {
    tool: 'jdk', name: 'JDK', category: 'java', homeVar: 'JAVA_HOME', binSubdir: 'bin',
    binaries: ['java', 'java.exe'],
    versionArgs: ['-version'],
    versionRegex: /version "([^"]+)"/,
    // Java 8 的 `java -version` 输出为 "1.8.0_392"，而 Adoptium / 安装记录用 "8u392"。
    // 统一为后者，确保安装记录与系统扫描检测的版本可正确去重与匹配（修复重复条目 / active 错位）。
    normalizeVersion: (raw: string) => {
      const m = raw.match(/^1\.8\.0[_u](\d+)$/);
      if (m) return `8u${m[1]}`;
      return raw;
    },
    scanDirs: [
      win('C:\\Program Files\\Java'),
      win('C:\\Program Files\\Eclipse Adoptium'),
      '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt/devenv/java',
    ],
    remoteVersions: ['8u392', '11.0.21', '17.0.9', '17.0.13', '21.0.2'],
    buildUrl: (v, p) => {
      // Adoptium(Temurin)：按「特性版本」解析最新 GA 构建（已验证 200）
      const feature = v.split(/[.u]/)[0];
      const os = p === 'win32' ? 'windows' : 'linux';
      return `https://api.adoptium.net/v3/binary/latest/${feature}/ga/${os}/x64/jdk/hotspot/normal/eclipse`;
    },
  },
  {
    tool: 'maven', name: 'Maven', category: 'build-tool', homeVar: 'MAVEN_HOME', binSubdir: 'bin',
    binaries: ['mvn', 'mvn.cmd'],
    versionArgs: ['-v'],
    versionRegex: /Apache Maven ([\d.]+)/,
    scanDirs: ['C:\\Program Files\\Apache Maven', '/opt/maven', '/opt/devenv/build-tool'],
    remoteVersions: ['3.9.6', '3.9.9', '3.9.16'],
    buildUrl: (v) => `https://archive.apache.org/dist/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip`,
  },
  {
    tool: 'gradle', name: 'Gradle', category: 'build-tool', homeVar: 'GRADLE_HOME', binSubdir: 'bin',
    binaries: ['gradle', 'gradle.bat'],
    versionArgs: ['-v'],
    versionRegex: /Gradle ([\d.]+)/,
    scanDirs: ['C:\\Program Files\\Gradle', '/opt/gradle', '/opt/devenv/build-tool'],
    remoteVersions: ['8.5', '8.7', '8.10'],
    buildUrl: (v) => `https://services.gradle.org/distributions/gradle-${v}-bin.zip`,
  },
  {
    tool: 'node', name: 'Node.js', category: 'node', binSubdir: '',
    binaries: ['node', 'node.exe'],
    versionArgs: ['--version'],
    versionRegex: /v([\d.]+)/,
    scanDirs: ['C:\\Program Files\\nodejs', '/usr/local/n', '/opt/devenv/node'],
    remoteVersions: ['18.20.4', '20.11.1', '22.11.0'],
    buildUrl: (v, p) => {
      // npmmirror 二进制镜像（已验证 200）：win=zip，linux=tar.gz
      const os = p === 'win32' ? 'win-x64' : 'linux-x64';
      const ext = p === 'win32' ? 'zip' : 'tar.gz';
      return `https://npmmirror.com/mirrors/node/v${v}/node-v${v}-${os}.${ext}`;
    },
  },
  {
    // MySQL（noinstall ZIP）差异化配置：除 MYSQL_HOME + %MYSQL_HOME%\bin 外，
    // 首次使用还须手动完成安装后动作：① 写 my.ini（basedir/datadir）；
    // ② `mysqld --initialize --console` 初始化数据目录；③ `mysqld --install` 注册并启动 Windows 服务。
    // 当前 ToolSpec 覆盖「检测 + 环境变量」；安装后动作由专属安装步骤管线完成
    // （mysql:myini 写 my.ini + mysql:init `mysqld --initialize-insecure` + mysql:service 注册并启动 Windows 服务，
    //  三者经 ensureRegistrySteps() 追加到通用基底步骤之后，前端逐步展示真实进度）。
    tool: 'mysql', name: 'MySQL', category: 'database', homeVar: 'MYSQL_HOME', binSubdir: 'bin',
    binaries: ['mysql', 'mysql.exe'],
    versionArgs: ['-V'],
    versionRegex: /(?:Ver|Distrib)\s+([\d.]+)/,
    scanDirs: ['C:\\Program Files\\MySQL', '/usr/local/mysql', '/opt/devenv/database'],
    remoteVersions: ['8.0.35', '8.0.39', '8.4.0'],
    buildUrl: (v, p) => {
      // dev.mysql.com/get 会 302 跳转到真实 CDN（下载器已支持跟随重定向）
      // 按主版本系列选择下载目录（8.0.x → MySQL-8.0；8.4.x → MySQL-8.4）
      const series = v.startsWith('8.4') ? 'MySQL-8.4' : 'MySQL-8.0';
      if (p === 'win32') return `https://dev.mysql.com/get/Downloads/${series}/mysql-${v}-winx64.zip`;
      return `https://dev.mysql.com/get/Downloads/${series}/mysql-${v}-linux-glibc2.28-x86_64.tar.xz`;
    },
  },
  {
    // Redis 在 Windows 上无官方预编译二进制：redis.io 官方推荐 WSL2 或 Memurai。
    // 社区移植 tporadowski/redis 提供 Windows 原生 zip（版本停留 5.0.x），
    // 最契合本软件「下载/解压/多版本切换」模型。除解压 + 配 PATH 外，
    // 还经 redisServiceStep 注册为 Windows 服务并启动，使 Redis 开机自启、后台常驻。
    tool: 'redis', name: 'Redis', category: 'database', homeVar: 'REDIS_HOME', binSubdir: '',
    binaries: ['redis-server.exe', 'redis-cli.exe'],
    versionArgs: ['--version'],
    // redis-server --version 输出 "Redis server v=5.0.14 sha=..."，取 v= 后的版本号
    versionRegex: /v=([\d.]+)/,
    // Redis 的 exe 在解压根目录（无 bin 子目录），与 JDK/Maven 不同；scanDirs 为常见 Windows 安装位置
    scanDirs: ['C:\\Program Files\\Redis', 'C:\\Redis', 'D:\\Redis', '/opt/devenv/database'],
    // tporadowski/redis 为 Windows 原生移植，版本停留在 5.0.x（官方在 Windows 不提供预编译二进制）
    remoteVersions: ['5.0.14', '5.0.10', '5.0.9'],
    // Windows：tporadowski 预编译 zip（已核实存在：v5.0.14 → Redis-x64-5.0.14.zip）
    // 其它平台：官方源码 tar.gz（Linux 原生，可经 WSL 使用）
    buildUrl: (v, p) => {
      if (p === 'win32')
        return `https://github.com/tporadowski/redis/releases/download/v${v}/Redis-x64-${v}.zip`;
      return `https://download.redis.io/releases/redis-${v}.tar.gz`;
    },
  },
  {
    tool: 'git', name: 'Git', category: 'tool', binSubdir: 'cmd',
    binaries: ['git', 'git.exe'],
    versionArgs: ['--version'],
    versionRegex: /git version ([\d.]+)/,
    scanDirs: ['C:\\Program Files\\Git', '/usr/local/git', '/opt/devenv/tool'],
    remoteVersions: ['2.45.2', '2.46.0'],
    buildUrl: (v, p) => {
      // Windows：git-for-windows 便携版 MinGit（npmmirror 镜像，稳定可达）
      // Linux：kernel.org 官方源码 tar.gz
      if (p === 'win32')
        return `https://registry.npmmirror.com/-/binary/git-for-windows/v${v}.windows.1/MinGit-${v}-64-bit.zip`;
      return `https://mirrors.edge.kernel.org/pub/software/scm/git/git-${v}.tar.gz`;
    },
  },
  {
    // Docker 定位为「仅纳管」工具：Docker Desktop 是独立 exe 安装器（无便携 zip），
    // 二进制实际位于 Docker\Docker\resources\bin\docker.exe，不在解压目录内，无法走通用 zip 安装流程。
    // 故标记 managedOnly：安装流程直接拒绝，引导用户先安装 Docker Desktop 再用「扫描」功能纳管。
    tool: 'docker', name: 'Docker', category: 'container', binSubdir: '', managedOnly: true,
    binaries: ['docker', 'docker.exe'],
    versionArgs: ['--version'],
    versionRegex: /Docker version ([\d.]+)/,
    scanDirs: ['C:\\Program Files\\Docker\\Docker\\resources\\bin', '/usr/bin', '/opt/devenv/container'],
    remoteVersions: ['27.0.3', '26.1.4'],
    buildUrl: (v, p) => {
      // Linux：官方静态二进制 tgz；Windows：Docker Desktop 安装器（exe，静默安装）
      if (p === 'win32') return `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe`;
      return `https://download.docker.com/linux/static/stable/x86_64/docker-${v}.tgz`;
    },
  },
  {
    tool: 'go', name: 'Go', category: 'go', homeVar: 'GOROOT', binSubdir: 'bin',
    binaries: ['go', 'go.exe'],
    versionArgs: ['version'],
    // `go version` 输出 "go version go1.22.5 windows/amd64"，取 go 后的版本号
    versionRegex: /go version go([\d.]+)/,
    scanDirs: ['C:\\Go', 'C:\\Program Files\\Go', 'C:\\Program Files (x86)\\Go', '/usr/local/go', '/opt/devenv/go'],
    remoteVersions: ['1.21.13', '1.22.5', '1.23.0'],
    // 官方分发包（已核实命名）：Windows 为 windows-amd64.zip，Linux 为 linux-amd64.tar.gz
    buildUrl: (v, p) =>
      p === 'win32'
        ? `https://go.dev/dl/go${v}.windows-amd64.zip`
        : `https://go.dev/dl/go${v}.linux-amd64.tar.gz`,
  },
  {
    tool: 'python', name: 'Python', category: 'python', homeVar: 'PYTHONHOME', binSubdir: '',
    binaries: ['python', 'python.exe', 'python3', 'python3.exe'],
    versionArgs: ['--version'],
    // `python --version` 输出 "Python 3.12.4"，取空格后的版本号
    versionRegex: /Python ([\d.]+)/,
    // Python 常见安装位：官方安装器默认放在 %USERPROFILE%\AppData\Local\Programs\Python\Python311，
    // 也常见于 C:\Python*、C:\Program Files\Python*。scanDirs 支持通配符与环境变量展开。
    scanDirs: [
      'C:\\Python*',
      'C:\\Program Files\\Python*',
      'C:\\Program Files (x86)\\Python*',
      '%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python*',
      '/usr/local/python',
      '/opt/devenv/python',
    ],
    remoteVersions: ['3.11.9', '3.12.4', '3.13.0'],
    buildUrl: (v, p) =>
      p === 'win32'
        ? `https://www.python.org/ftp/python/${v}/python-${v}-embed-amd64.zip`
        : `https://www.python.org/ftp/python/${v}/Python-${v}.tgz`,
  },
  {
    // Nginx：Windows 官方提供便携 zip（绿色解压即运行，nginx.exe 在根目录），
    // 常用于前后端联调的反向代理（把 /api 代理到 Spring Boot）。
    // 解压后顶层 nginx-<v>/ 会被 flattenSingleRoot 上移，使 nginx.exe 落到 destDir 根。
    tool: 'nginx', name: 'Nginx', category: 'web-server', homeVar: 'NGINX_HOME', binSubdir: '',
    binaries: ['nginx', 'nginx.exe'],
    versionArgs: ['-v'],
    // `nginx -v` 输出 "nginx version: nginx/1.26.3"，取 nginx/ 后的版本号
    versionRegex: /nginx\/([\d.]+)/,
    scanDirs: [
      'C:\\nginx',
      'C:\\Program Files\\nginx',
      'C:\\Program Files (x86)\\nginx',
      '/usr/local/nginx',
      '/opt/devenv/web-server',
    ],
    remoteVersions: ['1.26.3', '1.30.3', '1.31.2'],
    // 官方 Windows 便携包（已核实 200）：nginx.org/download/nginx-<v>.zip
    buildUrl: (v, p) =>
      p === 'win32'
        ? `https://nginx.org/download/nginx-${v}.zip`
        : `https://nginx.org/download/nginx-${v}.tar.gz`,
  },
];

export function getSpec(tool: string): ToolSpec | undefined {
  return REGISTRY.find((s) => s.tool === tool);
}

/** 列出某工具所有可下载版本（list --remote 的数据来源） */
export function listRemote(tool: string): string[] {
  return getSpec(tool)?.remoteVersions ?? [];
}

/**
 * 展开 scanDirs 中的环境变量与通配符，提升发现率。
 * - 支持 Windows 环境变量 %VAR%（如 %USERPROFILE%）
 * - 支持单级通配符 *（如 C:\Python* 匹配 C:\Python311、C:\Python312 等）
 */
async function expandScanDirs(scanDirs: string[]): Promise<string[]> {
  const { promises: fsp, statSync } = await import('node:fs');
  const out: string[] = [];
  for (const dir of scanDirs) {
    let expanded = dir;
    if (process.platform === 'win32') {
      expanded = expanded.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? '');
    }
    expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? '');

    if (!expanded.includes('*')) {
      out.push(expanded);
      continue;
    }

    const starIdx = expanded.lastIndexOf('*');
    const base = expanded.slice(0, starIdx);
    const sepIdx = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
    const baseDir = expanded.slice(0, sepIdx + 1);
    const pattern = expanded.slice(sepIdx + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp('^' + pattern + '$');

    try {
      const entries = await fsp.readdir(baseDir);
      for (const entry of entries) {
        const p = path.join(baseDir, entry);
        if (!regex.test(entry)) continue;
        try { if (statSync(p).isDirectory()) out.push(p); } catch { /* 跳过不可访问项 */ }
      }
    } catch { /* 基目录不存在或不可读 */ }
  }
  return out;
}
export async function detectTool(spec: ToolSpec, runner: Runner): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const seen = new Set<string>();

  // 1) PATH 上的版本：优先收集所有匹配路径（多版本共存），单 runner 未实现 whichAll 则回退到单个 which
  const pathBins: string[] = [];
  for (const bin of spec.binaries) {
    const all = runner.whichAll ? await runner.whichAll(bin) : [];
    if (all.length > 0) {
      pathBins.push(...all);
    } else {
      const single = await runner.which(bin);
      if (single) pathBins.push(single);
    }
  }
  for (const binPath of [...new Set(pathBins)]) {
    const rawVer = await readVersion(runner, binPath, spec);
    const ver = spec.normalizeVersion && rawVer ? spec.normalizeVersion(rawVer) : rawVer;
    if (DEBUG) console.log(`[detectTool] ${spec.tool} which(${binPath}) → version=${ver}`);
    // 过滤明显不完整的版本号（如 Windows 包装器输出仅 "3"），避免 Dashboard 出现无意义条目
    if (!ver || !/^\d/.test(ver) || (!/^\d+u\d+$/i.test(ver) && !/^\d+(?:\.\d+)+/.test(ver))) continue;
    const home = guessHome(binPath, spec.binSubdir);
    const id = `${spec.tool}@${ver}@${home}`;
    if (!seen.has(id)) {
      seen.add(id);
      results.push({
        tool: spec.tool, name: spec.name, category: spec.category,
        version: ver, path: home, inPath: true,
      });
    }
  }

  // 2) 扫描常见目录发现多版本
  //    候选根目录 = ① dir 自身（覆盖 msi/官方安装器把二进制直接放在 dir 根目录的情况，
  //                  如 Redis 的 C:\Program Files\Redis\redis-server.exe）；
  //               ② dir 的每个直接子目录（覆盖「版本父目录/各版本子目录」布局，
  //                  如 C:\Program Files\Java\jdk-17）。
  //    scanDirs 支持环境变量（%USERPROFILE%）与通配符（*），可匹配 Python 的 C:\Python311 等。
  //    对每个候选遍历所有 binary 候选（自动兼容 Windows 的 .exe/.cmd/.bat 扩展名，而非仅 binaries[0]）。
  const expandedDirs = await expandScanDirs(spec.scanDirs);
  for (const dir of expandedDirs) {
    if (!(await runner.exists(dir))) continue;
    const { promises: fsp, statSync } = await import('node:fs');
    const candidates: string[] = [dir];
    try {
      for (const child of await fsp.readdir(dir)) {
        const p = `${dir}/${child}`;
        try { if (statSync(p).isDirectory()) candidates.push(p); } catch { /* 跳过不可访问项 */ }
      }
    } catch { /* 目录不可读则仅尝试 dir 自身 */ }

    for (const candidate of candidates) {
      // 遍历 binaries，取第一个存在的可执行文件（兼容 Windows 扩展名 .exe/.cmd/.bat）
      let matchedExe: string | null = null;
      for (const bin of spec.binaries) {
        const sub = spec.binSubdir ? `${candidate}/${spec.binSubdir}` : candidate;
        const exe = `${sub}/${bin}`;
        if (await runner.exists(exe)) { matchedExe = exe; break; }
      }
      if (!matchedExe) continue;
      const rawVer = await readVersion(runner, matchedExe, spec);
      const ver = spec.normalizeVersion && rawVer ? spec.normalizeVersion(rawVer) : rawVer;
      const id = `${spec.tool}@${ver}@${candidate}`;
      if (!seen.has(id) && ver && /^\d/.test(ver) && (ver.includes('.') || ver.includes('u'))) {
        seen.add(id);
        results.push({
          tool: spec.tool, name: spec.name, category: spec.category,
          version: ver, path: candidate, inPath: false,
        });
      }
    }
  }

  return results;
}

async function readVersion(runner: Runner, binPath: string, spec: ToolSpec): Promise<string | null> {
  try {
    const { stdout } = await runner.run(binPath, spec.versionArgs);
    const m = stdout.match(spec.versionRegex);
    if (m) return m[1];
  } catch {
    // 命令执行失败时走路径回退
  }
  // 回退：从二进制路径提取版本号（适用于 mvn 因 JAVA_HOME 缺失而失败等场景）
  // 匹配 apache-maven-3.9.9 / maven-3.9.9 / mysql-8.0.39 等常见命名模式
  const pathVer = binPath.match(/[\\/-](?:apache-)?(maven|mysql|gradle|node|jdk|redis|git|mingit|docker|go|python|nginx)[-_]?(?:v)?(\d[\d.]*)/i);
  if (pathVer) return pathVer[2];
  return null;
}

/** 由二进制路径推断 HOME（去掉 /bin 或 /bin 前缀） */
function guessHome(binPath: string, binSubdir: string): string {
  // 根目录型工具（binSubdir=''）的二进制就在 HOME 根目录，直接取 exe 所在目录
  if (!binSubdir) return path.dirname(binPath);
  const idx = binPath.lastIndexOf(`/${binSubdir}`);
  if (idx >= 0) return binPath.slice(0, idx);
  const i2 = binPath.lastIndexOf(`\\${binSubdir}`);
  if (i2 >= 0) return binPath.slice(0, i2);
  return binPath;
}
