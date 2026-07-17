import { Controller, Get, Post, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  // 见 discover.controller 说明：tsx/esbuild 不 emit 装饰器元数据，构造注入会失败，故手动实例化。
  private readonly searchService = new SearchService();

  // 发起搜索：POST /api/search/start {referenceId, tags, platforms}
  @Post('start')
  start(@Body() body: { referenceId: number; tags: any[]; platforms?: string[] }) {
    return this.searchService.startSearch(body);
  }

  // 会话列表：GET /api/search/sessions?referenceId=X
  @Get('sessions')
  sessions(@Query('referenceId') referenceId: string) {
    return this.searchService.listSessions(Number(referenceId));
  }

  // 结果列表：GET /api/search/results?sessionId=X&tier=tier1
  @Get('results')
  results(@Query('sessionId') sessionId: string, @Query('tier') tier?: string) {
    return this.searchService.listResults(Number(sessionId), tier);
  }

  // 复核进二级库
  @Post('results/:id/review')
  review(@Param('id', ParseIntPipe) id: number) { return this.searchService.review(id); }

  // 丢弃
  @Post('results/:id/reject')
  reject(@Param('id', ParseIntPipe) id: number) { return this.searchService.reject(id); }

  // 正式入库
  @Post('results/:id/promote')
  promote(@Param('id', ParseIntPipe) id: number) { return this.searchService.promote(id); }
}
