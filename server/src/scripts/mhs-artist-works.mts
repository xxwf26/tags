// 独立子进程：爬米画师画师主页的作品列表，输出 JSON 到 stdout。
// 用法（由 mihuashi.ts 的 crawlMihuashiHomepageWorks 调用）：node --import tsx mhs-artist-works.mts <profileId> <limit>
//
// 为什么子进程 + 反检测 + 登录态：主页作品接口 /api/v1/users/{id}/artworks 需登录态(mhs-auth.json)；
// 且 chromium 在 Windows 反复用会原生 segfault，发现流程会连爬多个画师主页，必须子进程隔离
// （只杀子进程不拖垮主服务）。等同于把主进程版 fetchMihuashiArtistWorks 挪进子进程。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const profileId = process.argv[2];
const limit = Number(process.argv[3]) || 8;
if (!profileId) { console.log(JSON.stringify({ arts: [], error: 'no profileId' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const arts: any[] = [];
const seen = new Set<number>();
let name: string | null = null;
const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
try {
  const authPath = join(process.cwd(), 'mhs-auth.json');
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: existsSync(authPath) ? authPath : undefined });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  p.on('response', async r => {
    const url = r.url();
    // 画师名：/api/v1/users/{id}（精确路径段，避开 /artworks 子路径）
    if (/\/api\/v1\/users\/\d+(?:\?|$)/.test(url) && url.includes(`/users/${profileId}`)) {
      try { const j = JSON.parse(await r.text()); const u = j?.user || j; if (u?.name && !name) name = String(u.name).trim(); } catch {}
    }
    // 仅收该画师自己的作品列表（users/{profileId}/artworks），排除登录账号 dashboard 请求
    if (url.includes(`/api/v1/users/${profileId}/artworks`)) {
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
    let stagnant = 0;
    for (let i = 0; i < 30 && arts.length < limit && stagnant < 3; i++) {
      const before = arts.length;
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
      stagnant = arts.length === before ? stagnant + 1 : 0;
    }
  } catch (e: any) {
    console.error(`[mhs-artist-works] profileId=${profileId} 异常: ${e.message}`);
  }
} finally {
  await b.close();
}
console.log(JSON.stringify({ name, arts: arts.slice(0, limit) }));
