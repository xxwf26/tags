// 一次性回填：读 /uploads 真实图片尺寸 → 写 width/height/orientation（按横纵比）
// 跑法：cd server && npx tsx src/database/backfill-orientation.ts
import 'dotenv/config';
import sharp from 'sharp';
import { db, schema } from './db.js';
import { eq, isNull } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function orient(w?: number | null, h?: number | null): '横' | '竖' | '方' {
  if (!w || !h) return '横';
  if (w > h * 1.1) return '横';
  if (h > w * 1.1) return '竖';
  return '方';
}

const rows = await db.select().from(schema.artworks).where(isNull(schema.artworks.deletedAt));
let fixed = 0, skipped = 0, missing = 0, fail = 0;
for (const a of rows) {
  if (a.width && a.height) { skipped++; continue; }
  const rel = (a.imageUrl || '').replace(/^\/uploads\//, '');
  const p = join(process.cwd(), 'uploads', rel);
  if (!rel || !existsSync(p)) { missing++; continue; }
  try {
    const meta = await sharp(await readFile(p)).metadata();
    const w = meta.width, h = meta.height;
    if (!w || !h) { fail++; continue; }
    await db.update(schema.artworks).set({ width: w, height: h, orientation: orient(w, h) }).where(eq(schema.artworks.id, a.id));
    fixed++;
  } catch { fail++; }
}
console.log(`回填完成：修正 ${fixed}，已有维度跳过 ${skipped}，缺文件 ${missing}，失败 ${fail}`);
process.exit(0);
