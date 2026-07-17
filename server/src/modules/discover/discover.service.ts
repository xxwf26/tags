// 发现（按画风搜作品）：选米画师原生画风标签 → 米画师召回 → 逐张(去重+AI质检) → 按质量排序
// → 复核 → 正式入库。异步执行：start 立即返回 sessionId，runSearch 后台跑并写进度。
// 平台范围：仅米画师（小红书/微博归寻源）。关键词必须用米画师原生标签，避免词表不一致导致 0 结果。
import { db, schema } from '../../database/db.js';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { downloadImage } from '../crawl/xhs.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { gateArtwork } from '../tagging/ai.js';
import { promoteSearchResult } from '../support/promote-helpers.js';

const PER_KW = 20;          // 每关键词召回上限
const CONCURRENCY = 6;      // 逐张处理并发度
const MIN_QUALITY = 5;      // AI 质检质量分下限

type Recalled = {
  platform: string; imageUrl: string; sourceUrl: string | null;
  title: string | null; author: string | null; authorUrl: string | null; tags: string[]; allImages: string[];
};

export class DiscoverService {
  // 发起搜索：关键词=传入的米画师原生标签 → 建 session → 立即返回，重活丢后台
  async start(body: { tags?: { label: string }[]; platforms?: string[] }) {
    const platforms = ['mihuashi']; // 发现只走米画师

    // 关键词：用户选中的米画师原生标签（必须传）
    const keywords = (body.tags ?? []).map(t => String(t.label).trim()).filter(Boolean);
    if (!keywords.length) throw new Error('请选择米画师画风标签作为搜索关键词');

    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: null, mode: 'tags',
      searchTags: { tags: keywords }, platforms,
      status: 'running', doneCount: 0, totalCount: 0,
    });
    const sessionId = (sr as any).insertId;

    this.runSearch(sessionId, { keywords })
      .catch(async (e) => {
        console.error(`[discover] session ${sessionId} 失败:`, e.message);
        await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).catch(() => {});
      });

    return { sessionId, mode: 'tags' as const };
  }

  // 后台：召回 → 逐张处理 → 写结果 + 进度
  private async runSearch(sessionId: number, ctx: { keywords: string[] }) {
    const { keywords } = ctx;

    // 1) 召回候选池（米画师 × 关键词）
    const pool: Recalled[] = [];
    for (const kw of keywords) {
      try {
        const arts = await searchMihuashi(kw, PER_KW);
        for (const a of arts) pool.push({ platform: 'mihuashi', imageUrl: a.imageUrl, sourceUrl: `https://www.mihuashi.com/artworks/${a.mhsId}`, title: `米画师·${kw}`, author: a.author, authorUrl: a.authorUrl, tags: [kw], allImages: [a.imageUrl] });
      } catch (e: any) { console.error(`[discover] 米画师 "${kw}" 召回失败: ${e.message}`); }
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
        // AI 没真正质检（无 key / 调用失败）：不伪装成通过，入库但 quality=null 标"未质检"，交人工复核
        if (gate.skipped) {
          await db.insert(schema.searchResults).values({
            sessionId, referenceImageId: null, platform: r.platform,
            sourceUrl: r.sourceUrl, imageUrl: r.imageUrl, title: r.title, author: r.author, authorUrl: r.authorUrl,
            tags: r.tags, allImages: r.allImages, imageHash: hash,
            similarity: null, quality: null, isNew: 1, tier: 'tier1',
          });
          kept++;
          return;
        }
        if (!gate.isArtwork || gate.quality < MIN_QUALITY) return;
        await db.insert(schema.searchResults).values({
          sessionId, referenceImageId: null, platform: r.platform,
          sourceUrl: r.sourceUrl, imageUrl: r.imageUrl, title: r.title, author: r.author, authorUrl: r.authorUrl,
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
    await logOperation({ type: 'discover_start', targetType: 'reference', targetId: 0, summary: `发现 #${sessionId}(tags)：召回 ${uniq.length}，入库 ${kept} 结果` });
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

  // 正式入库：tier2 → promoted（共用 promoteSearchResult）
  async promote(id: number) {
    const [result] = await db.select().from(schema.searchResults).where(eq(schema.searchResults.id, id));
    if (!result) throw new Error('结果不存在');
    return promoteSearchResult(result, { filePrefix: 'discover', logType: 'discover_promote' });
  }
}
