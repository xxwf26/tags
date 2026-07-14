import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query } from '@nestjs/common';
import { TagService } from './tag.service.js';

@Controller()
export class TagController {
  private readonly tagService = new TagService();

  @Get('tags')
  tree(@Query('all') all?: string) {
    return this.tagService.getTree(all === '1' || all === 'true');
  }

  @Post('tags')
  createTag(@Body() body: { dimensionId: number; label: string; aliases?: string[] }) {
    return this.tagService.createTag(body);
  }

  @Patch('tags/:id')
  updateTag(@Param('id', ParseIntPipe) id: number, @Body() body: { label?: string; aliases?: string[]; enabled?: number; note?: string }) {
    return this.tagService.updateTag(id, body);
  }

  @Delete('tags/:id')
  deleteTag(@Param('id', ParseIntPipe) id: number) {
    return this.tagService.deleteTag(id);
  }

  @Post('dimensions')
  createDimension(@Body() body: { parentId?: number | null; code: string; name: string }) {
    return this.tagService.createDimension(body);
  }
}
