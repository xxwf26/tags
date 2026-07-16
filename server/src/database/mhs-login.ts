// 捕获米画师登录态：开有头浏览器 → 你手动登录 → 回车后存 storageState 到 mhs-auth.json。
// 跑法（需在能看到浏览器窗口的桌面环境）： npx tsx src/database/mhs-login.ts
// 存下的 mhs-auth.json 已 gitignore，勿提交。
import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function waitEnter(msg: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(msg, () => { rl.close(); res(); }));
}

async function main() {
  const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  await p.goto('https://www.mihuashi.com/', { waitUntil: 'domcontentloaded' });
  console.error('\n>>> 浏览器已打开，请在窗口里手动登录米画师（扫码/账号密码均可）。');
  console.error('>>> 登录成功、能看到自己头像后，回到这里按【回车】保存登录态。\n');
  await waitEnter('登录完成后按回车 > ');
  const out = join(process.cwd(), 'mhs-auth.json');
  await ctx.storageState({ path: out });
  console.error(`\n登录态已保存到 ${out}`);
  await b.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
