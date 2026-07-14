import { Controller, Get, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import { CandidateService } from './candidate.service.js';
import { fetchMihuashiTags } from '../crawl/mihuashi.js';

@Controller()
export class CandidateController {
  private readonly candidateService = new CandidateService();

  // 采集：POST /api/crawl/note  body: { url | text }，支持单条或多条链接（自动提取全部）
  @Post('crawl/note')
  crawl(@Body() body: { url?: string; text?: string }) {
    return this.candidateService.createFromInput(body.url || body.text || '');
  }

  // 米画师按画风批量采集：POST /api/crawl/mihuashi { tag, limit }
  @Post('crawl/mihuashi')
  crawlMihuashi(@Body() body: { tag?: string; limit?: number }) {
    return this.candidateService.createMihuashiBatch(body.tag || '', body.limit || 30);
  }

  // 米画师可用画风标签：GET /api/mihuashi/tags
  @Get('mihuashi/tags')
  async mihuashiTags() {
    return fetchMihuashiTags();
  }

  // 候选队列：GET /api/candidates?status=pending
  @Get('candidates')
  list(@Query('status') status?: string) {
    return this.candidateService.list(status || 'pending');
  }

  // 转正入库：POST /api/candidates/:id/promote  body: { artistId?, newArtist? }
  @Post('candidates/:id/promote')
  promote(@Param('id', ParseIntPipe) id: number, @Body() body: { artistId?: number; newArtist?: boolean }) {
    return this.candidateService.promote(id, body);
  }

  // 丢弃：POST /api/candidates/:id/reject
  @Post('candidates/:id/reject')
  reject(@Param('id', ParseIntPipe) id: number) {
    return this.candidateService.reject(id);
  }

  // 按画师小红书主页爬作品：POST /api/artists/:id/crawl-works  body: { limit?, tag? }
  @Post('artists/:id/crawl-works')
  crawlWorks(@Param('id', ParseIntPipe) id: number, @Body() body: { limit?: number; tag?: boolean }) {
    return this.candidateService.crawlArtistWorks(id, body.limit ?? 8, body.tag ?? false);
  }

  // 按画师微博主页爬作品：POST /api/artists/:id/crawl-works-weibo
  @Post('artists/:id/crawl-works-weibo')
  crawlWorksWeibo(@Param('id', ParseIntPipe) id: number, @Body() body: { limit?: number; tag?: boolean }) {
    return this.candidateService.crawlArtistWorksWeibo(id, body.limit ?? 8, body.tag ?? false);
  }
}
