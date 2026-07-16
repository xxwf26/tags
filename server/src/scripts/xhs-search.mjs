// 独立子进程：用 playwright 搜小红书，输出 JSON 到 stdout
// 用法：node xhs-search.mjs <keyword> <cookie> <limit>
import { chromium } from 'playwright';

const keyword = process.argv[2];
const cookieStr = process.argv[3];
const limit = Number(process.argv[4]) || 50;

const AD_KEYWORDS = ['开课','摆摊','发布会','报名','课程','招生','培训','兼职','招聘','众筹','预售','下单','购买','淘宝','拼多多','闲鱼','微店','链接','优惠','折扣','活动','抽奖','转发','关注我','求关注','互粉'];

const b = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
const cookies = cookieStr.split('; ').map(c => { const [name,...r] = c.split('='); return { name, value: r.join('='), domain: '.xiaohongshu.com', path: '/' }; });
const ctx = await b.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
});
await ctx.addCookies(cookies);
const p = await ctx.newPage();
const items = [];
const seen = new Set();
let skippedVideo = 0, skippedAd = 0;

p.on('response', async (r) => {
  if (r.url().includes('/api/sns/web/v2/search/notes') || r.url().includes('/api/sns/web/v1/search/notes')) {
    try {
      const j = await r.json();
      const notes = j.data?.items || [];
      for (const n of notes) {
        const nc = n.note_card || n;
        const noteId = nc.note_id || n.id || '';
        if (!noteId || seen.has(noteId)) continue;
        if (nc.type === 'video') { skippedVideo++; continue; }
        const title = nc.display_title || nc.title || '';
        if (AD_KEYWORDS.some(kw => title.includes(kw))) { skippedAd++; continue; }
        seen.add(noteId);
        const allImages = [];
        for (const im of (nc.image_list || [])) {
          const infoList = im.info_list || [];
          const url = (infoList.find(x => x.image_scene === 'WB_DFT') || infoList[infoList.length - 1] || infoList[0])?.url;
          if (url) allImages.push(String(url).replace(/^http:\/\//, 'https://'));
        }
        if (!allImages.length) {
          const cover = nc.cover?.url_default || nc.cover?.url_pre || '';
          if (cover) allImages.push(String(cover).replace(/^http:\/\//, 'https://'));
        }
        const xhsTags = [];
        for (const tag of (nc.corner_tag_info || [])) { if (tag?.text) xhsTags.push(tag.text); }
        items.push({ noteId, title, author: nc.user?.nickname || '', sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`, type: nc.type || 'normal', images: allImages, xhsTags });
      }
    } catch {}
  }
});

try {
  await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2000);
  await p.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(6000);
  const maxScrolls = Math.ceil(limit / 20) + 5;
  for (let i = 0; i < maxScrolls && items.length < limit; i++) {
    await p.evaluate(() => window.scrollBy(0, 1200));
    await p.waitForTimeout(3000 + Math.random() * 1000);
  }
} catch {}

await ctx.close();
await b.close();

// 输出 JSON 到 stdout（父进程解析）
process.stdout.write(JSON.stringify({ items: items.slice(0, limit), skippedVideo, skippedAd }));
