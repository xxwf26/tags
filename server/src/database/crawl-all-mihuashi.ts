// 批量补爬有米画师主页链接的画师作品到目标张数（默认8），复用 crawlArtistWorksMihuashi
// （登录态 mhs-auth.json + 压缩到长边1600 + 去重，不跑AI闸门）。宁缺毋滥。
// 跑法： npx tsx src/database/crawl-all-mihuashi.ts [target=8] [pool=25] [onlyIds]
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from './db.js';
import { sql } from 'drizzle-orm';
import { CandidateService } from '../modules/candidate/candidate.service.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const target = Number(process.argv[2] || 8);
  const pool = Number(process.argv[3] || 25);
  const only = (process.argv[4] || '').split(',').map(s => Number(s.trim())).filter(Boolean);

  const counts = await db.select({ artistId: schema.artworks.artistId, n: sql<number>`count(*)` })
    .from(schema.artworks).groupBy(schema.artworks.artistId);
  const cntMap = new Map(counts.map(c => [c.artistId, Number(c.n)]));

  const artists = await db.select().from(schema.artists);
  const targets = artists.filter(a => {
    const links = (a.links as any) || {};
    if (!(links.mihuashi || [])[0]) return false;
    return only.length ? only.includes(a.id) : true;
  });
  console.error(`有米画师链的画师：${targets.length} 个，目标每人 ${target} 张（pool=${pool}，压缩1600+去重，无AI闸门）`);

  const svc = new CandidateService();
  const results: any[] = [];
  const errors: any[] = [];
  const under: any[] = [];
  let i = 0;
  for (const a of targets) {
    i++;
    const have = cntMap.get(a.id) || 0;
    const need = target - have;
    if (need <= 0) { results.push({ id: a.id, name: a.name, have, imported: 0, skip: '已达标' }); continue; }
    try {
      const r = await svc.crawlArtistWorksMihuashi(a.id, need, false, pool);
      const total = have + r.imported;
      results.push({ id: a.id, name: a.name, have, imported: r.imported, total, found: r.found, skipped: r.skipped, failed: r.failed });
      if (total < target) under.push({ id: a.id, name: a.name, total, reason: `found${r.found} 重${r.skipped} 败${r.failed}` });
      console.error(`  [${i}/${targets.length}] ${a.name}: +${r.imported} → ${total}张 (found${r.found}/重${r.skipped}/败${r.failed})`);
    } catch (e) {
      errors.push({ id: a.id, name: a.name, have, error: (e as Error).message });
      console.error(`  [${i}/${targets.length}] ${a.name}: 失败 - ${(e as Error).message}`);
    }
    await sleep(2500);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: 'mihuashi', target, pool,
    totalArtists: targets.length,
    imported: results.reduce((s, r) => s + (r.imported || 0), 0),
    reachedTarget: results.filter(r => (r.total ?? r.have) >= target).length,
    underTargetCount: under.length,
    errorCount: errors.length,
    under, errors, results,
  };
  await writeFile(join(process.cwd(), 'crawl-report-mihuashi.json'), JSON.stringify(report, null, 2), 'utf8');
  console.error(`\n完成：新增 ${report.imported} 张；达标 ${report.reachedTarget}/${targets.length}；未达标 ${under.length}；失败 ${errors.length}`);
  console.error(`报告写入 crawl-report-mihuashi.json`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
