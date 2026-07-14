import { Controller, Get, Post, Query, Param, ParseIntPipe, Body, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ArtworkService } from './artwork.service.js';

@Controller('artworks')
export class ArtworkController {
  private readonly artworkService = new ArtworkService();

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.artworkService.list(query);
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.artworkService.getOne(id);
  }

  // 手动录作品：multipart，file=图，字段 artistId/title/width/height/sourceUrl/tagIds
  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }))
  async create(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    if (!file) throw new Error('缺少文件 file');
    const tagIds = String(body.tagIds || '').split(',').map(Number).filter(Boolean);
    return this.artworkService.create({
      artistId: body.artistId ? Number(body.artistId) : undefined,
      title: body.title,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
      sourceUrl: body.sourceUrl,
      tagIds,
      file,
    });
  }
}
