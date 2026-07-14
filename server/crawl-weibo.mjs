// 批量爬取微博画师配图（playwright）。跑法：node crawl-weibo.mjs [limit] [delayMs]
const LIMIT = Number(process.argv[2] || 5);
const DELAY = Number(process.argv[3] || 1500);
const BASE = 'http://localhost:3322';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const artists = await (await fetch(BASE + '/api/artists')).json();
// 有微博链接、且当前无作品的画师
const targets = artists.filter(a => a.links?.weibo?.length && a.total === 0);
console.log(`待爬微博 ${targets.length} 位，每人 ${LIMIT} 张，间隔 ${DELAY}ms\n`);

let ok = 0, empty = 0, err = 0, totalImgs = 0;
for (let i = 0; i < targets.length; i++) {
  const a = targets[i];
  const tag = `[${i + 1}/${targets.length}] ${a.name}(id=${a.id})`;
  try {
    const r = await fetch(`${BASE}/api/artists/${a.id}/crawl-works-weibo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: LIMIT }),
    });
    const j = await r.json();
    if (j.imported > 0) { ok++; totalImgs += j.imported; console.log(`${tag} ✓ ${j.imported}张 (found ${j.found}, skip ${j.skipped}, fail ${j.failed})`); }
    else if (j.error || j.message) { err++; console.log(`${tag} ✗ ${j.message || j.error}`); }
    else { empty++; console.log(`${tag} — 0张`); }
  } catch (e) { err++; console.log(`${tag} ✗ ${e.message}`); }
  await sleep(DELAY);
}
console.log(`\n完成：成功 ${ok} 人 / 空 ${empty} / 出错 ${err}，共入库 ${totalImgs} 张`);
