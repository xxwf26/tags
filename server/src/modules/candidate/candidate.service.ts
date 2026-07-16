// 候选复核队列：采集小红书笔记 → 入队 → 转正入库（下载图 + 建作品 + AI 打标）
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { db, schema } from '../../database/db.js';
import { eq, isNotNull } from 'drizzle-orm';
import { fetchNote, fetchProfileNotes, downloadImage, extractUrls } from '../crawl/xhs.js';
import { searchMihuashi, fetchMihuashiArtistWorks, extractMihuashiProfileId } from '../crawl/mihuashi.js';
import { fetchWeiboImages, extractWeiboUid } from '../crawl/weibo.js';
import { TaggingService } from '../tagging/tagging.service.js';
import { gateArtwork } from '../tagging/ai.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';

function deriveOrientation(w?: number | null, h?: number | null): '横' | '竖' | '方' {
  if (!w || !h) return '横';
  if (w > h * 1.1) return '横';
  if (h > w * 1.1) return '竖';
  return '方';
}
// 从图片 buffer 读真实宽高 → 定朝向（封面图常不带尺寸，必须读图）
async function dimsOf(buf: Buffer): Promise<{ width: number | null; height: number | null; orientation: '横' | '竖' | '方' }> {
  try {
    const m = await sharp(buf).metadata();
    return { width: m.width ?? null, height: m.height ?? null, orientation: deriveOrientation(m.width, m.height) };
  } catch {
    return { width: null, height: null, orientation: '横' };
  }
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
        const dims = await dimsOf(buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: raw.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          width: dims.width,
          height: dims.height,
          orientation: dims.orientation,
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
    await logOperation({ type: 'promote', targetType: 'candidate', targetId: id, summary: `转正候选 #${id}（${artworkIds.length} 张作品）` });
    return { candidateId: id, artistId, artworkIds, count: artworkIds.length, skipped };
  }

  async reject(id: number) {
    await db.update(schema.candidates).set({ status: 'rejected' }).where(eq(schema.candidates.id, id));
    return { candidateId: id, status: 'rejected' };
  }

  // 按画师小红书主页链接爬其作品封面图，下载→去重→AI质检闸门(过滤广告/文字海报+质量分)→择优→建作品→可选AI打标。
  // limit=每人最终入库张数；pool=候选池大小(先扒 pool 篇再择优取 limit)；minQuality=质量分下限。
  async crawlArtistWorks(artistId: number, limit = 5, doTag = false, pool = 20, minQuality = 5) {
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
    const existingHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];

    // 阶段一：下载候选池(最多 pool 篇)，去重 + AI 闸门判定作品/广告并打质量分
    type Cand = { it: any; buf: Buffer; type: string; imageHash: string | null; quality: number; category: string };
    const cands: Cand[] = [];
    let skipped = 0, failed = 0, rejected = 0;
    for (const it of profile.items) {
      if (cands.length >= pool) break;
      try {
        const { buf, type } = await downloadImage(it.url!);
        let imageHash: string | null = null;
        try { imageHash = await aHash(buf); } catch {}
        if (imageHash && existingHashes.find(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipped++; continue; }
        const gate = await gateArtwork(buf.toString('base64'), type);
        if (!gate.isArtwork || gate.quality < minQuality) { rejected++; continue; }
        cands.push({ it, buf, type, imageHash, quality: gate.quality, category: gate.category });
        if (imageHash) existingHashes.push(imageHash); // 池内去重
      } catch { failed++; }
    }

    // 阶段二：按质量分降序，取前 limit 张入库
    cands.sort((a, b) => b.quality - a.quality);
    const chosen = cands.slice(0, limit);
    const artworkIds: number[] = [];
    for (const c of chosen) {
      try {
        // 文件名带 noteId + 时间戳，避免同画师多次爬/noteId 缺失时覆盖旧文件
        const uniq = `${c.it.noteId || 'n'}-${Date.now()}-${artworkIds.length}`;
        const filename = `xhs-${artistId}-${uniq}.${extOf(c.type)}`;
        await writeFile(join(uploadsDir, filename), c.buf);
        const dims = await dimsOf(c.buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: c.it.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          width: dims.width,
          height: dims.height,
          orientation: dims.orientation,
          imageHash: c.imageHash,
          sourcePlatform: 'xiaohongshu',
          sourceUrl: profileUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        if (tagging) { try { await tagging.tagArtwork(aid); } catch {} }
      } catch { failed++; }
    }
    await logOperation({ type: 'crawl_import', targetType: 'artwork', targetId: artistId, summary: `主页爬取「${profile.nickname}」导入 ${artworkIds.length} 张` });
    return { artistId, nickname: profile.nickname, found: profile.items.length, pooled: cands.length, imported: artworkIds.length, skipped, rejected, failed, artworkIds };
  }

  // 按画师微博主页爬配图（playwright），下载→去重→AI质检闸门(过滤广告/文字海报+质量分)→择优→建作品→可选AI打标。
  // limit=最终入库张数；pool=候选池大小(先扒 pool 张再择优)；minQuality=质量分下限。
  async crawlArtistWorksWeibo(artistId: number, limit = 8, doTag = false, pool = 30, minQuality = 5) {
    const [artist] = await db.select().from(schema.artists).where(eq(schema.artists.id, artistId));
    if (!artist) throw new Error('画师不存在');
    const links = (artist.links as any) || {};
    const weiboUrl: string | undefined = (links.weibo || [])[0];
    if (!weiboUrl) throw new Error('该画师无微博主页链接');
    const uid = extractWeiboUid(weiboUrl);
    if (!uid) throw new Error('微博链接无法解析 uid');

    const { nickname, items } = await fetchWeiboImages(uid, pool);
    if (!items.length) throw new Error('微博主页未解析到配图');

    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const tagging = doTag ? new TaggingService() : null;
    const existingHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];

    // 阶段一：下载候选池，去重 + AI 闸门判定作品/广告并打质量分
    type Cand = { it: any; buf: Buffer; type: string; imageHash: string | null; quality: number; category: string };
    const cands: Cand[] = [];
    let skipped = 0, failed = 0, rejected = 0;
    for (const it of items) {
      if (cands.length >= pool) break;
      try {
        const { buf, type } = await downloadImage(it.url);
        let imageHash: string | null = null;
        try { imageHash = await aHash(buf); } catch {}
        if (imageHash && existingHashes.find(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipped++; continue; }
        const gate = await gateArtwork(buf.toString('base64'), type);
        if (!gate.isArtwork || gate.quality < minQuality) { rejected++; continue; }
        cands.push({ it, buf, type, imageHash, quality: gate.quality, category: gate.category });
        if (imageHash) existingHashes.push(imageHash); // 池内去重
      } catch { failed++; }
    }

    // 阶段二：按质量分降序，取前 limit 张入库
    cands.sort((a, b) => b.quality - a.quality);
    const chosen = cands.slice(0, limit);
    const artworkIds: number[] = [];
    for (const c of chosen) {
      try {
        const uniq = `${c.it.noteId || 'n'}-${Date.now()}-${artworkIds.length}`;
        const filename = `wb-${artistId}-${uniq}.${extOf(c.type)}`;
        await writeFile(join(uploadsDir, filename), c.buf);
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: c.it.title || null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          imageHash: c.imageHash,
          sourcePlatform: 'weibo',
          sourceUrl: weiboUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        if (tagging) { try { await tagging.tagArtwork(aid); } catch {} }
      } catch { failed++; }
    }
    return { artistId, nickname, found: items.length, pooled: cands.length, imported: artworkIds.length, skipped, rejected, failed, artworkIds };
  }

  // 按画师米画师主页链接爬其作品（需登录态 mhs-auth.json）。米画师是画师上传的成品高清原图，
  // 几乎无广告，故【不跑AI闸门只去重】；原图动辄十几MB/上万像素，下载后【压缩到长边≤1600px】再存。
  // limit=最终入库张数；pool=候选池；authPath=登录态文件。
  async crawlArtistWorksMihuashi(artistId: number, limit = 8, doTag = false, pool = 30, authPath = join(process.cwd(), 'mhs-auth.json')) {
    const [artist] = await db.select().from(schema.artists).where(eq(schema.artists.id, artistId));
    if (!artist) throw new Error('画师不存在');
    const links = (artist.links as any) || {};
    const mhsUrl: string | undefined = (links.mihuashi || [])[0];
    if (!mhsUrl) throw new Error('该画师无米画师主页链接');
    const profileId = extractMihuashiProfileId(mhsUrl);
    if (!profileId) throw new Error('米画师链接无法解析 profileId');

    const items = await fetchMihuashiArtistWorks(profileId, authPath, pool);
    if (!items.length) throw new Error('米画师主页未解析到作品');

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
        const { buf } = await downloadImage(it.imageUrl);
        // 压缩到长边≤1600、转 webp，省空间；同时拿压缩后真实宽高
        const img = sharp(buf, { failOn: 'none' }).rotate();
        const meta = await img.metadata();
        const out = await img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 }).toBuffer();
        let imageHash: string | null = null;
        try { imageHash = await aHash(out); } catch {}
        if (imageHash && existingHashes.find(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipped++; continue; }
        const uniq = `${it.mhsId || 'n'}-${Date.now()}-${artworkIds.length}`;
        const filename = `mhs-${artistId}-${uniq}.webp`;
        await writeFile(join(uploadsDir, filename), out);
        const w = it.width || meta.width || null, h = it.height || meta.height || null;
        const [ar] = await db.insert(schema.artworks).values({
          artistId,
          title: null,
          imageUrl: `/uploads/${filename}`,
          thumbUrl: `/uploads/${filename}`,
          width: w, height: h,
          orientation: deriveOrientation(w, h),
          imageHash,
          sourcePlatform: 'mihuashi',
          sourceUrl: mhsUrl,
          tagStatus: 'pending',
        });
        const aid = (ar as any).insertId;
        artworkIds.push(aid);
        if (imageHash) existingHashes.push(imageHash);
        if (tagging) { try { await tagging.tagArtwork(aid); } catch {} }
      } catch { failed++; }
    }
    await logOperation({ type: 'crawl_import', targetType: 'artwork', targetId: artistId, summary: `米画师爬取「${artist.name}」导入 ${artworkIds.length} 张` });
    return { artistId, nickname: artist.name, found: items.length, imported: artworkIds.length, skipped, failed, artworkIds };
  }
}
