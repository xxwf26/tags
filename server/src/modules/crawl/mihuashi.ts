// 米画师画风采集（playwright 驱动真实页面绕过签名）
// 打开 /artworks → 点画风标签 → 滚动加载 → 拦截 search API 收集作品图
import { chromium } from 'playwright';

export type MhsArtwork = { mhsId: number; imageUrl: string; width: number | null; height: number | null };

export async function searchMihuashi(tagName: string, limit = 30): Promise<MhsArtwork[]> {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const arts: MhsArtwork[] = [];
  const seen = new Set<number>();
  p.on('response', async r => {
    if (r.url().includes('/api/v1/artworks/search')) {
      try {
        const j = JSON.parse(await r.text());
        for (const a of j.artworks || []) {
          if (a.id && !seen.has(a.id)) {
            seen.add(a.id);
            arts.push({ mhsId: a.id, imageUrl: a.url, width: a.width ?? null, height: a.height ?? null });
          }
        }
      } catch {}
    }
  });
  try {
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
    const tag = await p.$(`text=${tagName}`).catch(() => null);
    if (tag) { await tag.click(); } else { await b.close(); return []; }
    await p.waitForTimeout(2000);
    for (let i = 0; i < 25 && arts.length < limit; i++) {
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(1500);
    }
  } catch (e) {
    // 超时/导航异常也返回已收集的
  } finally {
    await b.close();
  }
  return arts.slice(0, limit);
}

// 拉米画师可用画风标签（供前端下拉）
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  let tags: any[] = [];
  p.on('response', async r => {
    if (r.url().includes('/api/v1/configure/artwork_tags')) {
      try { const j = JSON.parse(await r.text()); tags = j.artwork_tags || []; } catch {}
    }
  });
  try {
    await p.goto('https://www.mihuashi.com/artworks?order=1', { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(1500);
  } finally { await b.close(); }
  return tags;
}
