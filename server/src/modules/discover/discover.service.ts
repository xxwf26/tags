// 发现（按画风搜作品）：图/标签 → 多平台关键词召回 → 逐张(去重+AI质检) → 按质量排序
// → 复核 → 正式入库。异步执行：startSearch 立即返回 sessionId，runSearch 后台跑并写进度。
// 上传图的作用是「AI 识别画风标签」，标签即搜索关键词——不做视觉相似度（避免 onnx 阻塞主线程）。
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { searchXhsByKeyword, downloadImage } from '../crawl/xhs.js';
import { searchWeiboByKeyword } from '../crawl/weibo.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { gateArtwork } from '../tagging/ai.js';

const PER_KW = 20;          // 每平台每关键词召回上限
const CONCURRENCY = 6;      // 逐张处理并发度
const MIN_QUALITY = 5;      // AI 质检质量分下限

type Recalled = {
  platform: string; imageUrl: string; sourceUrl: string | null;
  title: string | null; author: string | null; tags: string[]; allImages: string[];
};

export class DiscoverService {
  // 发起搜索：解析关键词（选中标签 / 参考图AI标签）→ 建 session → 立即返回，重活丢后台
  async start(body: { referenceId?: number | null; tags?: { label: string }[]; platforms?: string[] }) {
    const platforms = (body.platforms ?? ['mihuashi']).filter(p => ['xiaohongshu', 'mihuashi', 'weibo'].includes(p));
    if (!platforms.length) throw new Error('未选择采集平台');

    // 关键词：优先用传入标签；若只传了参考图则用其 AI 标签
    let keywords = (body.tags ?? []).map(t => String(t.label).trim()).filter(Boolean);
    const referenceId = body.referenceId ?? null;
    const mode: 'image' | 'tags' = referenceId ? 'image' : 'tags';

    if (referenceId) {
      const [ref] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, referenceId));
      if (!ref) throw new Error('参考图不存在');
      if (!keywords.length) {
        const aiTags = (ref.aiTags as any[]) || [];
        keywords = aiTags.map(t => t.label).filter(Boolean);
      }
    }
    if (!keywords.length) throw new Error('无搜索关键词：请选画风标签，或上传能识别出画风的参考图');

    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: referenceId, mode,
      searchTags: { tags: keywords }, platforms,
      status: 'running', doneCount: 0, totalCount: 0,
    });
    const sessionId = (sr as any).insertId;

    this.runSearch(sessionId, { platforms, keywords, mode, referenceId })
      .catch(async (e) => {
        console.error(`[discover] session ${sessionId} 失败:`, e.message);
        await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).catch(() => {});
      });

    return { sessionId, mode };
  }

  // 后台：召回 → 逐张处理 → 写结果 + 进度
  private async runSearch(sessionId: number, ctx: {
    platforms: string[]; keywords: string[]; mode: 'image' | 'tags'; referenceId: number | null;
  }) {
    const { platforms, keywords, mode, referenceId } = ctx;
    const xhsCookie = process.env.XHS_COOKIE || '';

    // 1) 召回候选池（各平台 × 关键词）
    const pool: Recalled[] = [];
    for (const platform of platforms) {
      for (const kw of keywords) {
        try {
          if (platform === 'mihuashi') {
            const arts = await searchMihuashi(kw, PER_KW);
            for (const a of arts) pool.push({ platform, imageUrl: a.imageUrl, sourceUrl: `https://www.mihuashi.com/artworks/${a.mhsId}`, title: `米画师·${kw}`, author: a.author ?? null, tags: [kw], allImages: [a.imageUrl] });
          } else if (platform === 'weibo') {
            const imgs = await searchWeiboByKeyword(kw, PER_KW);
            for (const im of imgs) pool.push({ platform, imageUrl: im.url, sourceUrl: im.sourceUrl || im.url, title: im.title || `微博·${kw}`, author: im.author ?? null, tags: [kw], allImages: [im.url] });
          } else if (platform === 'xiaohongshu') {
            if (!xhsCookie) { console.error('[discover] 小红书未配置 XHS_COOKIE，跳过'); continue; }
            const notes = await searchXhsByKeyword(kw, PER_KW, xhsCookie);
            for (const n of notes) if (n.images.length) pool.push({ platform, imageUrl: n.images[0], sourceUrl: n.sourceUrl, title: n.title || kw, author: n.author || null, tags: n.xhsTags || [], allImages: n.images });
          }
        } catch (e: any) { console.error(`[discover] ${platform} "${kw}" 召回失败: ${e.message}`); }
      }
    }

    // 按 sourceUrl 去重候选池
    const seenUrl = new Set<string>();
    const uniq = pool.filter(r => { const k = r.sourceUrl || r.imageUrl; if (!k || seenUrl.has(k)) return false; seenUrl.add(k); return true; });
    await db.update(schema.searchSessions).set({ totalCount: uniq.length }).where(eq(schema.searchSessions.id, sessionId));

    // 库内已有 hash（去重）
    const libHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];
    const seenHash: string[] = [...libHashes];
    let done = 0, kept = 0;

    // 2) 逐张处理（分批并发）：下载 → 去重 → AI质检 → 写结果
    const processOne = async (r: Recalled) => {
      try {
        const { buf, type } = await downloadImage(r.imageUrl);
        let hash: string | null = null;
        try { hash = await aHash(buf); } catch {}
        if (hash && seenHash.some(h => hamming(hash!, h) <= DEDUP_THRESHOLD)) return; // 去重
        if (hash) seenHash.push(hash);
        // AI 质检闸门（单模型，省成本）：过滤广告/照片/文字海报/低质
        const gate = await gateArtwork(buf.toString('base64'), type);
        if (!gate.isArtwork || gate.quality < MIN_QUALITY) return;
        await db.insert(schema.searchResults).values({
          sessionId, referenceImageId: referenceId, platform: r.platform,
          sourceUrl: r.sourceUrl, imageUrl: r.imageUrl, title: r.title, author: r.author,
          tags: r.tags, allImages: r.allImages, imageHash: hash,
          similarity: null, quality: gate.quality, isNew: 1, tier: 'tier1',
        });
        kept++;
      } catch (e: any) {
        console.error(`[discover] 处理失败 ${r.imageUrl?.slice(0, 50)}: ${e.message}`);
      } finally {
        done++;
        if (done % 3 === 0 || done === uniq.length) await db.update(schema.searchSessions).set({ doneCount: done }).where(eq(schema.searchSessions.id, sessionId)).catch(() => {});
      }
    };

    for (let i = 0; i < uniq.length; i += CONCURRENCY) {
      await Promise.all(uniq.slice(i, i + CONCURRENCY).map(processOne));
    }

    await db.update(schema.searchSessions).set({ status: 'ok', doneCount: uniq.length, resultCount: kept }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'discover_start', targetType: 'reference', targetId: referenceId ?? 0, summary: `发现 #${sessionId}(${mode})：召回 ${uniq.length}，入库 ${kept} 结果` });
  }

  // 任务进度
  async taskStatus(sessionId: number) {
    const [s] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    if (!s) throw new Error('会话不存在');
    return { status: s.status, done: s.doneCount ?? 0, total: s.totalCount ?? 0, resultCount: s.resultCount ?? 0, mode: s.mode };
  }

  // 结果列表：按质量分降序
  async listResults(sessionId: number, tier?: string) {
    const conds = [eq(schema.searchResults.sessionId, sessionId)];
    if (tier) conds.push(eq(schema.searchResults.tier, tier as any));
    return db.select().from(schema.searchResults).where(and(...conds)).orderBy(desc(schema.searchResults.quality), desc(schema.searchResults.id));
  }

  // 复核：tier1 → tier2
  async review(id: number) {
    await db.update(schema.searchResults).set({ tier: 'tier2' }).where(eq(schema.searchResults.id, id));
    return { id, tier: 'tier2' };
  }

  // 丢弃
  async reject(id: number) {
    await db.update(schema.searchResults).set({ tier: 'rejected' }).where(eq(schema.searchResults.id, id));
    return { id, tier: 'rejected' };
  }

  // 正式入库：下载图 → 建作品 → 建/找画师 → 同步画师库+画廊
  async promote(id: number) {
    const [result] = await db.select().from(schema.searchResults).where(eq(schema.searchResults.id, id));
    if (!result) throw new Error('结果不存在');
    if (!result.imageUrl) throw new Error('结果无图片URL');

    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const { buf, type } = await downloadImage(result.imageUrl);
    let imageHash: string | null = null;
    try { imageHash = await aHash(buf); } catch {}
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const filename = `discover-${id}-${Date.now()}.${ext}`;
    await writeFile(join(uploadsDir, filename), buf);

    // 找/建画师（按署名精确匹配）
    let artistId: number | null = null;
    if (result.author) {
      const all = await db.select().from(schema.artists);
      const ex = all.find(a => (a.name || '').trim() === result.author!.trim());
      if (ex) artistId = ex.id;
      else {
        const links = result.platform ? { [result.platform]: [result.sourceUrl] } : undefined;
        const [ar] = await db.insert(schema.artists).values({ name: result.author.trim(), links });
        artistId = (ar as any).insertId;
      }
    }

    const [aw] = await db.insert(schema.artworks).values({
      artistId, title: result.title || null,
      imageUrl: `/uploads/${filename}`, thumbUrl: `/uploads/${filename}`,
      imageHash, sourcePlatform: result.platform || 'discover', sourceUrl: result.sourceUrl || null,
      tagStatus: 'pending',
    });
    const artworkId = (aw as any).insertId;

    await db.update(schema.searchResults).set({ tier: 'promoted', promotedArtworkId: artworkId }).where(eq(schema.searchResults.id, id));
    await logOperation({ type: 'discover_promote', targetType: 'search_result', targetId: id, summary: `发现结果 #${id} 正式入库 → 作品 #${artworkId}` });
    return { id, tier: 'promoted', artworkId, artistId };
  }
}
