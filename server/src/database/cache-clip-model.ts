// 一次性预缓存 CLIP 模型：clip.worker.ts 设了 allowRemoteModels=false（只读缓存，不联网），
// 故首次需本脚本下载 Xenova/clip-vit-base-patch32 到本地缓存。之后 worker 离线即可加载。
// 用法：npx tsx src/database/cache-clip-model.ts
import { pipeline, env } from '@xenova/transformers';

env.allowRemoteModels = true; // 允许下载到缓存
console.log('正在下载/加载 CLIP 模型到本地缓存（首次约 360MB，请耐心）...');
const t0 = Date.now();
const extractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
console.log(`模型已缓存，耗时 ${Math.round((Date.now() - t0) / 1000)}s。cacheDir=${env.cacheDir}`);
// 触发一次推理确保完全可用
const { RawImage } = await import('@xenova/transformers');
// 用 1x1 像素 PNG 触发一次推理
const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const img = await RawImage.fromBlob(new Blob([px]));
await extractor(img);
console.log('推理验证通过，CLIP 可用。');
process.exit(0);
