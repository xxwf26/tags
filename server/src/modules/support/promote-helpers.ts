// 入库共享辅助：发现/寻源两条链路共用，避免重复实现与行为漂移。
// - findDuplicateArtwork：入库前按感知哈希查库内近重复，防同一张图被反复入库。
// - findOrCreateArtist：按署名查/建画师，用 WHERE 精确查询（非全表扫）；靠唯一约束兜住并发重名。
// - promoteSearchResult：tier2 → promoted 的完整入库流程（下载→去重→建作品→建画师→记日志）。
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
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
// 应用层并发防护：artists.name 无唯一约束（允许合法重名画师），故 catch 兜不住并发重复。
// 用进程内 per-name 锁串行化"同名建画师"——同一画师的多张代表作并发 promote 时，
// 后来者 await 第一个的建库结果并复用，避免产生 N 个同名重复画师。
const artistCreateLocks = new Map<string, Promise<number | null>>();
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

  // 已有同名建库进行中 → 复用其结果，不再各自插入
  const inflight = artistCreateLocks.get(trimmed);
  if (inflight) return inflight;

  const links = platform ? { [platform]: sourceUrl ? [sourceUrl] : [] } : undefined;
  const task = (async (): Promise<number | null> => {
    // 拿到锁后再查一次（可能在等待期间别的请求已建好）
    const [again0] = await db.select({ id: schema.artists.id })
      .from(schema.artists).where(eq(schema.artists.name, trimmed)).limit(1);
    if (again0) return again0.id;
    try {
      const [ar] = await db.insert(schema.artists).values({ name: trimmed, links });
      return (ar as any).insertId;
    } catch (e) {
      const [again] = await db.select({ id: schema.artists.id })
        .from(schema.artists).where(eq(schema.artists.name, trimmed)).limit(1);
      if (again) return again.id;
      throw e;
    }
  })();
  artistCreateLocks.set(trimmed, task);
  try {
    return await task;
  } finally {
    artistCreateLocks.delete(trimmed);
  }
}

// 用寻源抽到的联系方式/档期/简介补全画师——只填空字段，不覆盖人工已编辑的数据。
// contact：现有 contact 为空才写；commission：现值 unknown/空才写；bio/engageNote：为空才写。
export async function enrichArtistContact(
  artistId: number,
  meta: { contact?: { wechat?: string; qq?: string; email?: string } | null; commission?: string | null; bio?: string | null; scheduleNote?: string | null },
): Promise<void> {
  const [a] = await db.select({
    contact: schema.artists.contact, commission: schema.artists.commission,
    bio: schema.artists.bio, engageNote: schema.artists.engageNote,
  }).from(schema.artists).where(eq(schema.artists.id, artistId)).limit(1);
  if (!a) return;
  const patch: any = {};
  const curContact = a.contact as Record<string, string> | null;
  if ((!curContact || !Object.keys(curContact).length) && meta.contact && Object.keys(meta.contact).length) patch.contact = meta.contact;
  if ((!a.commission || a.commission === 'unknown') && meta.commission && meta.commission !== 'unknown') patch.commission = meta.commission;
  if (!a.bio && meta.bio) patch.bio = meta.bio;
  if (!a.engageNote && meta.scheduleNote) patch.engageNote = meta.scheduleNote;
  if (Object.keys(patch).length) await db.update(schema.artists).set(patch).where(eq(schema.artists.id, artistId));
}

// tier2 → promoted：下载图 → 库内去重 → 建作品 → 建/找画师 → 标记结果 → 记日志。
// filePrefix 区分文件名前缀与默认 sourcePlatform；logType 区分审计日志类型。
export async function promoteSearchResult(
  result: { id: number; imageUrl: string | null; title: string | null; author: string | null; platform: string | null; sourceUrl: string | null; authorUrl?: string | null; aiTags?: any },
  opts: { filePrefix: string; logType: string },
): Promise<{ id: number; tier: 'promoted'; artworkId: number; artistId: number | null; duplicate?: boolean }> {
  if (!result.imageUrl) throw new Error('结果无图片URL');
  const uploadsDir = join(process.cwd(), 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  // 寻源/发现的结果 imageUrl 在采集时已下载为本地 /uploads/xxx（见 search/discover.service），
  // 此时不能再当远程 URL 下载（会 Invalid URL）——直接读本地文件；只有仍是外链时才下载。
  const isLocal = result.imageUrl.startsWith('/uploads/');
  let buf: Buffer, type: string;
  if (isLocal) {
    buf = await readFile(join(uploadsDir, basename(result.imageUrl)));
    const ext = result.imageUrl.split('.').pop()?.toLowerCase() || 'jpg';
    type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  } else {
    ({ buf, type } = await downloadImage(result.imageUrl));
  }
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

  // 画师建联链接优先用 authorUrl（画师主页），寻源结果的 sourceUrl 是图片直链，建联点回去无意义。
  const artistLink = result.authorUrl || result.sourceUrl;
  const artistId = await findOrCreateArtist(result.author, result.platform, artistLink);
  // 寻源抽到的联系方式/档期/简介补进画师（只填空字段）。aiTags[0] 存的是画师级信息。
  if (artistId) {
    const meta = (result.aiTags as any[])?.[0];
    if (meta && (meta.contact || meta.commission || meta.bio || meta.scheduleNote)) {
      await enrichArtistContact(artistId, { contact: meta.contact, commission: meta.commission, bio: meta.bio, scheduleNote: meta.scheduleNote });
    }
  }
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
