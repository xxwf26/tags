// 独立子进程：搜米画师指定标签的作品，输出 JSON 到 stdout。
// 用法（由 mihuashi.ts 的 searchMihuashi 调用）：node --import tsx mhs-search.mts <tagId> <limit>
//
// 为什么用子进程：米画师 headless chromium 在 Windows 反复用会原生 segfault，拖垮整个 node 主进程。
// 子进程里 chromium segfault 只杀子进程，主服务不受影响（spawn 返回空，上层重试）。每次新开浏览器，不复用单例。
import { chromium } from 'playwright';

const tagId = process.argv[2];
const limit = Number(process.argv[3]) || 30;
if (!tagId) { console.log(JSON.stringify({ arts: [], error: 'no tagId' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extractAuthor(a: any): { author: string | null; authorUrl: string | null } {
  const u = a?.author || a?.user || a?.painter || a?.creator || null;
  const author = a?.author_name || a?.nickname || u?.name || u?.nickname || u?.username || null;
  const pid = a?.author_id || a?.user_id || u?.id || u?.profile_id || null;
  return { author: author ? String(author).trim() : null, authorUrl: pid ? `https://www.mihuashi.com/profiles/${pid}` : null };
}

const arts: any[] = [];
const seen = new Set<number>();
const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
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
try {
  // 带标签直接进筛选后的列表页；order=1 最新，tags={id} 指定画风/类型
  await p.goto(`https://www.mihuashi.com/artworks?order=1&tags=${tagId}`, { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(2000);
  for (let i = 0; i < 25 && arts.length < limit; i++) {
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(1500);
  }
} catch (e: any) {
  console.error(`[mhs-search] tagId=${tagId} 异常: ${e.message}`);
} finally {
  await b.close();
}
console.log(JSON.stringify({ arts: arts.slice(0, limit) }));
