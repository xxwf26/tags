import { Controller, Get, Post, Param, ParseIntPipe, Query } from '@nestjs/common';
import { OperationService } from './operation.service.js';

@Controller('operations')
export class OperationController {
  private readonly operationService = new OperationService();

  @Get()
  list(@Query('limit') limit?: string) {
    // 校验 limit，避免 Number('abc')=NaN 传进 .limit() 生成非法 SQL
    const n = Number(limit);
    return this.operationService.list(Number.isInteger(n) && n > 0 ? n : 100);
  }

  @Post(':id/undo')
  undo(@Param('id', ParseIntPipe) id: number) {
    return this.operationService.undo(id);
  }

  @Post(':id/redo')
  redo(@Param('id', ParseIntPipe) id: number) {
    return this.operationService.redo(id);
  }
}
