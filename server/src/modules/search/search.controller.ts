import { Controller, Get, Post, Delete, Patch, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  private readonly searchService = new SearchService();

  // 发起搜索：POST /api/search/start {referenceId, tags, platforms}
  @Post('start')
  start(@Body() body: { referenceId: number; tags: any[]; platforms?: string[] }) {
    return this.searchService.startSearch(body);
  }

  // 终止搜索：POST /api/search/abort/:sessionId
  @Post('abort/:sessionId')
  abort(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.searchService.abort(sessionId);
  }

  // 继续搜索更多：POST /api/search/continue/:sessionId（往已有session加结果，不新建记录）
  @Post('continue/:sessionId')
  continueSearch(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.searchService.continueSearch(sessionId);
  }

  // 删除单个搜索历史：DELETE /api/search/sessions/:id
  @Delete('sessions/:id')
  deleteSession(@Param('id', ParseIntPipe) id: number) {
    return this.searchService.deleteSession(id);
  }

  // 重命名搜索历史：PATCH /api/search/sessions/:id { name }
  @Patch('sessions/:id')
  renameSession(@Param('id', ParseIntPipe) id: number, @Body() body: { name: string }) {
    return this.searchService.renameSession(id, body.name);
  }

  // 清空参考图所有搜索历史：DELETE /api/search/sessions-all?referenceId=X
  @Delete('sessions-all')
  deleteAllSessions(@Query('referenceId') referenceId: string) {
    return this.searchService.deleteAllSessions(Number(referenceId));
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
