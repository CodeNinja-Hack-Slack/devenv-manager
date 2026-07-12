import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerIpc } from '../electron/ipc/handlers.js';
import { normPathForActive, expandEnv } from '../electron/ipc/handlers-helpers.js';
import { defaultConfig, saveConfig } from '../src/config/store.js';

// ----------------------------------------------------------------------------
// 纯函数辅助单测（expandEnv / normPathForActive）
// ----------------------------------------------------------------------------
describe('handlers-helpers', () => {
  it('expandEnv resolves single %VAR% reference', () => {
    expect(expandEnv('%JAVA_HOME%\\bin', { JAVA_HOME: 'C:\\Java' })).toBe('C:\\Java\\bin');
  });
  it('expandEnv resolves chained references up to 6 iterations', () => {
    const env: Record<string, string | undefined> = {
      JAVA_HOME: '%JAVA_HOME17%',
      JAVA_HOME17: 'C:\\Java17',
    };
    expect(expandEnv('%JAVA_HOME%', env)).toBe('C:\\Java17');
  });
  it('expandEnv leaves unknown references intact', () => {
    expect(expandEnv('%NOPE%', {})).toBe('%NOPE%');
  });
  it('normPathForActive normalizes separators, case and trailing slash', () => {
    expect(normPathForActive('C:\\Java\\JDK\\')).toBe('c:/java/jdk');
    expect(normPathForActive(undefined)).toBe('');
  });
});

// ----------------------------------------------------------------------------
// IPC 处理器集成测试：用 mock ipcMain/app/dialog 桥接，applyEnv=false → DryRun 安全
// 覆盖「配置读取 / 远程版本 / 纳管开关 / 卸载」等核心桥接逻辑（不触发真实系统写入）
// ----------------------------------------------------------------------------
describe('handlers (mock ipcMain)', () => {
  let tmp: string;
  let subRoot: string;
  let existingDir: string;
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hdl-'));
    subRoot = path.join(tmp, 'root');
    await fsp.mkdir(subRoot, { recursive: true });
    const cfg = defaultConfig(subRoot);
    cfg.applyEnv = false; // DryRun：env 不写系统
    await saveConfig(cfg);

    // handlers 据 app.getAppPath()/devenv-data/devenv-root.txt 定位配置根
    const runtimeHome = path.join(tmp, 'devenv-data');
    await fsp.mkdir(runtimeHome, { recursive: true });
    await fsp.writeFile(path.join(runtimeHome, 'devenv-root.txt'), subRoot, 'utf8');

    existingDir = path.join(tmp, 'existing-mysql');
    await fsp.mkdir(existingDir, { recursive: true });

    handlers = {};
    const ipcMain = { handle: (name: string, fn: any) => { handlers[name] = fn; } };
    const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
    const app = {
      getAppPath: () => tmp,
      // getPath('userData') 返回 tmp，使 runtimeHome 仍为 tmp/devenv-data（与测试准备一致）；
      // getPath('exe') 指向 tmp 下，使安装目录内的 devenv-data 与 userData 相同 → 迁移 no-op。
      getPath: (name: string) => (name === 'exe' ? path.join(tmp, 'DevEnv Manager.exe') : tmp),
    };
    registerIpc({ ipcMain, dialog, app });
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('config:init reports configured root', async () => {
    const r = await handlers['config:init']();
    expect(r.configured).toBe(true);
    expect(r.rootDir).toBe(subRoot);
  });

  it('config:get returns the saved config', async () => {
    const cfg = await handlers['config:get']();
    expect(cfg).toBeTruthy();
    expect(cfg.rootDir).toBe(subRoot);
    expect(cfg.tools).toEqual([]);
  });

  it('listRemote returns tool versions via bridge', async () => {
    expect(await handlers['listRemote'](null, 'mysql')).toEqual(['8.0.35', '8.0.39', '8.4.0']);
    expect(await handlers['listRemote'](null, 'maven')).toContain('3.9.9');
  });

  it('tool:add then tool:remove toggles adoption (external record)', async () => {
    const payload = {
      tool: 'mysql', name: 'MySQL', category: 'database', version: '8.0.39', path: existingDir, homeVar: 'MYSQL_HOME',
    };
    const add = await handlers['tool:add'](null, payload);
    expect(add.ok).toBe(true);
    expect(add.id).toBe('mysql@8.0.39@external');

    let cfg = await handlers['config:get']();
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.tools[0].mode).toBe('external');
    expect(cfg.tools[0].active).toBe(false);

    // 再次纳管同一条目应幂等更新而非重复
    await handlers['tool:add'](null, payload);
    cfg = await handlers['config:get']();
    expect(cfg.tools).toHaveLength(1);

    const rm = await handlers['tool:remove'](null, { id: 'mysql@8.0.39@external' });
    expect(rm.ok).toBe(true);
    cfg = await handlers['config:get']();
    expect(cfg.tools).toHaveLength(0);
  });

  it('tool:add rejects a non-existent path', async () => {
    const r = await handlers['tool:add'](null, {
      tool: 'mysql', name: 'MySQL', category: 'database', version: '8.0.39',
      path: path.join(tmp, 'does-not-exist'), homeVar: 'MYSQL_HOME',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('路径不存在');
  });

  it('tool:uninstall removes an externally-adopted tool without deleting files', async () => {
    await handlers['tool:add'](null, {
      tool: 'mysql', name: 'MySQL', category: 'database', version: '8.0.39', path: existingDir, homeVar: 'MYSQL_HOME',
    });
    const id = 'mysql@8.0.39@external';
    // 纳管记录仍存在
    expect((await handlers['config:get']()).tools).toHaveLength(1);
    const r = await handlers['tool:uninstall'](null, id, { deleteFiles: false });
    expect(r.ok, `uninstall failed: ${JSON.stringify(r.error ?? r)}`).toBe(true);
    expect((await handlers['config:get']()).tools).toHaveLength(0);
    // 文件未被删除（外部纳管工具默认不删文件）
    const stillThere = await fsp.access(existingDir).then(() => true).catch(() => false);
    expect(stillThere).toBe(true);
  });

  it('tool:remove errors when record not found', async () => {
    const r = await handlers['tool:remove'](null, { id: 'nope@1.0@external' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
  });
});
