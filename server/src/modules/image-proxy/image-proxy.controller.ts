import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { downloadImage } from '../crawl/xhs.js';

// 外站图片代理：sinaimg(微博)/xhscdn(小红书) 等 CDN 有防盗链，浏览器 <img> 直连（无 Referer）会 403。
// 前端把外站图指到 /api/img?u=<encoded url>，由后端带正确 Referer 取回再转发。downloadImage 已按域名选 Referer。

// SSRF 防护：只允许已知图片 CDN 域名，杜绝拿代理探测内网/云元数据（如 169.254.169.254、127.0.0.1）。
const ALLOWED_HOSTS = ['xhscdn.com', 'sinaimg.cn', 'mihuashi.com', 'mihuahi.com'];
function isAllowedImageUrl(u: string): boolean {
  let host: string;
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  // 精确匹配或子域（.xhscdn.com），不能用 includes 以防 evil-xhscdn.com.attacker.net 绕过
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

@Controller('img')
export class ImageProxyController {
  @Get()
  async proxy(@Query('u') u: string, @Res() res: Response) {
    if (!u || !/^https?:\/\//.test(u)) { res.status(400).send('bad url'); return; }
    if (!isAllowedImageUrl(u)) { res.status(403).send('host not allowed'); return; }
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
