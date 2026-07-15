import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ReferenceService } from './reference.service.js';

@Controller('reference')
export class ReferenceController {
  private readonly referenceService = new ReferenceService();

  @Get()
  list() { return this.referenceService.list(); }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) { return this.referenceService.getOne(id); }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new Error('缺少文件 file');
    return this.referenceService.upload(file);
  }

  @Patch(':id/tags')
  updateTags(@Param('id', ParseIntPipe) id: number, @Body() body: { manualTags: any[] }) {
    return this.referenceService.updateTags(id, body.manualTags);
  }
}
