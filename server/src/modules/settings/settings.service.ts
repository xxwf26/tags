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
      preview: r.value ? r.value.slice(0, 30) + '...' : null,
    }));
  }

  async set(key: string, value: string) {
    // upsert
    const [existing] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
    if (existing) {
      await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key));
    } else {
      await db.insert(schema.settings).values({ key, value });
    }
    return { key, saved: true };
  }

  async getXhsCookie() {
    return this.get('xhs_cookie') || process.env.XHS_COOKIE || '';
  }
}
