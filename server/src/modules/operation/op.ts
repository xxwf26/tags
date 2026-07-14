// 操作记录写入（审计日志）。各 service 调用，失败不阻断主流程。
import { db, schema } from '../../database/db.js';

export async function logOperation(opts: {
  type: string; targetType?: string | null; targetId?: number | null;
  summary?: string | null; payload?: any; undoable?: boolean;
}): Promise<number | null> {
  try {
    const [r] = await db.insert(schema.operations).values({
      type: opts.type,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      summary: opts.summary ?? null,
      payload: opts.payload ?? null,
      undoable: opts.undoable ? 1 : 0,
    });
    return (r as any).insertId ?? null;
  } catch {
    return null;
  }
}
