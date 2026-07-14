import { Controller, Get } from '@nestjs/common';
import { TagService } from './tag.service.js';

@Controller('tags')
export class TagController {
  private readonly tagService = new TagService();

  @Get()
  tree() {
    return this.tagService.getTree();
  }
}
