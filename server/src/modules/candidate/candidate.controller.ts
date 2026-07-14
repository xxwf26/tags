import { Controller, Get, Post, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import { CandidateService } from './candidate.service.js';

@Controller()
export class CandidateController {
  private readonly candidateService = new CandidateService();

  // 采集：POST /api/crawl/note  body: { url | text }，支持单条或多条链接（自动提取全部）
  @Post('crawl/note')
  crawl(@Body() body: { url?: string; text?: string }) {
    return this.candidateService.createFromInput(body.url || body.text || '');
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
}
