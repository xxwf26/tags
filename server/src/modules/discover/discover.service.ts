// 发现（按画风搜作品）：图/标签 → 多平台关键词召回 → 逐张(去重+AI质检+CLIP相似度) → 排序
// → 复核 → 正式入库。异步执行：start 立即返回 sessionId，runSearch 后台跑并写进度。
// 有参考图时(image 模式)：CLIP 视觉相似度精排——每张候选与参考图算余弦相似度，按 相似度×质量 排序。
// CLIP 推理走独立 worker 线程（embed/clip.ts），不阻塞主线程。无参考图(tags 模式)：纯质量排序。
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { searchXhsByKeyword, downloadImage } from '../crawl/xhs.js';
import { searchWeiboByKeyword } from '../crawl/weibo.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { gateArtwork } from '../tagging/ai.js';
import { embedImage, cosine, isEmbedAvailable } from '../embed/clip.js';
import { findDuplicateArtwork, findOrCreateArtist } from './promote-helpers.js';
import { Injectable } from '@nestjs/common';

const PER_KW = 20;          // 每平台每关键词召回上限
const CONCURRENCY = 6;      // 逐张处理并发度
const MIN_QUALITY = 5;      // AI 质检质量分下限
const SIM_FLOOR = 0.2;      // image 模式相似度下限（很宽松，只砍明显不相干；同画风梯度可低至 ~0.58）
// CLIP 视觉精排总开关。false = 关闭（因 CLIP worker 与 playwright chromium 同进程 segfault，方案A 先保稳定）。
// 方案B 将 CLIP 移到独立子进程后改回 true。关闭时 image 模式自动退化为纯质量排序。
const CLIP_ENABLED = false;

// 米画师站内筛选只认这套官方标签（画风 + 类型两个维度）。用它作白名单：
// 采集靠点击页面上「文字=关键词」的标签按钮，非官方词点不中、只会空跑，故直接跳过。
const MIHUASHI_TAGS = new Set([
  // 画风
  '日系', '平涂', '萌系', '厚涂', '赛璐璐', '古风', '中国风', '童趣', '写实系', '韩系',
  '少女漫画', '欧美系', '水彩', '美式卡通', '白描', '科幻风', '像素风', '水墨', '硬派',
  // 类型
  '头像', '插图', 'Q版', '自设/OC', '立绘', '角色设计', '壁纸', '封面', '场景', '海报',
  '概念设计', '印花', '图标', 'Live2D', 'CG', '和纸胶带', '像素图', '卡牌', '条漫', 'UI', '版型', '分镜', '抱枕', '特效',
]);

type Recalled = {
  platform: string; imageUrl: string; sourceUrl: string | null;
  title: string | null; author: string | null; tags: string[]; allImages: string[];
};

// 正在运行的发现进程（用于终止）。与 search.service 的 runningSearches 对称：sessionId → aborted?
const runningDiscovers = new Map<number, boolean>();

@Injectable()
export class DiscoverService {
  // 终止发现：置 aborted 标记（runSearch 各阶段检查）+ 立即把 session 标为 failed（前端轮询即收敛）
  async abort(sessionId: number) {
    runningDiscovers.set(sessionId, true);
    await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, aborted: true };
  }

  // 发起搜索：解析关键词（选中标签 / 参考图AI标签）→ 建 session → 立即返回，重活丢后台
  async start(body: { referenceId?: number | null; tags?: { label: string }[]; platforms?: string[] }) {
    const platforms = (body.platforms ?? ['mihuashi']).filter(p => ['xiaohongshu', 'mihuashi', 'weibo'].includes(p));
    if (!platforms.length) throw new Error('未选择采集平台');

    // 关键词：优先用传入标签；若只传了参考图则用其 AI 标签
    let keywords = (body.tags ?? []).map(t => String(t.label).trim()).filter(Boolean);
    const referenceId = body.referenceId ?? null;
    const mode: 'image' | 'tags' = referenceId ? 'image' : 'tags';

    // 防重复：同一参考图已有进行中的搜索则拒绝，避免并发多任务打爆平台反爬
    if (referenceId) {
      const [running] = await db.select({ id: schema.searchSessions.id }).from(schema.searchSessions)
        .where(and(eq(schema.searchSessions.referenceImageId, referenceId), eq(schema.searchSessions.status, 'running'))).limit(1);
      if (running) throw new Error('该参考图正在搜索中，请等待完成');
    }

    // image 模式：算参考图 CLIP 向量。失败/关闭则退化为 tags 行为（纯质量排序）。
    // ⚠️ CLIP_ENABLED=false：CLIP worker(onnxruntime) 与采集用的 playwright(chromium) 在同一 node 进程内
    // 共存会触发原生层 segfault，整个后端崩溃。方案A 先关闭视觉精排保稳定；方案B 将把 CLIP 挪到独立子进程后再开启。
    let refEmbedding: number[] | null = null;
    if (referenceId) {
      const [ref] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, referenceId));
      if (!ref) throw new Error('参考图不存在');
      if (!keywords.length) {
        const aiTags = (ref.aiTags as any[]) || [];
        keywords = aiTags.map(t => t.label).filter(Boolean);
      }
      if (CLIP_ENABLED && isEmbedAvailable()) {
        try {
          const refBuf = await readFile(join(process.cwd(), 'uploads', basename(ref.imageUrl)));
          refEmbedding = await embedImage(refBuf);
        } catch (e: any) {
          console.error(`[discover] 参考图向量计算失败，退化为纯质量排序: ${e.message}`);
        }
      }
    }
    if (!keywords.length) throw new Error('无搜索关键词：请选画风标签，或上传能识别出画风的参考图');

    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: referenceId, mode,
      refEmbedding, searchTags: { tags: keywords }, platforms,
      status: 'running', doneCount: 0, totalCount: 0,
    });
    const sessionId = (sr as any).insertId;

    runningDiscovers.set(sessionId, false);
    this.runSearch(sessionId, { platforms, keywords, mode, referenceId, refEmbedding })
      .catch(async (e) => {
        console.error(`[discover] session ${sessionId} 失败:`, e.message);
        await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).catch(() => {});
      })
      .finally(() => runningDiscovers.delete(sessionId));

    return { sessionId, mode };
  }

  // 后台：召回 → 逐张处理 → 写结果 + 进度
  private async runSearch(sessionId: number, ctx: {
    platforms: string[]; keywords: string[]; mode: 'image' | 'tags'; referenceId: number | null; refEmbedding: number[] | null;
  }) {
    const { platforms, keywords, mode, referenceId, refEmbedding } = ctx;
    const xhsCookie = process.env.XHS_COOKIE || '';
    const isAborted = () => runningDiscovers.get(sessionId) === true;

    // 1) 召回候选池（各平台 × 关键词）
    const pool: Recalled[] = [];
    for (const platform of platforms) {
      if (isAborted()) break;
      for (const kw of keywords) {
        if (isAborted()) break;
        try {
          if (platform === 'mihuashi') {
            if (!MIHUASHI_TAGS.has(kw)) { console.error(`[discover] 米画师跳过非官方标签「${kw}」（点不中、只会空跑）`); continue; }
            const arts = await searchMihuashi(kw, PER_KW);
            for (const a of arts) pool.push({ platform, imageUrl: a.imageUrl, sourceUrl: `https://www.mihuashi.com/artworks/${a.mhsId}`, title: `米画师·${kw}`, author: null, tags: [kw], allImages: [a.imageUrl] });
          } else if (platform === 'weibo') {
            const imgs = await searchWeiboByKeyword(kw, PER_KW);
            for (const im of imgs) pool.push({ platform, imageUrl: im.url, sourceUrl: im.url, title: im.title || `微博·${kw}`, author: null, tags: [kw], allImages: [im.url] });
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
    // 漏斗计数：让"0 结果"能看清卡在哪个环节
    const stats = {
      recalled: pool.length, unique: uniq.length, dedup: 0, downloadFail: 0,
      notArtwork: 0, lowQuality: 0, aiSkipped: 0,
      lowSimilarity: 0,   // image 模式：被相似度下限淘汰的
      embedFail: 0,       // 单张 CLIP 计算失败（similarity 留 null，仍入库）
      embedSkipped: 0,    // 整个 session 未做视觉精排（无参考向量，退化 tags 排序）
      kept: 0,
    };
    // image 模式但拿不到参考向量 → 本次不做视觉精排，退化为纯质量排序
    const useClip = mode === 'image' && !!refEmbedding;
    if (mode === 'image' && !refEmbedding) stats.embedSkipped = 1;

    // 2) 逐张处理（分批并发）：下载 → 去重 → AI质检 →(image)CLIP相似度 → 写结果
    const processOne = async (r: Recalled) => {
      try {
        const { buf, type } = await downloadImage(r.imageUrl);
        let hash: string | null = null;
        try { hash = await aHash(buf); } catch {}
        if (hash && seenHash.some(h => hamming(hash!, h) <= DEDUP_THRESHOLD)) { stats.dedup++; return; } // 去重
        if (hash) seenHash.push(hash);
        // AI 质检闸门（单模型，省成本）：过滤广告/照片/文字海报/低质
        const gate = await gateArtwork(buf.toString('base64'), type);
        // AI 没真正质检（无 key / 调用失败）：不伪装成通过，入库但 quality=null 标"未质检"，交人工复核
        if (gate.skipped) {
          stats.aiSkipped++;
          await db.insert(schema.searchResults).values({
            sessionId, referenceImageId: referenceId, platform: r.platform,
            sourceUrl: r.sourceUrl, imageUrl: r.imageUrl, title: r.title, author: r.author,
            tags: r.tags, allImages: r.allImages, imageHash: hash,
            similarity: null, quality: null, isNew: 1, tier: 'tier1',
          });
          kept++;
          return;
        }
        if (!gate.isArtwork) { stats.notArtwork++; return; }
        if (gate.quality < MIN_QUALITY) { stats.lowQuality++; return; }
        // image 模式：算与参考图的视觉相似度（CLIP，走 worker）。单张失败不影响入库。
        let similarity: number | null = null;
        if (useClip) {
          try { similarity = cosine(refEmbedding!, await embedImage(buf)); }
          catch { stats.embedFail++; }
          // 相似度下限过滤：明显不相干的砍掉；算失败(null)的不淘汰，避免误杀
          if (similarity !== null && similarity < SIM_FLOOR) { stats.lowSimilarity++; return; }
        }
        await db.insert(schema.searchResults).values({
          sessionId, referenceImageId: referenceId, platform: r.platform,
          sourceUrl: r.sourceUrl, imageUrl: r.imageUrl, title: r.title, author: r.author,
          tags: r.tags, allImages: r.allImages, imageHash: hash,
          similarity, quality: gate.quality, isNew: 1, tier: 'tier1',
        });
        kept++;
      } catch (e: any) {
        stats.downloadFail++;
        console.error(`[discover] 处理失败 ${r.imageUrl?.slice(0, 50)}: ${e.message}`);
      } finally {
        done++;
        if (done % 3 === 0 || done === uniq.length) await db.update(schema.searchSessions).set({ doneCount: done }).where(eq(schema.searchSessions.id, sessionId)).catch(() => {});
      }
    };

    for (let i = 0; i < uniq.length; i += CONCURRENCY) {
      if (isAborted()) { console.log(`[discover] session ${sessionId} 已终止（已处理 ${done}/${uniq.length}）`); break; }
      await Promise.all(uniq.slice(i, i + CONCURRENCY).map(processOne));
    }

    stats.kept = kept;
    // 被终止的：标 failed，不覆盖为 ok。仍写入已完成部分的进度与漏斗，方便复盘。
    await db.update(schema.searchSessions).set({
      status: isAborted() ? 'failed' : 'ok', doneCount: done, resultCount: kept,
      searchTags: { tags: keywords, stats },
    }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'discover_start', targetType: 'reference', targetId: referenceId ?? 0, summary: `发现 #${sessionId}(${mode})：召回 ${uniq.length}，入库 ${kept} 结果` });
  }

  // 任务进度
  async taskStatus(sessionId: number) {
    const [s] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    if (!s) throw new Error('会话不存在');
    const stats = (s.searchTags as any)?.stats ?? null;
    return { status: s.status, done: s.doneCount ?? 0, total: s.totalCount ?? 0, resultCount: s.resultCount ?? 0, mode: s.mode, stats };
  }

  // 历史会话列表：发现 session（mode 非空；寻源 session 的 mode 为 null 不会列出），最新在前
  async listSessions(limit = 30) {
    const rows = await db.select().from(schema.searchSessions)
      .where(isNotNull(schema.searchSessions.mode))
      .orderBy(desc(schema.searchSessions.id)).limit(limit);
    return rows.map((s: any) => ({
      id: s.id, mode: s.mode, status: s.status, resultCount: s.resultCount ?? 0,
      tags: Array.isArray(s.searchTags?.tags) ? s.searchTags.tags : [],
      platforms: s.platforms, stats: s.searchTags?.stats ?? null, createdAt: s.createdAt,
    }));
  }

  // 结果列表：image 模式按 相似度×质量 降序，tags 模式按质量降序。
  // 应用层排序（非 SQL orderBy）：similarity×quality 是复合式且要处理 null，单 session 结果量小无性能问题。
  async listResults(sessionId: number, tier?: string) {
    const [s] = await db.select({ mode: schema.searchSessions.mode }).from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    const conds = [eq(schema.searchResults.sessionId, sessionId)];
    if (tier) conds.push(eq(schema.searchResults.tier, tier as any));
    const rows = await db.select().from(schema.searchResults).where(and(...conds));
    if (s?.mode === 'image') {
      // similarity/quality 为 null 时给中性默认，避免 NaN 沉底（如 AI 未质检或单张 embed 失败的图）
      return rows.sort((a, b) =>
        ((b.similarity ?? 0.5) * (b.quality ?? 5)) - ((a.similarity ?? 0.5) * (a.quality ?? 5)) || b.id - a.id);
    }
    return rows.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || b.id - a.id);
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

    // 库内去重：这张图已在作品库则不重复入库，直接指向已有作品
    const dupId = await findDuplicateArtwork(imageHash);
    if (dupId) {
      await db.update(schema.searchResults).set({ tier: 'promoted', promotedArtworkId: dupId }).where(eq(schema.searchResults.id, id));
      return { id, tier: 'promoted', artworkId: dupId, duplicate: true };
    }

    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const filename = `discover-${id}-${Date.now()}.${ext}`;
    await writeFile(join(uploadsDir, filename), buf);

    // 找/建画师（按署名精确匹配）
    const artistId = await findOrCreateArtist(result.author, result.platform, result.sourceUrl);

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
