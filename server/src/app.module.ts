import { Module } from '@nestjs/common';
import { TagModule } from './modules/tag/tag.module.js';
import { ArtworkModule } from './modules/artwork/artwork.module.js';
import { ArtistModule } from './modules/artist/artist.module.js';
import { TaggingModule } from './modules/tagging/tagging.module.js';
import { CandidateModule } from './modules/candidate/candidate.module.js';
import { OperationModule } from './modules/operation/operation.module.js';
import { ReferenceModule } from './modules/reference/reference.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { DiscoverModule } from './modules/discover/discover.module.js';

@Module({
  imports: [TagModule, ArtworkModule, ArtistModule, TaggingModule, CandidateModule, OperationModule, ReferenceModule, SearchModule, SettingsModule, DiscoverModule],
})
export class AppModule {}
