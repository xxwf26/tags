// 独立子进程：拉米画师官方画风标签（config API），输出 JSON 到 stdout。
// 用法：node --import tsx mhs-tags.mts
// 为什么用子进程：fetchMihuashiTags 在主进程内开 chromium，segfault 会拖垮主服务；子进程隔离。
import { chromium } from 'playwright';

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let tags: any[] = [];
const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();
p.on('response', async r => {
  if (r.url().includes('/api/v1/configure/artwork_tags')) {
    try { const j = JSON.parse(await r.text()); tags = j.artwork_tags || []; } catch {}
  }
});
try {
  await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(1500);
} catch (e: any) {
  console.error(`[mhs-tags] 异常: ${e.message}`);
} finally {
  await b.close();
}
console.log(JSON.stringify(tags));
