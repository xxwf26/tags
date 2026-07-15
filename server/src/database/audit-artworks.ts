// 存量作品质检审计（只读，绝不删库）：
// 读出爬取入库的作品 → 每张过 gateArtwork 回判 → 输出 UTF-8 JSON 报告。
// 本机 GBK 终端中文会乱码，故结果写文件用 Read 工具看。
// 跑法： AI_API_KEY=xxx npx tsx src/database/audit-artworks.ts [minQuality]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from './db.js';
import { inArray, and } from 'drizzle-orm';
import { gateArtwork } from '../modules/tagging/ai.js';

function mimeOf(f: string) {
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  const minQuality = Number(process.argv[2] || 5);
  if (!process.env.AI_API_KEY && !process.env.PAPERHUB_API_KEY) {
    console.error('!! 未设置 AI_API_KEY，闸门会全部中性放行、审计无意义。中止。');
    process.exit(1);
  }

  // 只审计爬取来的（手动上传的不动）。可选第2个参数：限定 artistId 列表（小批验证用），逗号分隔。
  const onlyArtists = (process.argv[3] || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  const platformCond = inArray(schema.artworks.sourcePlatform, ['xiaohongshu', 'weibo']);
  const arts = await db.select().from(schema.artworks)
    .where(onlyArtists.length ? and(platformCond, inArray(schema.artworks.artistId, onlyArtists)) : platformCond);
  console.error(`待审计作品：${arts.length} 张${onlyArtists.length ? `（限画师 ${onlyArtists.join(',')}）` : ''}`);

  const uploadsDir = join(process.cwd(), 'uploads');
  const flagged: any[] = [];   // 疑似广告/低质
  const kept: any[] = [];      // 判定为合格作品
  const errors: any[] = [];    // 读图/AI 出错，人工兜底看
  let done = 0;

  // 单张判定
  async function judge(a: any) {
    const filename = a.imageUrl.replace(/^\/uploads\//, '');
    let buf: Buffer;
    try { buf = await readFile(join(uploadsDir, filename)); }
    catch (e) { errors.push({ id: a.id, artistId: a.artistId, imageUrl: a.imageUrl, error: '读图失败:' + (e as Error).message }); return; }

    const gate = await gateArtwork(buf.toString('base64'), mimeOf(filename));
    const rec = { id: a.id, artistId: a.artistId, title: a.title, imageUrl: a.imageUrl,
      quality: gate.quality, category: gate.category, isArtwork: gate.isArtwork, reason: gate.reason };
    if (gate.error) errors.push({ ...rec, error: gate.error });
    else if (!gate.isArtwork || gate.quality < minQuality) flagged.push(rec);
    else kept.push(rec);
    if (++done % 20 === 0) console.error(`  ...已判 ${done}/${arts.length}`);
  }

  // 并发跑，一次 CONCURRENCY 张
  const CONCURRENCY = 8;
  for (let i = 0; i < arts.length; i += CONCURRENCY) {
    await Promise.all(arts.slice(i, i + CONCURRENCY).map(judge));
  }

  flagged.sort((x, y) => x.quality - y.quality);   // 最差的排最前
  const report = {
    generatedAt: new Date().toISOString(),
    minQuality,
    total: arts.length,
    keptCount: kept.length,
    flaggedCount: flagged.length,
    errorCount: errors.length,
    flagged,
    errors,
    // kept 不全量写，太长；只留计数
  };
  const out = join(process.cwd(), 'audit-report.json');
  await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.error(`\n审计完成：合格 ${kept.length} / 疑似低质 ${flagged.length} / 出错 ${errors.length}`);
  console.error(`报告已写入：${out}（用 Read 工具查看）`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
