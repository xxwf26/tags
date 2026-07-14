// 共识伪金标准：3 个可靠模型 ≥2 票同意的标签作 gold.json（无人工标注时的替代）
// 用法：node consensus.mjs   读取 results/<指定>.json → gold.json
// 注意：这是模型共识，非真金标准；eval 结论需人工校正 gold.json 后再下。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dimensions } from './taxonomy.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dir, 'results');
const VOTERS = ['gemini-3.5-flash', 'qwen3-vl-plus', 'doubao-seed-1-6-vision'];
const THRESHOLD = 2; // 至少几票

const data = {};
for (const m of VOTERS) {
  const p = path.join(RESULTS, `${m}.json`);
  data[m] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

// 所有图（取并集）
const imgs = [...new Set(Object.values(data).flatMap(d => Object.keys(d)))];
const gold = {};
for (const img of imgs) {
  gold[img] = {};
  for (const d of dimensions()) {
    const counts = {};
    for (const m of VOTERS) {
      const tags = data[m]?.[img]?.tags?.[d] || [];
      for (const t of tags) counts[t] = (counts[t] || 0) + 1;
    }
    gold[img][d] = Object.entries(counts).filter(([, c]) => c >= THRESHOLD).map(([t]) => t).sort();
  }
}
fs.writeFileSync(path.join(__dir, 'gold.json'), JSON.stringify(gold, null, 2));
const total = Object.values(gold).flatMap(g => Object.values(g).flat()).length;
console.log(`共识金标准 → gold.json：${imgs.length} 图，共 ${total} 个标签`);
for (const img of imgs) {
  const flat = Object.entries(gold[img]).filter(([,v])=>v.length).map(([k,v])=>`${k}:${v.join('/')}`).join(' ');
  console.log(`  ${img}  ${flat}`);
}
