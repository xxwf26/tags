// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 打开 /artworks → 点画风标签 → 滚动加载 → 拦截 search API 收集作品图
// 注意：米画师靠 navigator.webdriver + HeadlessChrome 特征识别自动化，识破后 search 接口
// 返回假的"签名错误"403。必须用反检测参数 + 抹掉 webdriver 标志才能过。
// 共享浏览器实例，避免反复启动。
import { chromium, type Browser, type BrowserContext } from 'playwright';

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
  // 串行 + 冷启动重试1次：第一个调用（冷浏览器）偶发被挡返回0，重试1次（热浏览器）即可。
  // 不多重试——连续搜索会被米画师限流返回0或chromium segfault拖垮进程，多重试反而更崩。
  // 被限流返回0时只能等一会儿再搜，不要立即狂重试。
  const arts = await withMhsLock(() => _searchMihuashi(tagName, limit));
  if (!arts.length) { await new Promise(r => setTimeout(r, 2000)); return withMhsLock(() => _searchMihuashi(tagName, limit)); }
  return arts;
}

async function _searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  // 把标签名转成 tag id，直接用 ?tags={id} 导航（画风/类型标签统一走这条路，不再点 DOM）
  const idMap = await getTagIdMap();
  const tagId = idMap.get(tagName);
  if (!tagId) { console.error(`[mihuashi] 未知标签「${tagName}」（不在米画师 43 个官方标签内）`); return []; }

  let ctx: BrowserContext | null = null;
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
  try {
    const b = await getBrowser();
    ctx = await stealthContext(b);
    const p = await ctx.newPage();
    p.on('response', async r => {
      if (r.url().includes('/api/v1/artworks/search')) {
        try {
          const j = JSON.parse(await r.text());
          for (const a of j.artworks || []) {
            if (a.id && !seen.has(a.id)) {
              seen.add(a.id);
              const { author, authorUrl } = extractAuthor(a);
              arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null, author, authorUrl });
            }
          }
        } catch {}
      }
    });
    // 带标签直接进筛选后的列表页；order=1 最新，tags={id} 指定画风/类型
    await p.goto(`https://www.mihuashi.com/artworks?order=1&tags=${tagId}`, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(2000);
    for (let i = 0; i < 25 && arts.length < limit; i++) {
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
    }
  } catch (e: any) {
    // 浏览器断开/超时/导航异常：返回已收集的，不抛（避免拖垮进程）
    console.error(`[mihuashi] "${tagName}" 搜索异常: ${e.message}`);
  } finally {
    if (ctx) try { await ctx.close(); } catch {}
  }
  return arts.slice(0, limit);
}

// 拉米画师可用画风标签（供前端下拉）
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  let ctx: BrowserContext | null = null;
  let tags: any[] = [];
  try {
    const b = await getBrowser();
    ctx = await stealthContext(b);
    const p = await ctx.newPage();
    p.on('response', async r => {
      if (r.url().includes('/api/v1/configure/artwork_tags')) {
        try { const j = JSON.parse(await r.text()); tags = j.artwork_tags || []; } catch {}
      }
    });
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
  } catch (e: any) {
    console.error(`[mihuashi] 拉标签异常: ${e.message}`);
  } finally {
    if (ctx) try { await ctx.close(); } catch {}
  }
  return tags;
}

// 标签名 → tag id 的缓存映射。米画师用 ?tags={id} 参数筛选（画风 skill_tag + 类型 art_category_tag 共用同一套 id），
// 比在页面上点标签按钮稳得多（类型标签藏在未展开下拉里，点不中）。43 个标签基本不变，进程内缓存即可。
let _tagMap: Map<string, number> | null = null;
async function getTagIdMap(): Promise<Map<string, number>> {
  if (_tagMap && _tagMap.size) return _tagMap;   // 已有非空缓存才复用
  const tags = await fetchMihuashiTags();
  // ⚠️ 拉标签失败（冷启动被反爬拦 / 限流 → 返回空）时绝不缓存空 map。
  // 否则空 map 会被永久缓存，之后每次搜索 tagId 都是 undefined → _searchMihuashi 直接空跑返回 0，
  // 表现为「搜索秒结束、0 结果」，且要重启后端才恢复。返回临时空 map，让下次调用重新拉。
  if (!tags.length) { console.error('[mihuashi] 标签映射拉取为空，不缓存，下次调用将重试'); return new Map(); }
  _tagMap = new Map(tags.map(t => [t.name, t.id]));
  return _tagMap;
}

// 用登录态(mhs-auth.json)抓画师主页作品。导航到 profiles/{id} → 页面自己翻页 →
// 拦截 users/{id}/artworks 响应收作品（高清原图 url + width/height）。
// 米画师画师主页接口需登录态，故走 storageState；反检测同 search。
export async function fetchMihuashiArtistWorks(profileId: string, authPath: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: authPath });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
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
  } finally {
    await b.close();
  }
  return arts.slice(0, limit);
}
