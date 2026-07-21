// 独立子进程：打开小红书登录页（非无头，显示二维码窗口），等待业务员扫码登录，自动提取完整cookie（含HttpOnly）。
// 用法：node --import tsx xhs-login.mts
// 输出 JSON 到 stdout：{ success: true, cookie: "..." } 或 { success: false, error: "..." }
import { chromium } from 'playwright';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

console.error('[xhs-login] 启动浏览器，打开小红书登录页...');
const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const p = await ctx.newPage();

try {
  await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);

  // 记录初始"登录"按钮数量（页面可能有多个"登录"文字）
  const initialLoginCount = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button, span, div'))
      .filter(e => e.children.length === 0 && e.textContent?.trim() === '登录').length;
  }).catch(() => 0);
  console.error(`[xhs-login] 页面"登录"按钮数: ${initialLoginCount}`);

  // 点"登录"按钮（如果未登录）
  if (initialLoginCount > 0) {
    const loginBtn = await p.$('text=登录').catch(() => null);
    if (loginBtn) {
      console.error('[xhs-login] 点击登录按钮，显示二维码...');
      await loginBtn.click();
      await p.waitForTimeout(3000);
    }
  }

  // 等待扫码登录：检测"登录"按钮消失（扫码后页面刷新，登录按钮变成头像）
  // 不用 cookie 检测——小红书给访客也发 web_session，会误判。
  console.error('[xhs-login] 等待扫码（120秒超时，扫完后窗口自动关闭）...');
  let loggedIn = false;
  for (let i = 0; i < 60; i++) {
    const loginCount = await p.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button, span, div'))
        .filter(e => e.children.length === 0 && e.textContent?.trim() === '登录').length;
    }).catch(() => 0);
    // "登录"按钮消失 = 登录成功（页面刷新后变成头像）
    if (initialLoginCount > 0 && loginCount === 0) { loggedIn = true; break; }
    // 也检测 URL 变化（登录后可能跳转）
    const hasAvatar = await p.$('.user-avatar, [class*="avatar"], [class*="user-info"]').catch(() => null);
    if (hasAvatar) { loggedIn = true; break; }
    await p.waitForTimeout(2000);
  }

  if (loggedIn) {
    await p.waitForTimeout(2000); // 等 cookie 完全写入
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    // 保存完整浏览器状态（cookie + localStorage）供 xhs-search.mjs 复用
    const authPath = join(process.cwd(), '.xhs-auth.json');
    await ctx.storageState({ path: authPath });
    console.error(`[xhs-login] 登录成功，${cookies.length} 个cookie，storageState 已保存`);
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
