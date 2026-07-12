import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/** 计算文件 SHA-256（返回 hex 小写） */
export async function sha256File(filePath: string): Promise<string> {
  return hashFile(filePath, 'sha256');
}

/** 计算文件 MD5（返回 hex 小写） */
export async function md5File(filePath: string): Promise<string> {
  return hashFile(filePath, 'md5');
}

async function hashFile(filePath: string, algo: 'sha256' | 'md5'): Promise<string> {
  const h = createHash(algo);
  const stream = (await import('node:fs')).createReadStream(filePath);
  for await (const chunk of stream) {
    h.update(chunk as Buffer);
  }
  return h.digest('hex');
}

/**
 * 校验文件完整性。
 * expected 可为 sha256 或 md5（根据长度自动判断：64=sha256，32=md5）。
 * expected 为空时跳过校验返回 true。
 */
export async function verifyChecksum(filePath: string, expected?: string): Promise<boolean> {
  if (!expected) return true;
  const e = expected.trim().toLowerCase();
  const actual = e.length === 64 ? await sha256File(filePath) : await md5File(filePath);
  return actual === e;
}
