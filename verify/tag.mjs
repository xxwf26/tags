// 画风打标横评：每图 base64 内嵌 → 固定 prompt → 多模型跑 → 落 results/<model>.json
// 用法：node tag.mjs [model1 model2 ...]  默认跑三个视觉模型
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAXONOMY, promptTaxonomy, normalize, dimensionOf, dimensions } from './taxonomy.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(__dir, 'dataset');
const RESULTS = path.join(__dir, 'results');

const BASE_URL = process.env.AI_BASE_URL || 'https://tc-paperhub.diezhi.net/v1';
const API_KEY = process.env.AI_API_KEY || process.env.PAPERHUB_API_KEY;
const MODELS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['qwen3-vl-plus', 'doubao-seed-1-6-vision', 'glm-5v-turbo'];

if (!API_KEY) { console.error('缺 AI_API_KEY 环境变量'); process.exit(1); }

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

async function callModel(model, b64, mime) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: '请给这张画作打标签，只输出 JSON。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ] },
    ],
    max_tokens: 800,
    temperature: 0,
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const ms = Date.now() - t0;
  const json = await res.json();
  if (json.error) return { error: json.error.message, ms };
  const content = json.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content);
  return { raw: content, parsed, ms, usage: json.usage };
}

// 归一化模型输出：每个标签映射到白名单，丢弃越界词，按维度归位
function cleanTags(parsed) {
  const out = {}; for (const d of dimensions()) out[d] = [];
  if (!parsed) return out;
  for (const [dim, arr] of Object.entries(parsed)) {
    if (!Array.isArray(arr)) continue;
    for (const w of arr) {
      const norm = normalize(w);
      if (!norm) continue;                       // 越界词丢弃
      const realDim = dimensionOf(norm);         // 以词表归属为准（模型可能放错维度）
      if (realDim && !out[realDim].includes(norm)) out[realDim].push(norm);
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(DATASET)) { console.error('缺 dataset/，先跑 fetch.mjs'); process.exit(1); }
  fs.mkdirSync(RESULTS, { recursive: true });
  const imgs = fs.readdirSync(DATASET).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort();
  if (!imgs.length) { console.error('dataset/ 没有图'); process.exit(1); }
  console.log(`图 ${imgs.length} 张，模型 ${MODELS.length} 个：${MODELS.join(', ')}\n`);

  for (const model of MODELS) {
    console.log(`\n===== ${model} =====`);
    const result = {};
    for (const img of imgs) {
      const buf = fs.readFileSync(path.join(DATASET, img));
      const mime = img.endsWith('.png') ? 'image/png' : img.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const b64 = buf.toString('base64');
      try {
        const r = await callModel(model, b64, mime);
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
