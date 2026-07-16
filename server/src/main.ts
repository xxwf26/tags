import 'reflect-metadata';
process.env.TZ = 'Asia/Shanghai';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { BeijingTimeInterceptor } from './beijing-time.interceptor.js';
import { AppModule } from './app.module.js';
import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalInterceptors(new BeijingTimeInterceptor());

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
