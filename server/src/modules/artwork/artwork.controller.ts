import { Controller, Get, Post, Delete, Patch, Query, Param, ParseIntPipe, Body, UseInterceptors, UploadedFile } from '@nestjs/common';
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

  @Get(':id/similar')
  similarById(@Param('id', ParseIntPipe) id: number) {
    return this.artworkService.similarById(id);
  }

  // 以图搜图：上传一张图，找相似作品（pHash 海明距离）
  @Post('similar')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }))
  async similarByImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new Error('缺少文件 file');
    return this.artworkService.similarByImage(file.buffer);
  }

  // 手动录作品：multipart，file=图，字段 artistId/title/width/height/sourceUrl/tagIds
  // 浏览器 FormData 以 UTF-8 发送，multer/busboy 正确解码中文（勿做 latin1 转换）
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
      artistName: body.artistName || undefined,
      title: body.title || undefined,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
      sourceUrl: body.sourceUrl || undefined,
      tagIds,
      file,
    });
  }

  // 删除作品（硬删 + 删图文件）
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.artworkService.remove(id);
  }

  // 编辑作品标签：body { tagIds: number[] }
  @Patch(':id/tags')
  setTags(@Param('id', ParseIntPipe) id: number, @Body() body: { tagIds: number[] }) {
    return this.artworkService.setTags(id, (body.tagIds || []).map(Number).filter(Boolean));
  }
}
