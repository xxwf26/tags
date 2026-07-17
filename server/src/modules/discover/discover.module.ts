import { Module } from '@nestjs/common';
import { DiscoverController } from './discover.controller.js';
import { DiscoverService } from './discover.service.js';

@Module({ controllers: [DiscoverController], providers: [DiscoverService] })
export class DiscoverModule {}
