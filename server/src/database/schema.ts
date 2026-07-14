// Drizzle schema：画风标签系统 5 表（对齐设计方案 §2）
import { mysqlTable, bigint, varchar, text, json, int, tinyint, float, char, mysqlEnum, datetime, primaryKey, unique, index } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

// 画师
export const artists = mysqlTable('artists', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  aliases: json('aliases'),                         // string[]
  bio: text('bio'),
  contact: json('contact'),                         // {wechat,qq,email}
  links: json('links'),                             // {xiaohongshu:[],weibo:[],mihuashi:[]}
  commission: mysqlEnum('commission', ['open', 'full', 'commercial_only', 'unknown']).default('unknown'),
  drawingHabit: json('drawing_habit'),              // 见设计 §2.5
  engageStatus: mysqlEnum('engage_status', ['pending', 'contacted', 'negotiating', 'cooperated', 'rejected', 'no_availability', 'unreachable']).default('pending'),
  engageNote: text('engage_note'),
  createdAt: datetime('created_at').default(sql`now()`),
  updatedAt: datetime('updated_at').default(sql`now()`).$onUpdateFn(() => new Date()),
});

// 标签维度（两级：parent_id 指向顶层；genre 顶层 + 4 子维度；其余顶层无子）
export const tagDimensions = mysqlTable('tag_dimensions', {
  id: int('id').autoincrement().primaryKey(),
  parentId: int('parent_id'),                       // NULL=顶层
  code: varchar('code', { length: 32 }),            // 顶层全局唯一；子维度父下唯一
  name: varchar('name', { length: 64 }),
  sort: int('sort').default(0),
}, (t) => ({
  parentIdx: index('idx_parent').on(t.parentId),
}));

// 标签值（白名单）
export const tags = mysqlTable('tags', {
  id: int('id').autoincrement().primaryKey(),
  dimensionId: int('dimension_id').notNull(),       // 指最具体维度（顶层或子维度）
  label: varchar('label', { length: 64 }).notNull(),
  aliases: json('aliases'),                         // 归一别名 string[]
  note: varchar('note', { length: 255 }),
  enabled: tinyint('enabled').default(1),
}, (t) => ({
  uqDimLabel: unique('uq_dim_label').on(t.dimensionId, t.label),
}));

// 作品（主角）
export const artworks = mysqlTable('artworks', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  artistId: bigint('artist_id', { mode: 'number' }),
  title: varchar('title', { length: 255 }),
  imageUrl: varchar('image_url', { length: 512 }).notNull(),
  thumbUrl: varchar('thumb_url', { length: 512 }),
  width: int('width'),
  height: int('height'),
  orientation: mysqlEnum('orientation', ['横', '竖', '方']).default('横'),
  imageHash: char('image_hash', { length: 16 }),
  sourcePlatform: varchar('source_platform', { length: 32 }).default('manual'),
  sourceUrl: varchar('source_url', { length: 512 }),
  ocrText: text('ocr_text'),
  aiSummary: text('ai_summary'),
  aiTagged: tinyint('ai_tagged').default(0),
  tagConfidence: float('tag_confidence'),
  tagStatus: mysqlEnum('tag_status', ['pending', 'confirmed']).default('pending'),
  embedding: json('embedding'),
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  artistIdx: index('idx_artist').on(t.artistId),
  hashIdx: index('idx_hash').on(t.imageHash),
  statusIdx: index('idx_status').on(t.tagStatus),
  orientIdx: index('idx_orient').on(t.orientation),
}));

// 作品 ↔ 标签
export const artworkTags = mysqlTable('artwork_tags', {
  artworkId: bigint('artwork_id', { mode: 'number' }).notNull(),
  tagId: int('tag_id').notNull(),
  source: mysqlEnum('source', ['ai', 'manual']).default('manual'),
  confidence: float('confidence'),
}, (t) => ({
  pk: primaryKey({ columns: [t.artworkId, t.tagId] }),
}));

export type Artist = typeof artists.$inferSelect;
export type Artwork = typeof artworks.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type TagDimension = typeof tagDimensions.$inferSelect;
