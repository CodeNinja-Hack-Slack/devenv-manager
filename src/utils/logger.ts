import { promises as fs } from 'node:fs';
import path from 'node:path';
import { planCacheDir } from './path.js';

type Level = 'info' | 'warn' | 'error';

/**
 * 轻量日志器：同时写控制台与 rootDir/config/logs/devenv-YYYYMMDD.log
 * 记录每次操作的模式（online/offline）由调用方在 message 中标注。
 */
export class Logger {
  private logFile: string;
  constructor(rootDir: string) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    this.logFile = path.join(planCacheDir(rootDir).replace(/cache$/, 'logs'), `devenv-${stamp}.log`);
  }

  private async append(level: Level, msg: string) {
    const t = new Date().toISOString();
    const line = `[${t}] [${level.toUpperCase()}] ${msg}`;
    // 控制台
    if (level === 'error') console.error(line);
    else console.log(line);
    // 文件（best-effort）
    try {
      await fs.mkdir(path.dirname(this.logFile), { recursive: true });
      await fs.appendFile(this.logFile, line + '\n', 'utf8');
    } catch {
      /* 忽略日志写入失败 */
    }
  }

  info(msg: string) {
    return this.append('info', msg);
  }
  warn(msg: string) {
    return this.append('warn', msg);
  }
  error(msg: string) {
    return this.append('error', msg);
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
