import { Controller, Get, Post, Patch, Delete, Param, ParseIntPipe, Body } from '@nestjs/common';
import { ArtistService } from './artist.service.js';

@Controller('artists')
export class ArtistController {
  private readonly artistService = new ArtistService();

  @Get()
  list() {
    return this.artistService.list();
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.artistService.getOne(id);
  }

  @Post()
  create(@Body() body: { name: string; bio?: string; links?: any }) {
    return this.artistService.create(body);
  }

  @Patch(':id/engage')
  updateEngage(@Param('id', ParseIntPipe) id: number, @Body() body: { engageStatus?: string; engageNote?: string; contact?: { wechat?: string; qq?: string; email?: string } | null; commission?: string }) {
    return this.artistService.updateEngage(id, body);
  }

  // 删除画师（连名下作品一起删，作品软删）
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.artistService.remove(id);
  }
}
