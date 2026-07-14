import { Controller, Get, Patch, Param, ParseIntPipe, Body } from '@nestjs/common';
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

  @Patch(':id/engage')
  updateEngage(@Param('id', ParseIntPipe) id: number, @Body() body: { engageStatus?: string; engageNote?: string }) {
    return this.artistService.updateEngage(id, body);
  }
}
