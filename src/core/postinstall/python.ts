import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallStep, StepContext, StepResult } from '../../types.js';
import { downloadFile } from '../downloader.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细安装日志，避免生产环境刷屏。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

/**
 * 关键步骤：启用 embeddable Python 的 site-packages。
 * Windows embeddable 版（python-{v}-embed-amd64.zip）解压后，python3XX._pth 文件里
 * `import site` 被注释为 `#import site`，导致标准库部分模块受限、且第三方包（含 pip）
 * 无法 import。本步骤取消该注释，使 <base>/Lib/site-packages 生效。
 * 非 embed 版（无 _pth 或已启用）则安全跳过。
 */
export const pythonSiteStep: InstallStep = {
  id: 'python:site',
  title: '启用 site-packages',
  description: '取消 embed 版 _pth 文件里的 #import site 注释，使标准库与第三方包可用',
  preview: (ctx) => ({
    files: [{ path: path.join(ctx.destDir, 'python3XX._pth'), note: '取消 #import site 注释，启用 site-packages' }],
    notes: ['仅 embeddable 版需要；非 embed 版自动跳过'],
  }),
  run: async (ctx: StepContext): Promise<StepResult> => {
    const dir = ctx.destDir;
    let pthFile: string | undefined;
    try {
      const entries = await fsp.readdir(dir);
      pthFile = entries.find((f) => /^python3\d*\._pth$/.test(f));
    } catch {
      return { ok: true, message: '无法读取安装目录，跳过 _pth 处理' };
    }
    if (!pthFile) {
      return { ok: true, message: '未找到 _pth 文件（非 embed 版或已处理），跳过' };
    }
    const p = path.join(dir, pthFile);
    const txt = await fsp.readFile(p, 'utf8');
    if (!txt.includes('#import site')) {
      return { ok: true, message: 'site 已启用，无需修改' };
    }
    const next = txt.replace(/#\s*import site/, 'import site');
    await fsp.writeFile(p, next, 'utf8');
    if (DEBUG) ctx.logger.info(`[python:site] 已取消 ${pthFile} 中的 #import site 注释`);
    return { ok: true, message: `已启用 site-packages（${pthFile}）` };
  },
};

const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

/**
 * 可选步骤：下载并运行 get-pip.py 安装 pip（需联网）。
 * embeddable 版不含 pip，装完后 `python -m pip` 不可用；本步骤补齐 pip。
 * 离线环境或下载/运行失败时仅记 warning，不阻断安装（Python 本体已可用）。
 */
export const pythonPipStep: InstallStep = {
  id: 'python:pip',
  title: '安装 pip 包管理器',
  description: '下载 get-pip.py 并运行，使 pip 可用（需联网）',
  optional: true,
  preview: () => ({ notes: ['下载 get-pip.py 并运行（需联网，可选）'] }),
  run: async (ctx: StepContext): Promise<StepResult> => {
    // 预览模式不联网：跳过 pip 安装，仅提示
    if (!ctx.applyEnv) {
      return { ok: true, message: '[dryRun] 跳过 pip 安装（预览模式不联网）' };
    }
    const pyBin = path.join(ctx.binPath, process.platform === 'win32' ? 'python.exe' : 'python');
    try {
      const getPip = path.join(ctx.destDir, 'get-pip.py');
      await downloadFile({ url: GET_PIP_URL, dest: getPip });
      const r = await ctx.run(pyBin, [getPip, '--no-warn-script-location']);
      if (r.code !== 0) {
        return { ok: false, warning: true, message: `pip 安装失败：${r.stderr || r.stdout || '无输出'}` };
      }
      return { ok: true, message: 'pip 已安装（python -m pip 可用）' };
    } catch (e: any) {
      return { ok: false, warning: true, message: `pip 安装跳过：${e?.message ?? e}` };
    }
  },
};
