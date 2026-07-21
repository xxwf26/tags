// 独立子进程：按关键词搜微博配图，输出 JSON 到 stdout。
// 用法：node --import tsx weibo-search.mts <keywordBase64> <limit>
// keyword 用 base64 传递（中文走 argv 会被 Windows 编码破坏；base64 是 ASCII 安全的）。
// 子进程隔离：weibo chromium segfault 只杀子进程，不拖垮主服务。
import { chromium } from 'playwright';

const keyword = Buffer.from(process.argv[2] || '', 'base64').toString('utf8');
const limit = Number(process.argv[3]) || 15;
if (!keyword) { console.log(JSON.stringify({ images: [] })); process.exit(0); }

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const items: { url: string; noteId?: string; title?: string; sourceUrl?: string; author?: string }[] = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();
try {
  // 必须先落到 m.weibo.cn 域，否则 page.evaluate(fetch) 跨域被拦 → Failed to fetch
  await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  for (let pg = 1; pg <= 3 && items.length < limit; pg++) {
    const api = `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${encodeURIComponent(keyword)}&page_type=searchall&page=${pg}`;
    const data: any = await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'MWeibo-Pwa': '1' } });
      if (!r.ok) return null;
      return r.json();
    }, api);
    if (!data?.data?.cards) break;
    for (const c of data.data.cards) {
      const mb = c.mblog;
      if (!mb?.pics?.length) continue;
      const author = mb.user?.screen_name || undefined;
      for (const pic of mb.pics) {
        const url = pic.large?.url || pic.url;
        if (url && !items.find(x => x.url === url)) {
          items.push({
            url, noteId: mb.id, author,
            // 微博原帖页（可点回溯来源），而非图片直链
            sourceUrl: mb.id ? `https://m.weibo.cn/status/${mb.id}` : undefined,
            title: String(mb.text || '').replace(/<[^>]+>/g, '').slice(0, 60),
          });
          if (items.length >= limit) break;
        }
      }
      if (items.length >= limit) break;
    }
    await page.waitForTimeout(1000);
  }
} catch (e: any) {
  console.error(`[weibo-search] "${keyword}" 异常: ${e.message}`);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ images: items }));
