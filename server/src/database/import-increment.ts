// 幂等导入：把伙伴发来的 sync-pack 合并进本地库，不覆盖已有数据、不依赖 id 对齐。
// 合并规则：
//   - 作品按 image_hash 查重：本地已存在相同 hash → 跳过（不重复导入）
//   - 画师按 name + 小红书 url 匹配本地画师；匹配不到 → 记入 unmatched 清单，默认跳过该作品
//     （加 --create-missing 则按 name 新建画师再挂靠）
//   - 图片文件已随包在 uploads/，本脚本只写 DB
// 用法：
//   1) 解压 sync-pack.tar.gz，把 sync-pack/uploads/* 拷进 server/uploads/
//   2) 预览： npx tsx src/database/import-increment.ts sync-pack/artworks.json
//   3) 执行： npx tsx src/database/import-increment.ts sync-pack/artworks.json --apply [--create-missing]
import { readFile } from 'node:fs/promises';
import { db, schema } from './db.js';
import { eq, and, isNotNull } from 'drizzle-orm';

async function main() {
  const jsonPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  const createMissing = process.argv.includes('--create-missing');
  if (!jsonPath) { console.error('用法：import-increment.ts <artworks.json> [--apply] [--create-missing]'); process.exit(1); }

  const pack = JSON.parse(await readFile(jsonPath, 'utf8'));
  const records: any[] = pack.records || [];
  console.error(`同步包：${records.length} 条作品（导出于 ${pack.exportedAt}）`);

  // 本地已有 hash 集（查重）
  const existing = (await db.select({ hash: schema.artworks.imageHash })
    .from(schema.artworks).where(isNotNull(schema.artworks.imageHash))).map(r => r.hash);
  const existingSet = new Set(existing);

  // 本地画师索引：按 name、按小红书 url
  const localArtists = await db.select().from(schema.artists);
  const byName = new Map(localArtists.map(a => [a.name, a]));
  const byXhs = new Map<string, any>();
  for (const a of localArtists) {
    const url = ((a.links as any) || {}).xiaohongshu?.[0];
    if (url) byXhs.set(url, a);
  }

  let willInsert = 0, dupSkip = 0, unmatched: string[] = [], toCreate = new Set<string>();
  const plan: any[] = [];
  for (const r of records) {
    if (r.imageHash && existingSet.has(r.imageHash)) { dupSkip++; continue; }  // 已有相同图，跳过
    // 找画师
    let artist = (r.artist?.xhsUrl && byXhs.get(r.artist.xhsUrl)) || (r.artist?.name && byName.get(r.artist.name)) || null;
    if (!artist) {
      if (createMissing && r.artist?.name) { toCreate.add(r.artist.name); }
      else { unmatched.push(`${r.artist?.name || '?'} / ${r.title || r.filename}`); continue; }
    }
    willInsert++;
    plan.push({ r, artistId: artist?.id ?? null, createName: artist ? null : r.artist?.name });
    if (r.imageHash) existingSet.add(r.imageHash); // 包内去重
  }

  console.error(`\n将导入 ${willInsert} 条；重复跳过 ${dupSkip}；画师匹配不到 ${unmatched.length}${createMissing ? `（将新建画师 ${toCreate.size} 个）` : '（跳过，加 --create-missing 可新建）'}`);
  if (unmatched.length && !createMissing) unmatched.slice(0, 20).forEach(u => console.error(`  未匹配: ${u}`));

  if (!apply) { console.error(`\n[DRY-RUN] 未加 --apply，未写库。`); process.exit(0); }

  // 新建缺失画师
  const createdMap = new Map<string, number>();
  if (createMissing) {
    for (const name of toCreate) {
      const [res] = await db.insert(schema.artists).values({ name });
      createdMap.set(name, (res as any).insertId);
    }
  }
  // 插入作品 + 标签
  let done = 0;
  for (const p of plan) {
    const aid = p.artistId ?? createdMap.get(p.createName!);
    if (!aid) continue;
    const [res] = await db.insert(schema.artworks).values({
      artistId: aid, title: p.r.title || null,
      imageUrl: `/uploads/${p.r.filename}`, thumbUrl: `/uploads/${p.r.filename}`,
      width: p.r.width, height: p.r.height, orientation: p.r.orientation || '横',
      imageHash: p.r.imageHash, sourcePlatform: p.r.sourcePlatform, sourceUrl: p.r.sourceUrl,
      tagStatus: 'pending',
    });
    const newId = (res as any).insertId;
    if (p.r.tags?.length) {
      await db.insert(schema.artworkTags).values(p.r.tags.map((t: any) => ({ artworkId: newId, tagId: t.tagId, source: t.source || 'ai', confidence: t.confidence })));
    }
    done++;
  }
  console.error(`\n完成：导入 ${done} 条作品${createMissing ? `，新建画师 ${createdMap.size} 个` : ''}。`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
