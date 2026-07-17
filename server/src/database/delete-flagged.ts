// 按审计报告删除低质作品。多重安全闸，符合「不擅自删库」红线：
//   1) 默认 dry-run，只打印将删清单，不动库；必须显式加 --apply 才真删
//   2) 删物理文件前查是否有其他作品记录共用同一 imageUrl，共用则只删 DB 记录、保留文件
//   3) 删前把将删记录备份进 audit-deleted-backup.json，可追溯/手工恢复
// 跑法：
//   预览： npx tsx src/database/delete-flagged.ts
//   执行： npx tsx src/database/delete-flagged.ts --apply
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from './db.js';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  const apply = process.argv.includes('--apply');
  const reportPath = join(process.cwd(), 'audit-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const flagged: any[] = report.flagged || [];
  if (!flagged.length) { console.error('报告里没有 flagged 记录，无事可做。'); process.exit(0); }
  const ids: number[] = flagged.map(f => f.id);
  console.error(`报告标记低质 ${ids.length} 条（minQuality=${report.minQuality}，生成于 ${report.generatedAt}）`);

  // 取将删记录当前 DB 快照做备份
  const rows = await db.select().from(schema.artworks).where(inArray(schema.artworks.id, ids));
  const foundIds = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !foundIds.has(id));
  if (missing.length) console.error(`  注意：${missing.length} 条已不在库（可能先前已删）：${missing.join(',')}`);

  // 判断每条的物理文件是否被别的（不在删除集里的）记录共用
  const plan: { id: number; imageUrl: string; deleteFile: boolean; sharedBy: number[] }[] = [];
  for (const r of rows) {
    const others = await db.select({ id: schema.artworks.id })
      .from(schema.artworks).where(eq(schema.artworks.imageUrl, r.imageUrl));
    const otherKeep = others.map(o => o.id).filter(oid => !foundIds.has(oid)); // 共用且不在删除集
    plan.push({ id: r.id, imageUrl: r.imageUrl, deleteFile: otherKeep.length === 0, sharedBy: otherKeep });
  }

  console.error(`\n将删 DB 记录：${plan.length} 条`);
  console.error(`将删物理文件：${plan.filter(p => p.deleteFile).length} 个`);
  const shared = plan.filter(p => !p.deleteFile);
  if (shared.length) {
    console.error(`保留文件（被其他保留记录共用）：${shared.length} 个`);
    for (const s of shared) console.error(`  - id ${s.id} 的 ${s.imageUrl} 被记录 ${s.sharedBy.join(',')} 共用，仅删记录`);
  }

  if (!apply) {
    console.error(`\n[DRY-RUN] 未加 --apply，未做任何改动。确认无误后加 --apply 执行。`);
    // 把删除计划也写出来供 Read 查看
    await writeFile(join(process.cwd(), 'delete-plan.json'), JSON.stringify({ report: reportPath, plan }, null, 2), 'utf8');
    console.error(`删除计划已写入 delete-plan.json`);
    process.exit(0);
  }

  // 备份
  await writeFile(join(process.cwd(), 'audit-deleted-backup.json'),
    JSON.stringify({ deletedAt: new Date().toISOString(), rows, plan }, null, 2), 'utf8');

  // 先删 artwork_tags（外键关系，避免悬挂），再删 artworks，最后删文件
  await db.delete(schema.artworkTags).where(inArray(schema.artworkTags.artworkId, ids));
  const delRes = await db.delete(schema.artworks).where(inArray(schema.artworks.id, ids));
  let filesDeleted = 0, fileErr = 0;
  for (const p of plan.filter(x => x.deleteFile)) {
    try { await unlink(join(process.cwd(), p.imageUrl.replace(/^\/uploads\//, 'uploads/'))); filesDeleted++; }
    catch { fileErr++; }
  }
  console.error(`\n完成：删 DB 记录 ${ids.length} 条（含标签），删文件 ${filesDeleted} 个（失败/不存在 ${fileErr}）。`);
  console.error(`备份已存 audit-deleted-backup.json`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
