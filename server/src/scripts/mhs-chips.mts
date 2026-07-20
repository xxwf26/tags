// 独立子进程：抓米画师 /artworks 页真实的画风筛选 chip（不是 config API 的 43 个全量标签）。
// config 里有但页面没 chip 的标签（如"平涂""萌系"）搜不到，故发现页下拉必须用页面真实 chip。
// 真实 chip = 画风/技法(日系/古风/欧美/厚涂/赛璐璐/水彩/写实/男性/女性) + 类型(角色/场景/Q版/插画)。
// 输出 JSON 到 stdout：{ chips: [{ category, name }] }
import { chromium } from 'playwright';

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();

const MAIN = '.artwork-category-panel__main-tag';
const SUB = '.artwork-category-panel__tag';
let chips: { category: string; name: string }[] = [];

try {
  await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
  try { await p.waitForResponse(r => r.url().includes('/api/v1/configure/artwork_tags'), { timeout: 15000 }); } catch {}
  // 轮询等筛选 panel 渲染（chip 渲染有时偏慢）
  for (let i = 0; i < 25; i++) {
    const n = await p.evaluate((s) => document.querySelectorAll(s).length, MAIN).catch(() => 0);
    if (n > 0) break;
    await p.waitForTimeout(800);
  }
  await p.waitForTimeout(500);
  // 收集主分类 tab(类型) 与 sub-chip(画风/技法)，去"全部"与尾部计数，去重。
  // 注意：evaluate 回调内不要定义嵌套具名函数，tsx 会注入 __name 序列化到浏览器报 ReferenceError。
  const data = await p.evaluate(() => {
    const mains = Array.from(document.querySelectorAll('.artwork-category-panel__main-tag')).map((e: any) => (e.textContent || '').replace(/\s+/g, '').replace(/\d+$/, '').trim()).filter((t: string) => t && t !== '全部');
    const subs = Array.from(document.querySelectorAll('.artwork-category-panel__tag')).map((e: any) => (e.textContent || '').replace(/\s+/g, '').replace(/\d+$/, '').trim()).filter((t: string) => t && t !== '全部');
    return { mains: [...new Set(mains)], subs: [...new Set(subs)] };
  });
  chips = [
    ...data.subs.map((name: string) => ({ category: '画风', name })),
    ...data.mains.map((name: string) => ({ category: '类型', name })),
  ];
} catch (e: any) {
  console.error(`[mhs-chips] 异常: ${e.message}`);
} finally {
  await b.close();
}

console.log(JSON.stringify({ chips }));
