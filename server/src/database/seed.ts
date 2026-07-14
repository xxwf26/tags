// 种子：6 维两级标签白名单 + 几个真实画师（画风标签留 P1 AI 打标 / P0 人工录入作品）
import 'dotenv/config';
import { db, schema } from './db.js';
import { eq } from 'drizzle-orm';

const GENRE_SUBS: Record<string, string[]> = {
  '东方画风': ['国风', '水墨', '工笔', '浮世绘'],
  '西方画风': ['欧美', '油画', '厚涂写实'],
  '二次元画风': ['日系', '赛璐璐', '二次元', '像素'],
  '民艺': ['皮影', '剪纸风', '年画'],
};
const ALIASES: Record<string, string[]> = {
  '国风': ['国风古风', '古风', '中国风'],
  '日系': ['日式', '日漫'],
  '二次元': ['日漫风'],
};

async function seedTaxonomy() {
  const existing = await db.select().from(schema.tagDimensions);
  if (existing.length) { console.log(`维度已存在（${existing.length} 行），跳过 taxonomy 种子`); return; }

  const top = [
    { code: 'genre', name: '画风', sort: 1 },
    { code: 'subject', name: '题材', sort: 2 },
    { code: 'technique', name: '绘制技巧', sort: 3 },
    { code: 'usage', name: '用途', sort: 4 },
    { code: 'tone', name: '色调/情绪', sort: 5 },
    { code: 'character', name: '人物类型', sort: 6 },
  ];
  const topIds: Record<string, number> = {};
  for (const t of top) {
    const [r] = await db.insert(schema.tagDimensions).values({ ...t, parentId: null });
    topIds[t.code] = (r as any).insertId;
  }
  // genre 子维度 + 标签
  let subSort = 1;
  for (const [subName, labels] of Object.entries(GENRE_SUBS)) {
    const [sr] = await db.insert(schema.tagDimensions).values({
      parentId: topIds.genre, code: `genre_${subSort}`, name: subName, sort: subSort,
    });
    const subId = (sr as any).insertId;
    for (const label of labels) {
      await db.insert(schema.tags).values({ dimensionId: subId, label, aliases: ALIASES[label] ?? null });
    }
    subSort++;
  }
  // 其余顶层维度标签
  const flatTags: Record<string, string[]> = {
    subject: ['人物立绘', '场景', '动物', 'Q版', '机甲', '美食', '风景', '建筑'],
    technique: ['线稿', '平涂', '厚涂', '伪厚涂', '噪点', '描线', '肌理'],
    usage: ['头像', '立绘', '表情包', '漫画', '插画', '商稿', '海报', '同人'],
    tone: ['高饱和', '低饱和', '冷色', '暖色', '治愈', '性冷淡', '通透', '浓郁'],
    character: ['成男', '成女', '小孩', 'Q版', '非人'],
  };
  for (const [code, labels] of Object.entries(flatTags)) {
    for (const label of labels) {
      await db.insert(schema.tags).values({ dimensionId: topIds[code], label, aliases: null });
    }
  }
  console.log('taxonomy 种子完成：6 顶层维度 + genre 4 子维度 + 标签');
}

async function seedArtists() {
  const seed = [
    { name: '尧立', bio: '国风插画师 · 工笔与水墨并行 · 约稿开放', commission: 'open', engageStatus: 'cooperated',
      links: { xiaohongshu: ['https://www.xiaohongshu.com/user/profile/646b54e70000000012037f15'] },
      drawingHabit: { update_frequency: '月更', active_time: '晚间更新居多', style_trend: '早期偏赛璐璐，近期转工笔', commission_signal: '约稿开放' } },
    { name: '子每', bio: '国风水墨 · 仅接商稿', commission: 'commercial_only', engageStatus: 'cooperated',
      links: { xiaohongshu: ['https://www.xiaohongshu.com/user/profile/61548ee6000000001f03f687'] },
      drawingHabit: { update_frequency: '月更', active_time: '晚间', style_trend: '国风水墨为主', commission_signal: '仅接商稿' } },
    { name: '金桥', bio: '皮影 / 民艺场景 · 约稿开放', commission: 'open', engageStatus: 'cooperated',
      links: { xiaohongshu: ['https://www.xiaohongshu.com/user/profile/62a19d35000000001902a1ab'] },
      drawingHabit: { update_frequency: '月更', active_time: '晚间', style_trend: '皮影出圈后持续民艺方向', commission_signal: '约稿开放' } },
  ];
  for (const a of seed) {
    const [ex] = await db.select().from(schema.artists).where(eq(schema.artists.name, a.name));
    if (ex) { console.log(`画师「${a.name}」已存在，跳过`); continue; }
    await db.insert(schema.artists).values(a as any);
    console.log(`画师「${a.name}」已插入`);
  }
}

async function main() {
  await seedTaxonomy();
  await seedArtists();
  console.log('种子完成');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
