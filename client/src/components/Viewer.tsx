import { useEffect, useState } from 'react';
import type { Artwork, TagNode } from '../api';
import { tagsByTopDim } from '../api';

const DIM_ROWS = [
  { code: 'genre', label: '画风' },
  { code: 'technique', label: '绘制技巧' },
  { code: 'subject', label: '题材' },
  { code: 'usage', label: '用途' },
  { code: 'tone', label: '色调/情绪' },
  { code: 'character', label: '人物类型' },
];

export function Viewer({ list, index, onClose, onNav, onTag, onConfirm, tagging, onDelete, onSaveTags, tagTree, savingTags }: {
  list: Artwork[]; index: number; onClose: () => void; onNav: (d: number) => void;
  onTag?: (id: number) => void; onConfirm?: (id: number) => void; tagging?: boolean;
  onDelete?: (id: number) => void;
  onSaveTags?: (id: number, tagIds: number[]) => void;
  tagTree?: TagNode[]; savingTags?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());

  const has = list.length > 0;
  const i = has ? ((index % list.length) + list.length) % list.length : 0;
  const w = has ? list[i] : null;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (editing) { if (e.key === 'Escape') setEditing(false); return; }
      if (e.key === 'ArrowLeft') onNav(-1);
      else if (e.key === 'ArrowRight') onNav(1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onNav, onClose, editing]);

  // 切换作品时退出编辑态
  useEffect(() => { setEditing(false); }, [w?.id]);

  if (!w) return null;

  const openEdit = () => { setSel(new Set(w.tags.map(t => t.id))); setEditing(true); };
  const toggle = (id: number) => { const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s); };
  const save = () => onSaveTags?.(w.id, [...sel]);
  const byDim = tagsByTopDim(tagTree ?? []);

  const del = () => {
    if (confirm(`确认删除作品「${w.title || '未命名'}」？删除后可在「管理」页撤销恢复。`)) {
      onDelete?.(w.id);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/92 z-[60] flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-4 md:px-6 pt-4 text-white/80 text-xs md:text-sm shrink-0" onClick={e => e.stopPropagation()}>
        <span className="truncate">{w.artistName || '未知画师'} · {w.tags[0]?.label || ''}</span>
        <span className="shrink-0 ml-2">{i + 1}/{list.length} · ←/→ 翻图 · ESC · 点空白关闭</span>
      </div>
      {/* 内容区：点击空白关闭；内部图片/面板阻止冒泡。overflow-y-auto+my-auto：短居中、长图从顶滚动不截断 */}
      <div className="flex-1 overflow-y-auto flex justify-center p-3 md:p-6" onClick={onClose}>
        <div className="my-auto flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-6 max-w-5xl" onClick={e => e.stopPropagation()}>
          <div className="relative shrink-0 flex items-center justify-center">
            <img src={w.imageUrl} alt={w.title || ''} className="max-h-[70vh] max-w-full md:max-w-[58vw] rounded-xl object-contain shadow-2xl" />
            <button className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs" onClick={e => { e.stopPropagation(); onNav(-1); }}>‹</button>
            <button className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs" onClick={e => { e.stopPropagation(); onNav(1); }}>›</button>
          </div>
          <div className="text-white w-full md:w-80 shrink-0">
            <div className="text-base md:text-lg font-semibold mb-1">{w.title || '未命名'}</div>
            <div className="text-white/60 text-sm mb-4">{w.orientation}屏 · {w.width}×{w.height}</div>

            {!editing ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-white/40">多维标签</span>
                  {onSaveTags && tagTree && (
                    <button onClick={openEdit} className="text-[11px] text-white/70 border border-white/20 rounded-full px-2 py-0.5 hover:bg-white/10">✏️ 编辑标签</button>
                  )}
                </div>
                <div className="flex gap-1.5 flex-wrap mb-5">
                  {w.tags.map(t => (
                    <span key={t.id} className="text-[12px] text-xhs bg-xhs-soft px-2 py-0.5 rounded-full">{t.label}</span>
                  ))}
                  {!w.tags.length && <span className="text-white/40 text-sm">无标签</span>}
                </div>
              </>
            ) : (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-white/40">编辑标签（点选/取消）</span>
                  <div className="flex gap-2">
                    <button onClick={() => setEditing(false)} className="text-[11px] text-white/60 px-2 py-0.5">取消</button>
                    <button onClick={save} disabled={savingTags} className="text-[11px] text-xhs bg-white rounded-full px-2.5 py-0.5 font-medium disabled:opacity-50">{savingTags ? '保存中…' : '保存'}</button>
                  </div>
                </div>
                <div className="space-y-2 max-h-[42vh] overflow-auto pr-1">
                  {DIM_ROWS.map(row => {
                    const tags = byDim.get(row.code)?.tags ?? [];
                    if (!tags.length) return null;
                    return (
                      <div key={row.code}>
                        <div className="text-[10px] text-white/40 mb-1">{row.label}</div>
                        <div className="flex gap-1 flex-wrap">
                          {tags.map(t => (
                            <span key={t.id} onClick={() => toggle(t.id)}
                              className={`text-[11px] px-2 py-0.5 rounded-full cursor-pointer border ${sel.has(t.id) ? 'bg-xhs text-white border-xhs' : 'bg-transparent text-white/70 border-white/25 hover:border-white/50'}`}>{t.label}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {w.artistName && !editing && (
              <a href={`#/artist/${w.artistId}`} onClick={onClose} className="inline-block text-[13px] text-white/60 border border-white/15 rounded-full px-3 py-1 hover:bg-white/10">查看画师「{w.artistName}」→</a>
            )}
            {!editing && (
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
                {onDelete && (
                  <button onClick={e => { e.stopPropagation(); del(); }}
                    className="text-[12px] text-rose-300 border border-rose-400/40 rounded-full px-3 py-1 hover:bg-rose-500/20">🗑 删除作品</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
