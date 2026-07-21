// 独立子进程：用 playwright 搜小红书，输出 JSON 到 stdout
// 用法：node xhs-search.mjs <keywords逗号分隔> <cookie> <limit>
// 优先用 storageState（扫码登录保存的完整浏览器状态），比纯 cookie 稳——小红书不软封锁。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const keywords = process.argv[2].split(',');
const cookieStr = process.argv[3];
const limit = Number(process.argv[4]) || 300;

const AD_KEYWORDS = ['开课','摆摊','发布会','报名','课程','招生','培训','兼职','招聘','众筹','预售','下单','购买','淘宝','拼多多','闲鱼','微店','链接','优惠','折扣','活动','抽奖','转发','关注我','求关注','互粉'];

const b = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
// 优先用 storageState（扫码登录保存的），否则回退到 addCookies
const authPath = join(process.cwd(), '.xhs-auth.json');
const ctxOpts = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
};
if (existsSync(authPath)) {
  ctxOpts.storageState = authPath;
}
const ctx = await b.newContext(ctxOpts);
// 如果没有 storageState，回退到 addCookies
if (!existsSync(authPath) && cookieStr) {
  const cookies = cookieStr.split('; ').map(c => { const [name,...r] = c.split('='); return { name, value: r.join('='), domain: '.xiaohongshu.com', path: '/' }; });
  await ctx.addCookies(cookies);
}

const items = [];
const seen = new Set();
let skippedVideo = 0, skippedAd = 0;

async function searchOneKeyword(keyword) {
  const p = await ctx.newPage();
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
          // 提取 xsec_token，拼接完整可访问的链接
          const xsecToken = n.xsec_token || nc.xsec_token || '';
          const sourceUrl = xsecToken
            ? `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsecToken}&xsec_source=pc_search`
            : `https://www.xiaohongshu.com/explore/${noteId}`;
          items.push({ noteId, title, author: nc.user?.nickname || '', sourceUrl, type: nc.type || 'normal', images: allImages, xhsTags });
        }
      } catch {}
    }
  });
  try {
    await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(2000);
    await p.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(6000);
    // 翻页（每页约20条，翻到 limit/keywords.length 条或到底）
    const targetPerKeyword = Math.ceil(limit / keywords.length);
    const maxScrolls = Math.ceil(targetPerKeyword / 20) + 10;
    for (let i = 0; i < maxScrolls && items.length < limit; i++) {
      await p.evaluate(() => window.scrollBy(0, 1200));
      await p.waitForTimeout(3000 + Math.random() * 1000);
    }
  } catch {}
  await p.close();
}

// 先访问首页预热
const p0 = await ctx.newPage();
await p0.goto('https://www.xiaohongshu.com/', { waitUntil: 'networkidle', timeout: 30000 });
await p0.waitForTimeout(2000);
await p0.close();

// 逐个关键词搜索
for (const kw of keywords) {
  if (items.length >= limit) break;
  await searchOneKeyword(kw.trim());
}

await ctx.close();
await b.close();

process.stdout.write(JSON.stringify({ items: items.slice(0, limit), skippedVideo, skippedAd }));

