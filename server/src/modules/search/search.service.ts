// 寻源搜索（作者中心）：按画风关键词搜小红书 → 按作者聚合 → 爬每个作者主页判断是不是画师号
// → 是画师则存其代表作（tier1，供复核入库建联），路人直接丢弃。目的是「找画师建联」，不管单张画风/质量。
// 微博：新流程不支持（无 authorId / 无主页 SSR 反查），跳过。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and, desc, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { searchXhsByKeyword, downloadImage, buildProfileUrl, fetchProfileNotes } from '../crawl/xhs.js';
import { fetchMihuashiArtworkAuthor, extractMihuashiArtworkId } from '../crawl/mihuashi.js';
import { aHash, hexToNibbles, hammingNib, DEDUP_THRESHOLD } from '../imghash/imghash.js';
import { logOperation } from '../operation/op.js';
import { judgeArtistAccount, isAiConfigured } from '../tagging/ai.js';
import { embedImage, isEmbedAvailable } from '../embed/clip.js';
import { SettingsService } from '../settings/settings.service.js';
import { promoteSearchResult } from '../support/promote-helpers.js';

// 正在运行的搜索进程（用于终止）
const runningSearches = new Map<number, boolean>(); // sessionId → aborted?

const ARTIST_CAP = 60;          // 单次最多反查多少个作者主页（按命中次数降序取 TopK，防爬爆/限流）
const ARTIST_CONCURRENCY = 6;   // 并发爬主页数（判画师号已换更快模型+重试，提到6）
const COVERS_TO_JUDGE = 6;      // 每个作者取主页前 N 张封面给 AI 判是不是画师号
const WORKS_PER_ARTIST = 6;     // 判定为画师后，存其主页前 N 张作品作为代表作
const XHS_RECALL = 300;         // 每个关键词召回帖数（用于聚合作者，非逐张处理）
// 约稿身份词：发这些词的基本是画师本人（或想找画师的甲方，会被"判画师号"兜底剔除）。
// 用来最大范围捞画师——画风词捞"内容"，约稿词捞"画师身份"，互补。
const COMMISSION_KEYWORDS = ['约稿', '画师约稿', '接稿', '商稿', '原画师', '插画约稿', 'lof画手', '画手', '稿件'];
// 文字预筛黑名单：作者昵称/帖子标题含这些词的明显是路人号，聚合阶段就跳过不反查主页（省爬取）
const NON_ART_TEXT = ['穿搭','美食','旅游','健身','减肥','化妆','护肤','发型','美甲','探店','测评','装修','家居','育儿','婚礼','酒店','机票','好物','种草','攻略','菜谱','食谱','瑜伽','翻唱','带货','电商','团购'];

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
    const referenceId = session.referenceImageId ?? null;
    const platforms = session.platforms ?? ['xiaohongshu', 'weibo'];
    const fuzzyRatio = (session.searchTags as any)?.fuzzyRatio ?? 0.5;
    const wideNet = (session.searchTags as any)?.wideNet ?? true;
    // 复用 startSearch 但 keywordMode='all'，不用建新 session——直接改本 session 状态
    runningSearches.set(sessionId, false);
    // 标记为 running（前端看到进度）
    await db.update(schema.searchSessions).set({ status: 'running', doneCount: 0, totalCount: 0 }).where(eq(schema.searchSessions.id, sessionId));
    this.executeSearch(sessionId, { referenceId, tags, platforms, fuzzyRatio, keywordMode: 'all', wideNet }, null, null).catch(e => {
      console.error(`[search] 继续搜索 session ${sessionId} 失败: ${e.message}`);
      db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, sessionId)).then(() => {});
    }).finally(() => { runningSearches.delete(sessionId); });
    return { sessionId, status: 'running' };
  }

  // 发起搜索：创建 session → 各平台搜索 → 存结果 → 标记 isNew
  // tags 支持 mode: 'must'(必中，用作搜索关键词) | 'fuzzy'(模糊，达到比例即满足)
  // keywordMode: 'genre'(默认,只用画风标签搜) | 'all'(继续搜索:用所有标签搜,找不同帖子)
  async startSearch(body: {
    referenceId?: number | null;
    tags: { tagId: number; label: string; dimensionId: number | null; mode: 'must' | 'fuzzy' }[];
    platforms?: string[]; fuzzyRatio?: number; keywordMode?: 'genre' | 'all'; wideNet?: boolean;
  }) {
    // 参考图可选：无图纯标签搜时 referenceId 为 0/undefined/null，统一归一为 null（DB 存 NULL）。
    // 无图会话按"上一次无图会话"链做 prevSession/isNew。
    const refId = body.referenceId ? body.referenceId : null;
    const refCond = refId == null
      ? isNull(schema.searchSessions.referenceImageId)
      : eq(schema.searchSessions.referenceImageId, refId);
    // 先创建 session 返回 sessionId，后台异步执行搜索
    const prevSessions = await db.select().from(schema.searchSessions)
      .where(refCond).orderBy(desc(schema.searchSessions.id));
    const prevSession = prevSessions[0]?.id ?? null;
    const [sr] = await db.insert(schema.searchSessions).values({
      referenceImageId: refId,
      parentSessionId: prevSession,
      searchTags: { tags: body.tags, fuzzyRatio: body.fuzzyRatio ?? 0.5, wideNet: body.wideNet ?? true },
      platforms: body.platforms ?? ['xiaohongshu'],
      status: 'running',
    });
    const sessionId = (sr as any).insertId;

    // CLIP：对参考图算 embedding 存入 session，供结果相似度排序。worker 不可用则跳过（降级纯质量排序）。
    let refEmbedding: number[] | null = null;
    if (isEmbedAvailable() && refId != null) {
      try {
        const [ref] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, refId));
        if (ref?.imageUrl) {
          const refBuf = await readFile(join('uploads', basename(ref.imageUrl)));
          refEmbedding = await embedImage(refBuf);
          await db.update(schema.searchSessions).set({ refEmbedding }).where(eq(schema.searchSessions.id, sessionId));
        }
      } catch (e: any) { console.error(`[search] 参考图 embedding 失败，降级纯质量排序: ${e.message}`); }
    }

    // 就地归一：使 executeSearch 写 result.referenceImageId 时自动落 NULL（无需改 executeSearch）
    body.referenceId = refId;
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
    const platforms = body.platforms ?? ['xiaohongshu'];
    const settingsSvc = new SettingsService();
    const xhsCookie = await settingsSvc.getXhsCookie();
    const fuzzyRatio = body.fuzzyRatio ?? 0.5;
    const wideNet = body.wideNet ?? true; // 约稿广撒网：并行搜约稿身份词，最大范围捞画师

    // 保留会话自定义名字：executeSearch 会整体覆盖 searchTags JSON，若不带上 name
    // 则「改名后继续搜索」会把名字冲掉。开头快照一次，写入时始终带上。
    const [curSession] = await db.select().from(schema.searchSessions).where(eq(schema.searchSessions.id, sessionId));
    const sessionName = (curSession?.searchTags as any)?.name;
    const buildTags = (progress: any) => {
      const st: any = { tags: body.tags, fuzzyRatio, wideNet, progress };
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

    // 搜索关键词：用 genre 画风标签搜（召回量大）。用于聚合作者，非逐张处理。
    const mustGenreTags = body.tags.filter((t: any) => t.mode === 'must' && rootCodeOf(t.dimensionId) === 'genre');
    const allGenreTags = body.tags.filter((t: any) => rootCodeOf(t.dimensionId) === 'genre');
    const searchKeywords = (mustGenreTags.length ? mustGenreTags : allGenreTags).map((t: any) => t.label);

    // 取上一次的结果（用于 isNew 判断）
    const prevResults = prevSession ? await db.select().from(schema.searchResults)
      .where(eq(schema.searchResults.sessionId, prevSession)) : [];
    const prevHashes = new Set<string>(prevResults.map(r => r.imageHash).filter(Boolean) as string[]);
    const prevUrls = new Set<string>(prevResults.map(r => r.sourceUrl).filter(Boolean) as string[]);

    // 作品图去重：库内已有 hash（预解析 nibble 缓存，查表 popcount，避免重复 parseInt 阻塞事件循环）
    const libHashes = (await db.select({ hash: schema.artworks.imageHash })
      .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(a => a.hash).filter(Boolean) as string[];
    const libNibs = libHashes.map(hexToNibbles);
    const sessionNibs: number[][] = []; // 本 session 已存作品图 hash，动态追加
    const isDup = (nib: number[]): boolean =>
      libNibs.some(h => hammingNib(nib, h) <= DEDUP_THRESHOLD) ||
      sessionNibs.some(h => hammingNib(nib, h) <= DEDUP_THRESHOLD);

    // 继续搜索：预加载本 session 已处理过的作者（从 authorUrl 提 user_id）+ 已存作品图 hash，避免重复反查/入库
    const existingInSession = await db.select({ hash: schema.searchResults.imageHash, sourceUrl: schema.searchResults.sourceUrl, authorUrl: schema.searchResults.authorUrl })
      .from(schema.searchResults).where(eq(schema.searchResults.sessionId, sessionId));
    const seenAuthorIds = new Set<string>();
    const profileIdRe = /user\/profile\/([0-9a-zA-Z]+)/;
    for (const r of existingInSession) {
      if (r.hash) sessionNibs.push(hexToNibbles(r.hash));
      if (r.sourceUrl) prevUrls.add(r.sourceUrl);
      const m = r.authorUrl?.match(profileIdRe);
      if (m) seenAuthorIds.add(m[1]);
    }

    let totalResults = existingInSession.length, newResults = 0, keptArtists = 0;
    // 聚合作者总数 / 因超 ARTIST_CAP 未反查的作者数（透出到前端，让用户知道还有多少候选没查，可点"继续搜索"）
    let aggAuthors = 0, droppedByCap = 0;

    // 微博：新流程（作者主页反查画师）不支持，若选了给出提示
    if (platforms.includes('weibo')) console.log('[search] 微博暂不支持"作者中心找画师"流程，已跳过');
    if (!platforms.includes('xiaohongshu')) {
      console.log('[search] 未选择小红书，无可执行平台');
    } else if (!xhsCookie) {
      console.error('[search] 小红书: 未配置 XHS_COOKIE，跳过');
    } else {
      // 召回关键词：画风词 +（广撒网时）约稿身份词。约稿词标记 commission，供排序加权。
      const genreKws = (searchKeywords.length ? searchKeywords : ['插画']).map((k: string) => ({ kw: k, commission: false }));
      const recallKws = wideNet
        ? [...genreKws, ...COMMISSION_KEYWORDS.map(k => ({ kw: k, commission: true }))]
        : genreKws;

      // ── A. 召回各关键词 → 按 authorId 聚合（跨关键词去重，同作者累加命中次数）──
      // fromCommission：该作者是否由约稿词召回（用于排序加权——约稿词命中的画师 hitCount 常为 1，
      // 不加权会被画风高频作者挤出 Top ARTIST_CAP，广撒网就白撒了）。
      type Agg = { authorId: string; nickname: string; hitCount: number; kw: string; fromCommission: boolean };
      const authorMap = new Map<string, Agg>();
      let dropNoId = 0, dropText = 0;
      // 召回阶段进度：搜完一个关键词写一次（这是最慢的阶段，广撒网有 10 个词，2-3 分钟，不能让前端干等）
      const kwTotal = recallKws.length;
      let kwDone = 0;
      await db.update(schema.searchSessions).set({ searchTags: buildTags({ stage: 'recall', kwDone, kwTotal, authorsFound: 0, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
      for (const { kw, commission } of recallKws) {
        if (isAborted()) break;
        const notes = await searchXhsByKeyword(kw, XHS_RECALL, xhsCookie);
        console.log(`[search] 小红书 "${kw}"${commission ? '(约稿词)' : ''}: ${notes.length} 帖，聚合作者中...`);
        for (const n of notes) {
          if (!n.authorId) { dropNoId++; continue; }
          if (seenAuthorIds.has(n.authorId)) continue; // 继续搜索：已处理过的作者跳过
          const g = authorMap.get(n.authorId);
          if (g) { g.hitCount++; if (commission) g.fromCommission = true; continue; }
          // 文字预筛：昵称/标题明显是路人号的，聚合阶段就不收（省一次主页反查）
          const txt = (n.author || '') + ' ' + (n.title || '');
          if (NON_ART_TEXT.some(w => txt.includes(w))) { dropText++; continue; }
          authorMap.set(n.authorId, { authorId: n.authorId, nickname: n.author || '', hitCount: 1, kw, fromCommission: commission });
        }
        kwDone++;
        await db.update(schema.searchSessions).set({ searchTags: buildTags({ stage: 'recall', kwDone, kwTotal, authorsFound: authorMap.size, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
      }

      // ── C. 排序取 Top ARTIST_CAP：约稿来源 +1 加权保底（防被画风高频作者挤掉），再按命中次数降序 ──
      const scoreOf = (a: Agg) => a.hitCount + (a.fromCommission ? 1 : 0);
      const allAuthors = [...authorMap.values()].sort((a, b) => scoreOf(b) - scoreOf(a));
      const authors = allAuthors.slice(0, ARTIST_CAP);
      aggAuthors = allAuthors.length;
      droppedByCap = allAuthors.length - authors.length;
      const commissionCount = authors.filter(a => a.fromCommission).length;
      progressTotal += authors.length;
      console.log(`[search] 聚合得 ${allAuthors.length} 个作者（无id丢 ${dropNoId}，路人词丢 ${dropText}），反查前 ${authors.length} 个（其中约稿词 ${commissionCount}）${droppedByCap ? `（超上限丢 ${droppedByCap}）` : ''}`);
      await db.update(schema.searchSessions).set({ searchTags: buildTags({ stage: 'judge', total: progressTotal, processed: 0, aggAuthors, droppedByCap, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));

      let fileSeq = totalResults; // 作品图文件名序号（continue 时从已有数接续，避免覆盖）
      let dropNotArtist = 0, profileFail = 0, skipNoCover = 0;

      // ── D. 并发(3)反查每个作者主页，判是不是画师号 ──
      const processAuthor = async (a: Agg) => {
        if (isAborted()) return;
        progressProcessed++;
        const url = buildProfileUrl(a.authorId);
        let profile: { nickname: string; items: any[] };
        try {
          profile = await fetchProfileNotes(url);
        } catch (e: any) { profileFail++; console.error(`[search] 主页反查失败 ${a.nickname}: ${e.message}`); return; }
        const items = (profile.items || []).filter(it => it.url);
        if (!items.length) { skipNoCover++; return; }

        // 下载前 N 张封面（索引对齐，失败的留 null）→ 判是不是画师号 + 拿每张质量分
        const coverN = Math.min(COVERS_TO_JUDGE, items.length);
        const coverBufs: (Buffer | null)[] = new Array(coverN).fill(null);
        for (let i = 0; i < coverN; i++) {
          try { coverBufs[i] = (await downloadImage(items[i].url)).buf; } catch {}
        }
        // judge 输入只放下载成功的，记 idxMap 让 qualities 能映回 items 索引
        const judgeIdx: number[] = [];
        const judgeCovers: { b64: string; mime: string }[] = [];
        coverBufs.forEach((b, i) => { if (b) { judgeCovers.push({ b64: b.toString('base64'), mime: 'image/jpeg' }); judgeIdx.push(i); } });
        if (!judgeCovers.length) { skipNoCover++; return; }
        const judge = await judgeArtistAccount(judgeCovers);
        if (!judge.isArtist) { dropNotArtist++; console.log(`[search] 丢弃路人 ${profile.nickname || a.nickname}: ${judge.reason}`); return; }
        // qualities[i] 对应 judgeCovers[i] → items[judgeIdx[i]]；取某 item 的质量分
        const qualityOf = (itemIdx: number): number | null => {
          const j = judgeIdx.indexOf(itemIdx);
          return j >= 0 ? (judge.qualities[j] ?? null) : null;
        };

        // 是画师：存主页前 N 张作品作为代表作（每张一行 search_result）
        // 复用已下载的封面 buf（避免重复下载提速）；allImages 统一存该画师所有代表作的【本地】URL
        let savedForThis = 0;
        const localUrls: string[] = [];
        const rowIds: number[] = [];
        const storeN = Math.min(WORKS_PER_ARTIST, items.length);
        const uploadsDir = join(process.cwd(), 'uploads');
        for (let i = 0; i < storeN; i++) {
          if (isAborted()) break;
          try {
            const buf = coverBufs[i] ?? (await downloadImage(items[i].url)).buf; // 复用封面，缺失才现下
            let imageHash: string | null = null;
            try { imageHash = await aHash(buf); } catch {}
            if (imageHash) {
              const nib = hexToNibbles(imageHash);
              if (isDup(nib)) continue; // 该作品已在库/session
              sessionNibs.push(nib);
            }
            await mkdir(uploadsDir, { recursive: true });
            const filename = `search-${sessionId}-${++fileSeq}.jpg`;
            await writeFile(join(uploadsDir, filename), buf);
            const localUrl = `/uploads/${filename}`;
            const isNew = !(imageHash && prevHashes.has(imageHash));
            const [ins] = await db.insert(schema.searchResults).values({
              sessionId,
              referenceImageId: body.referenceId,
              platform: 'xiaohongshu',
              sourceUrl: items[i].url,
              imageUrl: localUrl,
              allImages: [localUrl], // 先占位，循环结束后统一回填该画师全部本地URL
              aiTags: [{ isArtist: true, artRatio: judge.artRatio, style: judge.style, reason: judge.reason }] as any,
              imageHash: imageHash || null,
              similarity: null,
              quality: qualityOf(i), // AI 给的代表作质量分，用于排序（item 2）
              title: items[i].title || profile.nickname || a.nickname,
              author: profile.nickname || a.nickname || null,
              authorUrl: url,
              tags: [a.kw],
              isNew: isNew ? 1 : 0,
              tier: 'tier1',
            });
            localUrls.push(localUrl);
            rowIds.push((ins as any).insertId);
            totalResults++; savedForThis++;
            if (isNew) newResults++;
          } catch (e: any) { console.error(`[search] 存作品失败: ${e.message}`); }
        }
        // 回填：该画师所有代表作行共享同一份本地URL列表，查看器翻图才能在画师内切换
        if (rowIds.length) {
          await db.update(schema.searchResults).set({ allImages: localUrls }).where(inArray(schema.searchResults.id, rowIds));
        }
        if (savedForThis) keptArtists++;
        // 轻微限速，降低主页密集访问被限流的概率
        await new Promise(r => setTimeout(r, 200 + Math.floor(progressProcessed % 5) * 80));
      };

      // 并发批处理（3 个作者主页同时）
      for (let i = 0; i < authors.length; i += ARTIST_CONCURRENCY) {
        if (isAborted()) break;
        await Promise.all(authors.slice(i, i + ARTIST_CONCURRENCY).map(processAuthor));
        await db.update(schema.searchSessions).set({ resultCount: totalResults, newCount: newResults, searchTags: buildTags({ stage: 'judge', total: progressTotal, processed: progressProcessed, artists: keptArtists, aggAuthors, droppedByCap, startTime: new Date(progressStart).toISOString() }) }).where(eq(schema.searchSessions.id, sessionId));
        console.log(`[search] 进度: ${progressProcessed}/${progressTotal} 作者，画师 ${keptArtists}（路人 ${dropNotArtist}，主页失败 ${profileFail}，无封面 ${skipNoCover}）`);
      }
      console.log(`[search] 小红书完成: 画师 ${keptArtists} 人 / ${totalResults} 作品（路人 ${dropNotArtist}，主页失败 ${profileFail}，无封面 ${skipNoCover}）`);
    }

    // 最终更新：包含进度信息（前端算百分比/ETA用）+ 画师数写入 progress 供前端展示
    const elapsed = Date.now() - progressStart;
    await db.update(schema.searchSessions).set({
      status: 'ok', resultCount: totalResults, newCount: newResults,
      searchTags: buildTags({ total: progressTotal, processed: progressProcessed, startTime: new Date(progressStart).toISOString(), elapsedMs: elapsed, artists: keptArtists, aggAuthors, droppedByCap }),
    }).where(eq(schema.searchSessions.id, sessionId));
    await logOperation({ type: 'search_start', targetType: 'reference', targetId: body.referenceId, summary: `寻源搜索 #${sessionId}：${keptArtists} 位画师 / ${totalResults} 作品（${newResults} 新增）` });
    return { sessionId, resultCount: totalResults, newCount: newResults, artists: keptArtists };
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

  // 删除参考图的所有 session + 结果（清空历史）。referenceId=0/无 → 清无图会话（IS NULL）。
  async deleteAllSessions(referenceId: number) {
    const refCond = referenceId
      ? eq(schema.searchSessions.referenceImageId, referenceId)
      : isNull(schema.searchSessions.referenceImageId);
    const sessions = await db.select().from(schema.searchSessions).where(refCond);
    for (const s of sessions) {
      await db.delete(schema.searchResults).where(eq(schema.searchResults.sessionId, s.id));
    }
    await db.delete(schema.searchSessions).where(refCond);
    return { referenceId, deletedSessions: sessions.length };
  }

  async listSessions(referenceId: number) {
    const refCond = referenceId
      ? eq(schema.searchSessions.referenceImageId, referenceId)
      : isNull(schema.searchSessions.referenceImageId);
    const sessions = await db.select().from(schema.searchSessions)
      .where(refCond).orderBy(desc(schema.searchSessions.id));
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

  // 结果按画师聚合：把一个 session 的结果按 author 归组，产出「候选画师清单」——寻源的真实目标。
  // 每个画师一组：作者名、主页链接、代表作、画风关键词、AI 判定的 artRatio。仿 discover.resultsByArtist。
  async resultsByArtist(sessionId: number, tier?: string) {
    const rows = await this.listResults(sessionId, tier);
    const groups = new Map<string, {
      author: string | null; authorUrl: string | null; platform: string | null;
      count: number; artRatio: number | null; style: string; styleTags: string[]; results: any[];
      alreadyInLibrary: boolean;
    }>();
    for (const r of rows) {
      const key = r.authorUrl || r.author?.trim() || '__unknown__';
      let g = groups.get(key);
      if (!g) { g = { author: r.author?.trim() || null, authorUrl: r.authorUrl ?? null, platform: r.platform, count: 0, artRatio: null, style: '', styleTags: [], results: [], alreadyInLibrary: false }; groups.set(key, g); }
      g.count++;
      g.results.push(r);
      // 代表作按 AI 质量分降序（quality 高的排前展示），null 当 0
      g.results.sort((a: any, b: any) => (b.quality ?? 0) - (a.quality ?? 0));
      if (!g.authorUrl && r.authorUrl) g.authorUrl = r.authorUrl;
      // 从 aiTags 里取 AI 判定的画师作品占比 + 主页画风概括（新流程存 [{isArtist,artRatio,style,reason}]）
      const tag0 = (r.aiTags as any[])?.[0];
      const ar = tag0?.artRatio;
      if (typeof ar === 'number' && (g.artRatio == null || ar > g.artRatio)) g.artRatio = ar;
      if (!g.style && tag0?.style) g.style = String(tag0.style);
      for (const t of (r.tags as string[] | null) || []) if (t && !g.styleTags.includes(t)) g.styleTags.push(t);
    }
    // 跨 session 去重标记：查 artists 表，名字或主页链接已存在的画师标 alreadyInLibrary，
    // 避免对已入库画师重复建联。匹配靠 name 精确 + links 里收集的 URL 集合。
    const libArtists = await db.select({ name: schema.artists.name, links: schema.artists.links }).from(schema.artists);
    const nameSet = new Set(libArtists.map(a => (a.name || '').trim()).filter(Boolean));
    const urlSet = new Set<string>();
    for (const a of libArtists) {
      const links = a.links as Record<string, string[]> | null;
      if (links) for (const urls of Object.values(links)) if (Array.isArray(urls)) for (const u of urls) if (u) urlSet.add(u);
    }
    for (const g of groups.values()) {
      g.alreadyInLibrary = !!(g.author && nameSet.has(g.author.trim())) || !!(g.authorUrl && urlSet.has(g.authorUrl));
    }
    // 有署名的按代表作数降序在前，未知作者组固定垫底
    return [...groups.values()].sort((a, b) => {
      if (!a.author && b.author) return 1;
      if (a.author && !b.author) return -1;
      return b.count - a.count;
    });
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

  // 取米画师结果的画师主页：列表接口不返回画师，按需从作品详情接口补。
  // 已有 authorUrl 直接返回（缓存）；否则从 sourceUrl 抠 artworkId → fetchMihuashiArtworkAuthor → 回填行。
  async fetchMhsAuthor(id: number): Promise<{ author: string | null; authorUrl: string | null }> {
    const [r] = await db.select().from(schema.searchResults).where(eq(schema.searchResults.id, id));
    if (!r) throw new Error('结果不存在');
    if (r.authorUrl) return { author: r.author, authorUrl: r.authorUrl };
    const artworkId = r.sourceUrl ? extractMihuashiArtworkId(r.sourceUrl) : null;
    if (!artworkId) return { author: r.author, authorUrl: null };
    const { author, authorUrl } = await fetchMihuashiArtworkAuthor(artworkId);
    if (author || authorUrl) {
      await db.update(schema.searchResults).set({ author: author ?? r.author, authorUrl: authorUrl ?? r.authorUrl }).where(eq(schema.searchResults.id, id));
    }
    return { author: author ?? r.author, authorUrl };
  }

  // 批量补全一个 session 内米画师结果的画师名+主页：串行抓 + 节流，防米画师反爬限流。
  // 后台异步执行（fire-and-forget），立即返回待补数量；前端轮询结果列表看进度。
  async fillSessionMhsAuthors(sessionId: number): Promise<{ started: true; pending: number }> {
    const rows = await db.select({ id: schema.searchResults.id, sourceUrl: schema.searchResults.sourceUrl, author: schema.searchResults.author, authorUrl: schema.searchResults.authorUrl })
      .from(schema.searchResults)
      .where(and(eq(schema.searchResults.sessionId, sessionId), eq(schema.searchResults.platform, 'mihuashi')));
    const pending = rows.filter(r => !r.author && !r.authorUrl);
    // 后台串行补全，不阻塞响应
    (async () => {
      for (const r of pending) {
        const artworkId = r.sourceUrl ? extractMihuashiArtworkId(r.sourceUrl) : null;
        if (!artworkId) continue;
        try {
          const { author, authorUrl } = await fetchMihuashiArtworkAuthor(artworkId);
          if (author || authorUrl) {
            await db.update(schema.searchResults).set({ author: author ?? r.author, authorUrl: authorUrl ?? r.authorUrl }).where(eq(schema.searchResults.id, r.id));
          }
        } catch (e: any) { console.error(`[search] 批量补画师 ${r.id} 失败: ${e.message}`); }
        await new Promise(res => setTimeout(res, 800)); // 节流：每次间隔 0.8s 防限流
      }
      console.log(`[search] session ${sessionId} 画师名补全完成，共 ${pending.length} 张`);
    })();
    return { started: true as const, pending: pending.length };
  }
}
