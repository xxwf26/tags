import { Controller, Get, Post, Body } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

@Controller('settings')
export class SettingsController {
  private readonly settingsService = new SettingsService();

  @Get()
  list() { return this.settingsService.getAll(); }

  @Post()
  set(@Body() body: { key: string; value: string }) {
    return this.settingsService.set(body.key, body.value);
  }

  @Get('xhs-cookie')
  async xhsCookie() {
    const cookie = await this.settingsService.getXhsCookie();
    return { hasCookie: !!cookie, preview: cookie ? cookie.slice(0, 40) + '...' : null };
  }

  @Post('xhs-cookie')
  setXhsCookie(@Body() body: { value: string }) {
    return this.settingsService.set('xhs_cookie', body.value);
  }
}
