import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({ host: process.env.DB_HOST, port: +process.env.DB_PORT!, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const [rows] = await c.query(`SELECT id, search_tags FROM search_sessions WHERE JSON_EXTRACT(search_tags, '$.tags') LIKE '%[object Object]%' ORDER BY id DESC LIMIT 30`);
console.log(`含[object Object]的session: ${(rows as any[]).length} 个`);
for (const r of rows as any[]) {
  const tags = r.search_tags?.tags;
  let fixed: string[] = [];
  if (Array.isArray(tags)) fixed = tags.map((t: any) => typeof t === 'string' ? t : (t?.label || t?.name || '?'));
  console.log(`  #${r.id}: [${fixed.join('+')}]`);
  const newSearchTags = { ...r.search_tags, tags: fixed };
  await c.query(`UPDATE search_sessions SET search_tags=? WHERE id=?`, [JSON.stringify(newSearchTags), r.id]);
}
console.log(`已修复 ${(rows as any[]).length} 个`);
await c.end();
