import { describe, it, expect } from 'vitest';
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSpec, detectTool, listRemote, type Runner } from '../src/tools/registry.js';

function fakeRunner(map: Record<string, { bin: string; version: string }>): Runner {
  return {
    async which(bin: string) {
      return Object.values(map).find((m) => m.bin.endsWith(bin))?.bin ?? null;
    },
    async run(binPath: string, _args: string[]) {
      const hit = Object.values(map).find((m) => m.bin === binPath);
      return { stdout: hit ? `version "${hit.version}"` : '', code: hit ? 0 : 1 };
    },
    async exists(p: string) {
      return p.startsWith('/opt/devenv/java') || Object.values(map).some((m) => m.bin === p);
    },
  };
}

describe('tool registry detection', () => {
  it('detects JDK on PATH via which + version', async () => {
    const runner = fakeRunner({ jdk17: { bin: '/opt/devenv/java/jdk17/bin/java', version: '17.0.9' } });
    const spec = getSpec('jdk')!;
    const r = await detectTool(spec, runner);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].version).toBe('17.0.9');
    expect(r[0].inPath).toBe(true);
  });

  it('listRemote returns built-in versions', () => {
    expect(listRemote('jdk')).toContain('17.0.9');
    expect(listRemote('node')).toContain('22.11.0');
  });

  it('normalizes JDK8 detected version 1.8.0_392 to 8u392 (Bug#3)', async () => {
    const runner = fakeRunner({ jdk8: { bin: '/opt/devenv/java/jdk8/bin/java', version: '1.8.0_392' } });
    const spec = getSpec('jdk')!;
    const r = await detectTool(spec, runner);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].version).toBe('8u392');
    expect(r[0].inPath).toBe(true);
  });

  // 基于真实文件系统的 runner（用于验证 scanDirs 的目录布局，而非 PATH which）
  function fsRunner(versionStdout: string): Runner {
    return {
      async which() { return null; },
      async run(_bin: string, _args: string[]) { return { stdout: versionStdout, code: 0 }; },
      async exists(p: string) { return existsSync(p); },
    };
  }
  // scanDirs 检测出的 path 用模板字符串拼接（可能为正斜杠），断言时统一按 / 归一比较
  const norm = (p: string) => p.replace(/\\/g, '/');

  it('scans redis installed at scanDir ROOT (msi layout, no version subdir)', async () => {
    // 复现用户场景：Redis 经 msi 安装，二进制直接在 C:\Program Files\Redis\ 根目录
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'redis-root-'));
    await fsp.writeFile(path.join(base, 'redis-server.exe'), '');
    await fsp.writeFile(path.join(base, 'redis-cli.exe'), '');
    const spec = { ...getSpec('redis')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('Redis server v=5.0.14 sha=...'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('5.0.14');
    expect(norm(r[0].path)).toBe(norm(base));
    expect(r[0].inPath).toBe(false);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('still scans redis under a version subdir (regression)', async () => {
    // 版本子目录布局（解压 zip 到 Redis-x64-5.0.14\）仍应被发现
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'redis-sub-'));
    const verDir = path.join(base, 'Redis-x64-5.0.14');
    await fsp.mkdir(verDir, { recursive: true });
    await fsp.writeFile(path.join(verDir, 'redis-server.exe'), '');
    const spec = { ...getSpec('redis')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('Redis server v=5.0.14'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('5.0.14');
    expect(norm(r[0].path)).toBe(norm(verDir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('scans java (Windows .exe) at scanDir root layout', async () => {
    // 验证 jdk 在 Windows 下 scanDirs 也能发现 java.exe（此前仅用 binaries[0]='java' 会漏）
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'jdk-root-'));
    const jdkDir = path.join(base, 'jdk-17');
    await fsp.mkdir(path.join(jdkDir, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(jdkDir, 'bin', 'java.exe'), '');
    const spec = { ...getSpec('jdk')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('version "17.0.9"'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('17.0.9');
    expect(norm(r[0].path)).toBe(norm(jdkDir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  // ---------------- Nginx（新增：web-server 类别，根目录型 binSubdir=''）----------------
  it('nginx spec: category web-server, NGINX_HOME homeVar, root-layout binSubdir', () => {
    const spec = getSpec('nginx')!;
    expect(spec).toBeTruthy();
    expect(spec.category).toBe('web-server');
    expect(spec.homeVar).toBe('NGINX_HOME');
    expect(spec.binSubdir).toBe('');
    expect(spec.binaries).toContain('nginx.exe');
    expect(spec.versionRegex.test('nginx version: nginx/1.26.3')).toBe(true);
  });

  it('listRemote returns nginx versions', () => {
    expect(listRemote('nginx')).toEqual(['1.26.3', '1.30.3', '1.31.2']);
  });

  it('scans nginx at scanDir root (binSubdir empty → nginx.exe at root)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nginx-root-'));
    await fsp.writeFile(path.join(base, 'nginx.exe'), '');
    const spec = { ...getSpec('nginx')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('nginx version: nginx/1.26.3'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('1.26.3');
    expect(norm(r[0].path)).toBe(norm(base));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('scans nginx under a version subdir (regression)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nginx-sub-'));
    const verDir = path.join(base, 'nginx-1.26.3');
    await fsp.mkdir(verDir, { recursive: true });
    await fsp.writeFile(path.join(verDir, 'nginx.exe'), '');
    const spec = { ...getSpec('nginx')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('nginx version: nginx/1.26.3'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('1.26.3');
    expect(norm(r[0].path)).toBe(norm(verDir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  function fsRunnerFailing(): Runner {
    return {
      async which() { return null; },
      async run() { return { stdout: '', code: 1 }; },
      async exists(p: string) { return existsSync(p); },
    };
  }
  it('nginx falls back to path-based version (dir name) when command fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nginx-fb-'));
    const verDir = path.join(base, 'nginx-1.26.3');
    await fsp.mkdir(verDir, { recursive: true });
    await fsp.writeFile(path.join(verDir, 'nginx.exe'), '');
    const spec = { ...getSpec('nginx')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('1.26.3');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
