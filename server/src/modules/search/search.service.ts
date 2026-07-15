// 寻源搜索：参考图标签 → 多平台搜索 → 结果存三级库 → 复核 → 正式入库
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { downloadImage } from '../crawl/xhs.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';

export class SearchService {
  // 发起搜索：创建 session → 各平台搜索 → 存结果 → 标记 isNew
  async startSearch(body: { referenceId: number; tags: { tagId: number; label: string; dimensionId: number | null }[]; platforms?: string[] }) {
    const platforms = body.platforms ?? ['mihuashi'];
    // 找上一次 session（迭代链）
    const prevSessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, body.referenceId)).orderBy(desc(schema.searchSessions.id));
    const prevSession = prevSessions[0]?.id ?? null;

    // 创建新 session
    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: body.referenceId,
      parentSessionId: prevSession,
      searchTags: body.tags,
      platforms,
      status: 'running',
    });
    const sessionId = (sr as any).insertId;

    // 取上一次的结果（用于 isNew 判断）
    const prevResults = prevSession ? await db.select().from(schema.searchResults)
      .where(eq(schema.searchResults.sessionId, prevSession)) : [];
    const prevHashes = new Set(prevResults.map(r => r.imageHash).filter(Boolean));
    const prevUrls = new Set(prevResults.map(r => r.sourceUrl).filter(Boolean));

    // 提取搜索关键词（genre 画风的标签）
    const genreTags = body.tags.filter(t => {
      // genre 子维度的 tagId —— 简化：取 label 作为关键词
      return t.label;
    });
    const keywords = genreTags.map(t => t.label);

    let totalResults = 0, newResults = 0;
    const allResults: any[] = [];

    for (const platform of platforms) {
      let items: { imageUrl: string; title?: string | null; author?: string | null; sourceUrl?: string; tags?: string[] }[] = [];
      try {
        if (platform === 'mihuashi') {
          // 米画师：按画风标签搜索（复用 searchMihuashi）
          for (const kw of keywords.length ? keywords : ['日系']) {
            const arts = await searchMihuashi(kw, 15);
            items.push(...arts.map(a => ({
              imageUrl: a.imageUrl, title: `米画师·${kw}`, author: null, sourceUrl: a.imageUrl, tags: [kw],
            })));
          }
        } else if (platform === 'xiaohongshu') {
          // 小红书关键词搜索：需 cookie + x-s 签名，暂返回空
          // TODO: playwright 驱动搜索页（需 cookie）
        } else if (platform === 'weibo') {
          // 微博关键词搜索：m.weibo.cn 搜索 API，暂返回空
          // TODO: m.weibo.cn/api/container/getIndex?type=search
        }
      } catch (e) {
        // 单平台失败不影响其他
      }

      // 去重 + 存结果
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.imageUrl)) continue;
        seen.add(item.imageUrl);
        const isNew = !prevUrls.has(item.sourceUrl || '') && !prevHashes.has(item.imageUrl);
        const [rr] = await db.insert(schema.searchResults).values({
          sessionId,
          referenceImageId: body.referenceId,
          platform,
          sourceUrl: item.sourceUrl || null,
          imageUrl: item.imageUrl,
          title: item.title || null,
          author: item.author || null,
          tags: item.tags || [],
          isNew: isNew ? 1 : 0,
          tier: 'tier1',
        });
        allResults.push({ id: (rr as any).insertId, isNew });
        totalResults++;
        if (isNew) newResults++;
      }
    }

    await db.update(schema.searchSessions).set({ status: 'ok', resultCount: totalResults, newCount: newResults }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'search_start', targetType: 'reference', targetId: body.referenceId, summary: `寻源搜索 #${sessionId}：${totalResults} 结果（${newResults} 新增）` });
    return { sessionId, resultCount: totalResults, newCount: newResults };
  }

  async listSessions(referenceId: number) {
    return db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, referenceId)).orderBy(desc(schema.searchSessions.id));
  }

  async listResults(sessionId: number, tier?: string) {
    const conds = [eq(schema.searchResults.sessionId, sessionId)];
    if (tier) conds.push(eq(schema.searchResults.tier, tier as any));
    return db.select().from(schema.searchResults).where(and(...conds)).orderBy(desc(schema.searchResults.isNew), desc(schema.searchResults.id));
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

  // 正式入库：tier2 → promoted（下载图 → 建作品 → 建画师 → 同步画师库+画廊）
  async promote(id: number) {
    const [result] = await db.select().from(schema.searchResults).where(eq(schema.searchResults.id, id));
    if (!result) throw new Error('结果不存在');

    // 下载图片
    if (!result.imageUrl) throw new Error('结果无图片URL');
    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const { buf, type } = await downloadImage(result.imageUrl);
    let imageHash: string | null = null;
    try { imageHash = await aHash(buf); } catch {}
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const filename = `search-${id}-${Date.now()}.${ext}`;
    await writeFile(join(uploadsDir, filename), buf);

    // 找/建画师
    let artistId: number | null = null;
    if (result.author) {
      const all = await db.select().from(schema.artists);
      const ex = all.find(a => (a.name || '').trim() === result.author!.trim());
      if (ex) artistId = ex.id;
      else {
        const [ar] = await db.insert(schema.artists).values({ name: result.author.trim() });
        artistId = (ar as any).insertId;
      }
    }

    // 建作品
    const [aw] = await db.insert(schema.artworks).values({
      artistId,
      title: result.title || null,
      imageUrl: `/uploads/${filename}`,
      thumbUrl: `/uploads/${filename}`,
      imageHash,
      sourcePlatform: result.platform,
      sourceUrl: result.sourceUrl || null,
      tagStatus: 'pending',
    });
    const artworkId = (aw as any).insertId;

    // 标记结果为 promoted
    await db.update(schema.searchResults).set({ tier: 'promoted', promotedArtworkId: artworkId }).where(eq(schema.searchResults.id, id));
    await logOperation({ type: 'search_promote', targetType: 'search_result', targetId: id, summary: `寻源结果 #${id} 正式入库 → 作品 #${artworkId}` });
    return { id, tier: 'promoted', artworkId, artistId };
  }
}
