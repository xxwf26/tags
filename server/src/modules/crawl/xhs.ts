// 小红书笔记页 SSR 抓取（无登录、不触登录墙）—— 移植自 verify/fetch.mjs
// fetchHtml + 抠 __INITIAL_STATE__ + parseNote；图片带 width/height
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

function get(url: string, redirects = 0, binary = false, extra: Record<string, string> = {}): Promise<{ status: number; body: any; type?: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { ...HEADERS, ...extra }, timeout: 25000 }, (res: any) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(get(next, redirects + 1, binary, extra));
      }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8'), type: res.headers['content-type'] });
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s一-龥，。]+/);
  return m ? m[0] : null;
}

// 提取文本里所有小红书链接（批量采集用）
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s一-龥，。]+/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return [...new Set(out)];
}

function parseNote(html: string) {
  const i = html.indexOf('__INITIAL_STATE__');
  if (i < 0) return null;
  const tail = html.slice(i);
  const eq = tail.indexOf('=');
  const end = tail.indexOf('</script>');
  if (eq < 0 || end < 0) return null;
  let raw = tail.slice(eq + 1, end).trim();
  raw = raw.replace(/:undefined/g, ':null').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  let state: any;
  try { state = JSON.parse(raw); } catch {
    try { state = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1)); } catch { return null; }
  }
  const map = state?.note?.noteDetailMap;
  if (!map) return null;
  const key = Object.keys(map)[0];
  const note = map[key]?.note;
  if (!note) return null;
  return {
    noteId: note.noteId || key,
    title: note.title || '',
    desc: note.desc || '',
    author: note.user?.nickname || '',
    tags: (note.tagList || []).map((t: any) => t.name).filter(Boolean),
    images: (note.imageList || []).map((im: any) => ({
      url: im.urlDefault || im.urlPre || im.infoList?.[0]?.url,
      width: im.width || null,
      height: im.height || null,
    })).filter((x: any) => x.url),
  };
}

export async function fetchNote(input: string) {
  const url = extractUrl(input) || input;
  const { status, body } = await get(url);
  const note = parseNote(body);
  if (!note) throw new Error(`解析失败 (status ${status})，链接可能过期，用新鲜分享`);
  return note;
}

export async function downloadImage(url: string): Promise<{ buf: Buffer; type: string }> {
  // CDN 防盗链：小红书/微博需带对应 Referer
  let extra: Record<string, string> = {};
  if (url.includes('xhscdn.com')) extra = { Referer: 'https://www.xiaohongshu.com/' };
  else if (url.includes('sinaimg.cn')) extra = { Referer: 'https://m.weibo.cn/' };
  const { status, body, type } = await get(url, 0, true, extra);
  if (status !== 200 || !body || body.length < 2000) throw new Error(`图下载失败 status ${status}`);
  return { buf: body, type: type || 'image/jpeg' };
}

// 从主页 SSR 的 __INITIAL_STATE__ 解析画师 + 笔记列表（封面图）
function parseProfile(html: string) {
  const i = html.indexOf('__INITIAL_STATE__');
  if (i < 0) return null;
  const tail = html.slice(i);
  const eq = tail.indexOf('=');
  const end = tail.indexOf('</script>');
  if (eq < 0 || end < 0) return null;
  let raw = tail.slice(eq + 1, end).trim().replace(/:undefined/g, ':null');
  let state: any;
  try { state = JSON.parse(raw); } catch {
    try { state = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1)); } catch { return null; }
  }
  const user = state?.user;
  if (!user) return null;
  let notes = user.notes;
  if (Array.isArray(notes) && notes.length && Array.isArray(notes[0])) notes = notes.flat();
  const items = (notes || []).map((n: any) => {
    const nc = n.noteCard || n;
    const info = nc.cover?.infoList || [];
    const best = info.find((x: any) => x.imageScene === 'WB_DFT') || info[info.length - 1] || info[0];
    return {
      noteId: nc.noteId || n.id,
      title: nc.displayTitle || nc.title || '',
      type: nc.type,
      xsecToken: nc.xsecToken || n.xsecToken || null,
      url: best?.url ? String(best.url).replace(/^http:\/\//, 'https://') : null,
    };
  }).filter((x: any) => x.url);
  return { nickname: user.userPageData?.basicInfo?.nickname || user.userInfo?.nickname || '', items };
}

// 抓画师主页作品列表（封面图）。profileUrl 形如 https://www.xiaohongshu.com/user/profile/{id}
export async function fetchProfileNotes(profileUrl: string) {
  const { status, body } = await get(profileUrl);
  const profile = parseProfile(body);
  if (!profile) throw new Error(`主页解析失败 (status ${status})，可能链接过期或页面结构变化`);
  return profile;
}

// 广告/无关帖关键词过滤
const AD_KEYWORDS = ['开课', '摆摊', '发布会', '报名', '课程', '招生', '培训', '兼职', '招聘', '众筹', '预售', '下单', '购买', '淘宝', '拼多多', '闲鱼', '微店', '链接', '优惠', '折扣', '活动', '抽奖', '转发', '关注我', '求关注', '互粉'];

export type XhsSearchResult = {
  noteId: string;
  title: string;
  author: string;
  sourceUrl: string;
  type: string;
  images: string[];   // 该帖所有图片URL
  xhsTags: string[];  // 帖子自带标签（从 corner_tag_info 提取）
};

// 按关键词搜索小红书笔记（需 cookie，拦截 v2 search API，翻页+限速）
// 过滤视频帖 + 广告帖，提取每帖全部图片
// 共享浏览器单例（避免每次搜索弹窗）
let _xhsBrowser: any = null;
async function getXhsBrowser() {
  if (!_xhsBrowser || !_xhsBrowser.isConnected()) {
    const { chromium } = await import('playwright');
    _xhsBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  }
  return _xhsBrowser;
}

export async function searchXhsByKeyword(keyword: string, limit = 100, cookieStr?: string): Promise<XhsSearchResult[]> {
  if (!cookieStr) return [];
  const b = await getXhsBrowser();
  const cookies = cookieStr.split('; ').map(c => { const [name, ...r] = c.split('='); return { name, value: r.join('='), domain: '.xiaohongshu.com', path: '/' }; });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
  });
  await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  const items: XhsSearchResult[] = [];
  const seen = new Set<string>();
  let skippedVideo = 0, skippedAd = 0;

  p.on('response', async r => {
    if (r.url().includes('/api/sns/web/v2/search/notes') || r.url().includes('/api/sns/web/v1/search/notes')) {
      try {
        const j = await r.json();
        const notes = j.data?.items || [];
        for (const n of notes) {
          const nc = n.note_card || n;
          const noteId = nc.note_id || n.id || '';
          if (!noteId || seen.has(noteId)) continue;
          // 过滤视频帖
          if (nc.type === 'video') { skippedVideo++; continue; }
          // 过滤广告/无关帖
          const title = nc.display_title || nc.title || '';
          if (AD_KEYWORDS.some(kw => title.includes(kw))) { skippedAd++; continue; }
          seen.add(noteId);
          // 提取该帖所有图片 URL（image_list → info_list → url）
          const allImages: string[] = [];
          for (const im of (nc.image_list || [])) {
            const infoList = im.info_list || [];
            const url = (infoList.find((x: any) => x.image_scene === 'WB_DFT') || infoList[infoList.length - 1] || infoList[0])?.url;
            if (url) allImages.push(String(url).replace(/^http:\/\//, 'https://'));
          }
          // 如果 image_list 没图，用 cover
          if (!allImages.length) {
            const cover = nc.cover?.url_default || nc.cover?.url_pre || '';
            if (cover) allImages.push(String(cover).replace(/^http:\/\//, 'https://'));
          }
          // 提取帖子标签（corner_tag_info）
          const xhsTags: string[] = [];
          for (const tag of (nc.corner_tag_info || [])) {
            if (tag?.text) xhsTags.push(tag.text);
          }
          items.push({
            noteId, title, author: nc.user?.nickname || '',
            sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
            type: nc.type || 'normal', images: allImages, xhsTags,
          });
        }
      } catch {}
    }
  });
  try {
    await p.goto('https://www.xiaohongshu.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(2000);
    await p.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(6000);
    const maxScrolls = Math.ceil(limit / 20) + 5;
    for (let i = 0; i < maxScrolls && items.length < limit; i++) {
      await p.evaluate(() => window.scrollBy(0, 1200));
      await p.waitForTimeout(3000 + Math.random() * 1000);
    }
  } catch {}
  await ctx.close();
  console.log(`[xhs] 搜索 "${keyword}": ${items.length} 条（过滤视频 ${skippedVideo}，广告 ${skippedAd}）`);
  return items.slice(0, limit);
}
