// 操作记录查询 + 撤销
import { db, schema } from '../../database/db.js';
import { eq, desc } from 'drizzle-orm';
import { logOperation } from './op.js';

export class OperationService {
  async list(limit = 100) {
    return db.select().from(schema.operations).orderBy(desc(schema.operations.id)).limit(limit);
  }

  async undo(id: number) {
    const [op] = await db.select().from(schema.operations).where(eq(schema.operations.id, id));
    if (!op) throw new Error('操作记录不存在');
    if (!op.undoable) throw new Error('该操作不可撤销');
    if (op.undone) throw new Error('已撤销过');

    if (op.type === 'artwork_delete') {
      const payload = op.payload as any;
      if (!payload?.artworkId) throw new Error('撤销信息缺失');
      await db.update(schema.artworks).set({ deletedAt: null }).where(eq(schema.artworks.id, payload.artworkId));
    } else {
      throw new Error(`暂不支持撤销 ${op.type}`);
    }

    await db.update(schema.operations).set({ undone: 1 }).where(eq(schema.operations.id, id));
    await logOperation({ type: 'undo', targetType: op.targetType, targetId: op.targetId, summary: `撤销「${op.summary}」` });
    return { undone: true };
  }

  // 重做（撤销的逆操作）：重新软删作品，op.undone 1→0
  async redo(id: number) {
    const [op] = await db.select().from(schema.operations).where(eq(schema.operations.id, id));
    if (!op) throw new Error('操作记录不存在');
    if (!op.undoable) throw new Error('该操作不可重做');
    if (!op.undone) throw new Error('该操作未撤销，无需重做');

    if (op.type === 'artwork_delete') {
      const payload = op.payload as any;
      if (!payload?.artworkId) throw new Error('重做信息缺失');
      await db.update(schema.artworks).set({ deletedAt: new Date(Date.now() + 8 * 3600 * 1000) }).where(eq(schema.artworks.id, payload.artworkId));
    } else {
      throw new Error(`暂不支持重做 ${op.type}`);
    }

    await db.update(schema.operations).set({ undone: 0 }).where(eq(schema.operations.id, id));
    await logOperation({ type: 'redo', targetType: op.targetType, targetId: op.targetId, summary: `重做「${op.summary}」` });
    return { redone: true };
  }
}
