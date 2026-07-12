import { describe, it, expect } from 'vitest';
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSpec, detectTool, listRemote, type Runner } from '../src/tools/registry.js';

function fsRunner(versionStdout: string): Runner {
  return {
    async which() { return null; },
    async run(_bin: string, _args: string[]) { return { stdout: versionStdout, code: 0 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
function fsRunnerFailing(): Runner {
  return {
    async which() { return null; },
    async run() { return { stdout: '', code: 1 }; },
    async exists(p: string) { return existsSync(p); },
  };
}
const norm = (p: string) => p.replace(/\\/g, '/');

describe('git ToolSpec', () => {
  it('listRemote returns Git versions', () => {
    expect(listRemote('git')).toEqual(['2.45.2', '2.46.0']);
  });

  it('parses version from `git --version` output (git version x.y.z)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-'));
    const home = path.join(base, 'PortableGit-2.46.0-64-bit');
    // MinGit 的 git.exe 位于 cmd/ 子目录（binSubdir='cmd'），与安装时加入 PATH 的目录一致
    await fsp.mkdir(path.join(home, 'cmd'), { recursive: true });
    await fsp.writeFile(path.join(home, 'cmd', 'git.exe'), '');
    const spec = { ...getSpec('git')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('git version 2.46.0'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('2.46.0');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects Git when scanDir points directly at the git home (root layout)', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-home-'));
    await fsp.mkdir(path.join(home, 'cmd'), { recursive: true });
    await fsp.writeFile(path.join(home, 'cmd', 'git.exe'), '');
    const spec = { ...getSpec('git')!, scanDirs: [home] };
    const r = await detectTool(spec, fsRunner('git version 2.45.2'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('2.45.2');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('falls back to path-based version (MinGit dir name) when `git --version` fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'git-fb-'));
    const home = path.join(base, 'MinGit-2.46.0-64-bit');
    await fsp.mkdir(path.join(home, 'cmd'), { recursive: true });
    await fsp.writeFile(path.join(home, 'cmd', 'git.exe'), '');
    const spec = { ...getSpec('git')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('2.46.0');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
