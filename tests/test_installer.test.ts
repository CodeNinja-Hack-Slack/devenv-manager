import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installTool } from '../src/core/installer.js';
import { defaultConfig } from '../src/config/store.js';
import { DryRunEnv } from '../src/platform/env.js';
import { Logger } from '../src/utils/logger.js';
import { planInstallDir, planInstallBaseDir } from '../src/utils/path.js';

function makeCtx(rootDir: string) {
  const cfg = defaultConfig(rootDir);
  const env = new DryRunEnv('win32', '');
  const logger = new Logger(rootDir);
  return { cfg, env, logger, platform: 'win32' as const };
}

// ── 隔离岛：本文件所有临时目录都建在唯一 island 子树下，减少与全量并行时
// 其它测试文件对 %TEMP% 根目录的 mkdtemp/rm 竞争（见 test_go_python 同款隔离）。
let ISLAND = '';
beforeAll(async () => {
  ISLAND = await fsp.mkdtemp(path.join(os.tmpdir(), 'devenv-island-inst-'));
});
afterAll(async () => {
  if (ISLAND) await fsp.rm(ISLAND, { recursive: true, force: true }).catch(() => {});
});

describe('installer (offline, dryRun env)', () => {
  it('installs offline and updates config + env', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');

    const fakeExtractor = async (archive: string, dest: string) => {
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(dest, 'bin', 'java'), '');
    };

    const r = await installTool(
      ctx,
      { tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: localPkg, extractor: fakeExtractor },
    );

    expect(r.ok).toBe(true);
    expect(ctx.cfg.tools).toHaveLength(1);
    expect(ctx.cfg.tools[0].active).toBe(true);
    const ops = ctx.env.preview();
    expect(ops).toContainEqual({
      kind: 'set',
      name: 'JAVA_HOME',
      value: planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '17.0.9'),
    });
    // 目标目录真实创建
    const exists = await fsp
      .access(path.join(planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '17.0.9'), 'bin', 'java'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('rolls back when extraction fails', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst2-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');

    const failExtractor = async () => {
      throw new Error('解压出错');
    };

    const r = await installTool(
      ctx,
      { tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: localPkg, extractor: failExtractor },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain('解压出错');
    expect(ctx.cfg.tools).toHaveLength(0);
    // 解压失败发生在“配置环境变量”步骤之前：不应产生任何 env 变更（保护用户原有环境）
    expect(ctx.env.preview()).toEqual([]);
    const exists = await fsp
      .access(planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '17.0.9'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false); // 回滚清理
  });

  it('offline without explicit version resolves from filename', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst3-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (archive: string, dest: string) => {
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(dest, 'bin', 'java'), '');
    };
    const r = await installTool(ctx, { tool: 'jdk', mode: 'offline', localPath: localPkg, extractor: fakeExtractor });
    expect(r.ok).toBe(true);
    expect(ctx.cfg.tools[0].version).toBe('17.0.9');
    expect(ctx.cfg.tools[0].id).toBe('java/jdk/17.0.9');
  });

  it('offline falls back to majorVersion when filename has no version', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst4-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'my-jdk-package.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (archive: string, dest: string) => {
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(dest, 'bin', 'java'), '');
    };
    const r = await installTool(
      ctx,
      { tool: 'jdk', mode: 'offline', localPath: localPkg, majorVersion: '17', extractor: fakeExtractor },
    );
    expect(r.ok).toBe(true);
    expect(ctx.cfg.tools[0].version).toBe('17');
    expect(ctx.cfg.tools[0].id).toBe('java/jdk/17');
  });

  it('offline errors when version cannot be resolved', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst5-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'random.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const r = await installTool(ctx, { tool: 'jdk', mode: 'offline', localPath: localPkg });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无法识别版本');
  });

  it('honors per-call path override without persisting to config defaults', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst-ovr-'));
    const ctx = makeCtx(root);
    // 预设一组“已保存默认”，与本次覆盖不同，用于验证二者不互相污染
    ctx.cfg.downloadDir = path.join(root, 'saved', 'dl');
    ctx.cfg.installDir = path.join(root, 'saved', 'inst');
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (archive: string, dest: string) => {
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(dest, 'bin', 'java'), '');
    };
    const overrideIl = path.join(root, 'once', 'inst');
    const r = await installTool(ctx, {
      tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: localPkg,
      extractor: fakeExtractor,
      downloadDir: path.join(root, 'once', 'dl'),
      installDir: overrideIl,
    });
    expect(r.ok).toBe(true);
    // 工具实际落到本次覆盖的安装路径
    const expected = planInstallDir(planInstallBaseDir({ ...ctx.cfg, installDir: overrideIl }), 'java', 'jdk', '17.0.9');
    expect(ctx.cfg.tools[0].path).toBe(expected);
    // 覆盖值不应写回 config 的默认字段（保护“记住默认”与单次覆盖的边界）
    expect(ctx.cfg.downloadDir).toBe(path.join(root, 'saved', 'dl'));
    expect(ctx.cfg.installDir).toBe(path.join(root, 'saved', 'inst'));
  });

  it('non-active install does NOT overwrite the active version JAVA_HOME', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst-home-'));
    const cfg = defaultConfig(root);
    const env = new DryRunEnv('win32', '');
    const logger = new Logger(root);
    const ctx = { cfg, env, logger, platform: 'win32' as const };
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'java'), '');
    };
    const pkg = (v: string) => path.join(root, `jdk-${v}.zip`);
    await fsp.writeFile(pkg('17.0.9'), 'x');
    await fsp.writeFile(pkg('11.0.21'), 'x');

    // 1) 首次安装 17 → 默认激活，JAVA_HOME 指向 17
    const r1 = await installTool(ctx, { tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: pkg('17.0.9'), extractor: fakeExtractor });
    expect(r1.ok).toBe(true);
    const home17 = planInstallDir(planInstallBaseDir(cfg), 'java', 'jdk', '17.0.9');
    expect(env.preview()).toContainEqual({ kind: 'set', name: 'JAVA_HOME', value: home17 });

    // 2) 再安装 11 为非默认（makeActive:false）→ 不应改写 JAVA_HOME
    const r2 = await installTool(ctx, { tool: 'jdk', version: '11.0.21', mode: 'offline', localPath: pkg('11.0.21'), makeActive: false, extractor: fakeExtractor });
    expect(r2.ok).toBe(true);
    expect(ctx.cfg.tools.find((t) => t.version === '11.0.21')?.active).toBe(false);
    // 关键：JAVA_HOME 末值仍为 17（不会被 11 覆盖）；非激活版不写 PATH（仅记录到 devenv.yaml，激活时由 switch 上 PATH）
    const homeSets = env.preview().filter((o) => o.name === 'JAVA_HOME' && o.kind === 'set');
    expect(homeSets).toHaveLength(1);
    expect(homeSets[homeSets.length - 1].value).toBe(home17);
    expect(ctx.cfg.tools.find((t) => t.version === '11.0.21')?.path).toBe(
      planInstallDir(planInstallBaseDir(cfg), 'java', 'jdk', '11.0.21'),
    );
  });

  it('preserves PATH on failed active install (rollback restores snapshot, Bug#1)', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst-rb-'));
    const cfg = defaultConfig(root);
    // 模拟系统中已存在 %JAVA_HOME%\bin（首次安装后的常态 PATH）
    const env = new DryRunEnv('win32', '%JAVA_HOME%\\bin');
    const logger = new Logger(root);
    const ctx = { cfg, env, logger, platform: 'win32' as const };
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    // extract 创建 dest 但不创建 bin/java → 步骤 6 verify 失败（触发回滚）
    const extractNoBin = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
    };
    const r = await installTool(ctx, { tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: localPkg, extractor: extractNoBin });
    expect(r.ok).toBe(false);
    // 关键：回滚应整体还原 PATH 快照，保留 %JAVA_HOME%\bin，而非清空（旧逻辑会 removePath 把它删掉）
    expect(await env.get('PATH')).toBe('%JAVA_HOME%\\bin');
    // JAVA_HOME 也应被精确还原（此处初始未设置，回滚后应为 undefined）
    expect(await env.get('JAVA_HOME')).toBeUndefined();
  });

  it('installs redis (root-dir binaries, binSubdir="") with correct binPath and PATH ref', async () => {
    const root = await fsp.mkdtemp(path.join(ISLAND, 'inst-redis-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'redis-5.0.14.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    // Redis 的 exe 在解压根目录（无 bin 子目录）
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'redis-server.exe'), '');
      await fsp.writeFile(path.join(d, 'redis-cli.exe'), '');
    };
    const r = await installTool(ctx, { tool: 'redis', version: '5.0.14', mode: 'offline', localPath: localPkg, extractor: fakeExtractor });
    expect(r.ok).toBe(true);
    const destDir = planInstallDir(planInstallBaseDir(ctx.cfg), 'database', 'redis', '5.0.14');
    expect(r.installed!.path).toBe(destDir);
    // 关键：binSubdir='' → binPath 即安装根目录（不是 destDir/bin）
    expect(r.installed!.binPath).toBe(destDir);
    const ops = ctx.env.preview();
    expect(ops).toContainEqual({ kind: 'set', name: 'REDIS_HOME', value: destDir });
    // 关键：PATH 引用为 %REDIS_HOME%（不带 \bin），避免拼出无效路径 %REDIS_HOME%\bin
    expect(ops).toContainEqual({ kind: 'appendPath', name: 'PATH', value: '%REDIS_HOME%' });
    expect(ops).not.toContainEqual({ kind: 'appendPath', name: 'PATH', value: '%REDIS_HOME%\\bin' });
    // 验证解压根目录确实创建了 redis-server.exe
    const exists = await fsp.access(path.join(destDir, 'redis-server.exe')).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});
