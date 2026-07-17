// 用你 Chrome 登录态的【副本】验证米画师画师主页能否抓作品。
// 新版 Chrome 禁止对默认用户目录远程调试，故复制 Default profile 到独立临时目录再挂接。
// 复制只带登录相关（cookie/localStorage/Local State/Preferences），跳过缓存，几十MB级。
// 跑法： npx tsx src/database/mhs-probe-login.ts [profileId=290450]
//   建议先关掉 Chrome（复制 cookie 文件时 Chrome 占用会导致复制到半截的锁文件）。
import { chromium } from 'playwright';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'C:\\Users\\xiaoxiaocha\\AppData\\Local\\Google\\Chrome\\User Data';
const DST = join(process.cwd(), '.mhs-chrome-profile');

// 需要的登录态文件（相对 User Data）
const NEED = [
  'Local State',                       // 含 cookie 解密密钥（DPAPI）
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Preferences',
  'Default/Local Storage',             // 目录：站点 localStorage（token 可能在此）
  'Default/Session Storage',
];

async function tryCopy(rel: string) {
  const s = join(SRC, rel), d = join(DST, rel);
  try { await access(s); } catch { return; }               // 源不存在就跳过
  try { await cp(s, d, { recursive: true, force: true }); } catch (e) { console.error(`  复制跳过 ${rel}: ${(e as Error).message}`); }
}

async function main() {
  const pid = process.argv[2] || '290450';
  console.error('复制 Chrome 登录态到独立目录…');
  await rm(DST, { recursive: true, force: true });
  await mkdir(join(DST, 'Default', 'Network'), { recursive: true });
  for (const rel of NEED) await tryCopy(rel);

  const ctx = await chromium.launchPersistentContext(DST, {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--profile-directory=Default'],
    viewport: null,
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = ctx.pages()[0] || await ctx.newPage();

  const hits: any[] = [];
  p.on('response', async r => {
    const u = r.url();
    if (u.includes('/api/v1/') && (u.includes('user') || u.includes('artwork'))) {
      let body = ''; try { body = (await r.text()).slice(0, 120); } catch {}
      hits.push({ url: u.replace('https://www.mihuashi.com', '').slice(0, 75), status: r.status(), body });
    }
  });

  try {
    // 先看首页确认是否已登录（右上角有无头像）
    await p.goto('https://www.mihuashi.com/', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(2500);
    const loggedIn = await p.evaluate(() => !document.body.innerText.includes('登录') || document.body.innerText.includes('我的'));
    console.error('首页疑似已登录:', loggedIn);

    await p.goto(`https://www.mihuashi.com/profiles/${pid}`, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(4000);
    for (let i = 0; i < 4; i++) { await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(1800); }
    console.error('画师页标题:', await p.title());
    console.error('相关 API:');
    hits.forEach(h => console.error(`  [${h.status}] ${h.url}\n     ${h.body}`));
  } catch (e) { console.error('异常:', (e as Error).message); }
  finally { await ctx.close(); }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
