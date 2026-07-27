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

// —— 快速去重原语 ——
// hamming() 每次比较都对两个 hex 串逐字符 parseInt，300 张 ×900+ 库 hash 全在主线程同步跑会阻塞事件循环。
// 预解析成 nibble 数组（每 hash 只解析一次），比较时查表 popcount，去掉重复 parseInt。
const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function hexToNibbles(h: string): number[] {
  const a = new Array<number>(h.length);
  for (let i = 0; i < h.length; i++) a[i] = parseInt(h[i], 16);
  return a;
}

export function hammingNib(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT4[a[i] ^ b[i]];
  return d;
}
