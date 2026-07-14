import { Controller, Get, Post, Param, ParseIntPipe, Query } from '@nestjs/common';
import { OperationService } from './operation.service.js';

@Controller('operations')
export class OperationController {
  private readonly operationService = new OperationService();

  @Get()
  list(@Query('limit') limit?: string) {
    return this.operationService.list(limit ? Number(limit) : 100);
  }

  @Post(':id/undo')
  undo(@Param('id', ParseIntPipe) id: number) {
    return this.operationService.undo(id);
  }
}
