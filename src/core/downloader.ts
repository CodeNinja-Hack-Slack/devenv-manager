import https from 'node:https';
import http, { type IncomingMessage } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { verifyChecksum } from '../utils/checksum.js';
import type { ChunkRange } from '../types.js';

// ============================================================================
// 在线下载器
// ----------------------------------------------------------------------------
// - 跟随 HTTP 3xx 重定向（mirror / dev.mysql.com / adoptium / github 均会跳转）
// - 用「纯 GET」解析最终 URL（dev.mysql.com/get 对 HEAD/带 Range 的 GET 返回 403）
// - 对最终 CDN 探测 Range 支持与大小，支持则多线程断点续传，否则单段顺序下载
// - 按 threads 切分并发下载各分片到 .part{i}
// - 支持 resume：读取 .progress.json 续传已完成分片
// - 合并后做 SHA256/MD5 完整性校验
// ============================================================================

export interface DownloadOptions {
  url: string;
  dest: string;
  threads?: number;
  /** 进度回调（0~100） */
  onProgress?: (percent: number, downloaded: number, total: number) => void;
  /** 是否允许续传（默认 true） */
  resume?: boolean;
  expectedSha256?: string;
  signal?: AbortSignal;
}

/** 纯函数：把总大小切成 threads 段（含端点的闭区间），可单测 */
export function planChunks(total: number, threads: number): ChunkRange[] {
  if (total <= 0 || threads <= 0) return [];
  const t = Math.min(threads, total);
  const base = Math.floor(total / t);
  const chunks: ChunkRange[] = [];
  let cursor = 0;
  for (let i = 0; i < t; i++) {
    // 余数分摊到前几段
    const size = base + (i < total % t ? 1 : 0);
    const start = cursor;
    const end = cursor + size - 1;
    chunks.push({ index: i, start, end, downloaded: 0 });
    cursor = end + 1;
  }
  return chunks;
}

export interface DownloadResult {
  dest: string;
  total: number;
  ok: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET（不带 Range）跟随重定向，返回最终 URL（最多 8 跳）。
 * 不使用 HEAD：dev.mysql.com/get 等重定向端点对 HEAD、以及对「带 Range 的 GET」
 * 直接返回 403，必须用纯 GET 才能拿到 302 跳转；跳转后的真实 CDN 才支持 Range。
 */
function resolveFinal(url: string, signal?: AbortSignal, max = 8): Promise<string> {
  return new Promise((resolve, reject) => {
    const attempt = (u: string, left: number) => {
      const lib = u.startsWith('https') ? https : http;
      const req = lib.request(
        u,
        { method: 'GET', signal, headers: { 'User-Agent': 'DevEnvManager' } },
        (res) => {
          res.resume();
          const loc = res.headers.location;
          if (REDIRECT_STATUSES.has(res.statusCode ?? 0) && loc && left > 0) {
            attempt(new URL(loc, u).toString(), left - 1);
          } else {
            resolve(u);
          }
        },
      );
      req.on('error', reject);
      req.end();
    };
    attempt(url, max);
  });
}

/**
 * 对最终 URL 探测是否支持 Range 断点续传，并返回文件总大小。
 * 发送 Range: bytes=0-0：
 *  - 206 + Content-Range(bytes 0-0/TOTAL) → 支持，total 取自 TOTAL
 *  - 200 + Content-Length → 不支持 Range，total 取自 Content-Length
 *  - 出错 → total=0，由调用方走单段顺序下载兜底
 */
function probeRange(
  url: string,
  signal?: AbortSignal,
): Promise<{ total: number; supportsRange: boolean }> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      url,
      { method: 'GET', signal, headers: { 'User-Agent': 'DevEnvManager', Range: 'bytes=0-0' } },
      (res) => {
        res.resume();
        const cr = res.headers['content-range'];
        if (res.statusCode === 206 && cr) {
          const m = /bytes \d+-\d+\/(\d+)/.exec(String(cr));
          if (m) {
            resolve({ total: parseInt(m[1], 10), supportsRange: true });
            return;
          }
        }
        const cl = parseInt(res.headers['content-length'] ?? '0', 10);
        resolve({ total: Number.isFinite(cl) && cl > 0 ? cl : 0, supportsRange: false });
      },
    );
    req.on('error', () => resolve({ total: 0, supportsRange: false }));
    req.end();
  });
}

/** GET 跟随重定向，返回最终响应流（调用方负责 pipe） */
function getFollowing(url: string, headers: Record<string, string>, signal?: AbortSignal, max = 8): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const attempt = (u: string, left: number) => {
      const lib = u.startsWith('https') ? https : http;
      const req = lib.request(u, { method: 'GET', headers, signal }, (res) => {
        const loc = res.headers.location;
        if (REDIRECT_STATUSES.has(res.statusCode ?? 0) && loc && left > 0) {
          res.resume();
          attempt(new URL(loc, u).toString(), left - 1);
        } else {
          resolve(res);
        }
      });
      req.on('error', reject);
      req.end();
    };
    attempt(url, max);
  });
}

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const threads = Math.max(1, opts.threads ?? 4);
  const resume = opts.resume ?? true;

  // 先解析最终 URL（纯 GET 跟随 3xx 重定向，避开 HEAD/带 Range 的 403 端点），
  // 再对最终 CDN 探测 Range 支持与文件大小
  const finalUrl = await resolveFinal(opts.url, opts.signal);
  const { total, supportsRange } = await probeRange(finalUrl, opts.signal);
  if (total <= 0 || !supportsRange) {
    // 不支持 Range 或大小未知：单段顺序下载（simpleDownload 内部走 GET 跟随重定向）
    await simpleDownload(finalUrl, opts.dest, opts.onProgress, opts.signal);
    if (opts.expectedSha256) {
      if (!(await verifyChecksum(opts.dest, opts.expectedSha256)))
        throw new Error('校验失败：SHA256 不匹配');
    }
    return { dest: opts.dest, total: -1, ok: true };
  }

  const chunks = planChunks(total, threads);
  const progressPath = `${opts.dest}.progress.json`;
  const done = resume ? await readProgress(progressPath) : {};
  const partPaths: string[] = [];

  let completedBytes = 0;
  for (const c of chunks) {
    const partPath = `${opts.dest}.part${c.index}`;
    partPaths.push(partPath);
    const already = done[c.index] ?? 0;
    c.downloaded = already;
    completedBytes += already;
  }

  const update = () => {
    opts.onProgress?.(Math.min(99, Math.floor((completedBytes / total) * 100)), completedBytes, total);
  };
  // 进度文件写盘节流：每个数据事件都整份 JSON 写盘会在大文件下载时产生成千上万次
  // 无谓的小写入（GB 级文件尤甚）。改为最多每 250ms 落盘一次，循环结束再补一次保证精确。
  let lastWrite = 0;
  const maybePersistProgress = () => {
    if (!resume) return;
    const now = Date.now();
    if (now - lastWrite >= 250) {
      lastWrite = now;
      void fsp.writeFile(progressPath, JSON.stringify(done)).catch(() => {});
    }
  };

  await Promise.all(
    chunks.map(async (c) => {
      const partPath = `${opts.dest}.part${c.index}`;
      const start = c.start + c.downloaded;
      if (start > c.end) return; // 该段已完成
      await downloadRange(finalUrl, start, c.end, partPath, (inc) => {
        c.downloaded += inc;
        completedBytes += inc;
        done[c.index] = c.downloaded;
        update();
        maybePersistProgress();
      }, opts.signal);
    }),
  );
  // 循环结束后确保最终进度落盘（保证断点续传计数精确）
  if (resume) await fsp.writeFile(progressPath, JSON.stringify(done)).catch(() => {});

  // 合并分片
  const fd = await fsp.open(opts.dest, 'w');
  try {
    for (const p of partPaths) {
      const data = await fsp.readFile(p);
      await fd.write(data);
    }
  } finally {
    await fd.close();
  }
  // 清理分片与进度
  await Promise.all(partPaths.map((p) => fsp.unlink(p).catch(() => {})));
  await fsp.unlink(progressPath).catch(() => {});

  if (opts.expectedSha256) {
    if (!(await verifyChecksum(opts.dest, opts.expectedSha256)))
      throw new Error('校验失败：SHA256 不匹配');
  }
  opts.onProgress?.(100, total, total);
  return { dest: opts.dest, total, ok: true };
}

async function downloadRange(
  url: string,
  start: number,
  end: number,
  partPath: string,
  onInc: (n: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return getFollowing(url, { Range: `bytes=${start}-${end}` }, signal).then(
    (res) =>
      new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(partPath, { flags: 'w' });
        res.on('data', (d: Buffer) => onInc(d.length));
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        res.on('error', reject);
      }),
  );
}

function simpleDownload(
  url: string,
  dest: string,
  onProgress?: (p: number, d: number, t: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return getFollowing(url, {}, signal).then(
    (res) =>
      new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let d = 0;
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        res.on('data', (c: Buffer) => {
          d += c.length;
          if (total) onProgress?.(Math.floor((d / total) * 100), d, total);
        });
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        res.on('error', reject);
      }),
  );
}

async function readProgress(p: string): Promise<Record<number, number>> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export { path };
