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

风格流派(genre)判定要点（重要，避免滥标）：
- 「日系」：日本动漫/二次元审美——大眼、小鼻、清透赛璐璐或伪厚涂上色。仅在明显是日漫风时才标。
- 「二次元」：泛ACG动漫风，与日系常并存；但写实/欧美插画不要标二次元。
- 「厚涂」：仅当笔触油画感、无明显线稿、体积感强时才标；有清晰线稿的平涂/赛璐璐不是厚涂。
- 「欧美」：美式/欧洲插画审美——新艺术运动(Art Nouveau)、美式复古、写实肌理、装饰性构图，常见做旧纸质肌理与噪点。这类不要误标日系/二次元。
- 「国风古风」：中式古典元素（汉服、水墨、传统纹样）才标。
- 「写实」：接近真实人体结构/光影，非动漫夸张比例。
不确定就少标，一张图的风格流派通常只有 1~2 个，不要堆叠。

规则：
1. 每个维度选 0~3 个最贴切的标签；拿不准就少选或不选，不要硬凑。
2. 只输出词表里出现过的原词。
3. 严格输出 JSON，格式：{"genre":[],"subject":[],"technique":[],"usage":[],"tone":[]}
4. 不要输出任何解释、不要用 markdown 代码块包裹，只输出这一个 JSON 对象。`;

function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // 优先找最后一个完整的 {...}（reasoning 模型常在思考后才给最终 JSON）
  const candidates = [...t.matchAll(/\{[\s\S]*?\}/g)].map(m => m[0]);
  // 从后往前尝试，取第一个能解析且含目标维度键的
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && (('genre' in obj) || ('subject' in obj) || ('tone' in obj))) return obj;
    } catch { /* 继续 */ }
  }
  // 退化：贪婪取首尾大括号
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
  const msg = json.choices?.[0]?.message || {};
  const content = msg.content || '';
  const reasoning = msg.reasoning_content || '';
  // 先从正文抠 JSON；正文没有再退到 reasoning（个别模型把结果留在思考里）
  const parsed = extractJson(content) || extractJson(reasoning);
  return { raw: content || reasoning, parsed, ms, usage: json.usage };
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
