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

describe('docker ToolSpec', () => {
  it('listRemote returns Docker versions (added to mock)', () => {
    expect(listRemote('docker')).toEqual(['27.0.3', '26.1.4']);
  });

  it('detects Docker at Docker Desktop real binary path (resources\\bin)', async () => {
    // Docker Desktop on Windows 实际二进制在 C:\Program Files\Docker\Docker\resources\bin\docker.exe（binSubdir=''）
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'docker-'));
    const binDir = path.join(base, 'resources', 'bin');
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.writeFile(path.join(binDir, 'docker.exe'), '');
    const spec = { ...getSpec('docker')!, scanDirs: [path.join(base, 'resources', 'bin')] };
    const r = await detectTool(spec, fsRunner('Docker version 27.0.3, build abc123'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('27.0.3');
    expect(norm(r[0].path)).toBe(norm(binDir));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects Docker when scanDir points directly at the bin dir (root layout)', async () => {
    const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'docker-bin-'));
    await fsp.writeFile(path.join(binDir, 'docker.exe'), '');
    const spec = { ...getSpec('docker')!, scanDirs: [binDir] };
    const r = await detectTool(spec, fsRunner('Docker version 26.1.4, build xyz'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('26.1.4');
    expect(norm(r[0].path)).toBe(norm(binDir));
    await fsp.rm(binDir, { recursive: true, force: true });
  });

  it('falls back to path-based version when `docker --version` fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'docker-fb-'));
    const binDir = path.join(base, 'docker-27.0.3');
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.writeFile(path.join(binDir, 'docker.exe'), '');
    const spec = { ...getSpec('docker')!, scanDirs: [binDir] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('27.0.3');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
