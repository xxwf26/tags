import { useState, useEffect, useCallback } from 'react';
import { useImageSearch } from '../hooks';
import type { SimilarArtwork } from '../api';

export function ImageSearchDialog({ onClose }: { onClose: () => void }) {
  const search = useImageSearch();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>('');

  const loadFile = useCallback((f: File | null) => {
    setFile(f);
    if (f) setPreview(URL.createObjectURL(f)); else setPreview('');
  }, []);

  // 粘贴上传
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      for (const it of e.clipboardData?.items ?? []) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile(); if (f) { e.preventDefault(); loadFile(f); break; }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);

  const doSearch = () => { if (file) search.mutate(file); };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-6 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full p-5 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-stone-800 text-lg">📷 以图搜图</h2>
          <button onClick={onClose} className="text-stone-400 text-xl leading-none">×</button>
        </div>

        <div
          onClick={() => document.getElementById('is-file')?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0] ?? null); }}
          className="border-2 border-dashed border-stone-200 rounded-xl p-4 text-center cursor-pointer hover:border-xhs hover:bg-xhs-soft/30"
        >
          {preview ? (
            <img src={preview} className="max-h-48 mx-auto rounded-lg" alt="query" />
          ) : (
            <div className="text-[12px] text-stone-400 py-6">📋 粘贴 / 🖱️ 点击选择 / 📂 拖入 要搜的图</div>
          )}
          <input id="is-file" type="file" accept="image/*" className="hidden"
            onChange={e => loadFile(e.target.files?.[0] ?? null)} />
        </div>

        <div className="flex justify-end mt-3">
          <button onClick={doSearch} disabled={!file || search.isPending}
            className="bg-xhs text-white text-sm px-5 py-2 rounded-full font-medium disabled:opacity-50">
            {search.isPending ? '搜索中…' : '搜相似作品'}
          </button>
        </div>

        {search.data && (
          <div className="mt-4">
            <div className="text-[13px] text-stone-500 mb-2">命中 {search.data.length} 张相似作品（pHash 海明距离，越小越像）</div>
            <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
              {search.data.map(a => (
                <div key={a.id} className="rounded-lg overflow-hidden border border-stone-100 relative">
                  <img src={a.thumbUrl || a.imageUrl} className="w-full aspect-square object-cover" alt="" />
                  <span className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white">dist {a.distance}</span>
                </div>
              ))}
              {!search.data.length && <div className="text-stone-400 text-sm col-span-full text-center py-6">无相似作品</div>}
            </div>
          </div>
        )}
        {search.isError && <div className="text-xs text-rose-500 mt-2">搜索失败：{(search.error as Error).message}</div>}
      </div>
    </div>
  );
}
