import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planBinPath } from '../src/utils/path.js';
import { installTool, planInstall } from '../src/core/installer.js';
import { buildBaseSteps, ensureRegistrySteps, nodeGlobalsStep } from '../src/core/steps.js';
import { verifyInstall } from '../src/core/extractor.js';
import { buildMavenSettingsXml, buildGradleInitScript } from '../src/core/postinstall/mirror.js';
import { getSpec, REGISTRY } from '../src/tools/registry.js';
import { defaultConfig } from '../src/config/store.js';
import { DryRunEnv } from '../src/platform/env.js';
import { Logger } from '../src/utils/logger.js';

function makeCtx(rootDir: string) {
  const cfg = defaultConfig(rootDir);
  const env = new DryRunEnv('win32', '');
  const logger = new Logger(rootDir);
  return { cfg, env, logger, platform: 'win32' as const, onProgress: undefined as ((p: any) => void) | undefined };
}

describe('step pipeline', () => {
  it('buildBaseSteps returns the 7 ordered base steps', () => {
    const steps = buildBaseSteps(getSpec('jdk')!);
    expect(steps.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig',
    ]);
  });

  it('ensureRegistrySteps attaches node globals + mysql extra steps', () => {
    ensureRegistrySteps();
    const node = getSpec('node')!;
    expect(node.steps?.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig', 'node:globals',
    ]);
    const mysql = getSpec('mysql')!;
    expect(mysql.steps?.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig',
      'mysql:myini', 'mysql:init', 'mysql:service',
    ]);
  });

  it('planInstall returns each step with editable params + change preview (plan-then-apply)', () => {
    ensureRegistrySteps();
    const plan = planInstall(makeCtx('/tmp/plan-test'), {
      tool: 'node', version: '20.11.1', mode: 'online',
    });
    // 步骤齐全
    expect(plan.steps.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig', 'node:globals',
    ]);
    // 必做步骤无可选标记，node:globals 为可选
    const globals = plan.steps.find((s) => s.id === 'node:globals')!;
    expect(globals.optional).toBe(true);
    // node:globals 暴露 nodeGlobal / nodeCache 两个可编辑参数
    expect(globals.params.map((p) => p.key)).toEqual(['nodeGlobal', 'nodeCache']);
    // 预览展示将要写入的 PATH 与创建的目录（不触碰系统）
    expect(JSON.stringify(globals.preview)).toContain('node_global');
    expect(JSON.stringify(globals.preview)).toContain('appendPath');
    // 写入 HOME 步骤应预览出 NODE_HOME 写入
    const envStep = plan.steps.find((s) => s.id === 'configure-env')!;
    expect(JSON.stringify(envStep.preview)).toContain('NODE_HOME');
  });

  it('planInstall honors user-edited targetDir and stepParams without mutating system', () => {
    ensureRegistrySteps();
    const plan = planInstall(makeCtx('/tmp/plan-test'), {
      tool: 'node', version: '20.11.1', mode: 'online',
      targetDir: 'C:/my-custom/node20',
      stepParams: { 'node:globals': { nodeCache: 'C:/my-custom/ncache' } },
    });
    expect(plan.destDir).toBe('C:/my-custom/node20');
    const globals = plan.steps.find((s) => s.id === 'node:globals')!;
    const nodeCache = globals.params.find((p) => p.key === 'nodeCache')!;
    expect(nodeCache.value).toBe('C:/my-custom/ncache');
  });

  it('planInstall: Redis serviceName edit is reflected in preview commands (plan-then-apply)', () => {
    ensureRegistrySteps();
    // 默认预览应使用默认服务名 Redis
    const def = planInstall(makeCtx('/tmp/plan-test'), { tool: 'redis', version: '5.0.14', mode: 'online' });
    const defSvc = def.steps.find((s) => s.id === 'redis:service')!;
    expect(JSON.stringify(defSvc.preview)).toContain('--service-name Redis');

    // 用户把服务名改成 MyRedis 后，预览命令应同步带 --service-name MyRedis
    const edited = planInstall(makeCtx('/tmp/plan-test'), {
      tool: 'redis', version: '5.0.14', mode: 'online',
      stepParams: { 'redis:service': { serviceName: 'MyRedis' } },
    });
    const editedSvc = edited.steps.find((s) => s.id === 'redis:service')!;
    expect(editedSvc.params.find((p) => p.key === 'serviceName')!.value).toBe('MyRedis');
    expect(JSON.stringify(editedSvc.preview)).toContain('--service-name MyRedis');
    expect(JSON.stringify(editedSvc.preview)).not.toContain('--service-name Redis');
  });

  it('guard: every declared step param is reflected in the step preview (plan-then-apply invariant)', () => {
    // 铁律：computeParams 声明的每个参数都必须在 preview 中真正使用，
    // 否则用户改参数后预览不变（违背 plan-then-apply 所见即所得）。
    // 遍历全部工具，对每个参数注入哨兵值，断言重算后的预览必须变化。
    ensureRegistrySteps();
    const tools = REGISTRY.filter((s) => !s.managedOnly && (s.remoteVersions?.length ?? 0) > 0).map((s) => s.tool);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const spec = REGISTRY.find((s) => s.tool === tool)!;
      const version = spec.remoteVersions[0];
      // useMirror:true 以覆盖 maven/gradle 的镜像步骤
      const withMirror = spec.mirrorStep != null;
      const base = planInstall(makeCtx('/tmp/guard'), { tool, version, mode: 'online', useMirror: withMirror });
      for (const step of base.steps) {
        if (!step.params || step.params.length === 0) continue;
        const basePreview = JSON.stringify(step.preview);
        for (const p of step.params) {
          const sentinel = `§GUARD§${tool}.${step.id}.${p.key}`;
          const overrideVal: any = p.type === 'checkbox' ? !(p.value as boolean) : `${String(p.value)}_${sentinel}`;
          const overridden = planInstall(makeCtx('/tmp/guard'), {
            tool, version, mode: 'online', useMirror: withMirror,
            stepParams: { [step.id]: { [p.key]: overrideVal } },
          });
          const ovStep = overridden.steps.find((s) => s.id === step.id)!;
          const ovPreview = JSON.stringify(ovStep.preview);
          expect(
            ovPreview,
            `tool=${tool} step=${step.id} param=${p.key}: 修改参数后预览未变化（参数未真正用于 preview）`,
          ).not.toBe(basePreview);
        }
      }
    }
  });

  it('emits ordered step progress events for jdk offline install', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-'));
    const ctx = makeCtx(root);
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const localPkg = path.join(root, 'jdk-17.0.9.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'java'), '');
    };
    const r = await installTool(ctx, {
      tool: 'jdk', version: '17.0.9', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    const stepEvents = events.filter((e) => e.phase === 'step');
    // 每个 base 步骤：一次 running + 一次 done（7 步 → 14 次事件）
    expect(stepEvents.length).toBe(14);
    // 顺序：先 running 后 done，且 stepIndex 递增
    expect(stepEvents[0].stepStatus).toBe('running');
    expect(stepEvents[0].stepIndex).toBe(0);
    expect(stepEvents[1].stepStatus).toBe('done');
    expect(stepEvents[1].stepIndex).toBe(0);
    expect(stepEvents[stepEvents.length - 2].stepStatus).toBe('running');
    expect(stepEvents[stepEvents.length - 1].stepStatus).toBe('done');
    expect(stepEvents[stepEvents.length - 1].stepIndex).toBe(6);
    // 最终 done 事件 percent=100
    expect(events.some((e) => e.phase === 'done' && e.percent === 100)).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('optional step failure does not block subsequent steps and yields warnings', async () => {
    // mysql 的 init/service 为 optional：真实执行 mysqld（缺失）失败应仅记警告，
    // 不阻断 myini（前）与 writeConfig（后）步骤，整体安装仍成功。
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-opt-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'mysql-8.0.39.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'mysql.exe'), '');
    };
    const r = await installTool(ctx, { tool: 'mysql', version: '8.0.39', mode: 'offline', localPath: localPkg, extractor: fakeExtractor });
    expect(r.ok).toBe(true); // 可选步骤失败不应导致整体失败
    expect(r.warnings && r.warnings.length).toBeGreaterThan(0); // 收集到警告
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('node install runs node:globals step and configures prefix/cache', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-node-'));
    const ctx = makeCtx(root);
    const localPkg = path.join(root, 'node-20.11.1.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'node.exe'), '');
      await fsp.writeFile(path.join(d, 'npm-cli.js'), '');
    };
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const r = await installTool(ctx, {
      tool: 'node', version: '20.11.1', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    // 进度事件中出现了 node:globals 步骤
    const globalsEvt = events.find((e) => e.stepId === 'node:globals');
    expect(globalsEvt).toBeDefined();
    await fsp.rm(root, { recursive: true, force: true });
  });

  // 回归锁定：node:globals 必须用真实 npm-cli.js 路径（node_modules/npm/bin/npm-cli.js）。
  // 旧实现硬编码 binPath/npm-cli.js，在 Node 官方 zip 结构下该文件不存在，真实安装会失败；
  // 旧测试在 fakeExtractor 把 npm-cli.js 放根目录，恰好掩盖了此 bug，故用真实结构新建本测试。
  it('node:globals resolves real npm-cli.js under node_modules/npm/bin', async () => {
    ensureRegistrySteps();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-node-npm-'));
    const spec = getSpec('node')!;
    const destDir = path.join(root, 'data', 'install', 'node', 'node20.11.1');
    // 模拟 Node 官方 zip 真实结构：node.exe 在根，npm-cli.js 在 node_modules/npm/bin/
    await fsp.mkdir(path.join(destDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    await fsp.writeFile(path.join(destDir, 'node.exe'), '');
    await fsp.writeFile(path.join(destDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    const binPath = planBinPath(destDir, spec.binSubdir);
    const runCalls: { cmd: string; args: string[] }[] = [];
    const stepCtx: any = {
      ...makeCtx(root),
      spec,
      destDir,
      binPath,
      version: '20.11.1',
      mode: 'online',
      applyEnv: true,
      params: {},
      state: {},
      run: async (cmd: string, args: string[]) => {
        runCalls.push({ cmd, args });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const r = await nodeGlobalsStep.run(stepCtx);
    expect(r.ok).toBe(true);
    // 第一次 run 必须是 node.exe 调用真实的 npm-cli.js 路径（而非根目录下的不存在路径）
    expect(runCalls.length).toBeGreaterThan(0);
    const first = runCalls[0];
    expect(first.cmd).toBe(path.join(destDir, 'node.exe'));
    expect(first.args[0]).toBe(path.join(destDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(first.args[0]).not.toBe(path.join(destDir, 'npm-cli.js'));
    await fsp.rm(root, { recursive: true, force: true });
  });

  // ============ 本轮新增：路径补全 + Docker 仅纳管 ============

  it('ensureRegistrySteps attaches python + go extra steps', () => {
    ensureRegistrySteps();
    const python = getSpec('python')!;
    expect(python.steps?.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig',
      'python:site', 'python:pip',
    ]);
    const go = getSpec('go')!;
    expect(go.steps?.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig',
      'go:gopath',
    ]);
  });

  it('python install enables site-packages via _pth (embed fix) and skips pip in dryRun', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-py-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false; // dryRun：避免 get-pip 联网
    const localPkg = path.join(root, 'python-3.12.4.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'python.exe'), '');
      await fsp.writeFile(path.join(d, 'python312._pth'), '#import site\n.');
    };
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const r = await installTool(ctx, {
      tool: 'python', version: '3.12.4', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    const destDir = r.installed!.path;
    const pth = await fsp.readFile(path.join(destDir, 'python312._pth'), 'utf8');
    expect(pth).toContain('import site');
    expect(pth).not.toContain('#import site'); // 注释已取消
    // pip 步骤在 dryRun 下安全跳过（不联网）：应有一条 stepStatus==='done' 的 python:pip 事件
    const pipDone = events.filter((e) => e.stepId === 'python:pip' && e.stepStatus === 'done');
    expect(pipDone.length).toBe(1);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('node install adds node_global to PATH preview', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-node2-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false;
    const localPkg = path.join(root, 'node-20.11.1.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'node.exe'), '');
      await fsp.writeFile(path.join(d, 'npm-cli.js'), '');
    };
    const r = await installTool(ctx, {
      tool: 'node', version: '20.11.1', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    const ops = ctx.env.preview();
    expect(ops.some((op: any) => op.kind === 'appendPath' && op.value.includes('node_global'))).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('go install adds GOPATH/bin to PATH preview', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-go-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false;
    const localPkg = path.join(root, 'go-1.22.5.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'go.exe'), '');
    };
    const r = await installTool(ctx, {
      tool: 'go', version: '1.22.5', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    const ops = ctx.env.preview();
    expect(ops.some((op: any) => op.kind === 'appendPath' && op.value.includes(path.join('go', 'bin')))).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('docker is managed-only and rejects install', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-docker-'));
    const ctx = makeCtx(root);
    const r = await installTool(ctx, { tool: 'docker', version: '27.0.3', mode: 'online' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('仅纳管');
    await fsp.rm(root, { recursive: true, force: true });
  });

  // ============ 本轮新增：Git binSubdir=cmd + Go %GOPATH%\\bin 引用式 PATH ============

  it('git uses %GIT_HOME%\\cmd in PATH (binSubdir cmd, avoids mingw bin pollution)', () => {
    ensureRegistrySteps();
    const spec = getSpec('git')!;
    // 优化点：git 官方推荐把 cmd（而非 bin）加进 PATH，bin 会引入大量 mingw 工具污染 PATH。
    expect(spec.binSubdir).toBe('cmd');
    const plan = planInstall(makeCtx('/tmp/plan-git'), { tool: 'git', version: spec.remoteVersions[0], mode: 'online' });
    const pathStep = plan.steps.find((s) => s.id === 'configure-path')!;
    // PATH 引用应跟随 binSubdir 变为 %GIT_HOME%\cmd（MinGit 的 cmd/git.exe 实际存在）
    const ref = (pathStep.preview.envOps?.[0] as any)?.value as string;
    expect(ref).toBe('%GIT_HOME%\\cmd');
    expect(ref).not.toContain('%GIT_HOME%\\bin');
  });

  it('go:gopath uses %GOPATH%\\bin reference when GOPATH at default location', () => {
    ensureRegistrySteps();
    const saved = process.env.GOPATH;
    try {
      // 模拟 GOPATH 设在默认位置
      process.env.GOPATH = path.join('C:', 'Users', 'test', 'go');
      const go = getSpec('go')!;
      const plan = planInstall(makeCtx('/tmp/plan-go-ref'), { tool: 'go', version: go.remoteVersions[0], mode: 'online' });
      const gopathStep = plan.steps.find((s) => s.id === 'go:gopath')!;
      // 默认位置：用 %GOPATH%\\bin 引用（与版本切换的引用式 PATH 风格一致），随 GOPATH 自动跟随
      const val = (gopathStep.preview.envOps?.[0] as any)?.value as string;
      expect(val).toBe('%GOPATH%\\bin');
    } finally {
      if (saved === undefined) delete process.env.GOPATH;
      else process.env.GOPATH = saved;
    }
  });

  it('go:gopath uses absolute path for custom GOPATH/bin (not the default)', () => {
    ensureRegistrySteps();
    const saved = process.env.GOPATH;
    try {
      process.env.GOPATH = path.join('C:', 'Users', 'test', 'go');
      const go = getSpec('go')!;
      const customBin = path.join('D:', 'custom', 'gobin');
      const plan = planInstall(makeCtx('/tmp/plan-go-custom'), {
        tool: 'go', version: go.remoteVersions[0], mode: 'online',
        stepParams: { 'go:gopath': { goPathBin: customBin } },
      });
      const gopathStep = plan.steps.find((s) => s.id === 'go:gopath')!;
      // 用户自定义了目录 → 用绝对路径（可靠且支持自定义位置），不套 %GOPATH% 引用
      const val = (gopathStep.preview.envOps?.[0] as any)?.value as string;
      expect(val).toBe(customBin);
      expect(val).not.toContain('%GOPATH%');
    } finally {
      if (saved === undefined) delete process.env.GOPATH;
      else process.env.GOPATH = saved;
    }
  });

  it('verifyInstall supports binSubdir (git cmd / root) and stays precise', async () => {
    // cmd/git.exe + binSubdir='cmd' → 通过；binSubdir='bin' → 失败（避免误判）
    const a = await fsp.mkdtemp(path.join(os.tmpdir(), 'vi-a-'));
    await fsp.mkdir(path.join(a, 'cmd'), { recursive: true });
    await fsp.writeFile(path.join(a, 'cmd', 'git.exe'), '');
    expect(await verifyInstall(a, ['git'], 'cmd')).toBe(true);
    expect(await verifyInstall(a, ['git'], 'bin')).toBe(false);

    // bin/git.exe + binSubdir='bin' → 通过；'cmd' → 失败
    const b = await fsp.mkdtemp(path.join(os.tmpdir(), 'vi-b-'));
    await fsp.mkdir(path.join(b, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(b, 'bin', 'git.exe'), '');
    expect(await verifyInstall(b, ['git'], 'bin')).toBe(true);
    expect(await verifyInstall(b, ['git'], 'cmd')).toBe(false);

    // 根目录型（binSubdir=''）：git.exe 直接放根目录
    const c = await fsp.mkdtemp(path.join(os.tmpdir(), 'vi-c-'));
    await fsp.writeFile(path.join(c, 'git.exe'), '');
    expect(await verifyInstall(c, ['git'], '')).toBe(true);

    await fsp.rm(a, { recursive: true, force: true });
    await fsp.rm(b, { recursive: true, force: true });
    await fsp.rm(c, { recursive: true, force: true });
  });

  // ============ 本轮新增：Redis 服务注册 + Maven/Gradle 国内镜像 ============

  it('ensureRegistrySteps attaches redis:service step (optional)', () => {
    ensureRegistrySteps();
    const redis = getSpec('redis')!;
    expect(redis.steps?.map((s) => s.id)).toEqual([
      'fetch', 'extract', 'configure-env', 'configure-path', 'verify-files', 'verify-env', 'writeConfig',
      'redis:service',
    ]);
    const svc = redis.steps!.find((s) => s.id === 'redis:service');
    expect(svc?.optional).toBe(true); // 服务注册失败（如缺管理员）不阻断安装
  });

  it('redis install emits redis:service step (dryRun: registered as optional, done)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-redis-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false; // dryRun：跳过真实服务注册
    const localPkg = path.join(root, 'Redis-x64-5.0.14.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    // tporadowski/redis 的 exe 在解压根目录（无 bin 子目录）
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'redis-server.exe'), '');
      await fsp.writeFile(path.join(d, 'redis.windows.conf'), '');
    };
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const r = await installTool(ctx, {
      tool: 'redis', version: '5.0.14', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    // 进度时间线中应出现「注册并启动 Windows 服务」步骤
    const svcEvents = events.filter((e) => e.stepId === 'redis:service');
    expect(svcEvents.length).toBeGreaterThan(0);
    expect(svcEvents.some((e) => e.stepStatus === 'done')).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('nginx install: root-layout binary + PATH ref %NGINX_HOME% (no special steps)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-nginx-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false; // dryRun：不碰系统
    const localPkg = path.join(root, 'nginx-1.26.3.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    // nginx.exe 在解压根目录（binSubdir=''，绿色解压即运行）
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, 'nginx.exe'), '');
    };
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const r = await installTool(ctx, {
      tool: 'nginx', version: '1.26.3', mode: 'offline', localPath: localPkg, extractor: fakeExtractor,
    });
    expect(r.ok).toBe(true);
    // 时间线应出现 configure-path 步骤，且 PATH 引用为根目录型 %NGINX_HOME%
    const pathEvents = events.filter((e) => e.stepId === 'configure-path');
    expect(pathEvents.length).toBeGreaterThan(0);
    const ops = ctx.env.preview();
    expect(ops.some((op: any) => op.kind === 'appendPath' && op.value === '%NGINX_HOME%')).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('maven/gradle mirror pure functions produce aliyun config', () => {
    const mavenXml = buildMavenSettingsXml();
    expect(mavenXml).toContain('https://maven.aliyun.com/repository/public');
    expect(mavenXml).toContain('<mirrorOf>*</mirrorOf>');
    const gradleScript = buildGradleInitScript();
    expect(gradleScript).toContain('maven.aliyun.com/repository/public');
    expect(gradleScript).toContain('allprojects');
  });

  it('maven install includes mirror step only when useMirror is true', async () => {
    // 用两个独立 root，避免两次安装落到同一 destDir 触发「目录已存在」冲突
    const rootOff = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-mvn-off-'));
    const ctxOff = makeCtx(rootOff);
    ctxOff.cfg.applyEnv = false;
    const pkgOff = path.join(rootOff, 'apache-maven-3.9.6-bin.zip');
    await fsp.writeFile(pkgOff, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'mvn.cmd'), '');
    };

    // 未勾选：管线不含 maven:mirror
    const eventsOff: any[] = [];
    ctxOff.onProgress = (p: any) => eventsOff.push(p);
    const rOff = await installTool(ctxOff, {
      tool: 'maven', version: '3.9.6', mode: 'offline', localPath: pkgOff, extractor: fakeExtractor,
    });
    expect(rOff.ok).toBe(true);
    expect(eventsOff.some((e) => e.stepId === 'maven:mirror')).toBe(false);

    // 勾选：管线追加 maven:mirror
    const rootOn = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-mvn-on-'));
    const ctxOn = makeCtx(rootOn);
    ctxOn.cfg.applyEnv = false;
    const pkgOn = path.join(rootOn, 'apache-maven-3.9.6-bin.zip');
    await fsp.writeFile(pkgOn, 'fakezip');
    const eventsOn: any[] = [];
    ctxOn.onProgress = (p: any) => eventsOn.push(p);
    const rOn = await installTool(ctxOn, {
      tool: 'maven', version: '3.9.6', mode: 'offline', localPath: pkgOn, extractor: fakeExtractor, useMirror: true,
    });
    expect(rOn.ok).toBe(true);
    const mirrorEvents = eventsOn.filter((e) => e.stepId === 'maven:mirror');
    expect(mirrorEvents.length).toBeGreaterThan(0);
    expect(mirrorEvents.some((e) => e.stepStatus === 'done')).toBe(true);
    await fsp.rm(rootOff, { recursive: true, force: true });
    await fsp.rm(rootOn, { recursive: true, force: true });
  });

  it('gradle install includes mirror step when useMirror is true', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipe-gradle-'));
    const ctx = makeCtx(root);
    ctx.cfg.applyEnv = false;
    const localPkg = path.join(root, 'gradle-8.7-bin.zip');
    await fsp.writeFile(localPkg, 'fakezip');
    const fakeExtractor = async (_a: string, d: string) => {
      await fsp.mkdir(path.join(d, 'bin'), { recursive: true });
      await fsp.writeFile(path.join(d, 'bin', 'gradle.bat'), '');
    };
    const events: any[] = [];
    ctx.onProgress = (p: any) => events.push(p);
    const r = await installTool(ctx, {
      tool: 'gradle', version: '8.7', mode: 'offline', localPath: localPkg, extractor: fakeExtractor, useMirror: true,
    });
    expect(r.ok).toBe(true);
    expect(events.some((e) => e.stepId === 'gradle:mirror')).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });
});
