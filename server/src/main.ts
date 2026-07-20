import 'reflect-metadata';
process.env.TZ = 'Asia/Shanghai';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { BeijingTimeInterceptor } from './beijing-time.interceptor.js';
import { AppModule } from './app.module.js';
import { db, schema } from './database/db.js';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { Request, Response, NextFunction } from 'express';

// 进程级兜底：采集用的 playwright/chromium 是易崩组件，其内部若抛出未捕获的异步错误，
// 默认会直接杀死整个 node 进程（连带 HTTP 服务、其他正在跑的搜索）。这里改成记录不退出——
// 单次采集失败不该拖垮整个后端。（真正的编程 bug 仍会在日志暴露，便于排查。）
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalInterceptors(new BeijingTimeInterceptor());

  // 清理僵尸搜索任务：后台搜索任务只存在于内存，进程重启后必然丢失，
  // 但库里 session 会永久停在 running（前端进度条转圈不止）。启动时把遗留的 running 标记为 failed。
  await db.update(schema.searchSessions).set({ status: 'failed' })
    .where(eq(schema.searchSessions.status, 'running'))
    .catch((e) => console.error('[startup] 清理僵尸搜索任务失败:', e.message));

  // 静态托管上传的原图
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  // 生产：托管前端 dist + SPA fallback（dev 下前端走 5322 代理）
  if (process.env.NODE_ENV === 'production') {
    const clientDist = join(process.cwd(), '..', 'client', 'dist');
    app.useStaticAssets(clientDist);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(join(clientDist, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3322);
  await app.listen(port);
  console.log(`style-atlas server on http://localhost:${port}`);

  // 启动时把卡住的 running session 标记为 failed（pm2重启会杀掉异步搜索）
  import('./database/db.js').then(async ({ db, schema }) => {
    const { eq } = await import('drizzle-orm');
    const stuck = await db.select().from(schema.searchSessions);
    for (const s of stuck) {
      if (s.status === 'running') {
        await db.update(schema.searchSessions).set({ status: 'failed' }).where(eq(schema.searchSessions.id, s.id));
        console.log(`[startup] 卡住的 session ${s.id} 标记为 failed`);
      }
    }
  }).catch(() => {});
}
bootstrap();
