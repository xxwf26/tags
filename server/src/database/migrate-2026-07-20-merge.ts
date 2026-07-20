// 一次性迁移：合并 feat/xunyuan-clip → main 后同步 DB
// 跑法：cd server && npx tsx src/database/migrate-2026-07-20-merge.ts
// 幂等，可重复执行。伙伴拉取此合并后必须跑一次，否则 /api/settings 会 500。
import 'dotenv/config';
import { db } from './db.js';
import { sql } from 'drizzle-orm';

// 1) 新建 settings 表（key-value，存 cookie 等系统设置）
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS settings (
    \`key\` varchar(64) NOT NULL,
    \`value\` text,
    updated_at datetime DEFAULT now(),
    PRIMARY KEY (\`key\`)
  )
`);
console.log('✓ settings 表已就绪');

// 2) 放宽 reference_image_id 为可空（纯标签搜索无参考图）——幂等
await db.execute(sql`ALTER TABLE search_sessions MODIFY reference_image_id bigint NULL`);
await db.execute(sql`ALTER TABLE search_results MODIFY reference_image_id bigint NULL`);
console.log('✓ search_sessions / search_results 的 reference_image_id 已放宽为可空');

console.log('迁移完成。');
process.exit(0);
