// 小红书笔记页抓取（SSR 法，无登录、不触登录墙）
// 移植验证过的 xhs-fetcher：fetchHtml + 抠 __INITIAL_STATE__ + parseNote
// 用法：node fetch.mjs   —— 读同目录 links.txt（每行一个链接或整段分享文本），抓图落 dataset/，标签落 gold.seed.json
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(__dir, 'dataset');
const SEED = path.join(__dir, 'gold.seed.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

function get(url, redirects = 0, binary = false) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: HEADERS, timeout: 25000 }, (res) => {
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
      const chunks = [];
      stream.on('data', c => chunks.push(c));
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

// 从整段分享文本里提取小红书链接
function extractUrl(text) {
  const m = text.match(/https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s一-龥，。]+/);
  return m ? m[0] : null;
}

// 抠 __INITIAL_STATE__ 并解析笔记
function parseNote(html) {
  const i = html.indexOf('__INITIAL_STATE__');
  if (i < 0) return null;
  const tail = html.slice(i);
  const eq = tail.indexOf('=');
  const end = tail.indexOf('</script>');
  if (eq < 0 || end < 0) return null;
  let raw = tail.slice(eq + 1, end).trim();
  // 小红书用 undefined 作值，JSON.parse 不认，替换掉
  raw = raw.replace(/:undefined/g, ':null').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  let state;
  try { state = JSON.parse(raw); } catch (e) {
    // 有的尾部有分号或多余内容，尝试截到最后一个 }
    try {
      const last = raw.lastIndexOf('}');
      state = JSON.parse(raw.slice(0, last + 1));
    } catch (e2) { return { _parseError: e2.message }; }
  }
  const map = state?.note?.noteDetailMap;
  if (!map) return { _noNoteMap: true };
  const key = Object.keys(map)[0];
  const note = map[key]?.note;
  if (!note) return { _emptyNote: true };
  return {
    noteId: note.noteId || key,
    title: note.title || '',
    desc: note.desc || '',
    author: note.user?.nickname || '',
    tags: (note.tagList || []).map(t => t.name).filter(Boolean),
    images: (note.imageList || []).map(im => im.urlDefault || im.urlPre || (im.infoList?.[0]?.url)).filter(Boolean),
  };
}

async function main() {
  const linksFile = path.join(__dir, 'links.txt');
  if (!fs.existsSync(linksFile)) {
    console.error('缺 links.txt —— 每行贴一个小红书笔记链接或整段分享文本');
    process.exit(1);
  }
  fs.mkdirSync(DATASET, { recursive: true });
  const lines = fs.readFileSync(linksFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const seed = fs.existsSync(SEED) ? JSON.parse(fs.readFileSync(SEED, 'utf8')) : {};

  let imgN = 0;
  for (const [idx, line] of lines.entries()) {
    const url = extractUrl(line);
    if (!url) { console.log(`[${idx}] 跳过（无链接）: ${line.slice(0, 40)}`); continue; }
    console.log(`\n[${idx}] ${url}`);
    try {
      const { status, body } = await get(url);
      const note = parseNote(body);
      if (!note || note._parseError || note._noNoteMap || note._emptyNote) {
        console.log(`   ✗ 解析失败:`, note, `(status ${status}) — 链接可能过期，请用新鲜分享`);
        continue;
      }
      console.log(`   ✓ 作者「${note.author}」 标题「${note.title.slice(0, 20)}」 平台标签[${note.tags.join(',')}] 图 ${note.images.length} 张`);
      // 下载图片
      const noteImgs = [];
      for (const [j, imgUrl] of note.images.entries()) {
        try {
          const r = await get(imgUrl, 0, true);
          if (r.status !== 200 || r.body.length < 2000) { console.log(`     图${j} 跳过(status ${r.status}, ${r.body.length}B)`); continue; }
          const ext = (r.type && r.type.includes('png')) ? 'png' : 'jpg';
          const fname = `${String(idx).padStart(2, '0')}_${String(j).padStart(2, '0')}.${ext}`;
          fs.writeFileSync(path.join(DATASET, fname), r.body);
          noteImgs.push(fname);
          imgN++;
          // 平台标签作为该图金标准种子
          seed[fname] = { platformTags: note.tags, author: note.author, title: note.title, sourceUrl: url };
        } catch (e) { console.log(`     图${j} 下载失败: ${e.message}`); }
      }
      console.log(`   落地 ${noteImgs.length} 张: ${noteImgs.join(', ')}`);
    } catch (e) {
      console.log(`   ✗ 抓取失败: ${e.message}`);
    }
  }
  fs.writeFileSync(SEED, JSON.stringify(seed, null, 2));
  console.log(`\n完成：共落地 ${imgN} 张图 → dataset/，平台标签种子 → gold.seed.json`);
  console.log(`下一步：把 gold.seed.json 校正成 gold.json（按 taxonomy 5 维填每图标准答案）`);
}

main();
