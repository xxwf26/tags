import { Injectable } from '@nestjs/common';
import { db, schema } from '../../database/db.js';
import { eq, sql } from 'drizzle-orm';

@Injectable()
export class TagService {
  async getTree(all = false) {
    const dims = await db.select().from(schema.tagDimensions).orderBy(schema.tagDimensions.sort);
    const tagRows = all
      ? await db.select().from(schema.tags)
      : await db.select().from(schema.tags).where(eq(schema.tags.enabled, 1));
    const tagsByDim = new Map<number, any[]>();
    for (const t of tagRows) {
      const arr = tagsByDim.get(t.dimensionId) ?? [];
      arr.push(t);
      tagsByDim.set(t.dimensionId, arr);
    }
    const byId = new Map(dims.map(d => [d.id, { ...d, children: [] as any[], tags: [] as any[] }]));
    const roots: any[] = [];
    for (const d of dims) {
      const node = byId.get(d.id)!;
      node.tags = (tagsByDim.get(d.id) ?? []).map(t => ({
        id: t.id, label: t.label, aliases: t.aliases, note: t.note, enabled: t.enabled,
      }));
      if (d.parentId && byId.has(d.parentId)) {
        byId.get(d.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async createTag(body: { dimensionId: number; label: string; aliases?: string[] }) {
    const [r] = await db.insert(schema.tags).values({
      dimensionId: body.dimensionId,
      label: body.label,
      aliases: body.aliases ?? null,
    });
    return this.getOneTag((r as any).insertId);
  }

  async updateTag(id: number, body: { label?: string; aliases?: string[]; enabled?: number; note?: string }) {
    const patch: any = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.aliases !== undefined) patch.aliases = body.aliases;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.note !== undefined) patch.note = body.note;
    await db.update(schema.tags).set(patch).where(eq(schema.tags.id, id));
    return this.getOneTag(id);
  }

  // 删除 = 禁用（有作品在用则禁用不物理删，引用保护）
  async deleteTag(id: number) {
    const [{ count }]: any = await db.select({ count: sql`count(*)` })
      .from(schema.artworkTags).where(eq(schema.artworkTags.tagId, id));
    if (Number(count) > 0) {
      await db.update(schema.tags).set({ enabled: 0 }).where(eq(schema.tags.id, id));
      return { id, disabled: true, reason: `${count} 张作品在用，已禁用（不物理删）` };
    }
    await db.delete(schema.tags).where(eq(schema.tags.id, id));
    return { id, deleted: true };
  }

  async createDimension(body: { parentId?: number | null; code: string; name: string }) {
    const [r] = await db.insert(schema.tagDimensions).values({
      parentId: body.parentId ?? null,
      code: body.code,
      name: body.name,
    });
    const [d] = await db.select().from(schema.tagDimensions).where(eq(schema.tagDimensions.id, (r as any).insertId));
    return d;
  }

  private async getOneTag(id: number) {
    const [t] = await db.select().from(schema.tags).where(eq(schema.tags.id, id));
    return t;
  }
}
