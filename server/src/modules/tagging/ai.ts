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
- is_artwork=false 若是：广告/商单推广图、纯文字海报或公告（约稿/涨价/课程/福利）、日常照片、表情包、截图、logo。
- quality：作为「画师作品集封面」的展示质量，0=极差(文字满屏/模糊/无绘画元素)，10=完成度高的精美插画。非作品一律给 0~2。
- category：artwork / ad / text_poster / photo / other 之一。
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
