# AI 画风打标 · 可行性 & 准确性验证

验证「用视觉大模型给作品自动打画风标签」是否可行、准不准，并横评多个模型选出最优。

## 关键结论（已探测）

- ✅ 中转 `tc-paperhub.diezhi.net` 有多个**通用视觉理解模型**：`qwen3-vl-plus` / `doubao-seed-1-6-vision` / `glm-5v-turbo`，另有 `gpt-5.x` / `grok-4.x` 旗舰。给的 key 实测可调视觉 chat（`glm-5v-turbo` 已跑通）。
- ⚠️ **别用 `qwen-vl-ocr` 做画风判断**——它是 OCR 特化模型，只读图上文字，不做风格理解。
- ⚠️ **图片必须 base64 内嵌**，不能传 URL：中转去下载外链图会超时。
- ⚠️ **小红书搜索页免登录抓不到结果**（结果走登录后签名 API）；只有**笔记详情页**的 SSR `__INITIAL_STATE__` 能免登录抓。所以样本走"人工发笔记链接"。

## 流程

```
1. 填 links.txt        每行一个小红书笔记链接（或整段 App 分享文本，自动提链接）
2. node fetch.mjs      笔记页 SSR 抓图 → dataset/，平台 tagList → gold.seed.json
3. 校正金标准          把 gold.seed.json 另存为 gold.json，按 taxonomy 5 维填每图标准答案
4. node tag.mjs        多模型横评打标 → results/<model>.json
5. node eval.mjs       分维度 P/R/F1 + 平台标签基线对照 → report.md
```

环境变量：`AI_API_KEY`（或 `PAPERHUB_API_KEY`）。可选 `AI_BASE_URL`（默认中转地址）。

## 文件

- `taxonomy.mjs` — 5 维画风标签白名单（风格流派/题材/技法/用途/色调）+ 别名归一。打标 prompt 和评测共用。
- `fetch.mjs` — 小红书笔记页 SSR 抓取（移植验证过的 xhs-fetcher）。
- `tag.mjs` — base64 内嵌 + 固定 prompt（强约束 JSON + 白名单）+ 多模型横评。
- `eval.mjs` — 分维度 precision/recall/F1，AI 各模型 vs 平台标签基线。

## 评测设计要点

- **分维度评**：客观维度（题材/用途）预期准，主观维度（色调/情绪）预期低——分开看才不被平均值掩盖真相。
- **金标准种子**：用作者自打的平台标签打底，人工只需校正增删，省一大半标注工。
- **基线对照**：AI 若显著优于平台标签，才证明有增量价值。
- 换模型：`node tag.mjs <model1> <model2> ...` 可指定任意中转模型横评。
