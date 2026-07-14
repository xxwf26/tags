import { Module } from '@nestjs/common';
import { ArtistController } from './artist.controller.js';
import { ArtistService } from './artist.service.js';

@Module({
  controllers: [ArtistController],
  providers: [ArtistService],
})
export class ArtistModule {}
