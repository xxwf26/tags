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

function get(url: string, redirects = 0, binary = false): Promise<{ status: number; body: any; type?: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: HEADERS, timeout: 25000 }, (res: any) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(get(next, redirects + 1, binary));
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
  const { status, body, type } = await get(url, 0, true);
  if (status !== 200 || !body || body.length < 2000) throw new Error(`图下载失败 status ${status}`);
  return { buf: body, type: type || 'image/jpeg' };
}
