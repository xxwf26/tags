import { Module } from '@nestjs/common';
import { TagModule } from './modules/tag/tag.module.js';
import { ArtworkModule } from './modules/artwork/artwork.module.js';
import { ArtistModule } from './modules/artist/artist.module.js';
import { TaggingModule } from './modules/tagging/tagging.module.js';
import { CandidateModule } from './modules/candidate/candidate.module.js';

@Module({
  imports: [TagModule, ArtworkModule, ArtistModule, TaggingModule, CandidateModule],
})
export class AppModule {}
