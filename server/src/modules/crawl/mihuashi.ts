// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 共享浏览器实例，避免反复启动弹窗
import { chromium, type Browser } from 'playwright';

export type MhsArtwork = { mhsId: number; imageUrl: string; width: number | null; height: number | null };

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  }
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; } }

export async function searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await getBrowser();
  const ctx = await b.newContext();
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
    if (tag) { await tag.click(); } else { await ctx.close(); return []; }
    await p.waitForTimeout(2000);
    for (let i = 0; i < 25 && arts.length < limit; i++) {
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
    }
  } catch (e) {
    // 超时/导航异常也返回已收集的
  } finally {
    await ctx.close();
  }
  return arts.slice(0, limit);
}

// 拉米画师可用画风标签（供前端下拉）
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  const b = await getBrowser();
  const ctx = await b.newContext();
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
  } finally { await ctx.close(); }
  return tags;
}
