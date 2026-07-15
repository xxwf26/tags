// 参考图：上传 → AI打标 → 人工调标签
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, desc } from 'drizzle-orm';
import sharp from 'sharp';
import { aHash } from '../imghash/imghash.js';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth } from '../tagging/ai.js';
import { logOperation } from '../operation/op.js';

export class ReferenceService {
  // 上传参考图 → AI 自动打标
  async upload(file: Express.Multer.File) {
    const meta = await sharp(file.buffer).metadata();
    const width = meta.width ?? null, height = meta.height ?? null;
    let imageHash: string | null = null;
    try { imageHash = await aHash(file.buffer); } catch {}

    const filename = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await mkdir(join(process.cwd(), 'uploads'), { recursive: true });
    await writeFile(join(process.cwd(), 'uploads', filename), file.buffer);

    const [r] = await db.insert(schema.referenceImages).values({
      imageUrl: `/uploads/${filename}`, imageHash, width, height,
      status: 'tagging',
    });
    const id = (r as any).insertId;

    // AI 打标（Gemini + 豆包 集成）
    const b64 = file.buffer.toString('base64');
    const mime = 'image/jpeg';
    const tax = await loadTaxonomy();
    const { gemini, doubao } = await callBoth(b64, mime, tax.prompt);
    const gIds = normalizeOutput(extractJson(gemini), tax.labelMap);
    const dIds = normalizeOutput(extractJson(doubao), tax.labelMap);
    const both = [...gIds].filter(x => dIds.has(x));
    const one = [...new Set([...gIds, ...dIds])].filter(x => !both.includes(x));

    // 取标签详情
    const allTagIds = [...gIds, ...dIds];
    const tagRows = allTagIds.length ? await db.select().from(schema.tags).where(eq(schema.tags.id, allTagIds[0])) : [];
    // 批量取（drizzle inArray）
    const { inArray } = await import('drizzle-orm');
    const tags = allTagIds.length ? await db.select().from(schema.tags).where(inArray(schema.tags.id, allTagIds)) : [];
    const tagById = new Map(tags.map(t => [t.id, t]));
    const aiTags = [...both, ...one].map(id => {
      const t = tagById.get(id);
      return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null, confidence: both.includes(id) ? 0.9 : 0.5 };
    });

    await db.update(schema.referenceImages).set({ aiTags, status: 'ready' }).where(eq(schema.referenceImages.id, id));
    await logOperation({ type: 'reference_upload', targetType: 'reference', targetId: id, summary: `上传参考图 #${id}，AI打标 ${aiTags.length} 个` });
    return this.getOne(id);
  }

  // 人工调整标签
  async updateTags(id: number, manualTags: { tagId: number; label: string; dimensionId: number | null }[]) {
    await db.update(schema.referenceImages).set({ manualTags }).where(eq(schema.referenceImages.id, id));
    return this.getOne(id);
  }

  async list() {
    return db.select().from(schema.referenceImages).orderBy(desc(schema.referenceImages.id));
  }

  async getOne(id: number) {
    const [r] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, id));
    return r;
  }
}
