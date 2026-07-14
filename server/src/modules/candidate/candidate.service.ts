// 候选复核队列：采集小红书笔记 → 入队 → 转正入库（下载图 + 建作品 + AI 打标）
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, isNotNull } from 'drizzle-orm';
import { fetchNote, fetchProfileNotes, downloadImage, extractUrls } from '../crawl/xhs.js';
import { fetchWeiboImages, extractWeiboUid } from '../crawl/weibo.js';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { TaggingService } from '../tagging/tagging.service.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';

function deriveOrientation(w?: number | null, h?: number | null): '横' | '竖' | '方' {
  if (!w || !h) return '横';
  if (w > h * 1.1) return '横';
  if (h > w * 1.1) return '竖';
  return '方';
}
function extOf(type: string): string {
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  return 'jpg';
}

export class CandidateService {
  // 采集：小红书笔记 URL → SSR 抓取 → 入候选队列（status=pending）
  async createFromNote(input: string) {
    const note = await fetchNote(input);
    const sourceUrl = input;
    const [existing] = await db.select().from(schema.candidates).where(eq(schema.candidates.sourceUrl, sourceUrl));
    if (existing) return { ...existing, raw: existing.raw, dedup: true };
    const [r] = await db.insert(schema.candidates).values({
      sourcePlatform: 'xiaohongshu',
      sourceUrl,
      artistName: note.author || null,
      raw: { noteId: note.noteId, title: note.title, desc: note.desc, tags: note.tags, images: note.images },
      status: 'pending',
    });
    const [cand] = await db.select().from(schema.candidates).where(eq(schema.candidates.id, (r as any).insertId));
    return cand;
  }

  // 批量采集：文本里提取所有小红书链接，逐条 SSR 抓取入队
  async createFromInput(input: string) {
    const urls = extractUrls(input);
    if (!urls.length) return { total: 0, results: [] };
    const results: any[] = [];
    for (const url of urls) {
      try { results.push(await this.createFromNote(url)); }
      catch (e: any) { results.push({ sourceUrl: url, error: e.message }); }
    }
    return { total: urls.length, results };
  }

  // 米画师按画风批量采集：playwright 搜指定画风标签 → 每张作品入候选队列
  async createMihuashiBatch(tagName: string, limit = 30) {
    const arts = await searchMihuashi(tagName, limit);
    const results: any[] = [];
    for (const a of arts) {
      const sourceUrl = a.imageUrl;
      const [existing] = await db.select().from(schema.candidates).where(eq(schema.candidates.sourceUrl, sourceUrl));
      if (existing) { results.push({ id: existing.id, dedup: true }); continue; }
      const [r] = await db.insert(schema.candidates).values({
        sourcePlatform: 'mihuashi',
        sourceUrl,
        artistName: null,
        raw: { title: `米画师·${tagName}`, tags: [tagName], images: [{ url: a.imageUrl, width: a.width, height: a.height }] },
        status: 'pending',
      });
      results.push({ id: (r as any).insertId });
    }
    return { tag: tagName, total: arts.length, results };
  }

  async list(status = 'pending') {
    const rows = await db.select().from(schema.candidates).where(eq(schema.candidates.status, status as any));
    return rows.map(c => ({ ...c, raw: c.raw }));
  }

  // 转正入库：下载图 → 建作品 → AI 打标；可选指定已有画师或新建
  async promote(id: number, body: { artistId?: number; newArtist?: boolean }) {
    const [cand] = await db.select().from(schema.candidates).where(eq(schema.candidates.id, id));
    if (!cand) throw new Error('候选不存在');
    const raw = cand.raw as any;

    // 确定画师
    let artistId = body.artistId;
    if (!artistId && body.newArtist && cand.artistName) {
      const [ex] = await db.select().from(schema.artists).where(eq(schema.artists.name, cand.artistName));
      artistId = ex?.id;
      if (!artistId) {
        const [ar] = await db.insert(schema.artists).values({
          name: cand.artistName,
          bio: raw.title || null,
          links: { xiaohongshu: [cand.sourceUrl] },
        });
        artistId = (ar as any).insertId;
      }
    }
    if (!artistId) throw new Error('需指定画师或勾选新建');

    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const tagging = new TaggingService();
    const artworkIds: number[] = [];
    let skipped = 0;

    for (let i = 0; i < (raw.images?.length || 0); i++) {
      const im = raw.images[i];
      try {
        const { buf, type } = await downloadImage(im.url);
        // 近重复去重：与库内已有作品比 pHash，命中则跳过
        let imageHash: string | null = null;
        try { imageHash = await aHash(buf); } catch {}
        if (imageHash) {
          const all = await db.select({ id: schema.artworks.id, hash: schema.artworks.imageHash })
            .from(schema.artworks).where(isNotNull(schema.artworks.imageHash));
          if (all.find(a => a.hash && hamming(imageHash!, a.hash) <= DEDUP_THRESHOLD)) {
            skipped++; continue;
          }
        }
        const filename = `xhs-${raw.noteId || cand.id}-${i}.${extOf(type)}`;
        await writeFile(join(uploadsDir, filename), buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: raw.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          width: im.width || null,
          height: im.height || null,
          orientation: deriveOrientation(im.width, im.height),
          imageHash,
          sourcePlatform: 'xiaohongshu',
          sourceUrl: cand.sourceUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        // AI 打标（Gemini+豆包集成）
        try { await tagging.tagArtwork(aid); } catch {}
      } catch (e) { /* 单张失败跳过 */ }
    }

    await db.update(schema.candidates).set({ status: 'promoted', promotedArtistId: artistId }).where(eq(schema.candidates.id, id));
    return { candidateId: id, artistId, artworkIds, count: artworkIds.length, skipped };
  }

  async reject(id: number) {
    await db.update(schema.candidates).set({ status: 'rejected' }).where(eq(schema.candidates.id, id));
    return { candidateId: id, status: 'rejected' };
  }

  // 按画师小红书主页链接爬其作品封面图，下载→去重→建作品→AI打标。limit 每人最多入库张数。
  async crawlArtistWorks(artistId: number, limit = 8, doTag = false) {
    const [artist] = await db.select().from(schema.artists).where(eq(schema.artists.id, artistId));
    if (!artist) throw new Error('画师不存在');
    const links = (artist.links as any) || {};
    const profileUrl: string | undefined = (links.xiaohongshu || [])[0];
    if (!profileUrl) throw new Error('该画师无小红书主页链接');

    const profile = await fetchProfileNotes(profileUrl);
    if (!profile.items.length) throw new Error('主页未解析到作品');

    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const tagging = doTag ? new TaggingService() : null;

    // 库内已有 hash（去重）
    const existingHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];

    const artworkIds: number[] = [];
    let skipped = 0, failed = 0;
    for (const it of profile.items) {
      if (artworkIds.length >= limit) break;
      try {
        const { buf, type } = await downloadImage(it.url!);
        let imageHash: string | null = null;
        try { imageHash = await aHash(buf); } catch {}
        if (imageHash && existingHashes.find(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipped++; continue; }
        const filename = `xhs-${it.noteId || artistId}-${artworkIds.length}.${extOf(type)}`;
        await writeFile(join(uploadsDir, filename), buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: it.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          imageHash,
          sourcePlatform: 'xiaohongshu',
          sourceUrl: profileUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        if (imageHash) existingHashes.push(imageHash);
        if (tagging) { try { await tagging.tagArtwork(aid); } catch {} }
      } catch { failed++; }
    }
    return { artistId, nickname: profile.nickname, found: profile.items.length, imported: artworkIds.length, skipped, failed, artworkIds };
  }

  // 按画师微博主页爬配图（playwright），下载→去重→建作品→可选AI打标
  async crawlArtistWorksWeibo(artistId: number, limit = 8, doTag = false) {
    const [artist] = await db.select().from(schema.artists).where(eq(schema.artists.id, artistId));
    if (!artist) throw new Error('画师不存在');
    const links = (artist.links as any) || {};
    const weiboUrl: string | undefined = (links.weibo || [])[0];
    if (!weiboUrl) throw new Error('该画师无微博主页链接');
    const uid = extractWeiboUid(weiboUrl);
    if (!uid) throw new Error('微博链接无法解析 uid');

    const { nickname, items } = await fetchWeiboImages(uid, limit);
    if (!items.length) throw new Error('微博主页未解析到配图');

    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const tagging = doTag ? new TaggingService() : null;
    const existingHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];

    const artworkIds: number[] = [];
    let skipped = 0, failed = 0;
    for (const it of items) {
      if (artworkIds.length >= limit) break;
      try {
        const { buf, type } = await downloadImage(it.url);
        let imageHash: string | null = null;
        try { imageHash = await aHash(buf); } catch {}
        if (imageHash && existingHashes.find(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipped++; continue; }
        const filename = `wb-${it.noteId || artistId}-${artworkIds.length}.${extOf(type)}`;
        await writeFile(join(uploadsDir, filename), buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: it.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          imageHash,
          sourcePlatform: 'weibo',
          sourceUrl: weiboUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        if (imageHash) existingHashes.push(imageHash);
        if (tagging) { try { await tagging.tagArtwork(aid); } catch {} }
      } catch { failed++; }
    }
    return { artistId, nickname, found: items.length, imported: artworkIds.length, skipped, failed, artworkIds };
  }
}
