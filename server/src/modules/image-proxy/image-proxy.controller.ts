import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { downloadImage } from '../crawl/xhs.js';

// 外站图片代理：sinaimg(微博)/xhscdn(小红书) 等 CDN 有防盗链，浏览器 <img> 直连（无 Referer）会 403。
// 前端把外站图指到 /api/img?u=<encoded url>，由后端带正确 Referer 取回再转发。downloadImage 已按域名选 Referer。
@Controller('img')
export class ImageProxyController {
  @Get()
  async proxy(@Query('u') u: string, @Res() res: Response) {
    if (!u || !/^https?:\/\//.test(u)) { res.status(400).send('bad url'); return; }
    try {
      const { buf, type } = await downloadImage(u);
      res.set('Content-Type', type || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');   // 缓存 1 天，避免反复回源
      res.send(buf);
    } catch (e: any) {
      res.status(502).send('proxy fail');
    }
  }
}
