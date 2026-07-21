// 独立子进程：打开小红书登录页（非无头，显示二维码窗口），等待业务员扫码登录，自动提取完整cookie（含HttpOnly）。
// 用法：node --import tsx xhs-login.mts
// 输出 JSON 到 stdout：{ success: true, cookie: "..." } 或 { success: false, error: "..." }
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

console.error('[xhs-login] 启动浏览器，打开小红书登录页...');
const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();

try {
  await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2000);

  // 点"登录"按钮（如果未登录）
  const loginBtn = await p.$('text=登录').catch(() => null);
  if (loginBtn) {
    console.error('[xhs-login] 点击登录按钮...');
    await loginBtn.click();
    await p.waitForTimeout(2000);
  }

  // 等待扫码登录：轮询 cookie，web_session 出现 = 登录成功
  console.error('[xhs-login] 等待扫码登录（120秒超时）...');
  let loggedIn = false;
  for (let i = 0; i < 60; i++) {
    const cookies = await ctx.cookies();
    if (cookies.some(c => c.name === 'web_session' && c.value && c.value.length > 10)) {
      loggedIn = true;
      break;
    }
    await p.waitForTimeout(2000);
  }

  if (loggedIn) {
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.error(`[xhs-login] 登录成功，获取 ${cookies.length} 个cookie，长度=${cookieStr.length}`);
    console.log(JSON.stringify({ success: true, cookie: cookieStr }));
  } else {
    console.error('[xhs-login] 登录超时');
    console.log(JSON.stringify({ success: false, error: '登录超时（120秒内未扫码）' }));
  }
} catch (e: any) {
  console.error(`[xhs-login] 异常: ${e.message}`);
  console.log(JSON.stringify({ success: false, error: e.message }));
} finally {
  await b.close();
}
process.exit(0);
