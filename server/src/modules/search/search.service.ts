// 寻源搜索：参考图标签 → 小红书/微博搜索 → 结果存三级库 → 复核 → 正式入库
// 平台范围：小红书（SSR + 文字预筛 + AI 双模型质检 + 增量写）、微博（关键词搜 + AI 单模型质检）
// CLIP：参考图 image 模式下给结果算视觉相似度，按相似度排序（worker 不可用则降级为纯质量排序）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, inArray, isNotNull, sql } from 'drizzle-orm';
import { searchXhsByKeyword, downloadImage } from '../crawl/xhs.js';
import { searchWeiboByKeyword } from '../crawl/weibo.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth, callGemini, isAiConfigured } from '../tagging/ai.js';
import { embedImage, cosine, isEmbedAvailable } from '../embed/clip.js';
import { SettingsService } from '../settings/settings.service.js';
import { promoteSearchResult } from '../support/promote-helpers.js';

// 正在运行的搜索进程（用于终止）
const runningSearches = new Map<number, boolean>(); // sessionId → aborted?

const MIN_QUALITY = 5; // AI 质检质量分下限
const CONCURRENCY = 6; // 并发 AI 质检数（6 张同时调 Gemini，6 倍速）
const SIM_FLOOR = 0.2; // CLIP 相似度下限（很宽松，只砍明显不相干）
// 文字预筛黑名单：标题/标签含这些词的帖子明显不是绘画作品，跳过不浪费 AI 调用（小红书+微博共用）
const NON_ART_TEXT = ['穿搭','美食','旅游','健身','减肥','化妆','护肤','发型','美甲','自拍','日常','vlog','探店','测评','开箱','装修','家居','宠物','猫','狗','宝宝','育儿','婚礼','毕业','生日','聚会','打卡','旅行','酒店','机票','购物','好物','种草','清单','攻略','教程','菜谱','食谱','运动','跑步','瑜伽','舞蹈','唱歌','翻唱','游戏','直播','抽奖','送','福利','红包','兼职','招聘','租房','二手房','买车','学车','考','证','报','课','AI绘画','AI生成','AI画','Midjourney','midjourney','Stable Diffusion','stable diffusion','SD生成','NovelAI','novelai','DALL-E','dalle','AI插画','AI创作','AI绘图','AI绘图工具','咒语','prompt分享','提示词','正向提示','负向提示','模型分享','LoRA','lora','ControlNet','comfyui','ComfyUI','webui','炼丹','跑图','出图','垫图','图生图','文生图','cosplay','Cosplay','COS','手办','周边','开箱','新闻','热搜','八卦','明星','综艺','电视剧','电影','影评','追剧','演唱会','综艺','选秀','偶像','粉丝','应援','带货','电商','优惠','折扣','秒杀','拼团','团购'];

export class SearchService {
  // 终止搜索
  async abort(sessionId: number) {
    runningSearches.set(sessionId, true);
    await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, aborted: true };
  }

  // 继续搜索：往已有 session 加结果（不创建新记录），用非 genre 标签做关键词找不同帖子
  async continueSearch(sessionId: number) {
    const [session] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    if (!session) throw new Error('会话不存在');
    const tags = (session.searchTags as any)?.tags ?? [];
    if (!tags.length) throw new Error('该会话无标签');
    const referenceId = session.referenceImageId ?? 0;
    const platforms = session.platforms ?? ['xiaohongshu', 'weibo'];
    const fuzzyRatio = (session.searchTags as any)?.fuzzyRatio ?? 0.5;
    // 复用 startSearch 但 keywordMode='all'，不用建新 session——直接改本 session 状态
    runningSearches.set(sessionId, false);
    // 标记为 running（前端看到进度）
    await db.update(schema.searchSessions).set({ status: 'running', doneCount: 0, totalCount: 0 }).where(eq(schema.searchSessions.id, sessionId));
    this.executeSearch(sessionId, { referenceId, tags, platforms, fuzzyRatio, keywordMode: 'all' }, null, null).catch(e => {
      console.error(`[search] 继续搜索 session ${sessionId} 失败: ${e.message}`);
      db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).then(() => {});
    }).finally(() => { runningSearches.delete(sessionId); });
    return { sessionId, status: 'running' };
  }

  // 发起搜索：创建 session → 各平台搜索 → 存结果 → 标记 isNew
  // tags 支持 mode: 'must'(必中，用作搜索关键词) | 'fuzzy'(模糊，达到比例即满足)
  // keywordMode: 'genre'(默认,只用画风标签搜) | 'all'(继续搜索:用所有标签搜,找不同帖子)
  async startSearch(body: {
    referenceId: number;
    tags: { tagId: number; label: string; dimensionId: number | null; mode: 'must' | 'fuzzy' }[];
    platforms?: string[]; fuzzyRatio?: number; keywordMode?: 'genre' | 'all';
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
    const keywordMode = body.keywordMode ?? 'genre';

    // 保留会话自定义名字：executeSearch 会整体覆盖 searchTags JSON，若不带上 name
    // 则「改名后继续搜索」会把名字冲掉。开头快照一次，写入时始终带上。
    const [curSession] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    const sessionName = (curSession?.searchTags as any)?.name;
    const buildTags = (progress: any) => {
      const st: any = { tags: body.tags, fuzzyRatio, progress };
      if (sessionName != null) st.name = sessionName;
      return st;
    };

    // 加载维度表，解析每个标签的顶层 code（genre/technique/...）
    const dims = await db.select().from(schema.tagDimensions);
    const dimById = new Map(dims.map(d => [d.id, d]));
    const rootCodeOf = (dimId: number | null): string => {
      if (!dimId) return '';
      let d = dimById.get(dimId), cur = dimId;
      while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
      return d?.code ?? '';
    };

    // 搜索关键词：所有选中标签空格拼接成一个组合关键词——平台搜索引擎直接返回兼具所有标签的帖，
    // 比逐个搜再 AI 过滤快得多（召回少但精准，AI 调用减少 50%+）。继续搜索用同样关键词（去重保证不重复）。
    const allLabels = body.tags.map((t: any) => t.label).filter(Boolean);
    const searchKeywords = [allLabels.join(' ')];
    // 所有标签都做 AI 过滤确认（平台搜索可能不完美，AI 再验一遍）
    const filterTags = allLabels;
    // fuzzyRatio 控制严格度：1.0=必须全部命中，0.5=至少命中一半
    const requiredMatchCount = Math.ceil(filterTags.length * fuzzyRatio);
    const checkTagFilter = (aiTags: any[]): boolean => {
      if (!filterTags.length || !aiTags.length) return true; // 无过滤标签或无 AI 标签 → 放行
      const aiLabels = new Set(aiTags.map(t => t.label));
      const matchCount = filterTags.filter((label: string) => aiLabels.has(label)).length;
      return matchCount >= requiredMatchCount;
    };

    // 取上一次的结果（用于 isNew 判断）
    const prevResults = prevSession ? await db.select().from(schema.searchResults)
      .where(eq(schema.searchResults.sessionId, prevSession)) : [];
    const prevHashes = new Set<string>(prevResults.map(r => r.imageHash).filter(Boolean) as string[]);
    const prevUrls = new Set<string>(prevResults.map(r => r.sourceUrl).filter(Boolean) as string[]);

    // 共享去重集合：库内已有 hash + 本 session 已有 hash（继续搜索时预加载已有结果，去重）
    const libHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];
    const libHashSet = new Set(libHashes);
    const sessionHashes = new Set<string>();
    // 继续搜索：预加载本 session 已有结果的 hash + url，避免重复入库
    const existingInSession = await db.select({ hash: schema.searchResults.imageHash, url: schema.searchResults.imageUrl, sourceUrl: schema.searchResults.sourceUrl })
      .from(schema.searchResults).where(eq(schema.searchResults.sessionId, sessionId));
    for (const r of existingInSession) {
      if (r.hash) sessionHashes.add(r.hash);
      if (r.url) prevUrls.add(r.url);
      if (r.sourceUrl) prevUrls.add(r.sourceUrl);
    }
    // 本轮搜索内的 sourceUrl 去重（防同帖重复入库，并发处理时尤其需要）
    const seenSourceUrls = new Set<string>(prevUrls);

    // 目标结果数：达到就停（不浪费 AI 调用）。继续搜索时加上已有结果数。
    const targetResults = 300 + existingInSession.length;

    let totalResults = existingInSession.length, newResults = 0;

    for (const platform of platforms) {
      if (totalResults >= targetResults) break; // 达到目标，不再搜下一个平台
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
              await db.update(schema.searchSessions).set({ searchTags: buildTags({ total: progressTotal, processed: 0, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
              let kept = 0, skipNotArt = 0, skipDup = 0, skipLowQ = 0;
              // 并发处理（6 张同时调 AI，6 倍速）
              const processXhs = async (n: any) => {
                if (isAborted() || totalResults >= targetResults) return;
                // sourceUrl 去重：同帖只处理一次（防止 XHS 搜索返回重复帖）
                if (n.sourceUrl && seenSourceUrls.has(n.sourceUrl)) { skipDup++; return; }
                if (n.sourceUrl) seenSourceUrls.add(n.sourceUrl);
                progressProcessed++;
                if (!n.images.length) { skipNotArt++; return; }
                // 文字预筛：标题/标签明显与绘画无关的跳过（不浪费AI调用）
                const noteText = (n.title || '') + ' ' + (n.xhsTags || []).join(' ');
                if (NON_ART_TEXT.some(kw => noteText.includes(kw))) { skipNotArt++; return; }
                let isArtwork = false;
                let quality = 0;
                let aiTags: any[] = [];
                let imageHash: string | null = null;
                let buf: Buffer | null = null;
                try {
                  buf = (await downloadImage(n.images[0])).buf;
                  try { imageHash = await aHash(buf); } catch {}
                  if (imageHash) {
                    if ([...libHashSet].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; return; }
                    if ([...sessionHashes].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; return; }
                    sessionHashes.add(imageHash);
                  }
                  const b64 = buf!.toString('base64');
                  const mime = 'image/jpeg';
                  const gemini = await callGemini(b64, mime, tax.prompt);
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
                if (!isArtwork) { skipNotArt++; return; }
                if (quality < MIN_QUALITY) { skipLowQ++; return; }
                if (filterTags.length && !checkTagFilter(aiTags)) { skipLowQ++; return; }
                let similarity: number | null = null;
                if (useClip && buf) {
                  try { similarity = cosine(refEmbedding!, await embedImage(buf)); }
                  catch { similarity = null; }
                  if (similarity !== null && similarity < SIM_FLOOR) { skipLowQ++; return; }
                }
                kept++;
                // 保存图片到本地（外站 CDN URL 会过期，本地存一份永久可看）
                let localImageUrl = n.images[0] || null;
                if (buf) {
                  try {
                    const uploadsDir = join(process.cwd(), 'uploads');
                    await mkdir(uploadsDir, { recursive: true });
                    const filename = `search-${sessionId}-${progressProcessed}.jpg`;
                    await writeFile(join(uploadsDir, filename), buf);
                    localImageUrl = `/uploads/${filename}`;
                  } catch (e: any) { console.error(`[search] 保存图片失败: ${e.message}`); }
                }
                const dedupKey = n.sourceUrl || n.images[0] || '';
                const isNew = !prevUrls.has(dedupKey) && !(imageHash && prevHashes.has(imageHash));
                await db.insert(schema.searchResults).values({
                  sessionId,
                  referenceImageId: body.referenceId,
                  platform: 'xiaohongshu',
                  sourceUrl: n.sourceUrl || null,
                  imageUrl: localImageUrl,
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
              };
              // 并发批处理（6 张同时）
              for (let i = 0; i < notes.length; i += CONCURRENCY) {
                if (isAborted() || totalResults >= targetResults) break;
                await Promise.all(notes.slice(i, i + CONCURRENCY).map(processXhs));
                await db.update(schema.searchSessions).set({ resultCount: totalResults, newCount: newResults, searchTags: buildTags({ total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
                console.log(`[search] 进度: ${progressProcessed}/${progressTotal} 已处理，保留 ${kept} 张（非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}）`);
              }
              console.log(`[search] 小红书 "${kw}" 筛选完成: 保留 ${kept}，非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}`);
            }
          }
        } else if (platform === 'weibo') {
          const tax = isAiConfigured() ? await loadTaxonomy() : null;
          for (const kw of searchKeywords.length ? searchKeywords : ['插画']) {
            if (isAborted()) { console.log(`[search] session ${sessionId} 已终止`); break; }
            const imgs = await searchWeiboByKeyword(kw, 100);
            console.log(`[search] 微博 "${kw}": ${imgs.length} 张，开始 AI 筛选（增量写入）...`);
            progressTotal += imgs.length;
            await db.update(schema.searchSessions).set({ searchTags: buildTags({ total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
            let kept = 0, skipNotArt = 0, skipDup = 0, skipLowQ = 0;
            const seenNoteIds = new Set<string>();
            // 并发处理（6 张同时调 AI，6 倍速）
            const processWeibo = async (im: any) => {
              if (isAborted() || totalResults >= targetResults) return;
              if (im.noteId && seenNoteIds.has(im.noteId)) return;
              if (im.noteId) seenNoteIds.add(im.noteId);
              // sourceUrl 去重：同帖只处理一次
              const wbSrc = im.sourceUrl || (im.noteId ? `https://m.weibo.cn/status/${im.noteId}` : im.url);
              if (seenSourceUrls.has(wbSrc)) { skipDup++; return; }
              seenSourceUrls.add(wbSrc);
              progressProcessed++;
              let isArtwork = false;
              let quality = 0;
              let skipped = false;
              let aiTags: any[] = [];
              let imageHash: string | null = null;
              let buf: Buffer | null = null;
              if (im.title && NON_ART_TEXT.some(kw => im.title!.includes(kw))) { skipNotArt++; return; }
              try {
                const downloaded = await downloadImage(im.url);
                buf = downloaded.buf;
                const type = downloaded.type;
                try { imageHash = await aHash(buf); } catch {}
                if (imageHash) {
                  if ([...libHashSet].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; return; }
                  if ([...sessionHashes].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) { skipDup++; return; }
                  sessionHashes.add(imageHash);
                }
                if (isAiConfigured() && tax) {
                  const b64 = buf.toString('base64');
                  const gemini = await callGemini(b64, type, tax.prompt);
                  const gParsed = extractJson(gemini);
                  isArtwork = gParsed?.is_artwork === true;
                  quality = Number(gParsed?.quality) || 0;
                  if (isArtwork) {
                    const gIds = normalizeOutput(gParsed, tax.labelMap);
                    const allIds = new Set([...gIds]);
                    const tagRows = allIds.size ? await db.select().from(schema.tags).where(inArray(schema.tags.id, [...allIds])) : [];
                    aiTags = tagRows.map(t => ({ tagId: t.id, label: t.label, dimensionId: t.dimensionId }));
                  }
                } else {
                  skipped = true;
                }
              } catch (e: any) {
                console.error(`[search] 微博图处理失败 "${im.title?.slice(0, 20)}": ${e.message}`);
              }
              if (!skipped) {
                if (!isArtwork) { skipNotArt++; return; }
                if (quality < MIN_QUALITY) { skipLowQ++; return; }
                if (filterTags.length && !checkTagFilter(aiTags)) { skipLowQ++; return; }
              }
              let similarity: number | null = null;
              if (useClip && buf) {
                try { similarity = cosine(refEmbedding!, await embedImage(buf)); }
                catch { similarity = null; }
                if (!skipped && similarity !== null && similarity < SIM_FLOOR) { skipLowQ++; return; }
              }
              kept++;
              let localImageUrl = im.url;
              if (buf) {
                try {
                  const uploadsDir = join(process.cwd(), 'uploads');
                  await mkdir(uploadsDir, { recursive: true });
                  const filename = `search-${sessionId}-${progressProcessed}.jpg`;
                  await writeFile(join(uploadsDir, filename), buf);
                  localImageUrl = `/uploads/${filename}`;
                } catch (e: any) { console.error(`[search] 微博图片保存失败: ${e.message}`); }
              }
              const sourceUrl = im.sourceUrl || (im.noteId ? `https://m.weibo.cn/status/${im.noteId}` : im.url);
              const isNew = !prevUrls.has(sourceUrl) && !(imageHash && prevHashes.has(imageHash));
              await db.insert(schema.searchResults).values({
                sessionId,
                referenceImageId: body.referenceId,
                platform: 'weibo',
                sourceUrl,
                imageUrl: localImageUrl,
                allImages: [im.url],
                imageHash: imageHash || null,
                aiTags: aiTags.length ? aiTags : null,
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
            };
            // 并发批处理（6 张同时）
            for (let i = 0; i < imgs.length; i += CONCURRENCY) {
              if (isAborted() || totalResults >= targetResults) break;
              await Promise.all(imgs.slice(i, i + CONCURRENCY).map(processWeibo));
              await db.update(schema.searchSessions).set({ resultCount: totalResults, newCount: newResults, searchTags: buildTags({ total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
              console.log(`[search] 微博进度: ${progressProcessed}/${progressTotal} 已处理，保留 ${kept} 张（非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}）`);
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
      searchTags: buildTags({ total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString(), elapsedMs: elapsed }),
    }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'search_start', targetType: 'reference', targetId: body.referenceId, summary: `寻源搜索 #${sessionId}：${totalResults} 结果（${newResults} 新增）` });
    return { sessionId, resultCount: totalResults, newCount: newResults };
  }

  // 重命名 session
  async renameSession(sessionId: number, name: string) {
    const [session] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    if (!session) throw new Error('会话不存在');
    const searchTags = session.searchTags as any || {};
    searchTags.name = name;
    await db.update(schema.searchSessions).set({ searchTags }).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, name };
  }

  // 删除单个 session + 其所有结果 + 已下载的图片文件
  async deleteSession(sessionId: number) {
    // promote 时下载的图片文件名是 search-{resultId}-{ts}.ext（见 promoteSearchResult），
    // 前缀嵌的是 result.id 而非 sessionId，所以要先取本 session 所有 result 的 id 再按其匹配删除。
    const results = await db.select({ id: schema.searchResults.id })
      .from(schema.searchResults).where(eq(schema.searchResults.sessionId, sessionId));
    const { readdir, unlink } = await import('node:fs/promises');
    const uploadsDir = join(process.cwd(), 'uploads');
    let deletedFiles = 0;
    if (results.length) {
      const prefixes = results.map(r => `search-${r.id}-`);
      try {
        const files = await readdir(uploadsDir);
        for (const f of files) {
          if (prefixes.some(p => f.startsWith(p))) {
            await unlink(join(uploadsDir, f)).catch(() => {});
            deletedFiles++;
          }
        }
      } catch {}
    }
    const deletedResults = await db.delete(schema.searchResults).where(eq(schema.searchResults.sessionId, sessionId));
    await db.delete(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    return { sessionId, deleted: true, deletedFiles, deletedResults: (deletedResults as any).affectedRows };
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
    const sessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, referenceId)).orderBy(desc(schema.searchSessions.id));
    if (!sessions.length) return sessions;
    // 用实际结果数修正 result_count（中断/失败的 session 可能 result_count=0 但有增量写入的结果）。
    // 单条 GROUP BY 聚合，避免 N+1；running 中的 session 结果数还在变，跳过修正与回写（避免与正在写入的搜索竞争）。
    const counts = await db.select({ sessionId: schema.searchResults.sessionId, n: sql<number>`count(*)` })
      .from(schema.searchResults)
      .where(inArray(schema.searchResults.sessionId, sessions.map(s => s.id)))
      .groupBy(schema.searchResults.sessionId);
    const countMap = new Map(counts.map(c => [c.sessionId, Number(c.n)]));
    for (const s of sessions) {
      if (s.status === 'running') continue;
      const actual = countMap.get(s.id) ?? 0;
      if (actual !== (s.resultCount ?? 0)) {
        await db.update(schema.searchSessions).set({ resultCount: actual }).where(eq(schema.searchSessions.id, s.id));
        s.resultCount = actual;
      }
    }
    return sessions;
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
