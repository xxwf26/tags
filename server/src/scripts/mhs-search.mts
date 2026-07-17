// 独立子进程：用 playwright 搜米画师指定画风标签，输出 JSON 到 stdout
// 用法（由 mihuashi.ts 的 searchMihuashi 调用）：node --import tsx mhs-search.mts <limit>，tagName 从 stdin 读
//
// 为什么用子进程：米画师对长期复用的浏览器实例做指纹标记，标记后 /artworks 页不再渲染画风筛选 chip。
// 长运行 NestJS 进程里直接调 playwright 会触发此问题；one-shot 子进程每次新开浏览器，复刻独立脚本的可靠行为。
import { chromium } from 'playwright';

// tagName 从 stdin 读（Windows 上 spawn 的中文 argv/env 会被编码破坏成乱码；stdin 是字节流，UTF-8 安全）
const tagName = await new Promise<string>(resolve => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c: string) => { buf += c; });
  process.stdin.on('end', () => resolve(buf.trim()));
});
const limit = Number(process.argv[2]) || 30;
if (!tagName) { console.log(JSON.stringify({ arts: [], error: 'no tagName' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();

const arts = [];
const seen = new Set();
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

try {
  await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
  // 显式等画风标签配置接口返回（chip 依赖它渲染），再给一点渲染时间
  try { await p.waitForResponse(r => r.url().includes('/api/v1/configure/artwork_tags'), { timeout: 15000 }); } catch {}
  await p.waitForTimeout(1500);
  // 等 tag chip 渲染并点击。chip 文本常带作品数（如"厚涂42"），故用「以 tagName 开头+可选数字」匹配，
  // 既兼容计数又不误命中"伪厚涂"（以"伪"开头）。选后代最少的最深层元素。
  let clicked = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    clicked = await p.evaluate((name) => {
      // 米画师画风标签为纯中文，无正则特殊字符；用「以 name 开头+可选数字」匹配，兼容带作品数(如"厚涂42")，不误命中"伪厚涂"
      const re = new RegExp('^\\s*' + name + '\\s*\\d*\\s*$');
      const all = Array.from(document.querySelectorAll('a,button,span,div,li,label'));
      const matches = all.filter(e => re.test((e.textContent || '').trim()));
      if (!matches.length) return false;
      matches.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      matches[0].click();
      return true;
    }, tagName);
    if (clicked) break;
    await p.waitForTimeout(800);
  }
  if (!clicked) {
    console.log(JSON.stringify({ arts: [], error: `标签 "${tagName}" 未在页面找到` }));
    await b.close();
    process.exit(0);
  }
  // 清掉初始默认列表（type=recent 的未过滤图），只收点击后的 tag 过滤结果
  arts.length = 0;
  seen.clear();
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

console.log(JSON.stringify({ arts: arts.slice(0, limit) }));
