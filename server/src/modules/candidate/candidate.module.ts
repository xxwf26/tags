import { Module } from '@nestjs/common';
import { CandidateController } from './candidate.controller.js';

@Module({
  controllers: [CandidateController],
})
export class CandidateModule {}
