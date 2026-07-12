import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extract, parseTarGz, parseZip } from '../src/core/extractor.js';

// ---- 在内存构造夹具（不依赖任何 CLI）----
function makeTar(files: { name: string; data: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const header = Buffer.alloc(512, 0);
    nameBuf.copy(header, 0);
    // size octal, 11 位 + null
    const sizeOct = data.length.toString(8).padStart(11, '0');
    Buffer.from(sizeOct).copy(header, 124);
    header[156] = 0x30; // '0' 普通文件
    header[157] = 0; // 终止 null
    // ustar magic
    Buffer.from('ustar').copy(header, 257);
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(512, 0)); // 结束块
  return Buffer.concat(blocks);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat([...locals, ...centrals]);
  const localSize = locals.reduce((a, b) => a + b.length, 0);
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  return Buffer.concat([cd, eocd]);
}

describe('extractor (pure JS)', () => {
  it('parses + flattens tar.gz', async () => {
    const tar = makeTar([
      { name: 'jdk17.0.9/bin/java', data: '#java' },
      { name: 'jdk17.0.9/release', data: 'JAVA_VERSION=17' },
    ]);
    const gz = zlib.gzipSync(tar);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-'));
    const archive = path.join(tmp, 'jdk.tar.gz');
    await fsp.writeFile(archive, gz);

    const parsed = parseTarGz(gz);
    expect(parsed.find((f) => f.name === 'jdk17.0.9/bin/java')?.data.toString()).toBe('#java');

    const dest = path.join(tmp, 'out');
    await extract(archive, dest, { format: 'tar.gz' });
    expect(await fsp.access(path.join(dest, 'bin', 'java')).then(() => true).catch(() => false)).toBe(true);
    expect(await fsp.access(path.join(dest, 'release')).then(() => true).catch(() => false)).toBe(true);
  });

  it('parses + flattens zip (store)', async () => {
    const zip = makeZip([
      { name: 'node20.11.1/bin/node', data: '#node' },
      { name: 'node20.11.1/README', data: 'hi' },
    ]);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'extz-'));
    const archive = path.join(tmp, 'node.zip');
    await fsp.writeFile(archive, zip);

    const parsed = parseZip(zip);
    expect(parsed.find((f) => f.name === 'node20.11.1/bin/node')?.data.toString()).toBe('#node');

    const dest = path.join(tmp, 'out');
    await extract(archive, dest, { format: 'zip' });
    expect(await fsp.access(path.join(dest, 'bin', 'node')).then(() => true).catch(() => false)).toBe(true);
  });
});
