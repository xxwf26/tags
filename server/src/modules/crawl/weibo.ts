// 微博移动端主页抓取（playwright 无头浏览器）—— 无需登录
// 打开 m.weibo.cn/u/{uid} 获取访客 cookie + containerid，翻页 getIndex 收集微博配图（mw2000 大图）
import { chromium, type Browser } from 'playwright';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export function extractWeiboUid(url: string): string | null {
  const m = String(url || '').match(/weibo\.com\/u\/(\d+)/) || String(url || '').match(/m\.weibo\.cn\/u\/(\d+)/) || String(url || '').match(/\/(\d{6,})/);
  return m ? m[1] : null;
}

let _browser: Browser | null = null;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) _browser = await chromium.launch({ headless: true });
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; } }

export type WeiboImage = { url: string; noteId?: string; title?: string };

// 抓某微博用户的配图，最多 limit 张。maxPages 控制翻页上限。
export async function fetchWeiboImages(uid: string, limit = 8, maxPages = 5): Promise<{ nickname: string; items: WeiboImage[] }> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto('https://m.weibo.cn/u/' + uid, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const containerId = '107603' + uid;
    const items: WeiboImage[] = [];
    let nickname = '';
    for (let pg = 1; pg <= maxPages && items.length < limit; pg++) {
      const api = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=${containerId}&page=${pg}`;
      const data: any = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'MWeibo-Pwa': '1' } });
        if (!r.ok) return null;
        return r.json();
      }, api);
      if (!data?.data) break;
      if (!nickname) nickname = data.data.userInfo?.screen_name || '';
      const cards = data.data.cards || [];
      for (const c of cards) {
        const mb = c.mblog;
        if (!mb?.pics?.length) continue;
        for (const pic of mb.pics) {
          const url = pic.large?.url || pic.url;
          if (url && !items.find(x => x.url === url)) {
            items.push({ url, noteId: mb.id, title: String(mb.text || '').replace(/<[^>]+>/g, '').slice(0, 60) });
            if (items.length >= limit) break;
          }
        }
        if (items.length >= limit) break;
      }
      await page.waitForTimeout(1200);
    }
    return { nickname, items };
  } finally {
    await ctx.close();
  }
}
