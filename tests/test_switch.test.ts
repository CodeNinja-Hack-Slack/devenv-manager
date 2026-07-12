import { describe, it, expect } from 'vitest';
import { planMigrate, switchVersion, switchVersionRef, listVersions, versionEnvName } from '../src/core/switch.js';
import { defaultConfig } from '../src/config/store.js';
import { DryRunEnv } from '../src/platform/env.js';
import { planInstallDir, planBinRef, planBinPath } from '../src/utils/path.js';
import type { InstalledTool } from '../src/types.js';

function jdkTool(version: string, root: string, active = false): InstalledTool {
  const p = planInstallDir(root, 'java', 'jdk', version);
  return {
    id: `java/jdk/${version}`,
    category: 'java',
    tool: 'jdk',
    name: 'JDK',
    version,
    path: p,
    binPath: `${p}/bin`,
    homeVar: 'JAVA_HOME',
    mode: 'online',
    active,
    addedToPath: true,
    installedAt: new Date().toISOString(),
  };
}

// 根目录型工具：Redis 的 exe 在解压根目录（binSubdir=''），binPath 即根目录
function redisTool(version: string, root: string, active = false): InstalledTool {
  const p = planInstallDir(root, 'database', 'redis', version);
  return {
    id: `database/redis/${version}`,
    category: 'database',
    tool: 'redis',
    name: 'Redis',
    version,
    path: p,
    binPath: p,
    homeVar: 'REDIS_HOME',
    mode: 'online',
    active,
    addedToPath: true,
    installedAt: new Date().toISOString(),
  };
}

describe('switch & migrate', () => {
  it('planMigrate recomputes paths under newRoot', () => {
    const cfg = defaultConfig('E:\\a');
    cfg.tools = [jdkTool('17.0.9', 'E:\\a', true), jdkTool('8.0', 'E:\\a')];
    const plan = planMigrate(cfg, 'D:\\dev');
    expect(plan.items[0].to).toBe('D:\\dev\\data\\install\\java\\jdk17.0.9');
    expect(plan.items[1].to).toBe('D:\\dev\\data\\install\\java\\jdk8.0');
  });

  it('switchVersion (via switchVersionRef) sets active + JAVA_HOME to absolute + PATH uses fixed %JAVA_HOME%\\bin (Plan B, dryRun)', async () => {
    const root = 'E:\\a';
    const cfg = defaultConfig(root);
    cfg.tools = [jdkTool('17.0.9', root, true), jdkTool('8.0', root)];
    const env = new DryRunEnv('win32', 'E:\\a\\java\\jdk17.0.9\\bin');
    const r = await switchVersion(cfg, 'java', '8.0', env);
    expect(r.ok).toBe(true);
    const active = cfg.tools.find((t) => t.active);
    expect(active!.version).toBe('8.0');
    const ops = env.preview();
    // Plan B：激活变量直接写绝对路径，不再写版本固定变量（JAVA_HOME8 / JAVA_HOME17）
    expect(ops).toContainEqual({ kind: 'set', name: 'JAVA_HOME', value: planInstallDir(root, 'java', 'jdk', '8.0') });
    expect(ops).not.toContainEqual({ kind: 'set', name: 'JAVA_HOME8', value: expect.anything() });
    expect(ops).not.toContainEqual({ kind: 'set', name: 'JAVA_HOME17', value: expect.anything() });
    // PATH 收敛为固定引用 %JAVA_HOME%\bin（并清理旧版遗留引用）
    expect(ops).toContainEqual({ kind: 'appendPath', name: 'PATH', value: '%JAVA_HOME%\\bin' });
    expect(ops).toContainEqual({ kind: 'removePath', name: 'PATH', value: '%JAVA_HOME17%\\bin' });
  });

  it('switchVersionRef returns versionVars (from file inventory) and activeVar=absolute path', async () => {
    const root = 'E:\\a';
    const cfg = defaultConfig(root);
    cfg.tools = [jdkTool('17.0.9', root, true), jdkTool('8.0', root)];
    const env = new DryRunEnv('win32');
    const r = await switchVersionRef(cfg, 'java', '8.0', env);
    expect(r.ok).toBe(true);
    expect(r.versionVars).toHaveLength(2); // 版本清单来自 devenv.yaml（文件化 inventory）
    expect(r.versionVars.map((v) => v.varName)).toEqual(expect.arrayContaining(['JAVA_HOME17', 'JAVA_HOME8']));
    expect(r.activeVar).toEqual({ name: 'JAVA_HOME', value: planInstallDir(root, 'java', 'jdk', '8.0') });
  });

  it('versionEnvName uses major version only (no underscore separator)', () => {
    expect(versionEnvName('JAVA_HOME', '17.0.9')).toBe('JAVA_HOME17');
    expect(versionEnvName('MAVEN_HOME', '3.9.6')).toBe('MAVEN_HOME3');
    expect(versionEnvName('GIT_HOME', '2.45.2')).toBe('GIT_HOME2');
    expect(versionEnvName('NODE_HOME', '20.12.0')).toBe('NODE_HOME20');
  });

  it('listVersions filters by category', () => {
    const cfg = defaultConfig('E:\\a');
    cfg.tools = [jdkTool('17.0.9', 'E:\\a', true), jdkTool('8.0', 'E:\\a')];
    expect(listVersions(cfg, 'java')).toHaveLength(2);
  });

  it('cleans up legacy version fixed vars on switch (Plan B, Opt#1)', async () => {
    const root = 'E:\\a';
    const cfg = defaultConfig(root);
    cfg.tools = [jdkTool('17.0.9', root, true), jdkTool('8.0', root)];
    const env = new DryRunEnv('win32', '');
    // 预置遗留版本变量（迁移自旧版）
    await env.set('JAVA_HOME17', planInstallDir(root, 'java', 'jdk', '17.0.9'));
    await env.set('JAVA_HOME8', planInstallDir(root, 'java', 'jdk', '8.0'));
    const r = await switchVersionRef(cfg, 'java', '8.0', env);
    expect(r.ok).toBe(true);
    const ops = env.preview();
    // Plan B 不再写版本固定变量，切换时应顺手清除遗留的 JAVA_HOME17 / JAVA_HOME8
    expect(ops).toContainEqual({ kind: 'unset', name: 'JAVA_HOME17' });
    expect(ops).toContainEqual({ kind: 'unset', name: 'JAVA_HOME8' });
  });

  it('switchVersion for redis uses %REDIS_HOME% PATH ref (root-dir binaries, no \\bin)', async () => {
    const root = 'E:\\a';
    const cfg = defaultConfig(root);
    cfg.tools = [redisTool('5.0.14', root, true), redisTool('5.0.10', root)];
    const env = new DryRunEnv('win32', planInstallDir(root, 'database', 'redis', '5.0.14'));
    const r = await switchVersionRef(cfg, 'database', '5.0.10', env);
    expect(r.ok).toBe(true);
    const ops = env.preview();
    expect(ops).toContainEqual({ kind: 'set', name: 'REDIS_HOME', value: planInstallDir(root, 'database', 'redis', '5.0.10') });
    // 关键：Redis 的 PATH 引用应为 %REDIS_HOME%（不带 \bin），否则会拼出无效路径
    expect(ops).toContainEqual({ kind: 'appendPath', name: 'PATH', value: '%REDIS_HOME%' });
    expect(ops).not.toContainEqual({ kind: 'appendPath', name: 'PATH', value: '%REDIS_HOME%\\bin' });
  });
});

describe('path helpers (binSubdir-aware)', () => {
  it('planBinRef appends \\binSubdir, empty binSubdir => no suffix', () => {
    expect(planBinRef('JAVA_HOME', 'bin')).toBe('%JAVA_HOME%\\bin');
    expect(planBinRef('REDIS_HOME', '')).toBe('%REDIS_HOME%');
    expect(planBinRef('MYSQL_HOME', 'bin')).toBe('%MYSQL_HOME%\\bin');
  });

  it('planBinPath: empty binSubdir returns root dir (not root/bin)', () => {
    expect(planBinPath('/x')).toBe('/x/bin');       // 默认 bin
    expect(planBinPath('/x', 'bin')).toBe('/x/bin');
    expect(planBinPath('/x', '')).toBe('/x');        // Redis 根目录型
    expect(planBinPath('/x', 'libexec')).toBe('/x/libexec');
  });
});
