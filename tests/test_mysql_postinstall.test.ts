import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mysqlMyIniStep, mysqlInitStep, mysqlServiceStep } from '../src/core/postinstall/mysql.js';
import { installTool } from '../src/core/installer.js';
import { getSpec } from '../src/tools/registry.js';
import { defaultConfig } from '../src/config/store.js';
import { DryRunEnv } from '../src/platform/env.js';
import { Logger } from '../src/utils/logger.js';
import { planInstallDir, planInstallBaseDir } from '../src/utils/path.js';

/** 构造一个捕获调用的 fake run：默认返回成功；可注入 init / service 失败 */
function fakeRun(opts?: { failInit?: boolean; failService?: boolean }) {
  const calls: { bin: string; args: string[] }[] = [];
  const run = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    if (opts?.failInit && /mysqld/i.test(bin) && args.some((a) => a.includes('--initialize'))) {
      return { code: 1, stdout: '', stderr: 'initialize failed' };
    }
    if (opts?.failService && /mysqld/i.test(bin) && args.includes('--install')) {
      return { code: 1, stdout: '', stderr: 'access denied' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

/** 构造最小 StepContext：仅提供步骤实际用到的字段，其余以 any 兜底 */
function makeStepCtx(destDir: string, platform: 'win32' | 'linux' | 'darwin', applyEnv: boolean, run: any) {
  return {
    spec: getSpec('mysql')!,
    destDir,
    binPath: path.join(destDir, 'bin'),
    version: '8.0.39',
    platform,
    cfg: defaultConfig(destDir),
    env: new DryRunEnv(platform, ''),
    logger: new Logger(destDir),
    applyEnv,
    mode: 'offline' as const,
    run,
    state: {},
    rollback: { envOpsBefore: new Map() },
  } as any;
}

describe('mysql install steps', () => {
  it('mysql:myini writes my.ini on win32 and skips on non-win32', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-myini-'));
    const destDir = path.join(base, 'mysql-8.0.39');
    await fsp.mkdir(path.join(destDir, 'bin'), { recursive: true });
    const { run } = fakeRun();
    const r = await mysqlMyIniStep.run(makeStepCtx(destDir, 'win32', true, run));
    expect(r.ok).toBe(true);
    const ini = await fsp.readFile(path.join(destDir, 'my.ini'), 'utf8');
    expect(ini).toContain('[mysqld]');
    expect(ini).toMatch(/basedir=/);
    expect(ini).toMatch(/datadir=/);

    // 非 win32 平台跳过
    const baseN = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-myini-nix-'));
    const destN = path.join(baseN, 'mysql-8.0.39');
    const rN = await mysqlMyIniStep.run(makeStepCtx(destN, 'linux', false, run));
    expect(rN.ok).toBe(true);
    const iniN = await fsp.access(path.join(destN, 'my.ini')).then(() => true).catch(() => false);
    expect(iniN).toBe(false);

    await fsp.rm(base, { recursive: true, force: true });
    await fsp.rm(baseN, { recursive: true, force: true });
  });

  it('mysql:init runs mysqld --initialize with --defaults-file first (win32)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-init-'));
    const destDir = path.join(base, 'mysql-8.0.39');
    await fsp.mkdir(path.join(destDir, 'bin'), { recursive: true });
    const { calls, run } = fakeRun();
    const r = await mysqlInitStep.run(makeStepCtx(destDir, 'win32', true, run));
    expect(r.ok).toBe(true);
    const initCall = calls.find((c) => c.args.some((a) => a.includes('--initialize')));
    expect(initCall).toBeDefined();
    expect(initCall!.args[0]).toMatch(/^--defaults-file=/);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('mysql:init is optional and reports warning (not failure) on non-zero exit', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-init-err-'));
    const destDir = path.join(base, 'mysql-8.0.39');
    await fsp.mkdir(path.join(destDir, 'bin'), { recursive: true });
    const { run } = fakeRun({ failInit: true });
    const r = await mysqlInitStep.run(makeStepCtx(destDir, 'win32', true, run));
    expect(r.ok).toBe(false); // 步骤返回失败
    expect(r.warning).toBe(true); // 但标记为可忽略警告
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('mysql:service registers + starts service on win32 applyEnv, skips in dryRun', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mysql-svc-'));
    const destDir = path.join(base, 'mysql-8.0.39');
    await fsp.mkdir(path.join(destDir, 'bin'), { recursive: true });
    const { calls, run } = fakeRun();
    const r = await mysqlServiceStep.run(makeStepCtx(destDir, 'win32', true, run));
    expect(r.ok).toBe(true);
    expect(calls.some((c) => /mysqld/i.test(c.bin) && c.args.includes('--install'))).toBe(true);
    expect(calls.some((c) => c.bin === 'net' && c.args[0] === 'start')).toBe(true);

    // dryRun 跳过服务注册（不执行真实命令）
    const { calls: callsDry, run: runDry } = fakeRun();
    const rDry = await mysqlServiceStep.run(makeStepCtx(destDir, 'win32', false, runDry));
    expect(rDry.ok).toBe(true);
    expect(callsDry.some((c) => c.bin === 'net' && c.args[0] === 'start')).toBe(false);

    await fsp.rm(base, { recursive: true, force: true });
  });
});

describe('installer mysql step pipeline (dryRun)', () => {
  it('installs mysql offline and runs my.ini + optional steps (dryRun)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'inst-mysql-'));
    const cfg = defaultConfig(root);
    cfg.applyEnv = false; // dryRun：init/service 走 no-op run，不执行真实 mysqld
    const env = new DryRunEnv('win32', '');
    const logger = new Logger(root);
    const ctx = { cfg, env, logger, platform: 'win32' as const };
    const localPkg = path.join(root, 'mysql-8.0.39.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'mysql.exe'), '');
      await fsp.writeFile(path.join(d, 'bin', 'mysqld.exe'), '');
    };
    const r = await installTool(ctx, { tool: 'mysql', version: '8.0.39', mode: 'offline', localPath: localPkg, extractor: fakeExtractor });
    expect(r.ok).toBe(true);
    const destDir = planInstallDir(planInstallBaseDir(cfg), 'database', 'mysql', '8.0.39');
    // 安装管线已生成 my.ini（mysql:myini 步骤）
    const iniExists = await fsp.access(path.join(destDir, 'my.ini')).then(() => true).catch(() => false);
    expect(iniExists).toBe(true);
    // dryRun 下可选步骤均成功（no-op），不产生 warning
    expect(r.warnings).toBeUndefined();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('collects warnings when optional steps fail but install still succeeds (tool files ready)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'inst-mysql-warn-'));
    const cfg = defaultConfig(root); // applyEnv 默认 true → 真实执行 mysqld（不存在 → 失败 → 警告）
    const env = new DryRunEnv('win32', '');
    const logger = new Logger(root);
    const ctx = { cfg, env, logger, platform: 'win32' as const };
    const localPkg = path.join(root, 'mysql-8.0.39.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'mysql.exe'), '');
    };
    const r = await installTool(ctx, { tool: 'mysql', version: '8.0.39', mode: 'offline', localPath: localPkg, extractor: fakeExtractor });
    expect(r.ok).toBe(true);
    expect(r.installed).toBeDefined();
    // mysqld.exe 不存在 → 真实执行 init/service 失败 → 收集 warning（安装本身成功）
    expect(r.warnings && r.warnings.length).toBeGreaterThan(0);
    await fsp.rm(root, { recursive: true, force: true });
  });
});
