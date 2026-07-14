import { Module } from '@nestjs/common';
import { OperationController } from './operation.controller.js';

@Module({
  controllers: [OperationController],
})
export class OperationModule {}
