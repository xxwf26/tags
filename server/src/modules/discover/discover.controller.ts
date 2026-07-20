import { Controller, Get, Post, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DiscoverService } from './discover.service.js';

@Controller('discover')
export class DiscoverController {
  // 用 new 实例化（项目所有 controller 的惯例）：tsx dev 不 emit decorator metadata，
  // 构造器 DI 在 dev 下注入不了；new 在 dev/prod 都生效。DiscoverService 逻辑不变。
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
