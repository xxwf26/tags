// Gemini 原生 v1beta 画风打标适配器（与 tag.mjs 同构，产物格式兼容 eval.mjs）
// Gemini 端点是原生协议（非 OpenAI 兼容），不能复用 tag.mjs 的 /chat/completions。
// 用法：node gemini.mjs [model1 model2 ...]  默认 gemini-3.5-flash
// 环境变量：PAPERHUB_API_KEY（或 AI_API_KEY）；可选 GEMINI_BASE_URL（默认中转）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptTaxonomy, normalize, dimensionOf, dimensions } from './taxonomy.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(__dir, 'dataset');
const RESULTS = path.join(__dir, 'results');

const BASE = (process.env.GEMINI_BASE_URL || 'https://tc-paperhub.diezhi.net').replace(/\/$/, '');
const API_KEY = process.env.PAPERHUB_API_KEY || process.env.AI_API_KEY;
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-3.5-flash'];

if (!API_KEY) { console.error('缺 PAPERHUB_API_KEY 环境变量'); process.exit(1); }

const SYSTEM = `你是资深插画风格分析师。给你一张画作，请从固定标签词表中为它打多维标签。
词表（只能从中选词，禁止自创）：
${promptTaxonomy()}

规则：
1. 每个维度选 0~3 个最贴切的标签；拿不准就少选或不选，不要硬凑。
2. 只输出词表里出现过的原词。
3. 严格输出 JSON，格式：{"genre":[],"subject":[],"technique":[],"usage":[],"tone":[]}
4. 不要输出任何解释、不要用 markdown 代码块包裹。`;

function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

// 归一化：标签映射白名单、按维度归位（与 tag.mjs 一致）
function cleanTags(parsed) {
  const out = {}; for (const d of dimensions()) out[d] = [];
  if (!parsed) return out;
  for (const [dim, arr] of Object.entries(parsed)) {
    if (!Array.isArray(arr)) continue;
    for (const w of arr) {
      const norm = normalize(w);
      if (!norm) continue;
      const realDim = dimensionOf(norm);
      if (realDim && !out[realDim].includes(norm)) out[realDim].push(norm);
    }
  }
  return out;
}

async function callGemini(model, b64, mime) {
  // Gemini v1beta generateContent：systemInstruction + contents(parts: text + inline_data)
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        { text: '请给这张画作打标签，只输出 JSON。' },
        { inline_data: { mime_type: mime, data: b64 } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/gemini/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const ms = Date.now() - t0;
  const json = await res.json();
  if (json.error) return { error: `${json.error.code} ${json.error.message}`, ms };
  const cand = json.candidates?.[0];
  if (!cand) return { error: 'no candidate', ms };
  if (cand.finishReason && !['STOP','MAX_TOKENS','FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    // 不一定致命，但记录
  }
  // 拼接非 thought 的文本 parts
  const parts = cand.content?.parts || [];
  const text = parts.filter(p => p.thought !== true).map(p => p.text || '').join('').trim();
  const parsed = extractJson(text);
  return { raw: text, parsed, ms, usage: json.usageMetadata };
}

async function main() {
  if (!fs.existsSync(DATASET)) { console.error('缺 dataset/，先跑 fetch.mjs 或放几张测试图'); process.exit(1); }
  fs.mkdirSync(RESULTS, { recursive: true });
  const imgs = fs.readdirSync(DATASET).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort();
  if (!imgs.length) { console.error('dataset/ 没有图'); process.exit(1); }
  console.log(`图 ${imgs.length} 张，Gemini 模型 ${MODELS.length} 个：${MODELS.join(', ')}\n`);

  for (const model of MODELS) {
    console.log(`\n===== ${model} =====`);
    const result = {};
    for (const img of imgs) {
      const buf = fs.readFileSync(path.join(DATASET, img));
      const mime = img.endsWith('.png') ? 'image/png' : img.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const b64 = buf.toString('base64');
      try {
        const r = await callGemini(model, b64, mime);
        if (r.error) { console.log(`  ${img}  ✗ ${r.error} (${r.ms}ms)`); result[img] = { error: r.error }; continue; }
        const tags = cleanTags(r.parsed);
        const flat = Object.entries(tags).filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.join('/')}`).join(' ');
        console.log(`  ${img}  ${r.parsed ? '✓' : '⚠解析失败'}  ${flat}  (${r.ms}ms)`);
        result[img] = { tags, raw: r.raw, ms: r.ms };
      } catch (e) {
        console.log(`  ${img}  ✗ ${e.message}`);
        result[img] = { error: e.message };
      }
    }
    fs.writeFileSync(path.join(RESULTS, `${model}.json`), JSON.stringify(result, null, 2));
    console.log(`  → results/${model}.json`);
  }
  console.log('\n完成。下一步：node eval.mjs（需先有 gold.json）');
}

main();
