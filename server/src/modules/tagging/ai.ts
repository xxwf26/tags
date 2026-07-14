// AI 打标：DB 词表构建 prompt + Gemini/豆包双模型调用 + 白名单归一
// 协议参考 verify/gemini.mjs（Gemini 原生 v1beta）与 verify/tag.mjs（OpenAI 兼容）
import { db, schema } from '../../database/db.js';
import { eq } from 'drizzle-orm';

const AI_BASE = (process.env.AI_BASE_URL || 'https://tc-paperhub.diezhi.net').replace(/\/$/, '');
const AI_KEY = process.env.AI_API_KEY || process.env.PAPERHUB_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-1-6-vision';

export type Taxonomy = {
  codes: string[];
  prompt: string;
  labelMap: Map<string, number>; // lower(label 或 alias) -> tagId
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
  const prompt = `你是资深插画风格分析师。给你一张画作，请从固定标签词表中为它打多维标签。
词表（只能从中选词，禁止自创）：
${tree.map(d => `- ${d.name}(${d.code})：${d.tags.map(t => t.label).join('、')}`).join('\n')}

规则：
1. 每个维度选 0~3 个最贴切的标签；拿不准就少选或不选，不要硬凑。
2. 只输出词表里出现过的原词。
3. 严格输出 JSON，格式：{${codes.map(c => `"${c}":[]`).join(',')}}
4. 不要输出任何解释、不要用 markdown 代码块包裹。`;

  const labelMap = new Map<string, number>();
  for (const t of tagRows) {
    labelMap.set(String(t.label).trim().toLowerCase(), t.id);
    for (const a of (t.aliases as string[] | null) || []) {
      labelMap.set(String(a).trim().toLowerCase(), t.id);
    }
  }
  return { codes, prompt, labelMap };
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

async function callGemini(b64: string, mime: string, prompt: string): Promise<string | null> {
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
