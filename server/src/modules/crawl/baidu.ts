// 百度图片搜索（免登录，JSON API）
// 需带完整浏览器请求头 + Referer，否则被反爬拦截
import https from 'node:https';

export type BaiduImage = {
  imageUrl: string;
  title: string;
  sourceUrl: string;
  width: number | null;
  height: number | null;
};

export async function searchBaiduImages(keyword: string, limit = 20): Promise<BaiduImage[]> {
  const enc = encodeURIComponent(keyword);
  const url = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&queryWord=${enc}&word=${enc}&pn=0&rn=${limit + 10}&ie=utf-8&oe=utf-8&z=0&ic=0&hd=0&latest=0&copyright=0&se=0&tab=&width=&height=&face=0&istype=2&qc=0&nc=1&expermode=&nojc=1&isAsync=1&gsm=3c&${Date.now()}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': `https://image.baidu.com/search/index?tn=baiduimage&word=${enc}`,
    'X-Requested-With': 'XMLHttpRequest',
  };

  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const items: BaiduImage[] = [];
          const seen = new Set<string>();
          for (const item of (j.data || [])) {
            const imgUrl = item.thumbURL || item.middleURL || item.objURL;
            if (!imgUrl || seen.has(imgUrl)) continue;
            seen.add(imgUrl);
            items.push({
              imageUrl: imgUrl.startsWith('http:') ? imgUrl.replace('http:', 'https:') : imgUrl,
              title: (item.fromPageTitleEnc || item.title || keyword).slice(0, 100),
              sourceUrl: item.fromURL || imgUrl,
              width: item.width ? Number(item.width) : null,
              height: item.height ? Number(item.height) : null,
            });
            if (items.length >= limit) break;
          }
          resolve(items);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  });
}
