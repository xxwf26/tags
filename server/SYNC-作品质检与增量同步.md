# 作品质检 + 批量补爬 + 增量同步 说明

本轮工作解决「爬取的作品封面混入广告/照片/文字海报导致质量差」的问题，并把有小红书链接的画师作品补到每人 8 张。数据（图片 + DB 记录）不走 git，通过增量同步包合并。

## 一、本轮代码修改项

| 文件 | 改动 |
|---|---|
| `server/src/modules/tagging/ai.ts` | 新增 `gateArtwork()` 质检闸门：单模型(Gemini)判图是 `artwork/ad/text_poster/photo/other` 并打质量分(0-10)；非作品或低分则拒。AI 故障时中性放行(退化回原行为，不空库)。`callGemini` 改为 export。 |
| `server/src/modules/candidate/candidate.service.ts` | `crawlArtistWorks` 改两阶段：先扒候选池(pool，默认20)→ 去重 + 过质检闸门 → 按质量分降序取前 `limit` 入库。返回体加 `pooled`/`rejected`。文件名改为带时间戳唯一，避免同画师多次爬时覆盖。 |
| `server/src/modules/candidate/candidate.controller.ts` | 端点 `POST /api/artists/:id/crawl-works` body 加可选参数 `pool`、`minQuality`。 |
| `server/src/database/audit-artworks.ts` | **新增**。只读审计脚本：对存量爬取作品逐张过闸门，输出 `audit-report.json`（疑似低质清单），绝不删库。 |
| `server/src/database/delete-flagged.ts` | **新增**。按审计报告删低质作品：默认 dry-run，`--apply` 才删；删前备份、共用文件保护。 |
| `server/src/database/crawl-all-works.ts` | **新增**。批量补爬：遍历有小红书链的画师，每人补到目标张数(默认8)，宁缺毋滥、含去重+闸门。输出 `crawl-report.json`。 |
| `server/src/database/export-increment.ts` | **新增**。导出增量同步包（见下）。 |
| `server/src/database/import-increment.ts` | **新增**。幂等导入同步包（见下）。 |

### 本轮数据成果（我这边）
- 存量 915 张 → AI 审计判出 202 张低质 → 删 199 张(保留3张草稿) → 剩 716 张
- 批量补爬 147 个有小红书链的画师，新增 578 张，144 人达标 8 张(2 人主页真作品不足、1 人链接失效)
- 当前总计 **1309 张**(小红书1162 + 微博147)，全部有 image_hash、零重复

> 注意：新爬作品**尚未打画风标签**(爬取时 doTag=false)。如需检索，导入后各自跑 `TaggingService.tagBatch()` 补标。
> 注意：**微博线(48个仅微博画师)尚未接质检闸门、未补爬**，本同步包不含。

## 二、如何同步我这边的图片+作品数据（增量合并，不覆盖你的数据）

数据分两部分，图片(uploads/)和 DB 记录都不在 git 里，通过 `sync-pack.tar.gz` 传递。

### 你收到 `sync-pack.tar.gz` 后：

```bash
# 1. 先 git pull 拿到导入脚本
git pull

# 2. 解压同步包
tar -xzf sync-pack.tar.gz

# 3. 把图片拷进 uploads（假设在仓库根目录解压）
cp sync-pack/uploads/* server/uploads/

# 4. 先预览：不写库，看会导入多少、有没有匹配不到的画师
cd server
npx tsx src/database/import-increment.ts ../sync-pack/artworks.json

# 5. 确认无误后真导入
npx tsx src/database/import-increment.ts ../sync-pack/artworks.json --apply
```

### 安全保障（为什么不会弄乱你的数据）
- **按 `image_hash` 查重**：你已有的相同图自动跳过，不会重复导入。
- **按画师 `name` + 小红书 url 挂靠**：不依赖 artist_id，即使两边画师 id 不一致也能挂对。
- **匹配不到的画师**默认跳过并列清单；若你库里确实缺这些画师，加 `--create-missing` 自动按名字新建。
- **默认 dry-run**，加 `--apply` 才写库，绝不覆盖/删除你的任何数据。

### 导入后可选：给新作品打画风标签
```bash
# 需要 .env 里配好 AI_API_KEY（tc-paperhub 中转 key）
# 用现有 tagging 批量接口或写脚本调 TaggingService.tagBatch()
```
