// 增量导出：把本次新增作品打成同步包，供伙伴幂等合并（不覆盖其数据、不依赖 id 对齐）。
// 导出内容：sync-pack/artworks.json（作品元数据 + 画师稳定标识 name/xhsUrl + 标签）+ sync-pack/uploads/（对应图片）
// 跑法： npx tsx src/database/export-increment.ts [sinceDate=今天]
//   sinceDate 形如 2026-07-15，导出该日起 created_at 的作品。
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from './db.js';
import { gte, inArray } from 'drizzle-orm';

async function main() {
  const since = process.argv[2] || new Date().toISOString().slice(0, 10);
  const arts = await db.select().from(schema.artworks).where(gte(schema.artworks.createdAt, new Date(since)));
  if (!arts.length) { console.error(`${since} 起没有新增作品，无事可做。`); process.exit(0); }
  console.error(`导出 ${since} 起新增作品：${arts.length} 张`);

  // 关联画师稳定标识（name + 小红书 profile url），避免依赖 artist_id 对齐
  const artistIds = [...new Set(arts.map(a => a.artistId).filter(Boolean))] as number[];
  const artistRows = await db.select().from(schema.artists).where(inArray(schema.artists.id, artistIds));
  const artistMap = new Map(artistRows.map(a => {
    const links = (a.links as any) || {};
    return [a.id, { name: a.name, xhsUrl: (links.xiaohongshu || [])[0] || null, weiboUrl: (links.weibo || [])[0] || null }];
  }));

  // 关联标签
  const artIds = arts.map(a => a.id);
  const tagRows = artIds.length ? await db.select().from(schema.artworkTags).where(inArray(schema.artworkTags.artworkId, artIds)) : [];
  const tagsByArt = new Map<number, any[]>();
  for (const t of tagRows) {
    if (!tagsByArt.has(t.artworkId)) tagsByArt.set(t.artworkId, []);
    tagsByArt.get(t.artworkId)!.push({ tagId: t.tagId, source: t.source, confidence: t.confidence });
  }

  const packDir = join(process.cwd(), 'sync-pack');
  const packUploads = join(packDir, 'uploads');
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packUploads, { recursive: true });

  const records: any[] = [];
  let fileOk = 0, fileMiss = 0;
  for (const a of arts) {
    const artist = artistMap.get(a.artistId!) || null;
    const filename = a.imageUrl.replace(/^\/uploads\//, '');
    // 复制图片
    try { await copyFile(join(process.cwd(), 'uploads', filename), join(packUploads, filename)); fileOk++; }
    catch { fileMiss++; }
    records.push({
      // 不导 id；用 image_hash 做作品唯一键，用 artist 标识挂靠
      artist,
      title: a.title,
      filename,                       // 图片文件名（伙伴解压到 uploads/ 后即可用）
      imageHash: a.imageHash,
      width: a.width, height: a.height, orientation: a.orientation,
      sourcePlatform: a.sourcePlatform, sourceUrl: a.sourceUrl,
      tags: tagsByArt.get(a.id) || [],
    });
  }

  await writeFile(join(packDir, 'artworks.json'),
    JSON.stringify({ exportedAt: new Date().toISOString(), since, count: records.length, records }, null, 2), 'utf8');
  console.error(`\n同步包已生成：sync-pack/（artworks.json + uploads/${fileOk}张图，缺失${fileMiss}）`);
  console.error(`下一步：tar 打包 sync-pack 发给伙伴，附 import-increment.ts`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
