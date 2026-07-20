// 入库共享辅助：发现/寻源两条链路共用，避免重复实现与行为漂移。
// - findDuplicateArtwork：入库前按感知哈希查库内近重复，防同一张图被反复入库。
// - findOrCreateArtist：按署名查/建画师，用 WHERE 精确查询（非全表扫）；靠唯一约束兜住并发重名。
// - promoteSearchResult：tier2 → promoted 的完整入库流程（下载→去重→建作品→建画师→记日志）。
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';
import { downloadImage } from '../crawl/xhs.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';

// 库内近重复作品：返回命中的 artworkId，无则 null。hash 为空时不查（判不了）。
export async function findDuplicateArtwork(hash: string | null): Promise<number | null> {
  if (!hash) return null;
  const rows = await db.select({ id: schema.artworks.id, hash: schema.artworks.imageHash }).from(schema.artworks);
  for (const r of rows) {
    if (r.hash && hamming(hash, r.hash) <= DEDUP_THRESHOLD) return r.id;
  }
  return null;
}

// 按署名找画师，找不到就建。links 仅在新建时写入。
export async function findOrCreateArtist(
  name: string | null,
  platform?: string | null,
  sourceUrl?: string | null,
): Promise<number | null> {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const [existing] = await db.select({ id: schema.artists.id })
    .from(schema.artists).where(eq(schema.artists.name, trimmed)).limit(1);
  if (existing) return existing.id;

  const links = platform ? { [platform]: sourceUrl ? [sourceUrl] : [] } : undefined;
  try {
    const [ar] = await db.insert(schema.artists).values({ name: trimmed, links });
    return (ar as any).insertId;
  } catch (e) {
    const [again] = await db.select({ id: schema.artists.id })
      .from(schema.artists).where(eq(schema.artists.name, trimmed)).limit(1);
    if (again) return again.id;
    throw e;
  }
}

// tier2 → promoted：下载图 → 库内去重 → 建作品 → 建/找画师 → 标记结果 → 记日志。
// filePrefix 区分文件名前缀与默认 sourcePlatform；logType 区分审计日志类型。
export async function promoteSearchResult(
  result: { id: number; imageUrl: string | null; title: string | null; author: string | null; platform: string | null; sourceUrl: string | null },
  opts: { filePrefix: string; logType: string },
): Promise<{ id: number; tier: 'promoted'; artworkId: number; artistId: number | null; duplicate?: boolean }> {
  if (!result.imageUrl) throw new Error('结果无图片URL');
  const uploadsDir = join(process.cwd(), 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  const { buf, type } = await downloadImage(result.imageUrl);
  let imageHash: string | null = null;
  try { imageHash = await aHash(buf); } catch {}

  // 库内去重：这张图已在作品库则不重复入库，直接指向已有作品
  const dupId = await findDuplicateArtwork(imageHash);
  if (dupId) {
    await db.update(schema.searchResults).set({ tier: 'promoted', promotedArtworkId: dupId }).where(eq(schema.searchResults.id, result.id));
    return { id: result.id, tier: 'promoted', artworkId: dupId, artistId: null, duplicate: true };
  }

  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const filename = `${opts.filePrefix}-${result.id}-${Date.now()}.${ext}`;
  await writeFile(join(uploadsDir, filename), buf);

  const artistId = await findOrCreateArtist(result.author, result.platform, result.sourceUrl);
  const [aw] = await db.insert(schema.artworks).values({
    artistId,
    title: result.title || null,
    imageUrl: `/uploads/${filename}`,
    thumbUrl: `/uploads/${filename}`,
    imageHash,
    sourcePlatform: result.platform || opts.filePrefix,
    sourceUrl: result.sourceUrl || null,
    tagStatus: 'pending',
  });
  const artworkId = (aw as any).insertId;

  await db.update(schema.searchResults).set({ tier: 'promoted', promotedArtworkId: artworkId }).where(eq(schema.searchResults.id, result.id));
  await logOperation({ type: opts.logType, targetType: 'search_result', targetId: result.id, summary: `结果 #${result.id} 正式入库 → 作品 #${artworkId}` });
  return { id: result.id, tier: 'promoted', artworkId, artistId };
}
