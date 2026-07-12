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

describe('node ToolSpec', () => {
  it('listRemote returns Node.js versions (aligned with registry)', () => {
    expect(listRemote('node')).toEqual(['18.20.4', '20.11.1', '22.11.0']);
  });

  it('places binaries at ROOT (binSubdir="") — Windows portable zip layout', async () => {
    // Node.js Windows 二进制 zip 解压后 node.exe 在版本目录根（无 bin 子目录）
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'node-'));
    const home = path.join(base, 'node-v22.11.0-win-x64');
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(path.join(home, 'node.exe'), '');
    const spec = { ...getSpec('node')!, scanDirs: [base] };
    expect(spec.binSubdir).toBe(''); // 关键：Node 走根目录，不是 bin
    const r = await detectTool(spec, fsRunner('v22.11.0'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('22.11.0');
    expect(norm(r[0].path)).toBe(norm(home));
    expect(r[0].inPath).toBe(false);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('detects Node when scanDir points directly at the node home (root layout)', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'node-home-'));
    await fsp.writeFile(path.join(home, 'node.exe'), '');
    const spec = { ...getSpec('node')!, scanDirs: [home] };
    const r = await detectTool(spec, fsRunner('v20.11.1'));
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('20.11.1');
    expect(norm(r[0].path)).toBe(norm(home));
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('falls back to path-based version when `node --version` fails', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'node-fb-'));
    const home = path.join(base, 'node-v18.20.4-win-x64');
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(path.join(home, 'node.exe'), '');
    const spec = { ...getSpec('node')!, scanDirs: [base] };
    const r = await detectTool(spec, fsRunnerFailing());
    expect(r).toHaveLength(1);
    expect(r[0].version).toBe('18.20.4');
    await fsp.rm(base, { recursive: true, force: true });
  });
});
