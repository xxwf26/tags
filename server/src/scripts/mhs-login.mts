// 独立子进程：扫码登录米画师，自动检测登录成功后存 storageState 到 mhs-auth.json，输出 JSON。
// 用法（settings 的 mhs-login 端点 spawn）：node --import tsx mhs-login.mts
// 与手动版 database/mhs-login.ts 的区别：不等回车，而是轮询"登录入口是否消失"自动判定，
// 这样服务端 spawn（无终端可按回车）也能用。输出 {success:true} 或 {success:false,error}。
import { chromium } from 'playwright';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 页面里是否还存在"登录"入口（登出态有，登录后被头像取代）。取叶子元素精确匹配文本，避免误命中。
const hasLoginEntry = () => Array.from(document.querySelectorAll('a,button,span,div'))
  .some(el => el.children.length === 0 && el.textContent?.trim() === '登录');

const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
let result: { success: boolean; error?: string } = { success: false, error: '登录超时（未在时限内检测到登录成功）' };
try {
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  await p.goto('https://www.mihuashi.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error('\n>>> 浏览器已打开，请在窗口里扫码/账号密码登录米画师，登录成功后本窗口会自动保存。\n');

  // 先确认登出基线（登录入口出现），避免页面未渲染完就误判为已登录
  let baselineLoggedOut = false;
  for (let i = 0; i < 10; i++) {
    if (await p.evaluate(hasLoginEntry).catch(() => false)) { baselineLoggedOut = true; break; }
    await p.waitForTimeout(1000);
  }

  // 轮询登录成功：登录入口消失（连续两次确认，防抖）。最多 ~120s。
  let confirms = 0;
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(2000);
    const stillOut = await p.evaluate(hasLoginEntry).catch(() => true);
    if (baselineLoggedOut && !stillOut) {
      if (++confirms >= 2) {
        await p.waitForTimeout(1500); // 等 cookie/localStorage 落定
        await ctx.storageState({ path: join(process.cwd(), 'mhs-auth.json') });
        result = { success: true };
        break;
      }
    } else { confirms = 0; }
  }
} catch (e: any) {
  result = { success: false, error: e?.message || String(e) };
} finally {
  await b.close();
}
console.log(JSON.stringify(result));
process.exit(0);
