// 评测：分维度算 precision/recall/F1，各模型 + 平台标签基线对照 → report.md
// 用法：node eval.mjs
// 需要：gold.json（人工校正后的金标准）、results/<model>.json、gold.seed.json（取平台标签作基线）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAXONOMY, dimensions, normalize, dimensionOf } from './taxonomy.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dir, 'results');

function loadJson(p, fallback = null) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

// 把平台标签种子归一成 5 维（作基线：只有平台标签能对齐白名单的部分）
function platformBaseline(seed) {
  const out = {};
  for (const [img, meta] of Object.entries(seed || {})) {
    const t = {}; for (const d of dimensions()) t[d] = [];
    for (const w of (meta.platformTags || [])) {
      const norm = normalize(w);
      if (!norm) continue;
      const dim = dimensionOf(norm);
      if (dim && !t[dim].includes(norm)) t[dim].push(norm);
    }
    out[img] = t;
  }
  return out;
}

// 单维 P/R：pred vs gold（都是标签数组）
function prCounts(pred, gold) {
  const g = new Set(gold), p = new Set(pred);
  let tp = 0; for (const x of p) if (g.has(x)) tp++;
  return { tp, fp: p.size - tp, fn: [...g].filter(x => !p.has(x)).length };
}

function scoreModel(preds, gold) {
  // 按维度累加
  const perDim = {}; for (const d of dimensions()) perDim[d] = { tp: 0, fp: 0, fn: 0 };
  let exactImgs = 0, total = 0;
  for (const [img, goldTags] of Object.entries(gold)) {
    const pred = preds[img]?.tags;
    if (!pred) continue;               // 该模型此图失败，跳过（不计入）
    total++;
    let allMatch = true;
    for (const d of dimensions()) {
      const c = prCounts(pred[d] || [], goldTags[d] || []);
      perDim[d].tp += c.tp; perDim[d].fp += c.fp; perDim[d].fn += c.fn;
      if (c.fp || c.fn) allMatch = false;
    }
    if (allMatch) exactImgs++;
  }
  const dimF1 = {};
  let TP = 0, FP = 0, FN = 0;
  for (const d of dimensions()) {
    const { tp, fp, fn } = perDim[d];
    TP += tp; FP += fp; FN += fn;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    dimF1[d] = { p, r, f1: p + r ? 2 * p * r / (p + r) : 0, tp, fp, fn };
  }
  const microP = TP + FP ? TP / (TP + FP) : 0;
  const microR = TP + FN ? TP / (TP + FN) : 0;
  return {
    dimF1,
    micro: { p: microP, r: microR, f1: microP + microR ? 2 * microP * microR / (microP + microR) : 0 },
    exactImgs, total,
  };
}

const pct = x => (x * 100).toFixed(1) + '%';

function main() {
  const gold = loadJson(path.join(__dir, 'gold.json'));
  if (!gold) {
    console.error('缺 gold.json。请把 gold.seed.json 校正成 gold.json：');
    console.error('  每图填 {"genre":[],"subject":[],"technique":[],"usage":[],"tone":[]}（用 taxonomy 白名单词）');
    process.exit(1);
  }
  const seed = loadJson(path.join(__dir, 'gold.seed.json'), {});
  const modelFiles = fs.readdirSync(RESULTS).filter(f => f.endsWith('.json'));
  const dims = dimensions();

  const rows = [];
  // 基线：平台标签
  rows.push(['平台标签(基线)', scoreModel(
    Object.fromEntries(Object.entries(platformBaseline(seed)).map(([k, v]) => [k, { tags: v }])), gold)]);
  for (const f of modelFiles) {
    const model = f.replace('.json', '');
    rows.push([model, scoreModel(loadJson(path.join(RESULTS, f)), gold)]);
  }

  let md = `# 画风打标横评报告\n\n`;
  md += `- 金标准图数：${Object.keys(gold).length}\n`;
  md += `- 参评：${rows.map(r => r[0]).join(' / ')}\n\n`;

  md += `## 总体（micro 平均，所有维度标签合并计）\n\n`;
  md += `| 模型 | Precision | Recall | F1 | 全维完全命中 |\n|---|---|---|---|---|\n`;
  for (const [name, s] of rows) {
    md += `| ${name} | ${pct(s.micro.p)} | ${pct(s.micro.r)} | ${pct(s.micro.f1)} | ${s.exactImgs}/${s.total} |\n`;
  }

  md += `\n## 分维度 F1\n\n`;
  md += `| 模型 | ${dims.map(d => TAXONOMY[d].name).join(' | ')} |\n|${'---|'.repeat(dims.length + 1)}\n`;
  for (const [name, s] of rows) {
    md += `| ${name} | ${dims.map(d => pct(s.dimF1[d].f1)).join(' | ')} |\n`;
  }

  md += `\n## 分维度 Precision / Recall 明细\n\n`;
  for (const [name, s] of rows) {
    md += `### ${name}\n\n| 维度 | P | R | F1 | TP/FP/FN |\n|---|---|---|---|---|\n`;
    for (const d of dims) {
      const x = s.dimF1[d];
      md += `| ${TAXONOMY[d].name} | ${pct(x.p)} | ${pct(x.r)} | ${pct(x.f1)} | ${x.tp}/${x.fp}/${x.fn} |\n`;
    }
    md += `\n`;
  }

  md += `\n## 读法\n\n`;
  md += `- **客观维度**（题材/用途）F1 应偏高，是 AI 打标最可信的部分。\n`;
  md += `- **主观维度**（色调/情绪、部分技法）F1 偏低属正常，人机都可能各有道理，需人工兜底或降级为"AI 建议、人工确认"。\n`;
  md += `- **Precision 高、Recall 低** = 打得准但打得少（宁缺勿滥，适合自动入库）；反之 = 打得全但噪声多（适合人工复核筛）。\n`;
  md += `- 与"平台标签基线"对比：AI 若显著优于作者自打的话题标签，说明 AI 打标有增量价值。\n`;

  fs.writeFileSync(path.join(__dir, 'report.md'), md);
  console.log(md);
  console.log('\n→ report.md 已写出');
}

main();
