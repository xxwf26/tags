import { Module } from '@nestjs/common';
import { DiscoverController } from './discover.controller.js';

@Module({ controllers: [DiscoverController] })
export class DiscoverModule {}
