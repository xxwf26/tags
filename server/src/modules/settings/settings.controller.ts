import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
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

  // cookie 有效性检测：missing=未设 / no_session=缺 web_session 登录态 / ok=有登录态(未真实验证)
  // ?probe=1 时真实探测：用搜索接口试一下能否返回结果（起子进程，慢，仅手动测试用）
  @Get('xhs-cookie-check')
  async xhsCookieCheck(@Query('probe') probe?: string): Promise<{ status: string; error?: string }> {
    const cookie = await this.settingsService.getXhsCookie();
    if (!cookie) return { status: 'missing' };
    if (!cookie.includes('web_session')) return { status: 'no_session' };
    if (probe !== '1') return { status: 'ok' };
    try {
      const { searchXhsByKeyword } = await import('../crawl/xhs.js');
      const notes = await searchXhsByKeyword('插画', 1, cookie);
      return { status: notes.length > 0 ? 'ok' : 'expired' };
    } catch (e: any) { return { status: 'error', error: e.message }; }
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

  // 米画师登录态状态：mhs-auth.json 是否存在 + 存了几天（超过约14天多半已过期，仅提示）
  @Get('mhs-auth-status')
  async mhsAuthStatus(): Promise<{ exists: boolean; ageDays: number | null }> {
    try {
      const s = await stat(join(process.cwd(), 'mhs-auth.json'));
      const ageDays = Math.floor((Date.now() - s.mtimeMs) / 86400000);
      return { exists: true, ageDays };
    } catch { return { exists: false, ageDays: null }; }
  }

  // 扫码登录米画师：弹出非无头浏览器窗口，业务员扫码/账号密码登录，脚本自动检测成功后存 mhs-auth.json
  @Post('mhs-login')
  async mhsLogin() {
    const scriptPath = join(process.cwd(), 'src', 'scripts', 'mhs-login.mts');
    return new Promise((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', scriptPath], {
        maxBuffer: 10 * 1024 * 1024, timeout: 160000, windowsHide: true,
      }, (err: any, stdout: any) => {
        if (err) { resolve({ success: false, error: err.message.includes('timeout') ? '登录超时，请重试' : err.message }); return; }
        try {
          const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
          resolve(result.success ? { success: true } : { success: false, error: result.error || '登录失败' });
        } catch { resolve({ success: false, error: '解析登录结果失败' }); }
      });
    });
  }
}
