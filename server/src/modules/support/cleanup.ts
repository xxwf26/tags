// 孤儿文件自动清理（无人值守）：扫 /uploads，删掉不被任何 searchResult/artwork/referenceImage 引用的图片。
// 触发：服务启动后 5 分钟跑一次，之后每 6 小时一次（main.ts 调 startCleanupSchedule）。
// 只清应用生成的命名（search-/discover-/artwork-/reference- 前缀），不动其他文件，防误删。
import { readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { db, schema } from '../../database/db.js';

const UPLOADS = join(process.cwd(), 'uploads');
const CLEAN_INTERVAL = 6 * 60 * 60 * 1000; // 6 小时
const START_DELAY = 5 * 60 * 1000; // 启动后 5 分钟
const PATTERNS = /^(search|discover|artwork|reference)-.+\.(jpg|jpeg|png|webp)$/i;

export async function cleanupOrphanUploads(): Promise<number> {
  let files: string[];
  try { files = await readdir(UPLOADS); } catch { return 0; }

  // 收集所有被引用的文件名（imageUrl / thumbUrl）
  const referenced = new Set<string>();
  const add = (url: string | null | undefined) => { if (url) referenced.add(basename(url)); };

  const srs = await db.select({ url: schema.searchResults.imageUrl }).from(schema.searchResults);
  for (const r of srs) add(r.url);
  const aws = await db.select({ url: schema.artworks.imageUrl, thumb: schema.artworks.thumbUrl }).from(schema.artworks);
  for (const a of aws) { add(a.url); add(a.thumb); }
  try {
    const refs = await db.select({ url: schema.referenceImages.imageUrl }).from(schema.referenceImages);
    for (const r of refs) add(r.url);
  } catch {}

  let deleted = 0;
  for (const f of files) {
    if (!PATTERNS.test(f)) continue;       // 只清应用生成的图
    if (referenced.has(f)) continue;        // 被引用则保留
    try { await unlink(join(UPLOADS, f)); deleted++; } catch {}
  }
  if (deleted) console.log(`[cleanup] 删除 ${deleted} 个无引用孤儿文件`);
  return deleted;
}

export function startCleanupSchedule() {
  setTimeout(() => { cleanupOrphanUploads().catch(e => console.error('[cleanup] 失败:', e.message)); }, START_DELAY);
  setInterval(() => { cleanupOrphanUploads().catch(e => console.error('[cleanup] 失败:', e.message)); }, CLEAN_INTERVAL);
}
