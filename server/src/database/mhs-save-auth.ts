// 从 Chrome 登录态副本导出 storageState 到 mhs-auth.json，供后续采集复用（不再依赖 Chrome）。
// 为什么走这条路：米画师对 playwright 起的浏览器有风控（触发短信验证还收不到码），
// 用用户已登录的真实 Chrome 配置导出 cookie 可绕开自动化检测。
// 前提：先完全关闭 Chrome（否则 Cookies 数据库被锁，复制到的是旧/不全的）。
// 跑法（手动）： npx tsx src/database/mhs-save-auth.ts
// 也被 settings 的 mhs-login 端点 spawn（配置页「从 Chrome 导入登录」按钮）；末行输出 JSON {success}。
import { chromium } from 'playwright';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'C:\\Users\\xiaoxiaocha\\AppData\\Local\\Google\\Chrome\\User Data';
const DST = join(process.cwd(), '.mhs-chrome-profile');
const NEED = ['Local State', 'Default/Network/Cookies', 'Default/Network/Cookies-journal', 'Default/Preferences', 'Default/Local Storage', 'Default/Session Storage'];

// 页面里是否还存在"登录"入口（登出态有，登录后被头像取代）——比作品接口(可能公开返回200)更可靠地判断登录。
const hasLoginEntry = () => Array.from(document.querySelectorAll('a,button,span,div'))
  .some(el => el.children.length === 0 && el.textContent?.trim() === '登录');

async function tryCopy(rel: string) {
  const s = join(SRC, rel), d = join(DST, rel);
  try { await access(s); } catch { return; }
  try { await cp(s, d, { recursive: true, force: true }); } catch {}
}

async function main() {
  await rm(DST, { recursive: true, force: true });
  await mkdir(join(DST, 'Default', 'Network'), { recursive: true });
  for (const rel of NEED) await tryCopy(rel);

  const ctx = await chromium.launchPersistentContext(DST, {
    headless: false, channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--profile-directory=Default'],
  });
  let loggedIn = false;
  try {
    const p = ctx.pages()[0] || await ctx.newPage();
    await p.goto('https://www.mihuashi.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 轮询几次判断登录态（复制来的 cookie 有效则首页不再显示"登录"入口）
    for (let i = 0; i < 6; i++) {
      await p.waitForTimeout(1500);
      if (!(await p.evaluate(hasLoginEntry).catch(() => true))) { loggedIn = true; break; }
    }
    console.error('登录态判定:', loggedIn ? '已登录' : '未登录（是否忘了关 Chrome / 登录在非 Default 配置？）');
    // 仅在确认已登录时才写，避免用登出态覆盖掉原有可用登录态
    if (loggedIn) {
      await ctx.storageState({ path: join(process.cwd(), 'mhs-auth.json') });
      console.error('登录态已存 mhs-auth.json');
    }
  } finally {
    await ctx.close();
    await rm(DST, { recursive: true, force: true }).catch(() => {});
  }
  console.log(JSON.stringify({ success: loggedIn }));
  process.exit(0);
}
main().catch(e => { console.error(e); console.log(JSON.stringify({ success: false, error: String(e?.message || e) })); process.exit(0); });
