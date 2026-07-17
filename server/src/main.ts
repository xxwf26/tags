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
}
bootstrap();
