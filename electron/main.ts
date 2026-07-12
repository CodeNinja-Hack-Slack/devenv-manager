// ============================================================================
// DevEnv Manager — Electron 主进程
// 主进程直接调用引擎层(src/) 的系统能力（扫描/安装/环境/切换/迁移/健康/方案）。
// 渲染进程(React) 通过 preload 暴露的 window.devenv 调用这些 IPC。
// ============================================================================

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 诊断日志开关：仅 DEVENV_DEBUG=1 时输出启动扫描详情，避免生产环境拖慢启动。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1200,
    minHeight: 700,
    title: 'DevEnv Manager',
    backgroundColor: '#0b0e14',
    // 先隐藏窗口，等首帧渲染完成再显示，彻底消除启动黑屏；
    // backgroundColor 与暗色主题一致，过渡无闪烁。
    show: false,
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

  // 首帧渲染完成后才显示窗口，避免黑屏（渲染完成前不显示）。
  win.once('ready-to-show', () => win.show());
  return win;
}

app.whenReady().then(async () => {
  // 注册 IPC 前先完成运行时数据目录迁移（best-effort）
  await registerIpc({ ipcMain, dialog, app });
  createWindow();

  // 启动诊断（仅 DEVENV_DEBUG=1 时执行，避免生产环境扫描拖慢启动）
  if (DEBUG) {
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
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
