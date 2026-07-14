import { Injectable } from '@nestjs/common';
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';

@Injectable()
export class TagService {
  async getTree() {
    const dims = await db.select().from(schema.tagDimensions).orderBy(schema.tagDimensions.sort);
    const tagRows = await db.select().from(schema.tags).where(eq(schema.tags.enabled, 1));
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
        id: t.id, label: t.label, aliases: t.aliases, note: t.note,
      }));
      if (d.parentId && byId.has(d.parentId)) {
        byId.get(d.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
