import { Module } from '@nestjs/common';
import { TaggingController } from './tagging.controller.js';

@Module({
  controllers: [TaggingController],
})
export class TaggingModule {}
