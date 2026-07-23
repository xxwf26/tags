// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 打开 /artworks → 点画风标签 → 滚动加载 → 拦截 search API 收集作品图
// 注意：米画师靠 navigator.webdriver + HeadlessChrome 特征识别自动化，识破后 search 接口
// 返回假的"签名错误"403。必须用反检测参数 + 抹掉 webdriver 标志才能过。
// 共享浏览器实例，避免反复启动。
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export type MhsArtwork = { mhsId: number; imageUrl: string; width: number | null; height: number | null; author: string | null; authorUrl: string | null };

// 从 search API 响应的单条作品里尽力提取画师名/主页（字段名跨版本不稳，多候选兜底）
function extractAuthor(a: any): { author: string | null; authorUrl: string | null } {
  const u = a?.author || a?.user || a?.painter || a?.creator || null;
  const author = a?.author_name || a?.nickname || u?.name || u?.nickname || u?.username || null;
  const pid = a?.author_id || a?.user_id || u?.id || u?.profile_id || null;
  return {
    author: author ? String(author).trim() : null,
    authorUrl: pid ? `https://www.mihuashi.com/profiles/${pid}` : null,
  };
}

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    try {
      _browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
    } catch (e: any) {
      _browser = null;
      throw new Error(`米画师浏览器启动失败（chromium 内核缺失或环境异常）: ${e.message}`);
    }
    // 浏览器意外崩溃时清空单例，下次调用会重新 launch，避免复用死实例连锁失败
    _browser.on('disconnected', () => { _browser = null; });
  }
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; } }

// 从米画师主页链接提取 profileId：https://www.mihuashi.com/profiles/290450
export function extractMihuashiProfileId(url: string): string | null {
  const m = String(url || '').match(/mihuashi\.com\/profiles\/(\d+)/);
  return m ? m[1] : null;
}

// 建带反检测的 context：去掉 HeadlessChrome 特征与 navigator.webdriver
async function stealthContext(b: Browser): Promise<BrowserContext> {
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  return ctx;
}

// 串行锁：米画师搜索共享浏览器实例 + 反爬，并发会互相挤掉导致都 0 结果。
// 多个发现 session 并行寻源时，米画师搜索在此排队（一次一个），微博/小红书不受影响仍并发。
let _mhsLock: Promise<unknown> = Promise.resolve();
function withMhsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _mhsLock.then(fn, fn);
  _mhsLock = next.then(() => undefined, () => undefined);
  return next as Promise<T>;
}

export async function searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  // 走独立子进程（src/scripts/mhs-search.mts）：米画师 chromium 在 Windows 反复用会原生 segfault，
  // 子进程隔离后 segfault 只杀子进程，主服务不受影响。tagName→tagId 在主进程查（缓存的 getTagIdMap），
  // tagId(数字)走 argv 传给子进程（无中文编码问题）。串行锁 + 冷启动重试1次。
  const idMap = await getTagIdMap();
  const tagId = idMap.get(tagName);
  if (!tagId) { console.error(`[mihuashi] 未知标签「${tagName}」（不在米画师 43 个官方标签内）`); return []; }

  const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-search.mts');
  const runOnce = (): Promise<MhsArtwork[]> => new Promise((resolve) => {
    // 用 execFile（同 xhs-search 模式）：避免 spawn+setTimeout 在 Node24 Windows 触发 libuv 句柄竞争崩溃
    execFile(process.execPath, ['--import', 'tsx', scriptPath, String(tagId), String(limit)], {
      maxBuffer: 50 * 1024 * 1024, timeout: 120000, windowsHide: true,
    }, (err: any, stdout: any) => {
      if (err) { console.error(`[mhs] 子进程搜索 "${tagName}" 失败: ${err.message}`); resolve([]); return; }
      try { resolve((JSON.parse(stdout).arts || []) as MhsArtwork[]); }
      catch { resolve([]); }
    });
  });

  const arts = await withMhsLock(runOnce);
  if (!arts.length) { await new Promise(r => setTimeout(r, 2000)); return withMhsLock(runOnce); }
  return arts;
}

// 取单个作品的画师信息（name + 主页）。米画师作品列表接口不返回画师，只有详情接口
// /api/v1/artworks/{id} 的 artwork.author 才有。入库(promote)时按需补画师用（方案乙）。
// 走子进程 mhs-artwork-detail.mts + 串行锁（与 searchMihuashi 共享，避免并发挤爆反爬）。
export async function fetchMihuashiArtworkAuthor(artworkId: string | number): Promise<{ author: string | null; authorUrl: string | null }> {
  const id = String(artworkId).trim();
  if (!id || !/^\d+$/.test(id)) return { author: null, authorUrl: null };
  const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-artwork-detail.mts');
  const runOnce = (): Promise<{ author: string | null; authorUrl: string | null }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', scriptPath, id], {
      maxBuffer: 8 * 1024 * 1024, timeout: 90000, windowsHide: true,
    }, (err: any, stdout: any) => {
      if (err) { console.error(`[mhs] 取作品 ${id} 画师失败: ${err.message}`); resolve({ author: null, authorUrl: null }); return; }
      try { const j = JSON.parse(stdout); resolve({ author: j.author ?? null, authorUrl: j.authorUrl ?? null }); }
      catch { resolve({ author: null, authorUrl: null }); }
    });
  });
  return withMhsLock(runOnce);
}

// 从米画师作品页 URL 抠作品 id：https://www.mihuashi.com/artworks/36711276
export function extractMihuashiArtworkId(url: string): string | null {
  const m = String(url || '').match(/mihuashi\.com\/artworks\/(\d+)/);
  return m ? m[1] : null;
}

// 拉米画师可用画风标签（供前端下拉 + getTagIdMap）。走子进程 mhs-tags.mts：chromium segfault 只杀子进程不拖垮主服务。
// 进程内缓存 10 分钟。
let _tagsCache: { data: { id: number; name: string; type: string }[]; ts: number } | null = null;
const TAGS_TTL = 10 * 60 * 1000;
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  if (_tagsCache && Date.now() - _tagsCache.ts < TAGS_TTL) return _tagsCache.data;
  const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-tags.mts');
  const data: { id: number; name: string; type: string }[] = await new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', scriptPath], {
      maxBuffer: 10 * 1024 * 1024, timeout: 90000, windowsHide: true,
    }, (err: any, stdout: any) => {
      if (err) { console.error(`[mhs] 拉标签子进程失败: ${err.message}`); resolve([]); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
  if (data.length) _tagsCache = { data, ts: Date.now() };
  return data;
}

// 标签名 → tag id 的缓存映射。米画师用 ?tags={id} 参数筛选（画风 skill_tag + 类型 art_category_tag 共用同一套 id），
// 比在页面上点标签按钮稳得多（类型标签藏在未展开下拉里，点不中）。43 个标签基本不变，进程内缓存即可。
// 硬编码兜底：子进程拉标签失败（chromium 崩/超时/反爬）时用这套映射，不让搜索因映射空而全挂。
const FALLBACK_TAG_MAP: Record<string, number> = {
  // 画风（skill_tag）
  '日系': 3, '平涂': 44, '萌系': 164, '厚涂': 16, '赛璐璐': 1, '古风': 70, '中国风': 166,
  '童趣': 940, '写实系': 9136, '韩系': 382, '少女漫画': 1391, '欧美系': 9645, '水彩': 80,
  '美式卡通': 161, '白描': 795, '科幻风': 11346, '像素风': 953, '水墨': 192, '硬派': 2390,
  // 类型（art_category_tag）
  '头像': 8, '插图': 134, 'Q版': 51, '自设/OC': 11348, '立绘': 68, '角色设计': 313,
  '壁纸': 337, '封面': 187, '场景': 46, '海报': 126, '概念设计': 674, '印花': 593,
  '图标': 938, 'Live2D': 5006, 'CG': 106, '和纸胶带': 231, '像素图': 1719, '卡牌': 432,
  '条漫': 37, 'UI': 937, '版型': 11345, '分镜': 811, '抱枕': 11347, '特效': 3001,
};
let _tagMap: Map<string, number> | null = null;
async function getTagIdMap(): Promise<Map<string, number>> {
  if (_tagMap && _tagMap.size) return _tagMap;   // 已有非空缓存才复用
  const tags = await fetchMihuashiTags();
  if (!tags.length) {
    // 拉标签失败（冷启动被反爬拦/限流/chromium 崩）→ 用硬编码兜底，不让搜索全挂
    console.error('[mihuashi] 标签映射拉取为空，用硬编码兜底');
    _tagMap = new Map(Object.entries(FALLBACK_TAG_MAP));
    return _tagMap;
  }
  _tagMap = new Map(tags.map(t => [t.name, t.id]));
  return _tagMap;
}

// 用登录态(mhs-auth.json)抓画师主页作品。导航到 profiles/{id} → 页面自己翻页 →
// 拦截 users/{id}/artworks 响应收作品（高清原图 url + width/height）。
// 米画师画师主页接口需登录态，故走 storageState；反检测同 search。
export async function fetchMihuashiArtistWorks(profileId: string, authPath: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
  try {
    // newContext/newPage/addInitScript 放进 try：storageState 文件损坏等异常时仍能在 finally 关掉浏览器，避免 chromium 进程泄漏。
    const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: authPath });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const p = await ctx.newPage();
    p.on('response', async r => {
      // 仅收该画师自己的作品列表（users/{profileId}/artworks），排除登录账号的 dashboard 请求
      if (r.url().includes(`/api/v1/users/${profileId}/artworks`)) {
        try {
          const j = JSON.parse(await r.text());
          for (const a of j.artworks || []) {
            if (a.id && a.url && !seen.has(a.id)) {
              seen.add(a.id);
              const { author, authorUrl } = extractAuthor(a);
              arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null, author, authorUrl });
            }
          }
        } catch {}
      }
    });
    try {
      await p.goto(`https://www.mihuashi.com/profiles/${profileId}`, { waitUntil: 'networkidle', timeout: 45000 });
      await p.waitForTimeout(3000);
      // 翻页：滚到底触发下一页，直到收够或无新增
      let stagnant = 0;
      for (let i = 0; i < 30 && arts.length < limit && stagnant < 3; i++) {
        const before = arts.length;
        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await p.waitForTimeout(1500);
        stagnant = arts.length === before ? stagnant + 1 : 0;
      }
    } catch (e) {
      // 超时也返回已收集的
    }
  } finally {
    await b.close();
  }
  return arts.slice(0, limit);
}
