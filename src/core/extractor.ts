import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ArchiveFormat } from '../types.js';
import { detectFormat } from './recognizer.js';

// ============================================================================
// 解压 / 静默安装器（纯 JS 实现，零外部 CLI 依赖，跨平台一致）
//   .zip / .tar.gz → 内置解析（仅用 zlib）
//   .msi / .exe     → 静默安装（系统命令）
//   .dmg            → 挂载复制（仅 macOS）
// 统一目录规范：内容落到 destDir，必要时扁平化单层根目录。
// ============================================================================

const execFileP = promisify(execFile);

export interface ExtractOptions {
  format?: ArchiveFormat;
  flatten?: boolean;
  installArgs?: string[];
  signal?: AbortSignal;
}

export async function extract(
  archivePath: string,
  destDir: string,
  opts: ExtractOptions = {},
): Promise<void> {
  const format = opts.format ?? detectFormat(archivePath);
  await fsp.mkdir(destDir, { recursive: true });

  switch (format) {
    case 'zip':
    case 'tar.gz':
    case 'tar.xz':
    case 'unknown': {
      const buf = await fsp.readFile(archivePath);
      // 用魔数嗅探真实格式（adoptium 等 URL 无扩展名，必须靠内容判断）
      const real = sniffFormat(buf);
      const effective = real !== 'unknown' ? real : format;
      let files: FileEntry[];
      if (effective === 'tar.gz') files = parseTarGz(buf);
      else if (effective === 'tar.xz') {
        await extractTarXz(archivePath, destDir);
        break;
      } else files = parseZip(buf);
      for (const f of files) {
        if (f.name.endsWith('/')) continue; // 目录由文件条目隐式创建
        const out = path.join(destDir, f.name);
        if (f.type === 'dir') {
          await fsp.mkdir(out, { recursive: true });
          continue;
        }
        if (f.type === 'symlink') {
          await fsp.mkdir(path.dirname(out), { recursive: true });
          // 符号链接目标相对归档根目录；best-effort，失败（如跨盘）忽略不阻断
          await fsp.symlink(f.linkTarget ?? '', out).catch(() => {});
          continue;
        }
        if (f.type === 'hardlink') {
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await fsp.link(f.linkTarget ?? '', out).catch(() => {});
          continue;
        }
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, f.data);
      }
      break;
    }
    case 'msi':
      await installMsi(archivePath, destDir, opts.installArgs);
      break;
    case 'exe':
      await installExe(archivePath, destDir, opts.installArgs);
      break;
    case 'dmg':
      await installDmg(archivePath, destDir);
      break;
  }

  if (opts.flatten !== false) await flattenSingleRoot(destDir);
}

// ----------------------------- TAR.GZ -----------------------------
interface FileEntry {
  name: string;
  data: Buffer;
  /** 条目类型：普通文件省略（默认 file）；目录 / 符号链接 / 硬链接显式标注 */
  type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  /** 符号/硬链接指向的目标路径 */
  linkTarget?: string;
}

export function parseTarGz(buf: Buffer): FileEntry[] {
  const tar = zlib.gunzipSync(buf);
  return parseTar(tar);
}

export function parseTar(buf: Buffer): FileEntry[] {
  const out: FileEntry[] = [];
  let off = 0;
  let longName = ''; // GNU 长文件名（typeflag 'L'）缓存
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;
    const name = readStr(header, 0, 100);
    const sizeStr = readStr(header, 124, 12);
    const size = parseInt(sizeStr.trim() || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const linkname = readStr(header, 157, 100);
    const prefix = readStr(header, 345, 155); // USTAR/POSIX 长名前缀
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    let fullName = name;
    if (prefix) fullName = `${prefix}/${name}`;

    // GNU 扩展：本条数据块内容即下一文件的完整名称
    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (longName) {
      fullName = longName;
      longName = '';
    }

    if (typeflag === '5' || fullName.endsWith('/')) {
      out.push({ name: fullName.replace(/\/$/, ''), data: Buffer.alloc(0), type: 'dir' });
    } else if (typeflag === '2') {
      out.push({ name: fullName, data: Buffer.alloc(0), type: 'symlink', linkTarget: linkname });
    } else if (typeflag === '1') {
      out.push({ name: fullName, data: Buffer.alloc(0), type: 'hardlink', linkTarget: linkname });
    } else {
      // '0' / '\0' / '' / '7'(contiguous) 等：按普通文件处理
      out.push({ name: fullName, data: Buffer.from(data) });
    }
  }
  return out;
}

// ------------------------------ ZIP ------------------------------
export function parseZip(buf: Buffer): FileEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset < 0 || cdOffset + 4 > buf.length) throw new Error('ZIP 中央目录偏移越界（文件可能损坏）');
  const out: FileEntry[] = [];
  let p = cdOffset;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // 读本地文件头
    if (localOffset < 0 || localOffset + 30 > buf.length) throw new Error(`ZIP 本地头越界：${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart < 0 || dataStart + compSize > buf.length)
      throw new Error(`ZIP 数据越界（文件可能损坏）：${name}`);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = compMethod === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ------------------------- 魔数嗅探 -------------------------
/** 通过文件头魔数判断真实归档格式（弥补扩展名缺失/错误） */
export function sniffFormat(buf: Buffer): ArchiveFormat {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) return 'zip'; // PK\x03\x04
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'tar.gz'; // gzip
  if (buf.length >= 6 && buf.toString('hex', 0, 6) === 'fd377a585a00') return 'tar.xz'; // xz
  return 'unknown';
}

// ----------------------- TAR.XZ (系统 tar) -----------------------
/** .tar.xz 需系统 tar 命令（Windows 10+ / Linux / macOS 自带且支持 xz） */
async function extractTarXz(archivePath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await execFileP('tar', ['-xf', archivePath, '-C', destDir], { windowsHide: true });
  } catch (e: any) {
    throw new Error(
      `解压 .tar.xz 需要系统 tar 命令且支持 xz 压缩（Windows 10+/Linux/macOS 自带）；当前环境不可用：${e?.message ?? e}`,
    );
  }
}

function readStr(buf: Buffer, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[start + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// --------------------------- 静默安装 ---------------------------
async function installMsi(archivePath: string, destDir: string, extra?: string[]) {
  const args = ['/a', archivePath, '/qn', `TARGETDIR=${destDir}`, ...(extra ?? [])];
  await execFileP('msiexec', args, { windowsHide: true });
}

async function installExe(archivePath: string, destDir: string, extra?: string[]) {
  const args = ['/S', `/D=${destDir}`, ...(extra ?? [])];
  try {
    await execFileP(archivePath, args, { windowsHide: true });
  } catch {
    await execFileP(archivePath, ['/s', `INSTALLDIR=${destDir}`, ...(extra ?? [])], { windowsHide: true });
  }
}

async function installDmg(archivePath: string, destDir: string) {
  if (process.platform !== 'darwin') throw new Error('dmg 仅支持 macOS');
  const mount = await execFileP('hdiutil', ['attach', '-nobrowse', archivePath], { windowsHide: true });
  const mountPoint = (mount.stdout as string).split('\n').pop()?.trim().split(/\s+/).pop();
  if (!mountPoint) throw new Error('挂载 dmg 失败');
  try {
    await execFileP('cp', ['-R', `${mountPoint}/.`, destDir], { windowsHide: true });
  } finally {
    await execFileP('hdiutil', ['detach', mountPoint], { windowsHide: true }).catch(() => {});
  }
}

/** 扁平化单层根目录 */
async function flattenSingleRoot(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir);
  if (entries.length === 1) {
    const only = path.join(dir, entries[0]);
    let stat;
    try {
      stat = await fsp.stat(only);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      const inner = await fsp.readdir(only);
      for (const f of inner) {
        await fsp.rename(path.join(only, f), path.join(dir, f));
      }
      await fsp.rm(only, { recursive: true, force: true });
    }
  }
}

/** 校验安装目录完整性 */
export async function verifyInstall(dir: string, binNames: string[], binSubdir: string = 'bin'): Promise<boolean> {
  // Windows 二进制多带扩展名（java.exe / redis-server.exe / mvn.cmd），需按平台尝试常见可执行后缀。
  // 仅校验无扩展名文件名会导致 Windows 下所有工具验证失败（含 Redis 根目录型与 JDK/Maven 等）。
  // binSubdir 动态拼接子目录：根目录型工具(binSubdir='')只查 dir 根；binSubdir='cmd'/'bin' 查 dir/<binSubdir>。
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const name of binNames) {
    const candidates: string[] = [];
    for (const ext of exts) {
      candidates.push(path.join(dir, name + ext)); // 根目录（node/redis/python 等根目录型）
      if (binSubdir) candidates.push(path.join(dir, binSubdir, name + ext)); // 按 binSubdir 动态子目录
    }
    if (!candidates.some((c) => fs.existsSync(c))) return false;
  }
  return true;
}

export { path };
