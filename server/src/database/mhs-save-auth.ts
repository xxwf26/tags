// 从 Chrome 登录态副本导出 storageState 到 mhs-auth.json，供后续采集复用（不再依赖 Chrome）。
// 前提：先关 Chrome。跑法： npx tsx src/database/mhs-save-auth.ts
import { chromium } from 'playwright';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'C:\\Users\\xiaoxiaocha\\AppData\\Local\\Google\\Chrome\\User Data';
const DST = join(process.cwd(), '.mhs-chrome-profile');
const NEED = ['Local State', 'Default/Network/Cookies', 'Default/Network/Cookies-journal', 'Default/Preferences', 'Default/Local Storage', 'Default/Session Storage'];

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
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto('https://www.mihuashi.com/', { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(2000);
  // 触发一次需登录的请求确认 cookie 有效
  const ok = await p.evaluate(async () => {
    try { const r = await fetch('/api/v1/users/290450/artworks?page=1&per=12&return_type=page'); return r.status; } catch { return -1; }
  });
  console.error('作品接口验证状态:', ok);
  await ctx.storageState({ path: join(process.cwd(), 'mhs-auth.json') });
  console.error('登录态已存 mhs-auth.json');
  await ctx.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
