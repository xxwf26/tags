# style-atlas 交接包说明

本包包含：源码 + 数据库 dump + 已下载图片（/uploads/）。
**不含**：`node_modules`、`dist`、`.git`、`.env`（凭据）、cookie/密钥文件。

## 一、恢复步骤

### 1. 安装依赖
- Node.js 20+
- MySQL 8.x
- Python 3.10+（CLIP worker 需要，见 `server/src/modules/embed/clip.worker.ts`）

### 2. 建库 + 导入数据
```bash
mysql -u root -p -e "CREATE DATABASE style_atlas DEFAULT CHARSET utf8mb4;"
mysql -u root -p style_atlas < server/style_atlas_dump.sql
```

### 3. 配置环境变量
```bash
cp server/.env.example server/.env
# 按本机实际情况填写 DB_HOST/PORT/USER/PASSWORD/NAME、PORT、AI_API_KEY 等
```
字段说明：
- `DB_*`：MySQL 连接（默认库名 `style_atlas`）
- `PORT`：后端端口（默认 3322）
- `AI_API_KEY` / `AI_BASE_URL` / `GEMINI_MODEL` / `DOUBAO_MODEL`：AI 打标用（Gemini + 豆包双模型）
- `XHS_COOKIE`：小红书 cookie（F12 → Network → Cookie 请求头），搜索需要

### 4. 装包 + 启动
```bash
cd server && npm install && npm run db:push   # 同步表结构（dump 已含结构，可跳过）
cd ../client && npm install
# 后端
cd ../server && npm run dev    # 或 npm run build && pm2 start dist/main.js --name style-atlas
# 前端
cd ../client && npm run dev
```

### 5. 图片
`server/uploads/` 已随包附带，无需额外下载。后端 `main.ts` 静态 serve `/uploads/`。

## 二、端口
- 后端：3322（PM2 生产跑 `dist/main.js`）
- 前端：5322（Vite dev，proxy `/api` → 3322）
- 生产访问：直接开后端端口，后端会 serve `client/dist`（需先 `cd client && npm run build`）

## 三、注意
- 数据库 dump 含业务数据（画师台账、作品、搜索记录），仅限有权限人员使用
- `.env` 不在包内，需自行配置；cookie/AI key 等凭据请各自申请
- 如需跑 AI 打标，确认 `AI_API_KEY` 已配，否则质检会降级为"未检"
