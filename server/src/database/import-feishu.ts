// @ts-nocheck
// 一次性导入：飞书台账「X6-2DLS-原画师资源汇总.xlsx」→ artists 表
// 幂等：按 小红书 profile id（无则 name）查重，已存在则合并更新。可重复跑。
// 跑法：cd server && npx tsx src/database/import-feishu.ts [可选xlsx路径]
import 'dotenv/config';
import xlsxPkg from 'xlsx';
const XLSX = (xlsxPkg as any).default ?? xlsxPkg;
import { db, schema } from './db.js';
import { eq } from 'drizzle-orm';

const XLSX_PATH = process.argv[2] || 'C:\\Users\\xiaoxiaocha\\Downloads\\X6-2DLS-原画师资源汇总.xlsx';

// ---- 画风白名单 + 别名归一（对齐 seed.ts）----
const GENRE_WHITELIST = new Set([
  '国风', '水墨', '工笔', '浮世绘', '欧美', '油画', '厚涂写实',
  '日系', '赛璐璐', '二次元', '像素', '皮影', '剪纸风', '年画',
]);
// 别名 → 标准画风
const ALIAS_TO_STD: Record<string, string> = {
  '国风古风': '国风', '古风': '国风', '中国风': '国风',
  '日式': '日系', '日漫': '日系', '日漫风': '二次元',
};
function normalizeGenre(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const std = ALIAS_TO_STD[t] || t;
  return GENRE_WHITELIST.has(std) ? std : null;
}

// ---- 建联状态映射 ----
const ENGAGE_MAP: Record<string, string> = {
  '待定': 'pending', '合作': 'cooperated', '不合作': 'rejected',
  '暂无档期': 'no_availability', '无法建联': 'unreachable',
};

// ---- URL：抽平台 + 稳定链接（剥 xsec_token 等 query）----
function parseLink(raw: string): { platform: string; url: string; profileId: string | null } | null {
  const s = String(raw || '').trim();
  if (!s.startsWith('http')) return null;
  const noQuery = s.split('?')[0];
  if (s.includes('xiaohongshu.com')) {
    const m = noQuery.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
    return { platform: 'xiaohongshu', url: noQuery, profileId: m ? m[1] : null };
  }
  if (s.includes('mihuashi.com')) {
    const m = noQuery.match(/\/users\/(\d+)/) || noQuery.match(/\/(\d+)(?:$|\/)/);
    return { platform: 'mihuashi', url: noQuery, profileId: m ? 'mhs_' + m[1] : null };
  }
  if (s.includes('weibo.com') || s.includes('weibo.cn')) {
    return { platform: 'weibo', url: noQuery, profileId: null };
  }
  return { platform: 'other', url: noQuery, profileId: null };
}

// ---- 风格备注拆分 ----
function parseStyleNote(raw: any): { styleHint: string[]; note: string | null } {
  const s = String(raw ?? '').trim();
  if (!s) return { styleHint: [], note: null };
  // 无效标记：纯符号 / 纯数字
  if (/^[✔✓✅√\s]+$/.test(s) || /^[\d.\s]+$/.test(s)) return { styleHint: [], note: null };

  const tokens = s.split(/[、，,／/]/).map(t => t.trim()).filter(Boolean);
  const genres = tokens.map(normalizeGenre).filter(Boolean) as string[];
  const allGenre = tokens.length > 0 && genres.length === tokens.length;

  if (allGenre) {
    // 纯画风列表：只进 styleHint，不占备注
    return { styleHint: [...new Set(genres)], note: null };
  }
  // 含描述性内容：原文进备注；短文本(≤8字)才顺带提画风，避免长句误提
  const styleHint = s.length <= 8 ? [...new Set(genres)] : [];
  return { styleHint, note: s };
}

type Acc = {
  key: string; name: string; links: Record<string, string[]>;
  styleHint: Set<string>; noteParts: string[]; engageStatus: string; createdAt?: Date;
};

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null });
  console.log(`读到 ${rows.length} 行`);

  // 表头（对齐实际列名）
  const COL = { name: '名称', date: '创建日期', profile: '个人概况', resume: '作品简历', style: '风格备注', engage: '是否推进合作' };

  // 1) 归并同一画师（按 dedup key）
  const accs = new Map<string, Acc>();
  for (const r of rows) {
    const name = String(r[COL.name] ?? '').trim();
    if (!name) continue;

    // 链接：个人概况 + 作品简历 合并去重
    const linkRaws = [r[COL.profile], r[COL.resume]].filter(Boolean);
    const parsed = linkRaws.map(parseLink).filter(Boolean) as NonNullable<ReturnType<typeof parseLink>>[];
    const profileId = parsed.find(p => p.profileId)?.profileId ?? null;
    const key = profileId ? 'pid:' + profileId : 'name:' + name;

    const { styleHint, note } = parseStyleNote(r[COL.style]);
    const engageRaw = String(r[COL.engage] ?? '').trim();
    const engageStatus = ENGAGE_MAP[engageRaw] || 'pending';
    const createdAt = r[COL.date] instanceof Date ? r[COL.date] : undefined;

    let acc = accs.get(key);
    if (!acc) {
      acc = { key, name, links: {}, styleHint: new Set(), noteParts: [], engageStatus: 'pending', createdAt };
      accs.set(key, acc);
    }
    for (const p of parsed) {
      const arr = acc.links[p.platform] ?? [];
      if (!arr.includes(p.url)) arr.push(p.url);
      acc.links[p.platform] = arr;
    }
    styleHint.forEach(g => acc!.styleHint.add(g));
    if (note && !acc.noteParts.includes(note)) acc.noteParts.push(note);
    // 建联状态：非 pending 优先保留
    if (engageStatus !== 'pending') acc.engageStatus = engageStatus;
    if (!acc.createdAt && createdAt) acc.createdAt = createdAt;
  }
  console.log(`归并后 ${accs.size} 个唯一画师（原 ${rows.length} 行）`);

  // 2) 已有画师索引（种子 + 之前导入）：按 profileId 与 name
  const existing = await db.select().from(schema.artists);
  const byPid = new Map<string, typeof existing[number]>();
  const byName = new Map<string, typeof existing[number]>();
  for (const a of existing) {
    byName.set(a.name, a);
    const links = (a.links as any) || {};
    for (const url of (links.xiaohongshu || [])) {
      const m = String(url).match(/\/user\/profile\/([0-9a-zA-Z]+)/);
      if (m) byPid.set(m[1], a);
    }
  }

  // 3) upsert
  const seenNames = new Set(existing.map(e => e.name));
  let inserted = 0, updated = 0;
  for (const acc of accs.values()) {
    const pid = acc.key.startsWith('pid:') ? acc.key.slice(4) : null;
    const match = (pid && byPid.get(pid)) || byName.get(acc.name);

    const mergedNote = acc.noteParts.length ? acc.noteParts.join(' ｜ ') : null;
    const styleHint = [...acc.styleHint];

    if (match) {
      // 合并：links 并集、styleHint 并集、备注补充（不覆盖种子已有 bio/habit）
      const exLinks = (match.links as any) || {};
      const links: Record<string, string[]> = { ...exLinks };
      for (const [plat, urls] of Object.entries(acc.links)) {
        const arr = links[plat] ?? [];
        for (const u of urls) if (!arr.includes(u)) arr.push(u);
        links[plat] = arr;
      }
      const exHint = ((match.styleHint as any) || []) as string[];
      const mergedHint = [...new Set([...exHint, ...styleHint])];
      const patch: any = { links, styleHint: mergedHint };
      // 种子画师已有 engageNote 则不覆盖；空则补
      if (!match.engageNote && mergedNote) patch.engageNote = mergedNote;
      // 种子画师 engageStatus 多为 cooperated，不降级；仅当现为 pending 才更新
      if (match.engageStatus === 'pending' && acc.engageStatus !== 'pending') patch.engageStatus = acc.engageStatus;
      await db.update(schema.artists).set(patch).where(eq(schema.artists.id, match.id));
      updated++;
    } else {
      // 重名不同人：加后缀区分
      let name = acc.name;
      if (seenNames.has(name)) { let i = 2; while (seenNames.has(`${acc.name} (${i})`)) i++; name = `${acc.name} (${i})`; }
      seenNames.add(name);
      const values: any = {
        name, links: acc.links, styleHint, engageStatus: acc.engageStatus,
        engageNote: mergedNote, commission: 'unknown',
      };
      if (acc.createdAt) values.createdAt = acc.createdAt;
      await db.insert(schema.artists).values(values);
      if (pid) { /* 记入索引，防同名再插 */ }
      inserted++;
    }
  }

  console.log(`\n完成：插入 ${inserted}，更新/合并 ${updated}`);
  const [{ n }] = await db.select().from(schema.artists).then(rs => [{ n: rs.length }]);
  console.log(`artists 现共 ${n} 行`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
