// 批量补爬所有有小红书主页链接的画师作品到目标张数（默认8），复用 crawlArtistWorks（含去重+AI质检闸门）。
// 宁缺毋滥：某画师主页真作品不足则有多少入多少，不降质量门槛。
// 跑法： AI_API_KEY=xxx npx tsx src/database/crawl-all-works.ts [target=8] [pool=30] [minQuality=5]
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from './db.js';
import { inArray, eq, sql } from 'drizzle-orm';
import { CandidateService } from '../modules/candidate/candidate.service.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const target = Number(process.argv[2] || 8);
  const pool = Number(process.argv[3] || 30);
  const minQuality = Number(process.argv[4] || 5);
  if (!process.env.AI_API_KEY && !process.env.PAPERHUB_API_KEY) {
    console.error('!! 未设置 AI_API_KEY，质检闸门会全部中性放行，广告会重新混入。中止。');
    process.exit(1);
  }

  // 现有各画师爬取作品数
  const counts = await db.select({ artistId: schema.artworks.artistId, n: sql<number>`count(*)` })
    .from(schema.artworks).groupBy(schema.artworks.artistId);
  const cntMap = new Map(counts.map(c => [c.artistId, Number(c.n)]));

  // 有小红书链接的画师（可选第4参数：限定 artistId 列表，逗号分隔，小批验证用）
  const only = (process.argv[5] || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  const artists = await db.select().from(schema.artists);
  const targets = artists.filter(a => {
    const links = (a.links as any) || {};
    if (!(links.xiaohongshu || [])[0]) return false;
    return only.length ? only.includes(a.id) : true;
  });
  console.error(`有小红书链的画师：${targets.length} 个，目标每人 ${target} 张（pool=${pool}, minQuality=${minQuality}）`);

  const svc = new CandidateService();
  const results: any[] = [];
  const errors: any[] = [];
  const under: any[] = [];   // 补完仍不足 target 的
  let i = 0;
  for (const a of targets) {
    i++;
    const have = cntMap.get(a.id) || 0;
    const need = target - have;
    if (need <= 0) { results.push({ id: a.id, name: a.name, have, imported: 0, skip: '已达标' }); continue; }
    try {
      // limit=need：只补差额；pool 放大尽量多捞候选
      const r = await svc.crawlArtistWorks(a.id, need, false, pool, minQuality);
      const total = have + r.imported;
      results.push({ id: a.id, name: a.name, have, imported: r.imported, total, pooled: r.pooled, rejected: r.rejected, skipped: r.skipped, failed: r.failed });
      if (total < target) under.push({ id: a.id, name: a.name, total, reason: `候选${r.pooled} 拒${r.rejected} 重${r.skipped}` });
      console.error(`  [${i}/${targets.length}] ${a.name}: +${r.imported} → ${total}张 (候选${r.pooled}/拒${r.rejected}/重${r.skipped}/败${r.failed})`);
    } catch (e) {
      errors.push({ id: a.id, name: a.name, have, error: (e as Error).message });
      console.error(`  [${i}/${targets.length}] ${a.name}: 失败 - ${(e as Error).message}`);
    }
    await sleep(3000); // 画师间限速防封
  }

  const report = {
    generatedAt: new Date().toISOString(),
    target, pool, minQuality,
    totalArtists: targets.length,
    imported: results.reduce((s, r) => s + (r.imported || 0), 0),
    reachedTarget: results.filter(r => (r.total ?? r.have) >= target).length,
    underTargetCount: under.length,
    errorCount: errors.length,
    under, errors, results,
  };
  await writeFile(join(process.cwd(), 'crawl-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.error(`\n完成：新增 ${report.imported} 张；达标 ${report.reachedTarget}/${targets.length}；未达标 ${under.length}；失败 ${errors.length}`);
  console.error(`报告写入 crawl-report.json`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
