// 入库共享辅助：发现/寻源两条链路的 promote 都用这套，避免重复实现与行为漂移。
// - findDuplicateArtwork：入库前按感知哈希查库内近重复，防同一张图被反复入库。
// - findOrCreateArtist：按署名查/建画师，用 WHERE 精确查询（非全表扫）；靠唯一约束兜住并发重名。
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';
import { hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';

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
// 用 WHERE name=? 命中索引（替代旧版全表拉取 + JS find）；promote 为人工点击、非高并发，
// 顺序查询已消除绝大多数重名竞态。极端并发下的兜底靠 catch 回查（若日后给 name 加唯一约束即可完全闭合）。
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
    // 并发插入撞唯一约束：回查取已存在的
    const [again] = await db.select({ id: schema.artists.id })
      .from(schema.artists).where(eq(schema.artists.name, trimmed)).limit(1);
    if (again) return again.id;
    throw e;
  }
}
