// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 打开 /artworks → 点画风标签 → 滚动加载 → 拦截 search API 收集作品图
// 注意：米画师靠 navigator.webdriver + HeadlessChrome 特征识别自动化，识破后 search 接口
// 返回假的"签名错误"403。必须用反检测参数 + 抹掉 webdriver 标志才能过。
// 共享浏览器实例，避免反复启动。
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type MhsArtwork = { mhsId: number; imageUrl: string; width: number | null; height: number | null; author: string | null; authorUrl: string | null };

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  }
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; } }

// 从米画师主页链接提取 profileId：https://www.mihuashi.com/profiles/290450
export function extractMihuashiProfileId(url: string): string | null {
  const m = String(url || '').match(/mihuashi\.com\/profiles\/(\d+)/);
  return m ? m[1] : null;
}

// 建带反检测的 context：去掉 HeadlessChrome 特征与 navigator.webdriver
async function stealthContext(b: Browser): Promise<BrowserContext> {
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  return ctx;
}

export async function searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  // 走独立子进程（src/scripts/mhs-search.mts）：米画师会对长运行进程内复用的浏览器做指纹标记，
  // 标记后 /artworks 页不再渲染画风筛选 chip → 找不到标签 → 0 结果。
  // one-shot 子进程每次新开浏览器，行为与独立脚本一致。chip 渲染有反爬 flaky，故失败时重试最多 2 次。
  const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-search.mts');
  const runOnce = (): Promise<MhsArtwork[]> => new Promise((resolve) => {
    // 必须用 tsx 运行 .mts：原生 node 跑 ESM 时 Playwright 在米画师页面行为异常（chip 不渲染）。
    // tagName 走 stdin 传递：Windows 上 execFile/spawn 的中文 argv/env 会被编码破坏成乱码，stdin 字节流 UTF-8 安全。
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, String(limit)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); console.error(`[mhs] spawn 失败 "${tagName}": ${e.message}`); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(stdout);
        console.log(`[mhs] 搜索 "${tagName}": ${j.arts?.length || 0} 张${j.error ? '（' + j.error + '）' : ''}`);
        resolve((j.arts || []) as MhsArtwork[]);
      } catch (e: any) {
        console.error(`[mhs] 解析子进程输出失败: ${e.message}${stderr ? ' stderr=' + stderr.slice(0, 200) : ''}`);
        resolve([]);
      }
    });
    child.stdin.write(tagName);
    child.stdin.end();
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const arts = await runOnce();
    if (arts.length) return arts;
    if (attempt < 3) console.log(`[mhs] "${tagName}" 第 ${attempt} 次无结果，重试…`);
  }
  return [];
}

// 拉米画师可用画风标签（供前端下拉）。每次要 spawn 浏览器 ~9s，加内存缓存避免页面加载卡顿。
let _tagsCache: { data: { id: number; name: string; type: string }[]; ts: number } | null = null;
const TAGS_TTL = 10 * 60 * 1000; // 10 分钟
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  if (_tagsCache && Date.now() - _tagsCache.ts < TAGS_TTL) return _tagsCache.data;
  const b = await getBrowser();
  const ctx = await stealthContext(b);
  const p = await ctx.newPage();
  let tags: any[] = [];
  p.on('response', async r => {
    if (r.url().includes('/api/v1/configure/artwork_tags')) {
      try { const j = JSON.parse(await r.text()); tags = j.artwork_tags || []; } catch {}
    }
  });
  try {
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
  } finally { await ctx.close(); }
  const data = tags as { id: number; name: string; type: string }[];
  _tagsCache = { data, ts: Date.now() };
  return data;
}

export type MhsChip = { category: string; name: string };

// 抓 /artworks 页真实的画风筛选 chip（画风/技法 + 类型），作为发现页下拉来源。
// 比配置接口的 43 个全量标签更准：config 里有但页面没 chip 的（如"平涂"）搜不到，不能放进下拉。
// 走子进程 mhs-chips.mts（one-shot 浏览器，避免长运行进程 chip 不渲染）；失败回退到 config 标签。
let _chipsCache: { data: MhsChip[]; ts: number } | null = null;
export async function fetchMihuashiFilterChips(): Promise<MhsChip[]> {
  if (_chipsCache && Date.now() - _chipsCache.ts < TAGS_TTL) return _chipsCache.data;
  const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-chips.mts');
  const data: MhsChip[] = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    const timer = setTimeout(() => { child.kill(); }, 90000);
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve((JSON.parse(stdout).chips || []) as MhsChip[]); }
      catch { resolve([]); }
    });
  });
  // 子进程失败（反爬/超时）→ 回退到 config 标签，保证下拉不空
  const result = data.length ? data : (await fetchMihuashiTags()).map(t => ({ category: t.type === 'skill_tag' ? '画风' : '类型', name: t.name }));
  _chipsCache = { data: result, ts: Date.now() };
  return result;
}

// 用登录态(mhs-auth.json)抓画师主页作品。导航到 profiles/{id} → 页面自己翻页 →
// 拦截 users/{id}/artworks 响应收作品（高清原图 url + width/height）。
// 米画师画师主页接口需登录态，故走 storageState；反检测同 search。
export async function fetchMihuashiArtistWorks(profileId: string, authPath: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await chromium.launch({ headless: true, args: STEALTH_ARGS });
  const ctx = await b.newContext({ userAgent: UA, locale: 'zh-CN', storageState: authPath });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const p = await ctx.newPage();
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
  p.on('response', async r => {
    // 仅收该画师自己的作品列表（users/{profileId}/artworks），排除登录账号的 dashboard 请求
    if (r.url().includes(`/api/v1/users/${profileId}/artworks`)) {
      try {
        const j = JSON.parse(await r.text());
        for (const a of j.artworks || []) {
          if (a.id && a.url && !seen.has(a.id)) {
            seen.add(a.id);
            arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null, author: null, authorUrl: null });
          }
        }
      } catch {}
    }
  });
  try {
    await p.goto(`https://www.mihuashi.com/profiles/${profileId}`, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(3000);
    // 翻页：滚到底触发下一页，直到收够或无新增
    let stagnant = 0;
    for (let i = 0; i < 30 && arts.length < limit && stagnant < 3; i++) {
      const before = arts.length;
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
      stagnant = arts.length === before ? stagnant + 1 : 0;
    }
  } catch (e) {
    // 超时也返回已收集的
  } finally {
    await b.close();
  }
  return arts.slice(0, limit);
}
