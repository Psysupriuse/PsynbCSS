// ============================================================
// Psy剪贴板 — 图标生成脚本(零依赖)
// 用 Node 内置 zlib 手写 PNG/ICO 编码,绘制淡蓝色剪贴板图形
// 用法:node scripts/make-icon.js
// 产出:assets/tray.png(32×32 托盘)、assets/icon-256.png、assets/icon.ico(安装包)
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 行首滤波类型 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 像素绘制 ----------
function makeCanvas(size) { return Buffer.alloc(size * size * 4); }

// 填充圆角矩形(透明背景,只写矩形内部)
function fillRoundedRect(buf, size, x0, y0, x1, y1, r, color) {
  for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r - 1);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r - 1);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const i = (y * size + x) * 4;
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = color[3];
    }
  }
}

// 剪贴板图形:底板 + 顶部夹子 + 三条白色文字线(以 256 为设计基准等比缩放)
function drawClipboard(size) {
  const buf = makeCanvas(size);
  const s = size / 256;
  const R = (v) => Math.round(v * s);
  const BLUE = [0x5b, 0xa8, 0xe0, 255];
  const WHITE = [255, 255, 255, 255];
  fillRoundedRect(buf, size, R(52), R(84), R(204), R(220), R(24), BLUE); // 底板
  fillRoundedRect(buf, size, R(108), R(52), R(148), R(96), R(12), BLUE);  // 夹子
  fillRoundedRect(buf, size, R(72), R(122), R(184), R(138), R(8), WHITE); // 文字线 1
  fillRoundedRect(buf, size, R(72), R(152), R(184), R(168), R(8), WHITE); // 文字线 2
  fillRoundedRect(buf, size, R(72), R(182), R(152), R(198), R(8), WHITE); // 文字线 3
  return buf;
}

// ---------- ICO(内嵌 PNG,Windows Vista+ 支持) ----------
function makeICO(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型:图标
  header.writeUInt16LE(1, 4); // 图片数量
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);      // 宽 0 = 256
  entry.writeUInt8(0, 1);      // 高 0 = 256
  entry.writeUInt8(0, 2);      // 调色板
  entry.writeUInt8(0, 3);      // 保留
  entry.writeUInt16LE(1, 4);   // 颜色平面
  entry.writeUInt16LE(32, 6);  // 位深
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // 数据偏移
  return Buffer.concat([header, entry, pngBuf]);
}

// ---------- 输出 ----------
const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'tray.png'), encodePNG(32, 32, drawClipboard(32)));
fs.writeFileSync(path.join(assetsDir, 'icon-256.png'), encodePNG(256, 256, drawClipboard(256)));
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), makeICO(encodePNG(256, 256, drawClipboard(256))));
console.log('图标已生成: assets/tray.png, assets/icon-256.png, assets/icon.ico');
