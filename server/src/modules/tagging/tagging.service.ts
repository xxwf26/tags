// 打标管线：读图 → Gemini+豆包双模型 → 白名单归一 → 集成 → 落 artwork_tags + 复核态
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, and } from 'drizzle-orm';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth } from './ai.js';

function mimeOf(filename: string): string {
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export class TaggingService {
  // 给单张作品 AI 打标：两模型共识=高置信，单方=低置信；source=ai，tag_status=pending 待复核
  async tagArtwork(id: number) {
    const [art] = await db.select().from(schema.artworks).where(eq(schema.artworks.id, id));
    if (!art) throw new Error('作品不存在');
    const filename = art.imageUrl.replace(/^\/uploads\//, '');
    const buf = await readFile(join(process.cwd(), 'uploads', filename));
    const b64 = buf.toString('base64');
    const mime = mimeOf(filename);

    const tax = await loadTaxonomy();
    const { gemini, doubao, geminiError, doubaoError } = await callBoth(b64, mime, tax.prompt);
    const gIds = normalizeOutput(extractJson(gemini), tax.labelMap);
    const dIds = normalizeOutput(extractJson(doubao), tax.labelMap);

    const both = [...gIds].filter(x => dIds.has(x));        // 共识 → 0.9
    const one = [...new Set([...gIds, ...dIds])].filter(x => !both.includes(x)); // 单方 → 0.5

    // 删除旧 AI 标签（保留 manual），写入新 AI 标签（排除已存在的 manual 标签，避免主键冲突）
    await db.delete(schema.artworkTags).where(and(eq(schema.artworkTags.artworkId, id), eq(schema.artworkTags.source, 'ai')));
    const existing = await db.select().from(schema.artworkTags).where(eq(schema.artworkTags.artworkId, id));
    const existingIds = new Set(existing.map(e => e.tagId));
    const bothNew = both.filter(t => !existingIds.has(t));
    const oneNew = one.filter(t => !existingIds.has(t));
    const rows = [
      ...bothNew.map(tagId => ({ artworkId: id, tagId, source: 'ai' as const, confidence: 0.9 })),
      ...oneNew.map(tagId => ({ artworkId: id, tagId, source: 'ai' as const, confidence: 0.5 })),
    ];
    if (rows.length) await db.insert(schema.artworkTags).values(rows);

    await db.update(schema.artworks).set({
      aiTagged: 1,
      tagStatus: 'pending',
      tagConfidence: both.length ? 0.9 : 0.5,
    }).where(eq(schema.artworks.id, id));

    return {
      artworkId: id,
      gemini: gIds.size, doubao: dIds.size,
      consensus: both.length, single: one.length,
      errors: { gemini: geminiError, doubao: doubaoError },
      tagIds: [...both, ...one],
    };
  }

  // 批量打标：所有 ai_tagged=0 的作品
  async tagBatch() {
    const rows = await db.select().from(schema.artworks).where(eq(schema.artworks.aiTagged, 0));
    const results = [];
    for (const a of rows) {
      try { results.push(await this.tagArtwork(a.id)); }
      catch (e) { results.push({ artworkId: a.id, error: (e as Error).message }); }
    }
    return { total: rows.length, results };
  }

  // 复核确认：tag_status → confirmed
  async confirm(id: number) {
    await db.update(schema.artworks).set({ tagStatus: 'confirmed' }).where(eq(schema.artworks.id, id));
    return { artworkId: id, tagStatus: 'confirmed' };
  }
}
