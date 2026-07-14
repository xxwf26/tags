import { useState, useEffect, useCallback } from 'react';
import { useTags, useArtists, useCreateArtwork } from '../hooks';
import { tagsByTopDim, tagArtwork } from '../api';

const DIM_ROWS = [
  { code: 'genre', label: '画风' },
  { code: 'technique', label: '绘制技巧' },
  { code: 'subject', label: '题材' },
  { code: 'usage', label: '用途' },
  { code: 'tone', label: '色调/情绪' },
  { code: 'character', label: '人物类型' },
];

export function EntryDialog({ onClose, presetArtistId }: { onClose: () => void; presetArtistId?: number }) {
  const tagsQ = useTags();
  const artistsQ = useArtists();
  const create = useCreateArtwork();

  const [artistName, setArtistName] = useState('');
  const [artistOpen, setArtistOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [autoTag, setAutoTag] = useState(true);
  const [tagging, setTagging] = useState(false);

  // 作者组合框：按输入过滤已有画师；输入新名字则提交时后端自动建
  const artistMatches = (artistsQ.data ?? [])
    .filter(a => a.name && (!artistName || a.name.toLowerCase().includes(artistName.toLowerCase())))
    .slice(0, 6);
  const isNewArtist = artistName.trim() && !(artistsQ.data ?? []).some(a => a.name === artistName.trim());
  const locked = !!presetArtistId;

  // 从画师详情页打开时：预填并锁定该画师
  useEffect(() => {
    if (presetArtistId && artistsQ.data) {
      const a = artistsQ.data.find(x => x.id === presetArtistId);
      if (a) setArtistName(a.name);
    }
  }, [presetArtistId, artistsQ.data]);

  const byDim = tagsByTopDim(tagsQ.data ?? []);

  const loadFile = useCallback((f: File | null) => {
    setFile(f);
    if (f) {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => { setDims({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.src = url;
    } else setDims(null);
  }, []);
  const onFile = loadFile;

  // 粘贴上传：对话框打开时监听 window paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); loadFile(f); break; }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);
  const toggle = (id: number) => {
    const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s);
  };

  const submit = () => {
    if (!file) { alert('请选择图片'); return; }
    const fd = new FormData();
    fd.append('file', file);
    if (artistName.trim()) fd.append('artistName', artistName.trim());
    if (title) fd.append('title', title);
    if (sourceUrl) fd.append('sourceUrl', sourceUrl);
    if (dims) { fd.append('width', String(dims.w)); fd.append('height', String(dims.h)); }
    fd.append('tagIds', [...selected].join(','));
    create.mutate(fd, {
      onSuccess: async (art) => {
        if (autoTag && art.id) {
          setTagging(true);
          try { await tagArtwork(art.id); } catch {}
        }
        onClose();
      },
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-3 md:p-6 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full p-5 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-stone-800 text-lg">手动录作品</h2>
          <button onClick={onClose} className="text-stone-400 text-xl leading-none">×</button>
        </div>

        <div className="space-y-3 text-sm">
          <div className="relative">
            <label className="text-xs text-stone-400">画师 {locked ? <span className="text-stone-300">（已锁定为当前画师）</span> : <span className="text-stone-300">（输入名字搜索已有；新名字自动建画师）</span>}</label>
            <input value={artistName} disabled={locked} onChange={e => { setArtistName(e.target.value); setArtistOpen(true); }}
              onFocus={() => setArtistOpen(true)} onBlur={() => setTimeout(() => setArtistOpen(false), 150)}
              placeholder="输入或选择画师名"
              className="w-full mt-1 border border-stone-200 rounded-lg px-3 py-2 focus:border-xhs outline-none disabled:bg-stone-100 disabled:text-stone-500" />
            {!locked && artistOpen && artistMatches.length > 0 && (
              <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                {artistMatches.map(a => (
                  <div key={a.id} onMouseDown={() => { setArtistName(a.name); setArtistOpen(false); }}
                    className="px-3 py-2 text-sm hover:bg-xhs-soft cursor-pointer flex items-center justify-between">
                    <span>{a.name}</span>
                    <span className="text-[11px] text-stone-400">{a.total}张作品</span>
                  </div>
                ))}
              </div>
            )}
            {!locked && isNewArtist && <div className="text-[11px] text-amber-600 mt-1">新画师「{artistName.trim()}」将自动创建</div>}
          </div>
          <div>
            <label className="text-xs text-stone-400">标题</label>
            <input value={title} onChange={e => setTitle(e.target.value)} className="w-full mt-1 border border-stone-200 rounded-lg px-3 py-2" placeholder="作品标题" />
          </div>
          <div>
            <label className="text-xs text-stone-400">作品图</label>
            <div
              onClick={() => document.getElementById('entry-file')?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0] ?? null); }}
              className="mt-1 border-2 border-dashed border-stone-200 rounded-xl p-4 text-center cursor-pointer hover:border-xhs hover:bg-xhs-soft/30 transition-colors"
            >
              {file ? (
                <div className="flex items-center gap-3">
                  <img src={URL.createObjectURL(file)} className="w-20 h-20 object-cover rounded-lg" alt="preview" />
                  <div className="text-left">
                    <div className="text-[12px] text-stone-700">{file.name}</div>
                    {dims && <div className="text-[11px] text-stone-400">{dims.w}×{dims.h} · {dims.w > dims.h ? '横屏' : dims.h > dims.w ? '竖屏' : '方'}</div>}
                    <div className="text-[11px] text-xhs mt-0.5">点击/粘贴/拖入可替换</div>
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-stone-400 py-2">
                  📋 粘贴 / 🖱️ 点击选择 / 📂 拖入图片
                </div>
              )}
              <input id="entry-file" type="file" accept="image/*" onChange={e => onFile(e.target.files?.[0] ?? null)} className="hidden" />
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-400">多维标签（白名单）</label>
            <div className="mt-1 space-y-2 max-h-60 overflow-auto">
              {DIM_ROWS.map(row => {
                const tags = byDim.get(row.code)?.tags ?? [];
                if (!tags.length) return null;
                return (
                  <div key={row.code} className="flex items-start gap-2">
                    <span className="text-[11px] text-stone-400 w-20 shrink-0 pt-1">{row.label}</span>
                    <div className="flex gap-1 flex-wrap">
                      {tags.map(t => (
                        <span key={t.id} onClick={() => toggle(t.id)}
                          className={`text-[11px] px-2 py-0.5 rounded-full cursor-pointer border ${selected.has(t.id) ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-600 border-stone-200'}`}>{t.label}</span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-400">来源链接（可选）</label>
            <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} className="w-full mt-1 border border-stone-200 rounded-lg px-3 py-2" placeholder="小红书笔记链接" />
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-600 cursor-pointer">
            <input type="checkbox" checked={autoTag} onChange={e => setAutoTag(e.target.checked)} className="accent-[#FF2442]" />
            录入后用 AI 自动打标（Gemini + 豆包，标签进入待复核）
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-stone-500 text-sm">取消</button>
          <button onClick={submit} disabled={create.isPending || tagging} className="px-5 py-2 rounded-full bg-xhs text-white text-sm font-medium disabled:opacity-50">
            {tagging ? 'AI 打标中…' : create.isPending ? '提交中…' : (autoTag ? '录入并 AI 打标' : '录入')}
          </button>
        </div>
        {create.isError && <div className="text-xs text-rose-500 mt-2">提交失败：{(create.error as Error).message}</div>}
      </div>
    </div>
  );
}
