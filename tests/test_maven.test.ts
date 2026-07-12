import { describe, it, expect } from 'vitest';
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSpec, detectTool, listRemote, type Runner } from '../src/tools/registry.js';

// 基于真实文件系统的 runner（验证 scanDirs 目录布局，而非 PATH which）
function fsRunner(versionStdout: string): Runner {
  return {
    async which() { return null; },
    async run(_bin: string, _args: string[]) { return { stdout: versionStdout, code: 0 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
// 命令执行失败（如 JAVA_HOME 缺失）→ 返回空 stdout，触发 readVersion 的路径回退
function fsRunnerFailing(): Runner {
  return {
    async which() { return null; },
    async run() { return { stdout: '', code: 1 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
const norm = (p: string) => p.replace(/\\/g, '/');

describe('maven ToolSpec', () => {
  it('listRemote returns Maven versions (aligned with registry)', () => {
    expect(listRemote('maven')).toEqual(['3.9.6', '3.9.9', '3.9.16']);
  });

  it('parses version from `mvn -v` output (Apache Maven x.y.z)', async () => {
    // 官方 `mvn -v` 首行: "Apache Maven 3.9.9 (2bdd9fddda4b...)"
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'maven-'));
    const home = path.join(base, 'apache-maven-3.9.9');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mvn.cmd'), '');
    const spec = { ...getSpec('maven')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('Apache Maven 3.9.9 (2bdd9fddda4b155ebf8000e807eb73fd829a51d5)'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('3.9.9');
    expect(norm(r[0].path)).toBe(norm(home));
    expect(r[0].inPath).toBe(false);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects Maven when scanDir points directly at the maven home (root layout)', async () => {
    // 备选布局：scanDir 直接是 maven 家目录，二进制在 家目录/bin（无版本子目录）
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'maven-home-'));
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mvn.cmd'), '');
    const spec = { ...getSpec('maven')!, scanDirs: [home] };
    const r = await detectTool(spec, fsRunner('Apache Maven 3.9.6 (abc)'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('3.9.6');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('falls back to path-based version when `mvn -v` fails (JAVA_HOME missing)', async () => {
    // mvn.cmd 存在但 JAVA_HOME 未配置导致 `mvn -v` 失败 → 从路径 apache-maven-3.9.9 回退解析
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'maven-fb-'));
    const home = path.join(base, 'apache-maven-3.9.9');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mvn.cmd'), '');
    const spec = { ...getSpec('maven')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('3.9.9');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
