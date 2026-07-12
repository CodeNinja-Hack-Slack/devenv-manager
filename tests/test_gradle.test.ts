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

describe('gradle ToolSpec', () => {
  it('listRemote returns Gradle versions', () => {
    expect(listRemote('gradle')).toEqual(['8.5', '8.7', '8.10']);
  });

  it('parses version from `gradle -v` output (Gradle x.y)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gradle-'));
    const home = path.join(base, 'gradle-8.10');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'gradle.bat'), '');
    const spec = { ...getSpec('gradle')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunner('Gradle 8.10\n\nBuild time: 2024-...'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.10');
    expect(norm(r[0].path)).toBe(norm(home));
    expect(r[0].inPath).toBe(false);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects Gradle when scanDir points directly at the gradle home (root layout)', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gradle-home-'));
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'gradle.bat'), '');
    const spec = { ...getSpec('gradle')!, scanDirs: [home] };
    const r = await detectTool(spec, fsRunner('Gradle 8.7'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.7');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('falls back to path-based version when `gradle -v` fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gradle-fb-'));
    const home = path.join(base, 'gradle-8.5');
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'gradle.bat'), '');
    const spec = { ...getSpec('gradle')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('8.5');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
