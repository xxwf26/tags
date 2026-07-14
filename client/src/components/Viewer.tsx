import { useEffect } from 'react';
import type { Artwork } from '../api';

function aspectOf(w?: number | null, h?: number | null): string {
  if (w && h) return `${w} / ${h}`;
  return '3 / 4';
}

export function Viewer({ list, index, onClose, onNav, onTag, onConfirm, tagging }: {
  list: Artwork[]; index: number; onClose: () => void; onNav: (d: number) => void;
  onTag?: (id: number) => void; onConfirm?: (id: number) => void; tagging?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onNav(-1);
      else if (e.key === 'ArrowRight') onNav(1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onNav, onClose]);

  if (!list.length) return null;
  const i = ((index % list.length) + list.length) % list.length;
  const w = list[i];

  return (
    <div className="fixed inset-0 bg-black/92 z-[60] flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-4 md:px-6 pt-4 text-white/80 text-xs md:text-sm shrink-0" onClick={e => e.stopPropagation()}>
        <span className="truncate">{w.artistName || '未知画师'} · {w.tags[0]?.label || ''}</span>
        <span className="shrink-0 ml-2">{i + 1}/{list.length} · ←/→ 翻图 · ESC · 点空白关闭</span>
      </div>
      {/* 内容区：点击空白关闭；内部图片/面板阻止冒泡 */}
      <div className="flex-1 flex items-center justify-center p-3 md:p-6 overflow-auto" onClick={onClose}>
        <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-6 max-w-5xl w-full" onClick={e => e.stopPropagation()}>
          <div className="relative shrink-0 flex items-center justify-center">
            <img src={w.imageUrl} alt={w.title || ''} className="max-h-[72vh] max-w-full rounded-xl object-contain shadow-2xl" />
            <button className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs" onClick={e => { e.stopPropagation(); onNav(-1); }}>‹</button>
            <button className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs" onClick={e => { e.stopPropagation(); onNav(1); }}>›</button>
          </div>
          <div className="text-white w-full md:w-80 shrink-0">
            <div className="text-base md:text-lg font-semibold mb-1">{w.title || '未命名'}</div>
            <div className="text-white/60 text-sm mb-4">{w.orientation}屏 · {w.width}×{w.height}</div>
            <div className="text-[11px] text-white/40 mb-2">多维标签</div>
            <div className="flex gap-1.5 flex-wrap mb-5">
              {w.tags.map(t => (
                <span key={t.id} className="text-[12px] text-xhs bg-xhs-soft px-2 py-0.5 rounded-full">{t.label}</span>
              ))}
              {!w.tags.length && <span className="text-white/40 text-sm">无标签</span>}
            </div>
            {w.artistName && (
              <a href={`#/artist/${w.artistId}`} onClick={onClose} className="inline-block text-[13px] text-white/60 border border-white/15 rounded-full px-3 py-1 hover:bg-white/10">查看画师「{w.artistName}」→</a>
            )}
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${w.tagStatus === 'confirmed' ? 'text-emerald-300 bg-emerald-500/20' : 'text-amber-300 bg-amber-500/20'}`}>
                {w.tagStatus === 'confirmed' ? '✓ 已确认' : '待复核'}
              </span>
              {onTag && (
                <button onClick={e => { e.stopPropagation(); onTag(w.id); }} disabled={tagging}
                  className="text-[12px] text-white/80 border border-white/20 rounded-full px-3 py-1 hover:bg-white/10 disabled:opacity-40">
                  {tagging ? 'AI 打标中…' : '🤖 AI 重新打标'}
                </button>
              )}
              {onConfirm && w.tagStatus !== 'confirmed' && (
                <button onClick={e => { e.stopPropagation(); onConfirm(w.id); }}
                  className="text-[12px] text-xhs bg-white rounded-full px-3 py-1 font-medium">确认复核</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
