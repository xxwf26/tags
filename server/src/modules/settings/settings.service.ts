// 系统设置：cookie 等key-value存取
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';

export class SettingsService {
  async get(key: string) {
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
    return row?.value ?? null;
  }

  async getAll() {
    const rows = await db.select().from(schema.settings);
    return rows.map(r => ({
      key: r.key,
      hasValue: !!r.value,
      updatedAt: r.updatedAt,
      preview: r.value ? (r.value.length > 30 ? r.value.slice(0, 30) + '...' : r.value) : null,
    }));
  }

  async set(key: string, value: string) {
    // 原子 upsert：key 是主键，先查后写会在并发保存同 key 时双双走 insert 撞主键。
    await db.insert(schema.settings).values({ key, value })
      .onDuplicateKeyUpdate({ set: { value } });
    return { key, saved: true };
  }

  async getXhsCookie() {
    return this.get('xhs_cookie') || process.env.XHS_COOKIE || '';
  }
}
