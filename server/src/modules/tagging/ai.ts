// AI 打标：DB 词表构建 prompt + Gemini/豆包双模型调用 + 白名单归一
// 协议参考 verify/gemini.mjs（Gemini 原生 v1beta）与 verify/tag.mjs（OpenAI 兼容）
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';

const AI_BASE = (process.env.AI_BASE_URL || 'https://tc-paperhub.diezhi.net').replace(/\/$/, '');
const AI_KEY = process.env.AI_API_KEY || process.env.PAPERHUB_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-1-6-vision';

// 是否配置了 AI key（结构性缺配检测，区别于运行时偶发故障）
export function isAiConfigured(): boolean {
  return !!AI_KEY;
}

export type Taxonomy = {
  codes: string[];
  prompt: string;
  labelMap: Map<string, number>;
  codesStr?: string;
};

// 从 DB 载入 6 维两级词表 + 构建 prompt + 别名归一表
export async function loadTaxonomy(): Promise<Taxonomy> {
  const dims = await db.select().from(schema.tagDimensions);
  const tagRows = await db.select().from(schema.tags).where(eq(schema.tags.enabled, 1));
  const dimById = new Map(dims.map(d => [d.id, d]));
  const rootOf = (id: number): number => {
    let d = dimById.get(id); let cur = id;
    while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
    return cur;
  };
  const tops = dims.filter(d => !d.parentId).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const tree = tops.map(top => ({
    code: top.code || '',
    name: top.name || top.code || '',
    tags: tagRows.filter(t => rootOf(t.dimensionId) === top.id).map(t => ({ label: t.label, aliases: t.aliases })),
  }));
  const codes = tree.map(d => d.code);
  const prompt = `你是资深插画风格分析师。给你一张图，先判断它是否为绘画/插画作品，再打标签。

判断标准（is_artwork 字段）：
- 是：人工创作的画作——手绘、板绘、数字插画、水彩、油画、国画、漫画等
- 否：以下全部判否——
  · 实拍照片、截图、纯文字图、广告海报、商品图、表情包贴图
  · AI生成图（Midjourney/Stable Diffusion/DALL-E/NovelAI等AI绘图工具生成的图片）
  · 疑似AI生成图（过度光滑、无笔触感、光影不自然、细节过度均匀等AI特征）

判断AI生成图的关键线索：皮肤/头发/衣物纹理过于平滑无笔触、光影逻辑不自洽、手指/眼睛/背景细节畸变、整体风格"太完美不像人画的"。拿不准时倾向于判否。

质量评分（quality 字段，0-10）：
- 0分：非画作（照片/截图/广告/纯文字）
- 1-2分：疑似AI生成图或低质量AI图
- 3-4分：画作但完成度低/草稿/速写/简笔画
- 3-4分：画作但完成度低/草稿/速写/简笔画
- 5-6分：普通完成度的插画
- 7-8分：精美的插画作品
- 9-10分：大师级作品

词表（只能从中选词，禁止自创）：
${tree.map(d => `- ${d.name}(${d.code})：${d.tags.map(t => t.label).join('、')}`).join('\n')}

规则：
1. 先判断 is_artwork 和 quality。
2. 如果 is_artwork=false，标签可以留空。
3. 如果 is_artwork=true，每个维度选 0~3 个最贴切的标签。
4. 只输出词表里出现过的原词。
5. 严格输出 JSON，格式：{"is_artwork":true,"quality":7,${codes.map(c => `"${c}":[]`).join(',')}}
6. 不要输出任何解释、不要用 markdown 代码块包裹。`;

  const labelMap = new Map<string, number>();
  for (const t of tagRows) {
    labelMap.set(String(t.label).trim().toLowerCase(), t.id);
    for (const a of (t.aliases as string[] | null) || []) {
      labelMap.set(String(a).trim().toLowerCase(), t.id);
    }
  }
  return { codes, prompt, labelMap, codesStr: codes.map(c => `"${c}":[]`).join(',') };
}

export function extractJson(text: string | null): any {
  if (!text) return null;
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

// 模型输出 → 命中白名单的 tagId 集合（按词表归属，丢弃越界词）
export function normalizeOutput(parsed: any, labelMap: Map<string, number>): Set<number> {
  const ids = new Set<number>();
  if (!parsed) return ids;
  for (const arr of Object.values(parsed)) {
    if (!Array.isArray(arr)) continue;
    for (const w of arr) {
      const id = labelMap.get(String(w).trim().toLowerCase());
      if (id) ids.add(id);
    }
  }
  return ids;
}

export async function callGemini(b64: string, mime: string, prompt: string): Promise<string | null> {
  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{ role: 'user', parts: [
      { text: '请给这张画作打标签，只输出 JSON。' },
      { inline_data: { mime_type: mime, data: b64 } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
  };
  const res = await fetch(`${AI_BASE}/gemini/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', headers: { Authorization: `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`gemini: ${json.error.message}`);
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: any) => p.thought !== true).map((p: any) => p.text || '').join('').trim() || null;
}

// 纯文本调用（无图）：抽取简介里的联系方式/档期用。复用 callGemini 的 fetch 模式。
export async function callGeminiText(prompt: string, userText: string): Promise<string | null> {
  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
  };
  const res = await fetch(`${AI_BASE}/gemini/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', headers: { Authorization: `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`gemini: ${json.error.message}`);
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: any) => p.thought !== true).map((p: any) => p.text || '').join('').trim() || null;
}

// 多图一次调用：把多张图放进同一个 user turn，适合"给整组图做一个整体判断"（如判画师主页画风构成）
// model/timeoutMs 可选：判画师号可用更快模型 + 更短超时配合重试。
export async function callGeminiMulti(imgs: { b64: string; mime: string }[], prompt: string, opts?: { model?: string; timeoutMs?: number }): Promise<string | null> {
  const model = opts?.model || GEMINI_MODEL;
  const timeoutMs = opts?.timeoutMs ?? 120000;
  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{ role: 'user', parts: [
      { text: '下面是同一个账号主页的多张笔记封面，请整体判断，只输出 JSON。' },
      ...imgs.map(im => ({ inline_data: { mime_type: im.mime, data: im.b64 } })),
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
  };
  const res = await fetch(`${AI_BASE}/gemini/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { Authorization: `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`gemini: ${json.error.message}`);
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: any) => p.thought !== true).map((p: any) => p.text || '').join('').trim() || null;
}

async function callDoubao(b64: string, mime: string, prompt: string): Promise<string | null> {
  const body = {
    model: DOUBAO_MODEL,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: [
        { type: 'text', text: '请给这张画作打标签，只输出 JSON。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ] },
    ],
    max_tokens: 800, temperature: 0,
  };
  const res = await fetch(`${AI_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`doubao: ${json.error.message}`);
  return json.choices?.[0]?.message?.content || null;
}

export async function callBoth(b64: string, mime: string, prompt: string) {
  const [g, d] = await Promise.allSettled([callGemini(b64, mime, prompt), callDoubao(b64, mime, prompt)]);
  return {
    gemini: g.status === 'fulfilled' ? g.value : null,
    doubao: d.status === 'fulfilled' ? d.value : null,
    geminiError: g.status === 'rejected' ? (g.reason as Error).message : null,
    doubaoError: d.status === 'rejected' ? (d.reason as Error).message : null,
  };
}

// 采集质检闸门：判断一张图是不是「原创插画作品」而非广告/文字海报/日常照，并给质量分。
// 用单模型（Gemini）控成本。AI 故障时中性放行（isArtwork=true, quality=5），
// 避免模型挂掉导致全部被拦、入库为空——此时退化为原「取前 N 张」行为。
const GATE_PROMPT = `你是插画作品筛选员。判断给你的这张图属于哪一类，并给质量分。
只输出 JSON，格式：{"is_artwork":true/false,"quality":0-10,"category":"...","reason":"..."}
判定规则：
- is_artwork=true 仅当这是一张原创绘画/插画/漫画作品（人物、场景、设定等手绘或数字绘画）。
- is_artwork=false 若是以下任何一种：
  · 广告/商单推广图、纯文字海报或公告（约稿/涨价/课程/福利）
  · 日常照片、cosplay照片、手办/周边商品实拍
  · 表情包、截图、logo
  · AI生成图（Midjourney/Stable Diffusion/DALL-E/NovelAI等，特征：过度光滑无笔触、光影不自洽、手指/眼睛畸变、细节过度均匀）
  · 疑似AI生成图（拿不准时倾向判否）
- quality：作为「画师作品集封面」的展示质量：
  · 0-2：非绘画作品（照片/广告/截图/AI图）
  · 3-4：绘画但完成度低（草稿/线稿/速写/简笔画/未上色）
  · 5-6：普通完成度的插画（有上色但构图/细节一般）
  · 7-8：精美的插画作品（构图好、细节丰富、色彩协调）
  · 9-10：大师级作品
  · 非作品一律给 0~2，线稿/草稿给 3-4。
- category：artwork / ai_generated / ad / text_poster / photo / cosplay / other 之一。
不要输出任何解释性文字、不要用 markdown 代码块包裹。`;

export type GateResult = { isArtwork: boolean; quality: number; category: string; reason: string; error: string | null; skipped: boolean };

export async function gateArtwork(b64: string, mime: string): Promise<GateResult> {
  // 无 key = 结构性缺配，不是偶发故障：明确标 skipped，让调用方决定（跳过入库 or 打"未质检"标）。
  // 否则每张图都命中下面的 catch 返回 quality=5，广告/照片/文字海报会全量涌进库。
  if (!isAiConfigured()) {
    return { isArtwork: true, quality: 5, category: 'unknown', reason: '', error: 'AI_API_KEY 未配置', skipped: true };
  }
  try {
    const raw = await callGemini(b64, mime, GATE_PROMPT);
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('gate 输出无法解析');
    const quality = Math.max(0, Math.min(10, Number(parsed.quality) || 0));
    return {
      isArtwork: parsed.is_artwork === true,
      quality,
      category: String(parsed.category || 'other'),
      reason: String(parsed.reason || ''),
      error: null,
      skipped: false,
    };
  } catch (e) {
    // 运行时偶发故障（超时/限流）：中性放行，不因抖动漏掉真作品，但标 skipped 供上层区分
    return { isArtwork: true, quality: 5, category: 'unknown', reason: '', error: (e as Error).message, skipped: true };
  }
}

// 质检 + 打标一次调用：tax.prompt 本就同时输出 is_artwork/quality/各维度标签，
// 一次 Gemini 拿全三者，避免「gate 短 prompt + tag 长 prompt」两次串行调用（对 vision flash，
// 延迟主要来自图片编码+输出生成，长 prompt 多几十个词几乎不增延迟，故合并 = 砍掉一半调用）。
// AI 故障/无 key：中性放行（isArtwork=true, quality=5, 无标签），标 skipped 供上层区分。
export type GateTagResult = { isArtwork: boolean; quality: number; tagIds: Set<number>; error: string | null; skipped: boolean };

export async function gateAndTag(b64: string, mime: string, tax: Taxonomy): Promise<GateTagResult> {
  if (!isAiConfigured()) {
    return { isArtwork: true, quality: 5, tagIds: new Set(), error: 'AI_API_KEY 未配置', skipped: true };
  }
  try {
    const raw = await callGemini(b64, mime, tax.prompt);
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('打标输出无法解析');
    const quality = Math.max(0, Math.min(10, Number(parsed.quality) || 0));
    return {
      isArtwork: parsed.is_artwork === true,
      quality,
      tagIds: normalizeOutput(parsed, tax.labelMap),
      error: null,
      skipped: false,
    };
  } catch (e) {
    return { isArtwork: true, quality: 5, tagIds: new Set(), error: (e as Error).message, skipped: true };
  }
}

// 判画师号：给一个账号主页的多张笔记封面，整体判断这是不是「画师/插画创作者」账号。
// 寻源新逻辑的核心——过滤标准是「作者是不是画师」而非「单张作品质量/画风」。
// 主页以原创绘画为主 = 画师（留）；穿搭/美食/日常/自拍/摄影/搬运转发为主 = 路人（丢）。
// 同时给每张封面打质量分（0-10），用于代表作排序——qualities[i] 与输入封面顺序一一对应。
const ARTIST_JUDGE_MODEL = process.env.ARTIST_JUDGE_MODEL || GEMINI_MODEL; // 可换更快模型
const ARTIST_JUDGE_TIMEOUT = Number(process.env.ARTIST_JUDGE_TIMEOUT) || 60000; // 短超时配合重试
const ARTIST_JUDGE_PROMPT = `你是画师星探。给你的是某个社交账号主页最近若干篇笔记的封面图（按给出顺序编号 0,1,2...），请整体判断这个账号是不是「画师/插画创作者」账号，并给每张封面打质量分。
只输出 JSON，格式：{"is_artist":true/false,"art_ratio":0.0~1.0,"style":"...","reason":"...","qualities":[7,5,8,...]}
判定规则：
- is_artist=true：主页以本人原创的绘画/插画/漫画/角色设计/同人图/概念设计为主（占比过半即可，允许夹杂线稿、过程图、少量杂图）。
- is_artist=false：主页以下列内容为主——穿搭/美食/旅游/健身/自拍/日常vlog/摄影写真/cosplay实拍/手办周边/影视综艺/搬运转发他人作品/纯文字/商品带货/教程课程。
- art_ratio：这些封面里「原创绘画作品」所占的大致比例（0~1）。
- style：用一句话概括这个画师的大致画风（如"日系厚涂人物"、"古风水墨"、"欧美卡通"、"Q版头像"），不限词表，自由概括；非画师则留空字符串。
- reason：一句话中文说明依据（如"主页多为原创古风人物插画"或"主页以穿搭自拍为主，非画师"）。
- qualities：数组，长度与输入封面数量一致，第 i 个元素是第 i 张封面作为「画师代表作展示质量」的评分(0-10)：0-2 非绘画/广告/截图/AI图，3-4 草稿线稿，5-6 普通插画，7-8 精美，9-10 大师级。务必按输入顺序对应，不可遗漏。
判断要点：看整体构成，不是看单张好坏。宁可对"疑似画师但夹杂杂图"判 true，也就是占比过半即算画师。
不要输出任何解释性文字、不要用 markdown 代码块包裹。`;

export type ArtistJudgeResult = { isArtist: boolean; artRatio: number; style: string; reason: string; qualities: number[]; error: string | null; skipped: boolean };

export async function judgeArtistAccount(covers: { b64: string; mime: string }[]): Promise<ArtistJudgeResult> {
  // 无 key / 无封面 = 结构性缺配：中性放行标 skipped，宁可留给人工筛也不漏画师。
  if (!isAiConfigured() || !covers.length) {
    return { isArtist: true, artRatio: 0.5, style: '', reason: '', qualities: [], error: isAiConfigured() ? '无封面' : 'AI_API_KEY 未配置', skipped: true };
  }
  // 超时/限流重试 1 次：偶发抖动不该让画师被中性放行混入或丢失
  const callOnce = async () => callGeminiMulti(covers, ARTIST_JUDGE_PROMPT, { model: ARTIST_JUDGE_MODEL, timeoutMs: ARTIST_JUDGE_TIMEOUT });
  const t0 = Date.now();
  let raw: string | null = null;
  try {
    raw = await callOnce();
    if (raw == null) throw new Error('空响应');
  } catch (e1: any) {
    console.warn(`[ai] 判画师首试失败(${e1.message})，1.5s 后重试…`);
    await new Promise(r => setTimeout(r, 1500));
    raw = await callOnce(); // 重试再失败则抛出，进下面的 catch 中性放行
  }
  console.log(`[ai] 判画师 ${covers.length} 张封面耗时 ${(Date.now() - t0) / 1000}s`);
  try {
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('画师判定输出无法解析');
    const artRatio = Math.max(0, Math.min(1, Number(parsed.art_ratio) || 0));
    const qualities = Array.isArray(parsed.qualities)
      ? parsed.qualities.map((q: any) => Math.max(0, Math.min(10, Number(q) || 0)))
      : [];
    return {
      isArtist: parsed.is_artist === true,
      artRatio,
      style: String(parsed.style || ''),
      reason: String(parsed.reason || ''),
      qualities,
      error: null,
      skipped: false,
    };
  } catch (e) {
    // 运行时偶发故障（重试仍失败）：中性放行不漏画师，标 skipped 供上层区分
    return { isArtist: true, artRatio: 0.5, style: '', reason: '', qualities: [], error: (e as Error).message, skipped: true };
  }
}
