// 批量爬取：对所有有小红书链接、尚无作品的画师爬封面图（每人 limit 张）
// 跑法：node crawl-all.mjs [limit] [delayMs]
const LIMIT = Number(process.argv[2] || 5);
const DELAY = Number(process.argv[3] || 2500);
const BASE = 'http://localhost:3322';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const artists = await (await fetch(BASE + '/api/artists')).json();
const targets = artists.filter(a => a.links?.xiaohongshu?.length && a.total === 0);
console.log(`待爬 ${targets.length} 位画师，每人 ${LIMIT} 张，间隔 ${DELAY}ms\n`);

let ok = 0, empty = 0, err = 0, totalImgs = 0;
for (let i = 0; i < targets.length; i++) {
  const a = targets[i];
  const tag = `[${i + 1}/${targets.length}] ${a.name}(id=${a.id})`;
  try {
    const r = await fetch(`${BASE}/api/artists/${a.id}/crawl-works`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: LIMIT }),
    });
    const j = await r.json();
    if (j.imported > 0) { ok++; totalImgs += j.imported; console.log(`${tag} ✓ ${j.imported}张 (found ${j.found}, skip ${j.skipped}, fail ${j.failed})`); }
    else { empty++; console.log(`${tag} — 0张 (found ${j.found ?? 0})`); }
  } catch (e) {
    err++; console.log(`${tag} ✗ ${e.message}`);
  }
  await sleep(DELAY);
}
console.log(`\n完成：成功 ${ok} 人 / 空 ${empty} / 出错 ${err}，共入库 ${totalImgs} 张`);
