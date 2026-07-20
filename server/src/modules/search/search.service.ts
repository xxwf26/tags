// 寻源搜索：参考图标签 → 小红书/微博搜索 → 结果存三级库 → 复核 → 正式入库
// 平台范围：小红书（SSR + 文字预筛 + AI 双模型质检 + 增量写）、微博（关键词搜 + AI 单模型质检）
// CLIP：参考图 image 模式下给结果算视觉相似度，按相似度排序（worker 不可用则降级为纯质量排序）
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, inArray, isNotNull } from 'drizzle-orm';
import { searchXhsByKeyword, downloadImage } from '../crawl/xhs.js';
import { searchWeiboByKeyword } from '../crawl/weibo.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth, gateArtwork } from '../tagging/ai.js';
import { embedImage, cosine, isEmbedAvailable } from '../embed/clip.js';
import { SettingsService } from '../settings/settings.service.js';
import { promoteSearchResult } from '../support/promote-helpers.js';

// 正在运行的搜索进程（用于终止）
const runningSearches = new Map<number, boolean>(); // sessionId → aborted?

const MIN_QUALITY = 5; // AI 质检质量分下限
const SIM_FLOOR = 0.2; // CLIP 相似度下限（很宽松，只砍明显不相干）

export class SearchService {
  // 终止搜索
  async abort(sessionId: number) {
    runningSearches.set(sessionId, true);
    await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, aborted: true };
  }

  // 发起搜索：创建 session → 各平台搜索 → 存结果 → 标记 isNew
  // tags 支持 mode: 'must'(必中，用作搜索关键词) | 'fuzzy'(模糊，达到比例即满足)
  async startSearch(body: {
    referenceId: number;
    tags: { tagId: number; label: string; dimensionId: number | null; mode: 'must' | 'fuzzy' }[];
    platforms?: string[]; fuzzyRatio?: number;
  }) {
    // 先创建 session 返回 sessionId，后台异步执行搜索
    const prevSessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, body.referenceId)).orderBy(desc(schema.searchSessions.id));
    const prevSession = prevSessions[0]?.id ?? null;
    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: body.referenceId,
      parentSessionId: prevSession,
      searchTags: { tags: body.tags, fuzzyRatio: body.fuzzyRatio ?? 0.5 },
      platforms: body.platforms ?? ['xiaohongshu', 'weibo'],
      status: 'running',
    });
    const sessionId = (sr as any).insertId;

    // CLIP：对参考图算 embedding 存入 session，供结果相似度排序。worker 不可用则跳过（降级纯质量排序）。
    let refEmbedding: number[] | null = null;
    if (isEmbedAvailable()) {
      try {
        const [ref] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, body.referenceId));
        if (ref?.imageUrl) {
          const refBuf = await readFile(join('uploads', basename(ref.imageUrl)));
          refEmbedding = await embedImage(refBuf);
          await db.update(schema.searchSessions).set({ refEmbedding }).where(eq(schema.searchSessions.id, sessionId));
        }
      } catch (e: any) { console.error(`[search] 参考图 embedding 失败，降级纯质量排序: ${e.message}`); }
    }

    // 异步执行，不阻塞响应
    runningSearches.set(sessionId, false);
    this.executeSearch(sessionId, body, prevSession, refEmbedding).catch(e => {
      console.error(`[search] session ${sessionId} 失败: ${e.message}`);
      db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).then(() => {});
    }).finally(() => {
      runningSearches.delete(sessionId);
    });

    return { sessionId, status: 'running' };
  }

  private async executeSearch(sessionId: number, body: any, prevSession: number | null, refEmbedding: number[] | null) {
    const isAborted = () => runningSearches.get(sessionId) === true;
    let progressTotal = 0, progressProcessed = 0;
    const progressStart = Date.now();
    const platforms = body.platforms ?? ['xiaohongshu', 'weibo'];
    const useClip = !!refEmbedding;
    const settingsSvc = new SettingsService();
    const xhsCookie = await settingsSvc.getXhsCookie();
    const fuzzyRatio = body.fuzzyRatio ?? 0.5;

    // 加载维度表，解析每个标签的顶层 code（genre/technique/...）
    const dims = await db.select().from(schema.tagDimensions);
    const dimById = new Map(dims.map(d => [d.id, d]));
    const rootCodeOf = (dimId: number | null): string => {
      if (!dimId) return '';
      let d = dimById.get(dimId), cur = dimId;
      while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
      return d?.code ?? '';
    };

    // 必中的 genre 画风标签 → 搜索关键词；没有必中 genre 则用所有 genre 标签
    const mustGenreTags = body.tags.filter((t: any) => t.mode === 'must' && rootCodeOf(t.dimensionId) === 'genre');
    const allGenreTags = body.tags.filter((t: any) => rootCodeOf(t.dimensionId) === 'genre');
    const searchKeywords = (mustGenreTags.length ? mustGenreTags : allGenreTags).map((t: any) => t.label);

    // 取上一次的结果（用于 isNew 判断）
    const prevResults = prevSession ? await db.select().from(schema.searchResults)
      .where(eq(schema.searchResults.sessionId, prevSession)) : [];
    const prevHashes = new Set(prevResults.map(r => r.imageHash).filter(Boolean));
    const prevUrls = new Set(prevResults.map(r => r.sourceUrl).filter(Boolean));

    // 共享去重集合：库内已有 hash + 本 session 已收集 hash
    const libHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];
    const libHashSet = new Set(libHashes);
    const sessionHashes = new Set<string>();

    let totalResults = 0, newResults = 0;

    for (const platform of platforms) {
      try {
        if (platform === 'xiaohongshu') {
          if (!xhsCookie) { console.error('[search] 小红书: 未配置 XHS_COOKIE，跳过'); }
          else {
            const keywords = searchKeywords.length ? searchKeywords : ['插画'];
            const tax = await loadTaxonomy();
            for (const kw of keywords) {
              if (isAborted()) { console.log(`[search] session ${sessionId} 已终止`); break; }
              const notes = await searchXhsByKeyword(kw, 300, xhsCookie);
              console.log(`[search] 小红书 "${kw}": ${notes.length} 帖，开始 AI 筛选（增量写入）...`);
              progressTotal += notes.length;
              await db.update(schema.searchSessions).set({ searchTags: { tags: body.tags, fuzzyRatio, progress: { total: progressTotal, processed: 0, startTime: new Date(progressStart).toISOString() } } }).where(eq(schema.searchSessions.id, sessionId));
              let kept = 0, skipNotArt = 0, skipDup = 0, skipLowQ = 0;
              for (const n of notes) {
                if (isAborted()) { console.log(`[search] session ${sessionId} 已终止（已处理 ${progressProcessed} 张）`); break; }
                progressProcessed++;
                if (!n.images.length) { skipNotArt++; continue; }
                // 文字预筛：标题/标签明显与绘画无关的跳过（不浪费AI调用）
                const noteText = (n.title || '') + ' ' + (n.xhsTags || []).join(' ');
                const NON_ART_TEXT = ['穿搭','美食','旅游','健身','减肥','化妆','护肤','发型','美甲','自拍','日常','vlog','探店','测评','开箱','装修','家居','宠物','猫','狗','宝宝','育儿','婚礼','毕业','生日','聚会','打卡','旅行','酒店','机票','购物','好物','种草','清单','攻略','教程','菜谱','食谱','运动','跑步','瑜伽','舞蹈','唱歌','翻唱','游戏','直播','抽奖','送','福利','红包','兼职','招聘','租房','二手房','买车','学车','考','证','报','课','AI绘画','AI生成','AI画','Midjourney','midjourney','Stable Diffusion','stable diffusion','SD生成','NovelAI','novelai','DALL-E','dalle','AI插画','AI创作','AI绘图','AI绘图工具','咒语','prompt分享','提示词','正向提示','负向提示','模型分享','LoRA','lora','ControlNet','comfyui','ComfyUI','webui','炼丹','跑图','出图','垫图','图生图','文生图'];
                if (NON_ART_TEXT.some(kw => noteText.includes(kw))) { skipNotArt++; continue; }
                let isArtwork = false;
                let quality = 0;
                let aiTags: any[] = [];
                let imageHash: string | null = null;
                let buf: Buffer | null = null;
                try {
                  buf = (await downloadImage(n.images[0])).buf;
                  try { imageHash = await aHash(buf); } catch {}
                  if (imageHash) {
                    if ([...libHashSet].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; continue; }
                    if ([...sessionHashes].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; continue; }
                    sessionHashes.add(imageHash);
                  }
                  const b64 = buf!.toString('base64');
                  const mime = 'image/jpeg';
                  const { gemini } = await callBoth(b64, mime, tax.prompt);
                  const gParsed = extractJson(gemini);
                  isArtwork = gParsed?.is_artwork === true;
                  quality = Number(gParsed?.quality) || 0;
                  if (isArtwork) {
                    const gIds = normalizeOutput(gParsed, tax.labelMap);
                    const allIds = new Set([...gIds]);
                    const tagRows = allIds.size ? await db.select().from(schema.tags).where(inArray(schema.tags.id, [...allIds])) : [];
                    aiTags = tagRows.map(t => ({ tagId: t.id, label: t.label, dimensionId: t.dimensionId, rootCode: rootCodeOf(t.dimensionId) }));
                  }
                } catch (e: any) {
                  console.error(`[search] AI判断失败 "${n.title?.slice(0, 20)}": ${e.message}`);
                }
                if (!isArtwork) { skipNotArt++; continue; }
                if (quality < MIN_QUALITY) { skipLowQ++; continue; }
                // CLIP 相似度（image 模式）：算失败(null)不淘汰，避免误杀；低于下限才丢
                let similarity: number | null = null;
                if (useClip && buf) {
                  try { similarity = cosine(refEmbedding!, await embedImage(buf)); }
                  catch { similarity = null; }
                  if (similarity !== null && similarity < SIM_FLOOR) { skipLowQ++; continue; }
                }
                kept++;
                // 增量写入：每筛选完一张立即写 DB
                const dedupKey = n.sourceUrl || n.images[0] || '';
                const isNew = !prevUrls.has(dedupKey) && !prevHashes.has(n.images[0] || '');
                await db.insert(schema.searchResults).values({
                  sessionId,
                  referenceImageId: body.referenceId,
                  platform: 'xiaohongshu',
                  sourceUrl: n.sourceUrl || null,
                  imageUrl: n.images[0] || null,
                  allImages: n.images,
                  aiTags: aiTags.length ? aiTags : null,
                  imageHash: imageHash || null,
                  similarity,
                  title: n.title || kw,
                  author: n.author || null,
                  tags: n.xhsTags || [],
                  isNew: isNew ? 1 : 0,
                  tier: 'tier1',
                });
                totalResults++;
                if (isNew) newResults++;
                // 每3张更新一次 session 计数（前端轮询能看到进度）
                if (progressProcessed % 3 === 0) {
                  await db.update(schema.searchSessions).set({ resultCount: totalResults, newCount: newResults, searchTags: { tags: body.tags, fuzzyRatio, progress: { total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() } } }).where(eq(schema.searchSessions.id, sessionId));
                  console.log(`[search] 进度: ${progressProcessed}/${progressTotal} 已处理，保留 ${kept} 张（非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}）`);
                }
              }
              console.log(`[search] 小红书 "${kw}" 筛选完成: 保留 ${kept}，非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}`);
            }
          }
        } else if (platform === 'weibo') {
          const keywords = searchKeywords.length ? searchKeywords : ['插画'];
          for (const kw of keywords) {
            if (isAborted()) { console.log(`[search] session ${sessionId} 已终止`); break; }
            const imgs = await searchWeiboByKeyword(kw, 15);
            console.log(`[search] 微博 "${kw}": ${imgs.length} 张，开始 AI 筛选（增量写入）...`);
            progressTotal += imgs.length;
            await db.update(schema.searchSessions).set({ searchTags: { tags: body.tags, fuzzyRatio, progress: { total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() } } }).where(eq(schema.searchSessions.id, sessionId));
            let kept = 0, skipNotArt = 0, skipDup = 0, skipLowQ = 0;
            for (const im of imgs) {
              if (isAborted()) { console.log(`[search] session ${sessionId} 已终止（已处理 ${progressProcessed} 张）`); break; }
              progressProcessed++;
              let isArtwork = false;
              let quality = 0;
              let skipped = false;
              let imageHash: string | null = null;
              let buf: Buffer | null = null;
              try {
                const downloaded = await downloadImage(im.url);
                buf = downloaded.buf;
                const type = downloaded.type;
                try { imageHash = await aHash(buf); } catch {}
                if (imageHash) {
                  if ([...libHashSet].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; continue; }
                  if ([...sessionHashes].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; continue; }
                  sessionHashes.add(imageHash);
                }
                const gate = await gateArtwork(buf.toString('base64'), type);
                isArtwork = gate.isArtwork;
                quality = gate.quality;
                skipped = gate.skipped;
              } catch (e: any) {
                console.error(`[search] 微博图处理失败 "${im.title?.slice(0, 20)}": ${e.message}`);
              }
              // AI 未真正质检（无 key/调用失败）：入库但 quality=null 标"未质检"，交人工复核
              if (!skipped) {
                if (!isArtwork) { skipNotArt++; continue; }
                if (quality < MIN_QUALITY) { skipLowQ++; continue; }
              }
              // CLIP 相似度（image 模式）
              let similarity: number | null = null;
              if (useClip && buf) {
                try { similarity = cosine(refEmbedding!, await embedImage(buf)); }
                catch { similarity = null; }
                if (!skipped && similarity !== null && similarity < SIM_FLOOR) { skipLowQ++; continue; }
              }
              kept++;
              const dedupKey = im.url;
              const isNew = !prevUrls.has(dedupKey) && !prevHashes.has(im.url);
              await db.insert(schema.searchResults).values({
                sessionId,
                referenceImageId: body.referenceId,
                platform: 'weibo',
                sourceUrl: im.url,
                imageUrl: im.url,
                allImages: [im.url],
                imageHash: imageHash || null,
                similarity,
                quality: skipped ? null : quality,
                title: im.title || `微博·${kw}`,
                author: null,
                tags: [kw],
                isNew: isNew ? 1 : 0,
                tier: 'tier1',
              });
              totalResults++;
              if (isNew) newResults++;
              if (progressProcessed % 3 === 0) {
                await db.update(schema.searchSessions).set({ resultCount: totalResults, newCount: newResults, searchTags: { tags: body.tags, fuzzyRatio, progress: { total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() } } }).where(eq(schema.searchSessions.id, sessionId));
                console.log(`[search] 进度: ${progressProcessed}/${progressTotal} 已处理，保留 ${kept} 张（非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}）`);
              }
            }
            console.log(`[search] 微博 "${kw}" 筛选完成: 保留 ${kept}，非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}`);
          }
        }
      } catch (e: any) {
        console.error(`[search] ${platform} 失败: ${e.message}`);
      }
    }

    // 最终更新：包含进度信息（前端算百分比/ETA用）
    const elapsed = Date.now() - progressStart;
    await db.update(schema.searchSessions).set({
      status: 'ok', resultCount: totalResults, newCount: newResults,
      searchTags: { tags: body.tags, fuzzyRatio, progress: { total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString(), elapsedMs: elapsed } },
    }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'search_start', targetType: 'reference', targetId: body.referenceId, summary: `寻源搜索 #${sessionId}：${totalResults} 结果（${newResults} 新增）` });
    return { sessionId, resultCount: totalResults, newCount: newResults };
  }

  // 删除单个 session + 其所有结果
  async deleteSession(sessionId: number) {
    await db.delete(schema.searchResults).where(eq(schema.searchResults.sessionId, sessionId));
    await db.delete(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, deleted: true };
  }

  // 删除参考图的所有 session + 结果（清空历史）
  async deleteAllSessions(referenceId: number) {
    const sessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, referenceId));
    for (const s of sessions) {
      await db.delete(schema.searchResults).where(eq(schema.searchResults.sessionId, s.id));
    }
    await db.delete(schema.searchSessions).where(eq(schema.searchSessions.referenceImageId, referenceId));
    return { referenceId, deletedSessions: sessions.length };
  }

  async listSessions(referenceId: number) {
    return db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, referenceId)).orderBy(desc(schema.searchSessions.id));
  }

  async listResults(sessionId: number, tier?: string) {
    const conds = [eq(schema.searchResults.sessionId, sessionId)];
    if (tier) conds.push(eq(schema.searchResults.tier, tier as any));
    const rows = await db.select().from(schema.searchResults).where(and(...conds));
    // image 模式（session 有 refEmbedding）按相似度降序(null 安全，null 在后)；否则按 isNew/id
    const [s] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    if (s?.refEmbedding) {
      rows.sort((a: any, b: any) => (b.similarity ?? -1) - (a.similarity ?? -1));
    } else {
      rows.sort((a: any, b: any) => (b.isNew - a.isNew) || (b.id - a.id));
    }
    return rows;
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
    return promoteSearchResult(result, { filePrefix: 'search', logType: 'search_promote' });
  }
}
