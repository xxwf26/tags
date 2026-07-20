// CLIP 视觉相似度——主线程侧单例。封装一个 worker 线程（见 clip.worker.ts），
// 对外暴露 embedImage（算图片 512 维向量）和 cosine（余弦相似度）。
//
// 设计要点：
// - 懒起：首次 embedImage 才启动 worker；没人用发现功能就不占模型内存。
// - 单 worker + pending map：worker 一次算一张（onnx 串行），主线程用 id→回调 表匹配结果，
//   不需自己排队；并发请求天然被 worker 事件循环串行化。
// - 降级：worker 起不来/加载失败/连崩 3 次 → 永久禁用，embedImage 抛错，调用方退回纯质量排序。
//   单张算失败只 reject 那一个请求，不影响 worker。
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REQUEST_TIMEOUT = 30_000;   // 单张 embedding 超时
const MAX_RESTARTS = 3;           // 累计崩溃达此数则永久降级

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let seq = 0;
let restarts = 0;
let disabled = false;

type Pending = { resolve: (v: number[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const pending = new Map<number, Pending>();

function rejectAllPending(err: Error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

// 启动 worker 并等它加载完模型（ready 握手）。dev/prod 双环境路径推导见下。
function ensureWorker(): Promise<void> {
  if (disabled) return Promise.reject(new Error('CLIP 已禁用（多次启动失败）'));
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<void>((resolve, reject) => {
    // 关键：dev 下 tsx 跑的是 clip.ts（.ts 结尾），worker 也得是 .ts 且用 --import tsx 让它能加载 .ts；
    // prod 下 tsc 编译后跑的是 clip.js，worker 是同目录的 clip.worker.js，无需 execArgv。
    // 用 import.meta.url 派生路径，不依赖 process.cwd()（pm2 的 cwd 可能与启动目录不同）。
    const here = fileURLToPath(import.meta.url);
    const isTs = here.endsWith('.ts');
    const workerFile = join(dirname(here), isTs ? 'clip.worker.ts' : 'clip.worker.js');

    let w: Worker;
    try {
      w = new Worker(workerFile, { execArgv: isTs ? ['--import', 'tsx'] : [] });
    } catch (e: any) {
      readyPromise = null;
      if (++restarts >= MAX_RESTARTS) disabled = true;
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    worker = w;
    let settled = false;   // readyPromise 是否已敲定——worker ready 之后再崩就不能再 reject 它了

    const onDead = (err: Error) => {
      rejectAllPending(new Error('CLIP worker 已退出'));
      worker = null;
      readyPromise = null;
      if (++restarts >= MAX_RESTARTS) disabled = true;
      if (!settled) { settled = true; reject(err); }   // 只在 ready 之前才 reject readyPromise
    };

    w.on('message', (m: any) => {
      if (m?.type === 'ready') { settled = true; resolve(); return; }
      if (m?.type === 'fatal') { return; } // 紧跟着会触发 exit，由 onDead 统一处理
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.embedding);
    });
    // worker 的 error/exit 事件必须有监听器，否则 error 会冒泡成主进程 uncaughtException → 整个后端崩溃。
    w.on('error', (e) => onDead(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', (code) => { if (code !== 0) onDead(new Error(`CLIP worker 退出码 ${code}`)); });
  });

  return readyPromise;
}

// 算一张图的 512 维归一化向量。worker 不可用时抛错（调用方据此降级）。
export async function embedImage(buf: Buffer): Promise<number[]> {
  await ensureWorker();
  const id = ++seq;
  // 切出独立 ArrayBuffer 再 transfer（零拷贝转移所有权给 worker）
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CLIP embedding 超时'));
    }, REQUEST_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    // postMessage 对已死的 worker 会同步抛错——包起来 reject 本请求，避免异常逃逸
    try {
      worker!.postMessage({ id, buffer: ab }, [ab]);
    } catch (e: any) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// 余弦相似度。两向量均已 L2 归一化，点积即余弦（范围约 0~1）。
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// 供调用方在算之前判断是否值得尝试（已永久降级则不必走 image 模式）。
export function isEmbedAvailable(): boolean {
  return !disabled;
}
