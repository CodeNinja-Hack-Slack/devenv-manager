// build/make-icon.mjs
// 零依赖生成 DevEnv Manager 应用图标 build/icon.ico
// 设计：aurora 渐变圆角方块（indigo -> cyan）+ 白色终端 ">" 符号 + 光标下划线
// 含 16/32/48/256 多尺寸，PNG-in-ICO（Windows Vista+ 原生支持）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 颜色工具 ----
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];
const TOP = [99, 102, 241];   // indigo #6366f1
const BOT = [34, 211, 238];   // cyan   #22d3ee

// 点到线段距离（用于画粗线）
function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x0 + t * dx, cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 渲染指定尺寸 N 的 RGBA 缓冲
function render(N) {
  const buf = new Uint8Array(N * N * 4); // 全透明
  const cx = N / 2, cy = N / 2;

  // 圆角半径（像素）
  const r = N * 0.22;
  // 终端符号线宽（像素）
  const lw = Math.max(1, N * 0.085);
  // 符号几何（归一化坐标，以中心为原点，范围约 [-0.5,0.5]）
  const k = N; // 缩放到像素
  const chev = [
    [-0.20 * N, -0.20 * N, 0.12 * N, 0.0],   // 左上 -> 右中
    [0.12 * N, 0.0, -0.20 * N, 0.20 * N],    // 右中 -> 左下
  ];
  const cursor = [-0.02 * N, 0.22 * N, 0.24 * N, 0.22 * N]; // 下划线

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // 圆角矩形遮罩（带 1px 抗锯齿）
      const dx = Math.max(0, Math.abs(x - cx + 0.5) - (N / 2 - r));
      const dy = Math.max(0, Math.abs(y - cy + 0.5) - (N / 2 - r));
      const d = Math.hypot(dx, dy);
      let mask = 1 - d; // 内部>1，边缘0~1，外部<0
      if (mask <= 0) continue;
      mask = Math.max(0, Math.min(1, mask));

      // 背景渐变（垂直）+ 顶部轻微提亮
      let t = y / N;
      let col = mix(TOP, BOT, t);
      if (y < N * 0.18) {
        const hl = 1 - y / (N * 0.18);
        col = mix(col, [255, 255, 255], hl * 0.18);
      }

      // 默认背景
      let R = col[0], G = col[1], B = col[2], A = 255 * mask;

      // 叠加白色终端符号（前景）
      let sym = 0;
      for (const [sx0, sy0, sx1, sy1] of chev) {
        const dd = distToSeg(x + 0.5, y + 0.5, sx0, sy0, sx1, sy1);
        sym = Math.max(sym, 1 - dd / (lw / 2));
      }
      {
        const dd = distToSeg(x + 0.5, y + 0.5, cursor[0], cursor[1], cursor[2], cursor[3]);
        sym = Math.max(sym, 1 - dd / (lw / 2));
      }
      sym = Math.max(0, Math.min(1, sym));
      if (sym > 0) {
        // 白字 + 轻微阴影对比（边缘略暗一点避免和亮背景糊在一起）
        const wA = sym * mask;
        R = Math.round(lerp(R, 255, wA));
        G = Math.round(lerp(G, 255, wA));
        B = Math.round(lerp(B, 255, wA));
        A = 255 * mask;
      }

      const i = (y * N + x) * 4;
      buf[i] = R; buf[i + 1] = G; buf[i + 2] = B; buf[i + 3] = Math.round(A);
    }
  }
  return buf;
}

// ---- PNG 编码（RGBA, 8bit, 无隔行）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(N, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // raw scanlines：每行前缀 filter byte 0
  const raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.subarray(y * N * 4, (y + 1) * N * 4).forEach((v, i) => {
      raw[y * (N * 4 + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO 封装（PNG-in-ICO）----
function encodeICO(pngs) {
  const sizes = pngs.map((p) => p.size);
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(count, 4);  // count

  let offset = 6 + count * 16;
  const entries = [];
  const dataBlocks = [];
  for (let i = 0; i < count; i++) {
    const png = pngs[i].buf;
    const s = sizes[i];
    const entry = Buffer.alloc(16);
    entry[0] = s >= 256 ? 0 : s;   // width (0 => 256)
    entry[1] = s >= 256 ? 0 : s;   // height
    entry[2] = 0;                  // colors (0)
    entry[3] = 0;                  // reserved
    entry.writeUInt16LE(1, 4);     // color planes
    entry.writeUInt16LE(32, 6);    // bit count
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    dataBlocks.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...dataBlocks]);
}

// ---- 主流程 ----
const sizes = [16, 32, 48, 256];
const pngs = sizes.map((N) => ({ size: N, buf: encodePNG(N, render(N)) }));
const ico = encodeICO(pngs);
mkdirSync(__dirname, { recursive: true });
const outPath = join(__dirname, 'icon.ico');
writeFileSync(outPath, ico);
console.log(`✅ icon written: ${outPath} (${(ico.length / 1024).toFixed(1)} KB, sizes=${sizes.join('/')})`);
