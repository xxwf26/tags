// 独立子进程：按昵称搜米画师同名画师，输出 JSON 到 stdout。
// 用法（由 mihuashi.ts 的 searchMihuashiArtists 调用）：node --import tsx mhs-artist-search.mts <name> <limit>
//
// 官方接口：GET /api/v1/artists/search?page=1&q=<昵称>&artworks_count=5
//   → { total_pages, artists:[{ id, name, avatar_url, role, is_verified, credit, artworks[], work_schedule_state, invite_calendar }] }
// 一次请求即带全「同名反查」所需：id(=profileId)、样图、认证、接单信誉、档期状态。
// 为什么子进程 + 反检测：米画师靠 navigator.webdriver 指纹识破自动化后返回假「签名错误」403；
// 且 chromium 在 Windows 反复用会原生 segfault，子进程隔离只杀子进程不拖垮主服务（同 mhs-search/mhs-profile）。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
const limit = Number(process.argv[3]) || 8;
if (!name) { console.log(JSON.stringify({ artists: [], error: 'no name' })); process.exit(0); }

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 从米画师 credit 派生一句接单信誉概要（接单量/准时率），无数据返回 null
function creditSummary(c: any): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (typeof c.total_accept_amount === 'number' && c.total_accept_amount > 0) parts.push(`接单${c.total_accept_amount}`);
  if (typeof c.ontime_rate === 'number' && c.ontime_rate >= 0) parts.push(`准时${Math.round(c.ontime_rate * 100)}%`);
  return parts.length ? parts.join(' · ') : null;
}

let artists: any[] = [];
const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
try {
  const authPath = join(process.cwd(), 'mhs-auth.json');
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: existsSync(authPath) ? authPath : undefined });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  p.on('response', async r => {
    if (r.url().includes('/api/v1/artists/search')) {
      try {
        const j = JSON.parse(await r.text());
        for (const a of j.artists || []) {
          artists.push({
            profileId: a.id,
            name: a.name ?? null,
            avatarUrl: a.avatar_url ?? null,
            profileUrl: a.id ? `https://www.mihuashi.com/profiles/${a.id}` : null,
            isVerified: !!a.is_verified,
            role: a.role ?? null,
            credit: creditSummary(a.credit),
            // work_schedule_state：unset/其它；有 invite_calendar.open_date 说明可约。此处只透原始，派生放主进程。
            scheduleState: a.work_schedule_state ?? null,
            inviteOpenDate: a.invite_calendar?.open_date ?? null,
            artworks: (a.artworks || []).slice(0, 6).map((w: any) => ({
              mhsId: w.id, imageUrl: w.url, width: w.width ?? null, height: w.height ?? null, likes: w.likes_count ?? null,
            })),
          });
        }
      } catch {}
    }
  });
  try {
    await p.goto(`https://www.mihuashi.com/search?q=${encodeURIComponent(name)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(2500);
  } catch (e: any) {
    console.error(`[mhs-artist-search] name="${name}" 异常: ${e.message}`);
  }
} finally {
  await b.close();
}
// 按接单信誉大致排序意义不大（字段稀疏），保持接口返回顺序（米画师已按相关度），仅截断
console.log(JSON.stringify({ artists: artists.slice(0, limit) }));
