// 独立子进程：打开小红书登录页（非无头），等待扫码登录，自动提取完整cookie。
// 用法：node --import tsx xhs-login.mts
// 输出 JSON：{ success: true, cookie: "..." } 或 { success: false, error: "..." }
import { chromium } from 'playwright';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

console.error('[xhs-login] 启动浏览器...');
const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();

try {
  await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 等 5 秒让页面完全渲染 + 访客 cookie 稳定
  await p.waitForTimeout(5000);

  // 记录访客的 web_session 值（访客也有这个 cookie，但值和登录后不同）
  const visitorCookies = await ctx.cookies();
  const visitorWebSession = visitorCookies.find(c => c.name === 'web_session')?.value || '';
  console.error(`[xhs-login] 访客 web_session=${visitorWebSession.slice(0, 20)}... (长度=${visitorWebSession.length})`);

  // 点"登录"按钮
  const loginBtn = await p.$('text=登录').catch(() => null);
  if (loginBtn) {
    console.error('[xhs-login] 点击登录，显示二维码...');
    await loginBtn.click();
    await p.waitForTimeout(3000);
  }

  // 等待扫码：检测 web_session 值变化（访客→登录后会话升级，值不同）
  // 或检测新出现 web_session（如果访客没有）
  console.error('[xhs-login] 等待扫码（120秒超时）...');
  let loggedIn = false;
  for (let i = 0; i < 60; i++) {
    const cookies = await ctx.cookies();
    const currentWebSession = cookies.find(c => c.name === 'web_session')?.value || '';
    // web_session 值变了 = 从访客升级为登录
    if (currentWebSession && currentWebSession !== visitorWebSession) {
      console.error(`[xhs-login] web_session 变化! 访客=${visitorWebSession.slice(0, 16)}... → 登录=${currentWebSession.slice(0, 16)}...`);
      loggedIn = true;
      break;
    }
    await p.waitForTimeout(2000);
  }

  if (loggedIn) {
    await p.waitForTimeout(3000); // 等 cookie 完全写入
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const authPath = join(process.cwd(), '.xhs-auth.json');
    await ctx.storageState({ path: authPath });
    console.error(`[xhs-login] 登录成功，${cookies.length} 个cookie，storageState 已保存`);
    console.log(JSON.stringify({ success: true, cookie: cookieStr }));
  } else {
    console.error('[xhs-login] 登录超时（120秒内未扫码）');
    console.log(JSON.stringify({ success: false, error: '登录超时（120秒内未扫码）' }));
  }
} catch (e: any) {
  console.error(`[xhs-login] 异常: ${e.message}`);
  console.log(JSON.stringify({ success: false, error: e.message }));
} finally {
  await b.close();
}
process.exit(0);
