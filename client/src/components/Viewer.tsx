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
      <div className="flex items-center justify-between px-6 pt-5 text-white/80 text-sm" onClick={e => e.stopPropagation()}>
        <span>{w.artistName || '未知画师'} · {w.tags[0]?.label || ''}</span>
        <span>{i + 1} / {list.length} · ←/→ 翻图 · ESC 关闭</span>
      </div>
      <div className="flex-1 flex items-center justify-center gap-4 px-6 pb-6 min-h-0" onClick={e => e.stopPropagation()}>
        <button className="w-11 h-11 rounded-full bg-white/10 text-white text-xl hover:bg-white/22 shrink-0" onClick={() => onNav(-1)}>‹</button>
        <div className="flex gap-5 max-w-5xl w-full items-center">
          <div className="rounded-xl overflow-hidden shadow-2xl shrink-0" style={{ width: 'min(58%, 520px)', aspectRatio: aspectOf(w.width, w.height) }}>
            <img src={w.imageUrl} alt={w.title || ''} className="w-full h-full object-cover" />
          </div>
          <div className="text-white flex-1 min-w-0">
            <div className="text-lg font-semibold mb-1">{w.title || '未命名'}</div>
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
            <div className="flex items-center gap-2 mt-4">
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${w.tagStatus === 'confirmed' ? 'text-emerald-300 bg-emerald-500/20' : 'text-amber-300 bg-amber-500/20'}`}>
                {w.tagStatus === 'confirmed' ? '✓ 已确认' : '待复核'}
              </span>
              {onTag && (
                <button onClick={() => onTag(w.id)} disabled={tagging}
                  className="text-[12px] text-white/80 border border-white/20 rounded-full px-3 py-1 hover:bg-white/10 disabled:opacity-40">
                  {tagging ? 'AI 打标中…' : '🤖 AI 重新打标'}
                </button>
              )}
              {onConfirm && w.tagStatus !== 'confirmed' && (
                <button onClick={() => onConfirm(w.id)}
                  className="text-[12px] text-xhs bg-white rounded-full px-3 py-1 font-medium">确认复核</button>
              )}
            </div>
          </div>
        </div>
        <button className="w-11 h-11 rounded-full bg-white/10 text-white text-xl hover:bg-white/22 shrink-0" onClick={() => onNav(1)}>›</button>
      </div>
    </div>
  );
}
