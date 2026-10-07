/**
 * Favicons as PNG, for the share cards: satori and resvg draw PNG, JPEG and SVG, but many projects' logos are .ico
 * files. An icon's largest image is used: an embedded PNG as it is, or a 24- or 32-bit bitmap re-encoded as PNG.
 */
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels (top row first) as a PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The icon's largest image as PNG, or null for an icon this can't read (palette bitmaps, damaged files). */
export function icoToPng(ico: Buffer): Buffer | null {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return null;
  const count = ico.readUInt16LE(4);
  let best: { size: number; offset: number; bytes: number } | null = null;
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    if (at + 16 > ico.length) return null;
    const size = ico[at] || 256;
    const bytes = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (offset + bytes > ico.length) continue;
    if (!best || size > best.size) best = { size, offset, bytes };
  }
  if (!best) return null;
  const img = ico.subarray(best.offset, best.offset + best.bytes);
  if (img.readUInt32BE(0) === 0x89504e47) return Buffer.from(img);
  // BITMAPINFOHEADER: the height counts the colour rows and the transparency mask's.
  if (img.length < 40 || img.readUInt32LE(0) < 40) return null;
  const w = img.readInt32LE(4);
  const h = img.readInt32LE(8) / 2;
  const bpp = img.readUInt16LE(14);
  if (w <= 0 || w > 256 || h <= 0 || h > 256 || (bpp !== 32 && bpp !== 24)) return null;
  const header = img.readUInt32LE(0);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const maskAt = header + stride * h;
  if (maskAt > img.length) return null;
  const rgba = Buffer.alloc(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    // Bitmaps are stored bottom row first.
    const row = header + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + (x * bpp) / 8;
      const o = (y * w + x) * 4;
      rgba[o] = img[p + 2]!;
      rgba[o + 1] = img[p + 1]!;
      rgba[o + 2] = img[p]!;
      rgba[o + 3] = bpp === 32 ? img[p + 3]! : 255;
      if (bpp === 32 && img[p + 3]) anyAlpha = true;
    }
  }
  // Without an alpha channel (or with an all-zero one), the 1-bit mask says what's transparent.
  if (!anyAlpha && maskAt + maskStride * h <= img.length)
    for (let y = 0; y < h; y++) {
      const row = maskAt + (h - 1 - y) * maskStride;
      for (let x = 0; x < w; x++) rgba[(y * w + x) * 4 + 3] = (img[row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
    }
  return encodePng(w, h, rgba);
}
