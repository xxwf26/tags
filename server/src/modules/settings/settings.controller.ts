import { Controller, Get, Post, Body } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

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

  // 扫码登录小红书：弹出非无头浏览器窗口显示二维码，业务员手机扫码后自动保存cookie
  @Post('xhs-login')
  async xhsLogin() {
    const scriptPath = join(process.cwd(), 'src', 'scripts', 'xhs-login.mts');
    return new Promise((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', scriptPath], {
        maxBuffer: 10 * 1024 * 1024, timeout: 140000, windowsHide: true,
      }, async (err: any, stdout: any) => {
        if (err) { resolve({ success: false, error: err.message.includes('timeout') ? '登录超时，请重试' : err.message }); return; }
        try {
          const result = JSON.parse(stdout);
          if (result.success && result.cookie) {
            await this.settingsService.set('xhs_cookie', result.cookie);
            process.env.XHS_COOKIE = result.cookie;
            resolve({ success: true });
          } else {
            resolve({ success: false, error: result.error || '登录失败' });
          }
        } catch { resolve({ success: false, error: '解析登录结果失败' }); }
      });
    });
  }
}
