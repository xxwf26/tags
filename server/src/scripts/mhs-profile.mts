// 独立子进程：取米画师画师主页的档期/约稿信息，输出 JSON 到 stdout。
// 用法（由 mihuashi.ts 的 fetchMihuashiArtistSchedule 调用）：node --import tsx mhs-profile.mts <profileId>
//
// 为什么用子进程 + 反检测浏览器：米画师有反爬（webdriver 指纹 + 签名校验），直接 fetch 会被
// 假的"签名错误"403 拦下；且 chromium 在 Windows 反复用会原生 segfault，子进程隔离只杀子进程。
// 主页信息接口 /api/v1/users/{id} 带 work_schedules(档期) + user_about(约稿详情) + invite_calendar(下次开放)。
// 派生逻辑（档期→commission、拼 scheduleNote）放主进程 mihuashi.ts，便于单测；这里只回原始字段。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const profileId = process.argv[2];
if (!profileId) { console.log(JSON.stringify({ error: 'no profileId' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let out: any = null;

const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
try {
  const authPath = join(process.cwd(), 'mhs-auth.json');
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: existsSync(authPath) ? authPath : undefined });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  p.on('response', async r => {
    // 用户信息接口：/api/v1/users/{id}（带 ?by=id&present_data[]=... query）。精确匹配路径段，避免命中 artworks/work_schedules 等子路径。
    if (/\/api\/v1\/users\/\d+(?:\?|$)/.test(r.url()) && r.url().includes(`/users/${profileId}`)) {
      try {
        const j = JSON.parse(await r.text());
        const u = j?.user || j;
        if (u) out = {
          name: u.name ?? null,
          about: u.about ?? null,
          userAbout: u.user_about ?? null,
          workSchedules: u.work_schedules ?? null,
          inviteCalendar: u.invite_calendar ?? null,
        };
      } catch {}
    }
  });
  try {
    await p.goto(`https://www.mihuashi.com/profiles/${profileId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(6000);
  } catch (e: any) {
    console.error(`[mhs-profile] profileId=${profileId} 异常: ${e.message}`);
  }
} finally {
  await b.close();
}
console.log(JSON.stringify(out || { error: 'no data' }));
