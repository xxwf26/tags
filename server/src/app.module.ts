import { Module } from '@nestjs/common';
import { TagModule } from './modules/tag/tag.module.js';
import { ArtworkModule } from './modules/artwork/artwork.module.js';
import { ArtistModule } from './modules/artist/artist.module.js';

@Module({
  imports: [TagModule, ArtworkModule, ArtistModule],
})
export class AppModule {}
