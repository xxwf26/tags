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
  styleHint: json('style_hint'),                    // 画师级临时画风 string[]（如 ["国风","水墨"]）；区别于作品级白名单标签 artwork_tags
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
  deletedAt: datetime('deleted_at'),                  // 软删时间戳（null=正常，非 null=已删除可恢复）
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  artistIdx: index('idx_artist').on(t.artistId),
  hashIdx: index('idx_hash').on(t.imageHash),
  statusIdx: index('idx_status').on(t.tagStatus),
  orientIdx: index('idx_orient').on(t.orientation),
  deletedIdx: index('idx_deleted').on(t.deletedAt),
}));

// 操作记录（审计日志 + 撤销）
export const operations = mysqlTable('operations', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  type: varchar('type', { length: 64 }),
  targetType: varchar('target_type', { length: 32 }),
  targetId: bigint('target_id', { mode: 'number' }),
  summary: varchar('summary', { length: 255 }),
  payload: json('payload'),
  undoable: tinyint('undoable').default(0),
  undone: tinyint('undone').default(0),
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  typeIdx: index('idx_op_type').on(t.type),
  targetIdx: index('idx_op_target').on(t.targetType, t.targetId),
}));

// 系统设置（key-value，存 cookie 等）
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value'),
  updatedAt: datetime('updated_at').default(sql`now()`).$onUpdateFn(() => new Date()),
});

// 作品 ↔ 标签
export const artworkTags = mysqlTable('artwork_tags', {
  artworkId: bigint('artwork_id', { mode: 'number' }).notNull(),
  tagId: int('tag_id').notNull(),
  source: mysqlEnum('source', ['ai', 'manual']).default('manual'),
  confidence: float('confidence'),
}, (t) => ({
  pk: primaryKey({ columns: [t.artworkId, t.tagId] }),
}));

// 候选（外部采集：小红书笔记 → 复核队列 → 转正入库）
export const candidates = mysqlTable('candidates', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  sourcePlatform: varchar('source_platform', { length: 32 }).default('xiaohongshu'),
  sourceUrl: varchar('source_url', { length: 512 }),
  artistName: varchar('artist_name', { length: 128 }),
  raw: json('raw'),                            // {title, desc, tags[], images:[{url,width,height}]}
  status: mysqlEnum('status', ['pending', 'promoted', 'merged', 'rejected']).default('pending'),
  dedupArtistId: bigint('dedup_artist_id', { mode: 'number' }),
  promotedArtistId: bigint('promoted_artist_id', { mode: 'number' }),
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  statusIdx: index('idx_cand_status').on(t.status),
}));

export type Artist = typeof artists.$inferSelect;
export type Artwork = typeof artworks.$inferSelect;
export type Tag = typeof tags.$inferSelect;

// ============ 寻源功能（参考图 → AI打标 → 按标签搜索 → 三级库） ============

// 参考图：上传的参考图 + AI/人工标签
export const referenceImages = mysqlTable('reference_images', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  imageUrl: varchar('image_url', { length: 512 }).notNull(),
  imageHash: char('image_hash', { length: 16 }),
  width: int('width'), height: int('height'),
  aiTags: json('ai_tags'),                        // AI 自动打的 [{tagId, label, dimensionId, confidence}]
  manualTags: json('manual_tags'),                // 人工调整后的 [{tagId, label, dimensionId}]
  status: mysqlEnum('status', ['tagging', 'ready', 'searching']).default('tagging'),
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  statusIdx: index('idx_ref_status').on(t.status),
}));

// 搜索会话：每次搜索 = 一个 session（不覆盖，迭代链）
export const searchSessions = mysqlTable('search_sessions', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  referenceImageId: bigint('reference_image_id', { mode: 'number' }),  // 可空：纯标签搜无参考图
  parentSessionId: bigint('parent_session_id', { mode: 'number' }),  // 上一次 session（迭代链）
  mode: varchar('mode', { length: 16 }).default('tags'),   // 'image'=以图找相近 | 'tags'=按标签搜
  refEmbedding: json('ref_embedding'),            // 参考图 CLIP 向量快照（image 模式）
  searchTags: json('search_tags'),                // 本次搜索标签快照 [{tagId, label, dimensionId}]
  platforms: json('platforms'),                   // ["mihuashi","xiaohongshu","weibo"]
  status: mysqlEnum('status', ['running', 'ok', 'failed']).default('running'),
  doneCount: int('done_count').default(0),        // 已处理候选数（进度）
  totalCount: int('total_count').default(0),      // 候选池总数（进度分母）
  resultCount: int('result_count').default(0),
  newCount: int('new_count').default(0),          // vs 上一次 session 新增的
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  refIdx: index('idx_session_ref').on(t.referenceImageId),
}));

// 搜索结果：每张找到的画
export const searchResults = mysqlTable('search_results', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  sessionId: bigint('session_id', { mode: 'number' }).notNull(),
  referenceImageId: bigint('reference_image_id', { mode: 'number' }),  // 可空：纯标签搜无参考图
  platform: varchar('platform', { length: 32 }),   // xiaohongshu/mihuashi/weibo
  sourceUrl: varchar('source_url', { length: 512 }),
  imageUrl: varchar('image_url', { length: 512 }),  // 外链（不落盘直到 promote）
  title: varchar('title', { length: 255 }),
  author: varchar('author', { length: 128 }),
  authorUrl: varchar('author_url', { length: 512 }),
  tags: json('tags'),                              // 平台自带标签
  aiTags: json('ai_tags'),                         // AI 给这张图打的标签（可选）
  allImages: json('all_images'),                   // 该帖所有图片URL（一帖多图）
  imageHash: char('image_hash', { length: 16 }),
  similarity: float('similarity'),                 // 与参考图的 CLIP 余弦相似度 0~1（image 模式；tags 模式为 null）
  quality: float('quality'),                       // AI 质检质量分 0~10
  isNew: tinyint('is_new').default(1),             // vs 上一次 session 是否新增
  tier: mysqlEnum('tier', ['tier1', 'tier2', 'promoted', 'rejected']).default('tier1'),
  promotedArtworkId: bigint('promoted_artwork_id', { mode: 'number' }),
  createdAt: datetime('created_at').default(sql`now()`),
}, (t) => ({
  sessionIdx: index('idx_result_session').on(t.sessionId),
  refIdx: index('idx_result_ref').on(t.referenceImageId),
  tierIdx: index('idx_result_tier').on(t.tier),
}));
export type TagDimension = typeof tagDimensions.$inferSelect;
