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

describe('mysql ToolSpec', () => {
  it('listRemote returns MySQL versions (including 8.4 series)', () => {
    expect(listRemote('mysql')).toEqual(['8.0.35', '8.0.39', '8.4.0']);
  });

  it('buildUrl selects correct series dir per version', () => {
    const spec = getSpec('mysql')!;
    expect(spec.buildUrl('8.0.39', 'win32')).toContain('Downloads/MySQL-8.0/mysql-8.0.39-winx64.zip');
    expect(spec.buildUrl('8.4.0', 'win32')).toContain('Downloads/MySQL-8.4/mysql-8.4.0-winx64.zip');
  });

  it('parses version from `mysql -V` output (mysql Ver x.y.z)', async () => {
    // `mysql -V` → "mysql  Ver 8.0.39 for Win64 on x86_64 (MySQL Community Server)"
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-'));
    const home = path.join(base, 'mysql-8.0.39-winx64');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mysql.exe'), '');
    const spec = { ...getSpec('mysql')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('mysql  Ver 8.0.39 for Win64 on x86_64 (MySQL Community Server)'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.0.39');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects MySQL when scanDir points directly at the mysql home (root layout)', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-home-'));
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mysql.exe'), '');
    const spec = { ...getSpec('mysql')!, scanDirs: [home] };
    const r = await detectTool(spec, fsRunner('mysql  Ver 8.4.0 for Win64 on x86_64 (MySQL Community Server)'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.4.0');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('falls back to path-based version when `mysql -V` fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-fb-'));
    const home = path.join(base, 'mysql-8.0.35-winx64');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'mysql.exe'), '');
    const spec = { ...getSpec('mysql')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.0.35');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
