// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 打开 /artworks → 点画风标签 → 滚动加载 → 拦截 search API 收集作品图
// 注意：米画师靠 navigator.webdriver + HeadlessChrome 特征识别自动化，识破后 search 接口
// 返回假的"签名错误"403。必须用反检测参数 + 抹掉 webdriver 标志才能过。
import { chromium, type Browser, type BrowserContext } from 'playwright';

export type MhsArtwork = { mhsId: number; imageUrl: string; width: number | null; height: number | null };

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

export async function searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  const ctx = await stealthContext(b);
  const p = await ctx.newPage();
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
  p.on('response', async r => {
    if (r.url().includes('/api/v1/artworks/search')) {
      try {
        const j = JSON.parse(await r.text());
        for (const a of j.artworks || []) {
          if (a.id && !seen.has(a.id)) {
            seen.add(a.id);
            arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null });
          }
        }
      } catch {}
    }
  });
  try {
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
    const tag = await p.$(`text=${tagName}`).catch(() => null);
    if (tag) { await tag.click(); } else { await b.close(); return []; }
    await p.waitForTimeout(2000);
    for (let i = 0; i < 25 && arts.length < limit; i++) {
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
    }
  } catch (e) {
    // 超时/导航异常也返回已收集的
  } finally {
    await b.close();
  }
  return arts.slice(0, limit);
}

// 拉米画师可用画风标签（供前端下拉）
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  const ctx = await stealthContext(b);
  const p = await ctx.newPage();
  let tags: any[] = [];
  p.on('response', async r => {
    if (r.url().includes('/api/v1/configure/artwork_tags')) {
      try { const j = JSON.parse(await r.text()); tags = j.artwork_tags || []; } catch {}
    }
  });
  try {
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
  } finally { await b.close(); }
  return tags;
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
            arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null });
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
