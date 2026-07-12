// ============================================================================
// DevEnv Manager — Electron 主进程
// 主进程直接调用引擎层(src/) 的系统能力（扫描/安装/环境/切换/迁移/健康/方案）。
// 渲染进程(React) 通过 preload 暴露的 window.devenv 调用这些 IPC。
// ============================================================================

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 将所有运行时状态（含 Electron 缓存 / localStorage / 日志）重定向到软件目录内，
// 避免在系统盘（C 盘）AppData 下创建任何文件或文件夹。
const APP_ROOT = path.resolve(__dirname, '..');
// 运行时状态集中到软件根下的 devenv-data/.runtime，避免分散且不在系统盘留任何文件
app.setPath('userData', path.join(APP_ROOT, 'devenv-data', '.runtime'));

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1200,
    minHeight: 700,
    title: 'DevEnv Manager',
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    win.loadURL(devServer);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist-ui', 'index.html'));
  }
  return win;
}

app.whenReady().then(async () => {
  registerIpc({ ipcMain, dialog, app });
  createWindow();

  // 启动诊断：在 Electron 主进程环境中直接执行一次扫描，验证 where/扫描引擎是否工作
  try {
    const { scanSystem } = await import('../src/core/scanner.js');
    console.log('[BOOT] Running startup scan test...');
    const t0 = Date.now();
    const bootResults = await scanSystem();
    const dt = Date.now() - t0;
    console.log(`[BOOT] Startup scan found ${bootResults.length} tools in ${dt}ms:`);
    for (const r of bootResults) {
      console.log(`[BOOT]   - ${r.tool}/${r.name} v${r.version} @ ${r.path}`);
    }
    // 验证 where 命令本身
    const { execFile } = await import('node:child_process');
    const p = require('node:util').promisify(execFile);
    try {
      const { stdout } = await p('where', ['java'], { windowsHide: true });
      console.log(`[BOOT] where(java) in Electron = ${stdout.trim().split(/\r?\n/)[0]}`);
    } catch (e) {
      console.error('[BOOT] where(java) FAILED:', e.code, e.message?.slice(0, 100));
    }
  } catch (e) {
    console.error('[BOOT] Startup scan threw:', e?.message ?? e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
