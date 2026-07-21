import { Module } from '@nestjs/common';
import { ImageProxyController } from './image-proxy.controller.js';

@Module({ controllers: [ImageProxyController] })
export class ImageProxyModule {}
