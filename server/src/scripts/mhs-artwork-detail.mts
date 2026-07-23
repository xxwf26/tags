// 独立子进程：取米画师单个作品的画师信息，输出 JSON 到 stdout。
// 用法（由 mihuashi.ts 的 fetchMihuashiArtworkAuthor 调用）：node --import tsx mhs-artwork-detail.mts <artworkId>
//
// 为什么用子进程 + 浏览器：米画师有反爬（webdriver 指纹 + 签名校验），直接 fetch 详情接口会被
// 假的"签名错误"403 拦下；必须走真实页面的反检测 chromium。且 chromium 在 Windows 反复用会原生
// segfault，子进程隔离后只杀子进程，主服务不受影响。
// 作品列表接口不返回画师，只有详情接口 /api/v1/artworks/{id} 的 artwork.author 才有（name + id）。
import { chromium } from 'playwright';

const artworkId = process.argv[2];
if (!artworkId) { console.log(JSON.stringify({ author: null, authorUrl: null, error: 'no artworkId' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let author: string | null = null;
let authorUrl: string | null = null;

const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
try {
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  p.on('response', async r => {
    // 精确匹配本作品的详情接口（避免抓到列表/其他作品）
    if (r.url().includes(`/api/v1/artworks/${artworkId}`)) {
      try {
        const j = JSON.parse(await r.text());
        const a = j?.artwork?.author;
        if (a) {
          author = a.name ? String(a.name).trim() : null;
          authorUrl = a.id ? `https://www.mihuashi.com/profiles/${a.id}` : null;
        }
      } catch {}
    }
  });
  try {
    await p.goto(`https://www.mihuashi.com/artworks/${artworkId}`, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(3000);
  } catch (e: any) {
    console.error(`[mhs-artwork-detail] artworkId=${artworkId} 异常: ${e.message}`);
  }
} finally {
  await b.close();
}
console.log(JSON.stringify({ author, authorUrl }));
