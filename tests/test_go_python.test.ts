import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSpec, detectTool, listRemote, type Runner } from '../src/tools/registry.js';
import type { ScanResult } from '../src/types.js';

// 基于真实文件系统的 runner（验证 scanDirs 目录布局，而非 PATH which）
function fsRunner(versionStdout: string): Runner {
  return {
    async which() { return null; },
    async run(_bin: string, _args: string[]) { return { stdout: versionStdout, code: 0 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
// 命令执行失败 → 返回空 stdout，触发 readVersion 的路径回退
function fsRunnerFailing(): Runner {
  return {
    async which() { return null; },
    async run() { return { stdout: '', code: 1 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
const norm = (p: string) => p.replace(/\\/g, '/');

// ── 隔离岛：本文件所有临时目录都建在唯一 island 子树下，避免与全量并行时
// 其它测试文件对 %TEMP% 根目录的海量 mkdtemp/rm 竞争（Windows 下共享 %TEMP%
// 根目录元数据在高压并发时偶发“刚创建的子目录尚未可见”，导致 detectTool 的
// readdir 偶发读不到刚写入的文件）。岛内子目录互不干扰，隔离了跨文件竞争。
let ISLAND = '';
beforeAll(async () => {
  ISLAND = await fsp.mkdtemp(path.join(os.tmpdir(), 'devenv-island-go-py-'));
});
afterAll(async () => {
  if (ISLAND) await fsp.rm(ISLAND, { recursive: true, force: true }).catch(() => {});
});

// 高压并发下，刚写入的目录可能被 %TEMP% 竞争短暂不可见；对 detectTool 的
// “路径回退”结果做有限重试（最多 5 次，间隔 20ms），吸收这类偶发文件系统竞态。
// 不影响“真实缺陷”判定：文件若真的没写，重试依旧失败。
async function detectFallback(
  spec: Parameters<typeof detectTool>[0],
  runner: Parameters<typeof detectTool>[1],
  version: string,
  tries = 5,
): Promise<ScanResult | undefined> {
  for (let i = 0; i < tries; i++) {
    const res = await detectTool(spec, runner);
    const r = res.find((x) => x.version === version);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  return undefined;
}

describe('go ToolSpec', () => {
  it('listRemote 含官方 Windows 版本', () => {
    expect(listRemote('go')).toEqual(['1.21.13', '1.22.5', '1.23.0']);
  });

  it('检测「版本子目录 + bin」布局（go1.22.5\\bin\\go.exe）', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-go-'));
    const dir = path.join(base, 'go1.22.5');
    await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'bin', 'go.exe'), '');
    const spec = { ...getSpec('go')!, scanDirs: [base] };
    const res = await detectTool(spec, fsRunner('go version go1.22.5 windows/amd64'));
    const r = res.find((x) => x.version === '1.22.5');
    expect(r).toBeTruthy();
    expect(norm(r!.path)).toBe(norm(dir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('检测根目录直装（base\\bin\\go.exe，binSubdir=bin）', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-go-'));
    await fsp.mkdir(path.join(base, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(base, 'bin', 'go.exe'), '');
    const spec = { ...getSpec('go')!, scanDirs: [base] };
    const res = await detectTool(spec, fsRunner('go version go1.23.0 windows/amd64'));
    const r = res.find((x) => x.version === '1.23.0');
    expect(r).toBeTruthy();
    expect(norm(r!.path)).toBe(norm(base));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('命令失败走路径回退解析版本', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-go-'));
    const dir = path.join(base, 'go1.22.5');
    await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'bin', 'go.exe'), '');
    const spec = { ...getSpec('go')!, scanDirs: [base] };
  const r = await detectFallback(spec, fsRunnerFailing(), '1.22.5');
  expect(r).toBeTruthy();
    await fsp.rm(base, { recursive: true, force: true });
  });
});

describe('python ToolSpec', () => {
  it('listRemote 含官方 Windows 版本', () => {
    expect(listRemote('python')).toEqual(['3.11.9', '3.12.4', '3.13.0']);
  });

  it('检测「版本子目录根目录直装」（python-3.12.4\\python.exe，binSubdir=\'\'）', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-py-'));
    const dir = path.join(base, 'python-3.12.4');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'python.exe'), '');
    const spec = { ...getSpec('python')!, scanDirs: [base] };
    const res = await detectTool(spec, fsRunner('Python 3.12.4'));
    const r = res.find((x) => x.version === '3.12.4');
    expect(r).toBeTruthy();
    expect(norm(r!.path)).toBe(norm(dir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('检测根目录直装（base\\python.exe，binSubdir=\'\'）', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-py-'));
    await fsp.writeFile(path.join(base, 'python.exe'), '');
    const spec = { ...getSpec('python')!, scanDirs: [base] };
    const res = await detectTool(spec, fsRunner('Python 3.13.0'));
    const r = res.find((x) => x.version === '3.13.0');
    expect(r).toBeTruthy();
    expect(norm(r!.path)).toBe(norm(base));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('命令失败走路径回退解析版本', async () => {
    const base = await fsp.mkdtemp(path.join(ISLAND, 'devenv-py-'));
    const dir = path.join(base, 'python-3.12.4');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'python.exe'), '');
    const spec = { ...getSpec('python')!, scanDirs: [base] };
  const r = await detectFallback(spec, fsRunnerFailing(), '3.12.4');
  expect(r).toBeTruthy();
    await fsp.rm(base, { recursive: true, force: true });
  });
});
