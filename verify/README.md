# AI 画风打标 · 可行性 & 准确性验证

验证「用视觉大模型给作品自动打画风标签」是否可行、准不准，并横评多个模型选出最优。

## 关键结论（已探测）

- ✅ 中转 `tc-paperhub.diezhi.net` 有多个**通用视觉理解模型**：`qwen3-vl-plus` / `doubao-seed-1-6-vision` / `glm-5v-turbo`，另有 `gpt-5.x` / `grok-4.x` 旗舰。给的 key 实测可调视觉 chat（`glm-5v-turbo` 已跑通）。
- ✅ **Gemini 走独立原生端点** `…/gemini/v1beta/models/<model>:generateContent`（非 OpenAI 兼容，不能复用 `tag.mjs`，用 `gemini.mjs`）。理解类模型 3 个：`gemini-3.5-flash`（推荐，非 thinking，~3s/图）、`gemini-3-flash-preview`（thinking，~5-7s/图，需 `maxOutputTokens≥4096` 否则思考耗光 token 答案为空）、`gemini-3.1-pro-preview`。三者实测均可看图输出 JSON 标签。
- ⚠️ **Gemini 的 `-image` 系列是图片生成模型**（`gemini-3.1-flash-lite-image` / `gemini-3-pro-image` 等，Nano Banana），输出图片、不能打标——别拿来跑 `gemini.mjs`。
- ⚠️ **别用 `qwen-vl-ocr` 做画风判断**——它是 OCR 特化模型，只读图上文字，不做风格理解。
- ⚠️ **图片必须 base64 内嵌**，不能传 URL：中转去下载外链图会超时。
- ⚠️ **小红书搜索页免登录抓不到结果**（结果走登录后签名 API）；只有**笔记详情页**的 SSR `__INITIAL_STATE__` 能免登录抓。所以样本走"人工发笔记链接"。

## 流程

```
1. 填 links.txt        每行一个小红书笔记链接（或整段 App 分享文本，自动提链接）
2. node fetch.mjs      笔记页 SSR 抓图 → dataset/，平台 tagList → gold.seed.json
3. 校正金标准          把 gold.seed.json 另存为 gold.json，按 taxonomy 5 维填每图标准答案
4. node tag.mjs        多模型横评打标 → results/<model>.json
   node gemini.mjs     Gemini 原生端点打标（v1beta，与 tag.mjs 产物同格式，eval 自动纳入）
5. node eval.mjs       分维度 P/R/F1 + 平台标签基线对照 → report.md
```

环境变量：`AI_API_KEY`（或 `PAPERHUB_API_KEY`）。可选 `AI_BASE_URL`（默认中转地址）。Gemini 适配器读 `PAPERHUB_API_KEY`，可选 `GEMINI_BASE_URL`。

## 文件

- `taxonomy.mjs` — 5 维画风标签白名单（风格流派/题材/技法/用途/色调）+ 别名归一。打标 prompt 和评测共用。
- `fetch.mjs` — 小红书笔记页 SSR 抓取（移植验证过的 xhs-fetcher）。
- `tag.mjs` — base64 内嵌 + 固定 prompt（强约束 JSON + 白名单）+ 多模型横评（OpenAI 兼容端点）。
- `gemini.mjs` — Gemini 原生 v1beta 适配器（`generateContent` + `inline_data` + `responseMimeType:application/json`），产物格式与 `tag.mjs` 一致，`eval.mjs` 自动纳入。用法：`PAPERHUB_API_KEY=xxx node gemini.mjs [gemini-3.5-flash ...]`。
- `eval.mjs` — 分维度 precision/recall/F1，AI 各模型 vs 平台标签基线。

## 评测设计要点

- **分维度评**：客观维度（题材/用途）预期准，主观维度（色调/情绪）预期低——分开看才不被平均值掩盖真相。
- **金标准种子**：用作者自打的平台标签打底，人工只需校正增删，省一大半标注工。
- **基线对照**：AI 若显著优于平台标签，才证明有增量价值。
- 换模型：`node tag.mjs <model1> <model2> ...` 可指定任意中转模型横评；Gemini 走 `node gemini.mjs <model1> ...`（默认 `gemini-3.5-flash`，可传 `gemini-3-flash-preview` / `gemini-3.1-pro-preview`）。两者结果都落 `results/<model>.json`，`eval.mjs` 一并评测。
