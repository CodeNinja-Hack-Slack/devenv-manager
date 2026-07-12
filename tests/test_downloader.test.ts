import { describe, it, expect } from 'vitest';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planChunks, downloadFile } from '../src/core/downloader.js';
import { sha256File } from '../src/utils/checksum.js';

describe('downloader planChunks', () => {
  it('splits total into threads covering full range', () => {
    const chunks = planChunks(100, 4);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(99);
    const sum = chunks.reduce((a, c) => a + (c.end - c.start + 1), 0);
    expect(sum).toBe(100);
  });
  it('handles remainder distribution', () => {
    const chunks = planChunks(10, 3); // 4,3,3
    expect(chunks.map((c) => c.end - c.start + 1)).toEqual([4, 3, 3]);
  });
  it('returns [] for invalid input', () => {
    expect(planChunks(0, 4)).toEqual([]);
    expect(planChunks(-1, 4)).toEqual([]);
  });
});

describe('downloader integration (local http server)', () => {
  it('downloads with checksum verification', async () => {
    const payload = Buffer.alloc(1024 * 64, 7); // 64KB
    const server = http.createServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)!;
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : payload.length - 1;
        res.writeHead(206, {
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${payload.length}`,
        });
        res.end(payload.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-length': payload.length });
        res.end(payload);
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const url = `http://127.0.0.1:${port}/file.bin`;

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(tmp, 'out.bin');
    const expectedSha = await sha256FileOfBuffer(payload);

    const result = await downloadFile({ url, dest, threads: 4, expectedSha256: expectedSha });
    expect(result.ok).toBe(true);

    const got = await fsp.readFile(dest);
    expect(got.equals(payload)).toBe(true);

    server.close();
  });
});

async function sha256FileOfBuffer(buf: Buffer): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(buf).digest('hex');
}
