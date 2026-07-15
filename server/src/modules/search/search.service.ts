// 寻源搜索：参考图标签 → 多平台搜索 → 结果存三级库 → 复核 → 正式入库
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, inArray, isNotNull } from 'drizzle-orm';
import { searchMihuashi } from '../crawl/mihuashi.js';
import { searchXhsByKeyword, downloadImage } from '../crawl/xhs.js';
import { searchWeiboByKeyword } from '../crawl/weibo.js';
import { searchBaiduImages } from '../crawl/baidu.js';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth } from '../tagging/ai.js';

export class SearchService {
  // 发起搜索：创建 session → 各平台搜索 → 存结果 → 标记 isNew
  // tags 支持 mode: 'must'(必中，用作搜索关键词) | 'fuzzy'(模糊，达到比例即满足)
  async startSearch(body: {
    referenceId: number;
    tags: { tagId: number; label: string; dimensionId: number | null; mode: 'must' | 'fuzzy' }[];
    platforms?: string[]; fuzzyRatio?: number;
  }) {
    const platforms = body.platforms ?? ['xiaohongshu'];
    const xhsCookie = process.env.XHS_COOKIE || '';
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

    // 必中的 genre 画风标签 → 米画师搜索关键词
    const mustGenreTags = body.tags.filter(t => t.mode === 'must' && rootCodeOf(t.dimensionId) === 'genre');
    // 如果没有必中 genre，退而用所有 genre 标签（含模糊）
    const allGenreTags = body.tags.filter(t => rootCodeOf(t.dimensionId) === 'genre');
    const searchKeywords = (mustGenreTags.length ? mustGenreTags : allGenreTags).map(t => t.label);

    // 找上一次 session（迭代链）
    const prevSessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, body.referenceId)).orderBy(desc(schema.searchSessions.id));
    const prevSession = prevSessions[0]?.id ?? null;

    // 创建新 session（存标签快照 + 模糊比例）
    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: body.referenceId,
      parentSessionId: prevSession,
      searchTags: { tags: body.tags, fuzzyRatio },
      platforms,
      status: 'running',
    });
    const sessionId = (sr as any).insertId;

    // 取上一次的结果（用于 isNew 判断）
    const prevResults = prevSession ? await db.select().from(schema.searchResults)
      .where(eq(schema.searchResults.sessionId, prevSession)) : [];
    const prevHashes = new Set(prevResults.map(r => r.imageHash).filter(Boolean));
    const prevUrls = new Set(prevResults.map(r => r.sourceUrl).filter(Boolean));

    let totalResults = 0, newResults = 0;

    for (const platform of platforms) {
      let items: { imageUrl: string; title?: string | null; author?: string | null; sourceUrl?: string; tags?: string[] }[] = [];
      try {
        if (platform === 'baidu') {
          // 百度图片：免登录 JSON API，最可靠
          const keywords = searchKeywords.length ? searchKeywords : ['插画'];
          for (const kw of keywords) {
            const imgs = await searchBaiduImages(kw, 20);
            console.log(`[search] 百度 "${kw}": ${imgs.length} 张`);
            items.push(...imgs.map(im => ({
              imageUrl: im.imageUrl, title: im.title || `百度·${kw}`, author: null, sourceUrl: im.sourceUrl || im.imageUrl, tags: [kw],
            })));
          }
        } else if (platform === 'mihuashi') {
          const keywords = searchKeywords.length ? searchKeywords : ['日系'];
          for (const kw of keywords) {
            const arts = await searchMihuashi(kw, 15);
            console.log(`[search] 米画师 "${kw}": ${arts.length} 张`);
            items.push(...arts.map(a => ({
              imageUrl: a.imageUrl, title: `米画师·${kw}`, author: null, sourceUrl: a.imageUrl, tags: [kw],
            })));
          }
        } else if (platform === 'xiaohongshu') {
          if (!xhsCookie) { console.error('[search] 小红书: 未配置 XHS_COOKIE，跳过'); }
          else {
            const keywords = searchKeywords.length ? searchKeywords : ['插画'];
            const tax = await loadTaxonomy();
            // 预加载维度表（rootCode 判定用）
            const dims = await db.select().from(schema.tagDimensions);
            const dimById = new Map(dims.map(d => [d.id, d]));
            const rootCodeOf = (dimId: number): string => {
              let d = dimById.get(dimId), cur = dimId;
              while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
              return d?.code ?? '';
            };
            // 预加载库内已有 hash（去重用）
            const libHashes = (await db.select({ hash: schema.artworks.imageHash })
              .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];
            const libHashSet = new Set(libHashes);
            // 本 session 内已收集的 hash（同 session 去重）
            const sessionHashes = new Set<string>();

            for (const kw of keywords) {
              const notes = await searchXhsByKeyword(kw, 100, xhsCookie);
              console.log(`[search] 小红书 "${kw}": ${notes.length} 帖，开始 AI 筛选...`);
              let kept = 0, skipNotArt = 0, skipDup = 0, skipLowQ = 0;
              for (const n of notes) {
                if (!n.images.length) { skipNotArt++; continue; }
                // AI 判断：是否绘画作品 + 质量分
                let isArtwork = false;
                let quality = 0;
                let aiTags: any[] = [];
                let imageHash: string | null = null;
                try {
                  const { buf } = await downloadImage(n.images[0]);
                  // pHash 去重：与库内 + 同 session 比对
                  try { imageHash = await aHash(buf); } catch {}
                  if (imageHash) {
                    // 与库内已有作品去重（汉明距离 ≤5 = 近重复）
                    if ([...libHashSet].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) {
                      skipDup++; continue;
                    }
                    // 同 session 去重
                    if ([...sessionHashes].some(h => hamming(imageHash!, h) <= DEDUP_THRESHOLD)) {
                      skipDup++; continue;
                    }
                    sessionHashes.add(imageHash);
                  }
                  // AI 打标 + 质量判断
                  const b64 = buf.toString('base64');
                  const mime = 'image/jpeg';
                  const { gemini, doubao } = await callBoth(b64, mime, tax.prompt);
                  const gIds = normalizeOutput(extractJson(gemini), tax.labelMap);
                  const dIds = normalizeOutput(extractJson(doubao), tax.labelMap);
                  const allIds = new Set([...gIds, ...dIds]);
                  const tagRows = allIds.size ? await db.select().from(schema.tags).where(inArray(schema.tags.id, [...allIds])) : [];
                  aiTags = tagRows.map(t => ({ tagId: t.id, label: t.label, dimensionId: t.dimensionId, rootCode: rootCodeOf(t.dimensionId) }));
                  isArtwork = aiTags.some(t => t.rootCode === 'genre');
                  // 质量分：两模型都选了 genre 标签 = 高质量(8)；一方选 = 中(5)；都没 genre = 低(2)
                  const gGenre = [...gIds].some(id => { const t = tagRows.find(x => x.id === id); return t && rootCodeOf(t.dimensionId) === 'genre'; });
                  const dGenre = [...dIds].some(id => { const t = tagRows.find(x => x.id === id); return t && rootCodeOf(t.dimensionId) === 'genre'; });
                  quality = (gGenre && dGenre) ? 8 : (gGenre || dGenre) ? 5 : 2;
                } catch (e: any) {
                  console.error(`[search] AI判断失败 "${n.title?.slice(0, 20)}": ${e.message}`);
                }
                // 闸门1：必须是绘画作品
                if (!isArtwork) { skipNotArt++; continue; }
                // 闸门2：质量分 ≥5
                if (quality < 5) { skipLowQ++; continue; }
                kept++;
                items.push({
                  imageUrl: n.images[0] || '',
                  title: n.title || kw,
                  author: n.author || null,
                  sourceUrl: n.sourceUrl,
                  tags: n.xhsTags || [],
                  allImages: n.images,
                  aiTags,
                  imageHash,
                  quality,
                } as any);
              }
              console.log(`[search] 小红书 "${kw}" 筛选完成: 保留 ${kept}，非绘画 ${skipNotArt}，低质 ${skipLowQ}，重复 ${skipDup}`);
            }
          }
        } else if (platform === 'weibo') {
          const keywords = searchKeywords.length ? searchKeywords : ['插画'];
          for (const kw of keywords) {
            const imgs = await searchWeiboByKeyword(kw, 15);
            console.log(`[search] 微博 "${kw}": ${imgs.length} 张`);
            items.push(...imgs.map(im => ({
              imageUrl: im.url, title: im.title || `微博·${kw}`, author: null, sourceUrl: im.url, tags: [kw],
            })));
          }
        }
      } catch (e: any) {
        console.error(`[search] ${platform} 失败: ${e.message}`);
      }

      // 去重 + 存结果（按 sourceUrl 去重，imageUrl 空也存）
      const seen = new Set<string>();
      for (const item of items) {
        const dedupKey = item.sourceUrl || item.imageUrl || '';
        if (!dedupKey || seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const isNew = !prevUrls.has(dedupKey) && !prevHashes.has(item.imageUrl || '');
        const [rr] = await db.insert(schema.searchResults).values({
          sessionId,
          referenceImageId: body.referenceId,
          platform,
          sourceUrl: item.sourceUrl || null,
          imageUrl: item.imageUrl || null,
          allImages: (item as any).allImages || null,
          aiTags: (item as any).aiTags || null,
          imageHash: (item as any).imageHash || null,
          title: item.title || null,
          author: item.author || null,
          tags: item.tags || [],
          isNew: isNew ? 1 : 0,
          tier: 'tier1',
        });
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
