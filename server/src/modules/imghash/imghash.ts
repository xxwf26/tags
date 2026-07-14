// 感知哈希（aHash：8x8 灰度均值 → 64bit）+ 海明距离，用于跨平台近重复去重 / 以图搜图
import sharp from 'sharp';

// 8x8 灰度 → 64bit → 16 位 hex
export async function aHash(buf: Buffer): Promise<string> {
  const data = await sharp(buf).resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  const px = Array.from(data);
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  let bits = '';
  for (const p of px) bits += p >= mean ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// 海明距离（两位 hex 字符串）
export function hamming(h1: string, h2: string): number {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    let x = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export const DEDUP_THRESHOLD = 5; // 海明距离 ≤5 视为近重复
