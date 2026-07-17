// CLIP worker：在独立线程加载 transformers 视觉模型并算图片 embedding。
// 独立线程的意义：onnxruntime 推理是 CPU 密集同步操作，放主线程会卡住整个 NestJS 事件循环
// （这正是上一版 CLIP 被移除的原因）。放 worker 里跑，主线程只负责收发消息，不被阻塞。
//
// 协议：
//   主线程 → worker: { id: number, buffer: ArrayBuffer }   请求算一张图
//   worker → 主线程: { type: 'ready' }                     模型加载完成，可接受请求
//                    { id, embedding: number[] }           某请求算完（512 维，已 L2 归一化）
//                    { id, error: string }                 某请求失败（单张，不影响 worker）
//                    { type: 'fatal', error }              模型加载失败，worker 即将退出
import { parentPort } from 'node:worker_threads';

type Extractor = (img: unknown) => Promise<{ data: Float32Array | number[] }>;
let extractor: Extractor | null = null;

// 启动即预热：加载 pipeline（实测本机缓存下 ~0.3s）。完成后握手告知主线程 ready。
async function init() {
  const { pipeline, env } = await import('@xenova/transformers');
  // 强制离线：只用 node_modules 里已缓存的模型，缺失就报错而非卡在联网下载
  (env as any).allowRemoteModels = false;
  extractor = (await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32')) as unknown as Extractor;
  parentPort!.postMessage({ type: 'ready' });
}

init().catch((e) => {
  parentPort!.postMessage({ type: 'fatal', error: String(e?.message ?? e) });
  process.exit(1);
});

parentPort!.on('message', async (m: { id: number; buffer: ArrayBuffer }) => {
  if (!extractor) { parentPort!.postMessage({ id: m.id, error: 'extractor 未就绪' }); return; }
  try {
    const { RawImage } = await import('@xenova/transformers');
    // transformers 在 Node 下 fromBlob 内部走 sharp 解码；传编码后的原始 bytes 即可
    const img = await RawImage.fromBlob(new Blob([m.buffer]));
    const out = await extractor(img);
    const raw = Array.from(out.data as Float32Array);
    // L2 归一化：归一化后两向量点积 = 余弦相似度，主线程 cosine() 只需做点积
    let norm = 0;
    for (const v of raw) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    parentPort!.postMessage({ id: m.id, embedding: raw.map((v) => v / norm) });
  } catch (e: any) {
    parentPort!.postMessage({ id: m.id, error: String(e?.message ?? e) });
  }
});
