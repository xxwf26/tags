import { Controller, Post, Param, ParseIntPipe } from '@nestjs/common';
import { TaggingService } from './tagging.service.js';

@Controller('tagging')
export class TaggingController {
  private readonly taggingService = new TaggingService();

  // 给单张作品 AI 打标（Gemini+豆包集成）
  @Post('artwork/:id')
  tagOne(@Param('id', ParseIntPipe) id: number) {
    return this.taggingService.tagArtwork(id);
  }

  // 批量打标所有未打标作品
  @Post('batch')
  batch() {
    return this.taggingService.tagBatch();
  }

  // 复核确认
  @Post('artwork/:id/confirm')
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.taggingService.confirm(id);
  }
}
