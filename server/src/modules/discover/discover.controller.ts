import { Controller, Get, Post, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DiscoverService } from './discover.service.js';

@Controller('discover')
export class DiscoverController {
  // 注：本项目用 tsx/esbuild 运行，不 emit 装饰器元数据，NestJS 构造注入拿不到参数类型 → 注入 undefined。
  // 故沿用项目一贯的手动实例化（全项目 controller 均如此），不接 DI 容器。
  private readonly discoverService = new DiscoverService();

  // 发起搜索：POST /api/discover/start {referenceId?, tags?:[{label}], platforms}
  @Post('start')
  start(@Body() body: { referenceId?: number | null; tags?: { label: string }[]; platforms?: string[] }) {
    return this.discoverService.start(body);
  }

  // 任务进度：GET /api/discover/task/:id
  @Get('task/:id')
  task(@Param('id', ParseIntPipe) id: number) {
    return this.discoverService.taskStatus(id);
  }

  // 历史会话列表：GET /api/discover/sessions?limit=30（只列发现 session：mode 非空）
  @Get('sessions')
  sessions(@Query('limit') limit?: string) {
    return this.discoverService.listSessions(limit ? Number(limit) : 30);
  }

  // 结果列表：GET /api/discover/results?sessionId=X&tier=tier1
  @Get('results')
  results(@Query('sessionId') sessionId: string, @Query('tier') tier?: string) {
    return this.discoverService.listResults(Number(sessionId), tier);
  }

  // 复核
  @Post('results/:id/review')
  review(@Param('id', ParseIntPipe) id: number) { return this.discoverService.review(id); }

  // 丢弃
  @Post('results/:id/reject')
  reject(@Param('id', ParseIntPipe) id: number) { return this.discoverService.reject(id); }

  // 正式入库
  @Post('results/:id/promote')
  promote(@Param('id', ParseIntPipe) id: number) { return this.discoverService.promote(id); }
}
