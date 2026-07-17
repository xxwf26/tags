// 参考图：上传 → AI打标 → 人工调标签
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, schema } from '../../database/db.js';
import { eq, desc } from 'drizzle-orm';
import sharp from 'sharp';
import { aHash } from '../imghash/imghash.js';
import { loadTaxonomy, extractJson, normalizeOutput, callBoth, suggestMihuashiTags } from '../tagging/ai.js';
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

    // AI 打标（Gemini + 豆包 集成）+ 米画师官方标签（供发现页直接搜米画师用）
    const b64 = file.buffer.toString('base64');
    const mime = 'image/jpeg';
    const tax = await loadTaxonomy();
    const [{ gemini, doubao }, mhsTags] = await Promise.all([
      callBoth(b64, mime, tax.prompt),
      suggestMihuashiTags(b64, mime),
    ]);
    const gIds = normalizeOutput(extractJson(gemini), tax.labelMap);
    const dIds = normalizeOutput(extractJson(doubao), tax.labelMap);
    const both = [...gIds].filter(x => dIds.has(x));
    const one = [...new Set([...gIds, ...dIds])].filter(x => !both.includes(x));

    // 取标签详情
    const allTagIds = [...gIds, ...dIds];
    // 批量取（drizzle inArray）
    const { inArray } = await import('drizzle-orm');
    const tags = allTagIds.length ? await db.select().from(schema.tags).where(inArray(schema.tags.id, allTagIds)) : [];
    const tagById = new Map(tags.map(t => [t.id, t]));
    const systemTags = [...both, ...one].map(id => {
      const t = tagById.get(id);
      return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null, confidence: both.includes(id) ? 0.9 : 0.5 };
    });
    // 米画师标签置前（tagId=null 标记来源；发现页据 label 预选，命中米画师白名单率高）。
    // 与系统标签按 label 去重，避免重复项。
    const sysLabels = new Set(systemTags.map(t => t.label));
    const mhsAiTags = mhsTags.filter(l => !sysLabels.has(l)).map(l => ({ tagId: null as number | null, label: l, dimensionId: null, confidence: 0.9 }));
    const aiTags = [...mhsAiTags, ...systemTags];

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

  // 删除参考图 + 其所有搜索会话 + 结果（软删参考图，硬删 sessions/results）
  async remove(id: number) {
    // 删该参考图的所有搜索结果
    const sessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, id));
    for (const s of sessions) {
      await db.delete(schema.searchResults).where(eq(schema.searchResults.sessionId, s.id));
    }
    // 删搜索会话
    await db.delete(schema.searchSessions).where(eq(schema.searchSessions.referenceImageId, id));
    // 删参考图记录（图文件留在 uploads 不删，避免误删）
    await db.delete(schema.referenceImages).where(eq(schema.referenceImages.id, id));
    await logOperation({ type: 'reference_delete', targetType: 'reference', targetId: id, summary: `删除参考图 #${id}（含 ${sessions.length} 次搜索）` });
    return { id, deleted: true, sessionsRemoved: sessions.length };
  }

  // 获取参考图详情 + 所有搜索会话（含每次的结果数）
  async getDetail(id: number) {
    const [ref] = await db.select().from(schema.referenceImages).where(eq(schema.referenceImages.id, id));
    if (!ref) return null;
    const sessions = await db.select().from(schema.searchSessions)
      .where(eq(schema.searchSessions.referenceImageId, id)).orderBy(desc(schema.searchSessions.id));
    // 每次会话的结果按 tier 统计
    const sessionsWithStats = [];
    for (const s of sessions) {
      const results = await db.select().from(schema.searchResults).where(eq(schema.searchResults.sessionId, s.id));
      const tierCount: Record<string, number> = {};
      for (const r of results) { const t = r.tier || 'tier1'; tierCount[t] = (tierCount[t] || 0) + 1; }
      sessionsWithStats.push({ ...s, resultStats: tierCount });
    }
    return { ...ref, sessions: sessionsWithStats };
  }
}
