import { Controller, Get, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import { CandidateService } from './candidate.service.js';
import { fetchMihuashiTags, fetchMihuashiFilterChips } from '../crawl/mihuashi.js';

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

  // 米画师可用画风标签（config 全量）：GET /api/mihuashi/tags
  @Get('mihuashi/tags')
  async mihuashiTags() {
    return fetchMihuashiTags();
  }

  // 米画师页面真实筛选 chip（发现页下拉用）：GET /api/mihuashi/filter-chips
  @Get('mihuashi/filter-chips')
  async mihuashiFilterChips() {
    return fetchMihuashiFilterChips();
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

  // 按画师小红书主页爬作品：POST /api/artists/:id/crawl-works  body: { limit?, tag?, pool?, minQuality? }
  // pool=候选池大小(先扒N篇择优)，minQuality=AI质检质量分下限(0-10)，过滤广告/文字海报
  @Post('artists/:id/crawl-works')
  crawlWorks(@Param('id', ParseIntPipe) id: number, @Body() body: { limit?: number; tag?: boolean; pool?: number; minQuality?: number }) {
    return this.candidateService.crawlArtistWorks(id, body.limit ?? 5, body.tag ?? false, body.pool ?? 20, body.minQuality ?? 5);
  }

  // 按画师微博主页爬作品：POST /api/artists/:id/crawl-works-weibo
  @Post('artists/:id/crawl-works-weibo')
  crawlWorksWeibo(@Param('id', ParseIntPipe) id: number, @Body() body: { limit?: number; tag?: boolean }) {
    return this.candidateService.crawlArtistWorksWeibo(id, body.limit ?? 8, body.tag ?? false);
  }
}
