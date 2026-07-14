import { Module } from '@nestjs/common';
import { ArtworkController } from './artwork.controller.js';
import { ArtworkService } from './artwork.service.js';

@Module({
  controllers: [ArtworkController],
  providers: [ArtworkService],
})
export class ArtworkModule {}
