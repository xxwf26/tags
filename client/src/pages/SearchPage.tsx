import { useState, useEffect, useCallback } from 'react';
import type { SearchResult } from '../api';
import { useReferences, useUploadReference, useUpdateReferenceTags, useStartSearch, useSearchSessions, useSearchResults, useReviewSearchResult, usePromoteSearchResult, useRejectSearchResult, useDeleteReference, useTags } from '../hooks';
import { tagsByTopDim } from '../api';
const BASE = '/api';

const TIER_LABEL: Record<string, { label: string; cls: string }> = {
  tier1: { label: '一级库', cls: 'text-stone-500 bg-stone-100' },
  tier2: { label: '二级库', cls: 'text-sky-600 bg-sky-50' },
  promoted: { label: '已入库', cls: 'text-emerald-600 bg-emerald-50' },
  rejected: { label: '已丢弃', cls: 'text-stone-400 bg-stone-100 line-through' },
};

const DIM_ROWS = [
  { code: 'genre', label: '画风' }, { code: 'technique', label: '技法' },
  { code: 'subject', label: '题材' }, { code: 'usage', label: '用途' },
  { code: 'tone', label: '色调' }, { code: 'character', label: '人物' },
];

export function SearchPage() {
  const refsQ = useReferences();
  const upload = useUploadReference();
  const updateTags = useUpdateReferenceTags();
  const tagsQ = useTags();
  const [selectedRef, setSelectedRef] = useState<number | null>(null);
  const [tagModes, setTagModes] = useState<Record<number, 'must' | 'fuzzy'>>({});
  const [fuzzyRatio, setFuzzyRatio] = useState(0.5);
  const [searching, setSearching] = useState(false);
  const [activeSession, setActiveSession] = useState<number | null>(null);
  const [viewResult, setViewResult] = useState<any>(null);
  const [viewImgIdx, setViewImgIdx] = useState(0);

  const startSearchM = useStartSearch();
  const sessionsQ = useSearchSessions(selectedRef ?? 0);
  const refetchSessions = sessionsQ.refetch;
  const resultsQ = useSearchResults(activeSession ?? 0);
  const reviewM = useReviewSearchResult();
  const promoteM = usePromoteSearchResult();
  const rejectM = useRejectSearchResult();
  const deleteRef = useDeleteReference();

  const ref = (refsQ.data ?? []).find(r => r.id === selectedRef);
  const byDim = tagsByTopDim(tagsQ.data ?? []);

  const loadFile = useCallback((f: File | null) => {
    if (!f) return;
    upload.mutate(f, { onSuccess: (r) => {
      setSelectedRef(r.id);
      const modes: Record<number, 'must' | 'fuzzy'> = {};
      (r.aiTags ?? []).forEach(t => { modes[t.tagId] = 'fuzzy'; });
      setTagModes(modes);
    } });
  }, [upload]);

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

  // 选中参考图时初始化标签模式
  useEffect(() => {
    if (ref) {
      const modes: Record<number, 'must' | 'fuzzy'> = {};
      (ref.manualTags ?? ref.aiTags ?? []).forEach(t => { modes[t.tagId] = 'fuzzy'; });
      setTagModes(modes);
    }
  }, [selectedRef]);

  const toggleTag = (id: number) => {
    const m = { ...tagModes };
    if (m[id]) delete m[id]; else m[id] = 'fuzzy';
    setTagModes(m);
  };
  const toggleMode = (id: number) => {
    const m = { ...tagModes };
    if (m[id] === 'must') m[id] = 'fuzzy'; else m[id] = 'must';
    setTagModes(m);
  };
  const selectedIds = Object.keys(tagModes).map(Number);
  const saveTags = () => { if (selectedRef) updateTags.mutate({ id: selectedRef, manualTags: selectedIds.map(id => { const t = (ref?.aiTags ?? []).find(a => a.tagId === id); return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null }; }) }); };

  const doSearch = async () => {
    if (!selectedRef) return;
    setSearching(true);
    const tags = selectedIds.map(id => {
      const t = (ref?.aiTags ?? []).find(a => a.tagId === id);
      return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null, mode: tagModes[id] };
    });
    startSearchM.mutate({ referenceId: selectedRef, tags, platforms: ['xiaohongshu'], fuzzyRatio }, {
      onSuccess: (r) => {
        setActiveSession(r.sessionId);
        // 轮询搜索状态
        const poll = setInterval(() => {
          refetchSessions();
          // 检查 session 状态
          fetch(BASE + '/search/sessions?referenceId=' + selectedRef)
            .then(r => r.json())
            .then((sessions: any[]) => {
              const cur = sessions.find(s => s.id === r.sessionId);
              if (cur && cur.status !== 'running') {
                clearInterval(poll);
                setSearching(false);
                refetchSessions();
                // 自动选中新 session 的结果
                setActiveSession(r.sessionId);
              }
            });
        }, 3000);
      },
      onError: () => setSearching(false),
    });
  };

  const sessions = sessionsQ.data ?? [];
  const results = resultsQ.data ?? [];

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {/* 上传区 */}
      <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
        <h2 className="font-semibold text-stone-800 text-[15px] mb-2">寻源 · 上传参考图</h2>
        <div onClick={() => document.getElementById('search-file')?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0] ?? null); }}
          className="border-2 border-dashed border-stone-200 rounded-xl p-4 text-center cursor-pointer hover:border-xhs hover:bg-xhs-soft/30">
          <span className="text-[12px] text-stone-400">📋 粘贴 / 🖱️ 点击选择 / 📂 拖入参考图</span>
          <input id="search-file" type="file" accept="image/*" className="hidden" onChange={e => loadFile(e.target.files?.[0] ?? null)} />
        </div>
        {(refsQ.data ?? []).length > 0 && (
          <div className="flex gap-2 mt-3 flex-wrap">
            {(refsQ.data ?? []).map(r => (
              <div key={r.id} className="relative">
                <button onClick={() => { setSelectedRef(r.id); setActiveSession(null); }}
                  className={`block w-16 h-16 rounded-lg overflow-hidden border-2 ${selectedRef === r.id ? 'border-xhs' : 'border-stone-200'}`}>
                  <img src={r.imageUrl} className="w-full h-full object-cover" alt="" />
                </button>
                <span className="absolute -bottom-1 -right-1 text-[9px] bg-stone-700 text-white rounded-full px-1.5 py-0.5">{r.status === 'tagging' ? '⏳' : '✓'}</span>
                <button onClick={(e) => { e.stopPropagation(); if (confirm('删除此参考图及其所有搜索记录？')) { deleteRef.mutate(r.id); if (selectedRef === r.id) { setSelectedRef(null); setActiveSession(null); } } }}
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-rose-500 text-white text-sm flex items-center justify-center shadow-md hover:bg-rose-600" title="删除参考图">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 选中参考图：标签 + 搜索 */}
      {ref && (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex gap-4">
            <img src={ref.imageUrl} className="w-32 h-32 object-cover rounded-xl shrink-0" alt="参考图" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-stone-700 mb-1">AI 标签（点击选/取消，再点切换必中/模糊）</div>
              <div className="space-y-1.5 max-h-40 overflow-auto">
                {DIM_ROWS.map(row => {
                  const tags = byDim.get(row.code)?.tags ?? [];
                  if (!tags.length) return null;
                  return (
                    <div key={row.code} className="flex items-start gap-2">
                      <span className="text-[11px] text-stone-400 w-14 shrink-0 pt-0.5">{row.label}</span>
                      <div className="flex gap-1 flex-wrap">
                        {tags.map(t => {
                          const mode = tagModes[t.id];
                          const selected = !!mode;
                          return (
                            <span key={t.id}>
                              <span onClick={() => toggleTag(t.id)} title={selected ? '点击取消' : '点击选中'}
                                className={`text-[11px] px-2 py-0.5 rounded-l-full cursor-pointer border-r-0 border ${selected ? (mode === 'must' ? 'bg-xhs text-white border-xhs' : 'bg-amber-400 text-white border-amber-400') : 'bg-white text-stone-500 border-stone-200 rounded-full'}`}>{t.label}</span>
                              {selected && <span onClick={() => toggleMode(t.id)} title="切换必中/模糊"
                                className={`text-[10px] px-1.5 py-0.5 rounded-r-full cursor-pointer border ${mode === 'must' ? 'bg-xhs text-white border-xhs' : 'bg-amber-400 text-white border-amber-400'}`}>{mode === 'must' ? '必' : '模'}</span>}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* 模糊比例滑块 */}
              <div className="flex items-center gap-2 mt-2 text-[11px] text-stone-500">
                <span>模糊标签满足比例：</span>
                <input type="range" min="0" max="100" value={Math.round(fuzzyRatio * 100)} onChange={e => setFuzzyRatio(Number(e.target.value) / 100)} className="w-32 accent-xhs" />
                <span className="text-xhs font-medium">{Math.round(fuzzyRatio * 100)}%</span>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={doSearch} disabled={searching}
                  className="text-[12px] bg-xhs text-white rounded-full px-4 py-1.5 font-medium disabled:opacity-50">
                  {searching ? '搜索中…（后台运行，可等结果）' : '🔍 按标签搜索'}
                </button>
                <button onClick={doSearch} disabled={searching}
                  className="text-[12px] bg-xhs text-white rounded-full px-4 py-1.5 font-medium disabled:opacity-50">
                  {searching ? '搜索中…（约30-60秒）' : '🔍 按标签搜索'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 搜索历史（session 文件夹，区分管理） */}
      {selectedRef && sessions.length > 0 && (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-stone-700 text-[14px]">搜索历史（{sessions.length} 次，不覆盖）</h3>
            <span className="text-[11px] text-stone-400">每次搜索独立保留，标新增</span>
          </div>
          <div className="space-y-2">
            {sessions.map((s, i) => {
              const tags = (s.searchTags as any)?.tags ?? s.searchTags ?? [];
              const tagLabels = Array.isArray(tags) ? tags.map((t: any) => t.label).filter(Boolean) : [];
              const ratio = (s.searchTags as any)?.fuzzyRatio;
              return (
                <div key={s.id} className={`border rounded-lg p-3 cursor-pointer transition-colors ${activeSession === s.id ? 'border-xhs bg-xhs-soft/30' : 'border-stone-200 hover:border-stone-300'}`}
                  onClick={() => setActiveSession(s.id)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-stone-700">第 {i + 1} 次搜索</span>
                      <span className="text-[10px] text-stone-400">{new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      {s.newCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-xhs text-white">{s.newCount} 新增</span>}
                    </div>
                    <span className="text-[12px] text-stone-500">{s.resultCount} 张结果</span>
                  </div>
                  <div className="flex gap-1 flex-wrap mt-1.5">
                    {tagLabels.map((label: string, j: number) => {
                      const tagMode = tags[j]?.mode;
                      return <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded ${tagMode === 'must' ? 'bg-xhs/10 text-xhs' : 'bg-amber-100 text-amber-700'}`}>{label}{tagMode === 'must' ? '' : '·模'}</span>;
                    })}
                    {ratio != null && <span className="text-[10px] text-stone-400">模糊比例 {Math.round(ratio * 100)}%</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 搜索结果 */}
      {activeSession && results.length > 0 && (
        <div>
          <div className="text-[13px] text-stone-500 mb-2 px-1">结果 {results.length} 帖（<span className="text-xhs">{results.filter(r => r.isNew).length} 新增</span>）</div>
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {results.map(r => {
              const allImgs: string[] = (r as any).allImages || (r.imageUrl ? [r.imageUrl] : []);
              return (
                <div key={r.id} className="mb-2.5 break-inside-avoid bg-white rounded-xl overflow-hidden border border-stone-100 card-hover">
                  <div className="relative cursor-pointer" onClick={() => setViewResult(r)}>
                    <img src={r.imageUrl || ''} referrerPolicy="no-referrer" className="w-full object-cover" alt="" style={{ aspectRatio: '3/4' }} onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} />
                    {r.isNew ? <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-xhs text-white">NEW</span> : null}
                    {allImgs.length > 1 && <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white">📊{allImgs.length}张</span>}
                    <span className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-white">{r.platform}</span>
                  </div>
                  <div className="p-2">
                    <div className="text-[11px] text-stone-600 truncate">{r.title || '未命名'}</div>
                    {r.author && <div className="text-[10px] text-stone-400">作者：{r.author}</div>}
                    {r.tags?.length > 0 && <div className="flex gap-1 flex-wrap mt-1">{r.tags.slice(0, 3).map((t: string, i: number) => <span key={i} className="text-[9px] text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">{t}</span>)}</div>}
                    <div className="flex items-center justify-between mt-1.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${TIER_LABEL[r.tier]?.cls || ''}`}>{TIER_LABEL[r.tier]?.label || r.tier}</span>
                      {r.tier === 'tier1' && (
                        <div className="flex gap-1">
                          <button onClick={() => reviewM.mutate(r.id)} className="text-[10px] text-sky-600 border border-sky-200 rounded-full px-2 py-0.5 hover:bg-sky-50">复核</button>
                          <button onClick={() => rejectM.mutate(r.id)} className="text-[10px] text-stone-400 border border-stone-200 rounded-full px-2 py-0.5">丢弃</button>
                        </div>
                      )}
                      {r.tier === 'tier2' && (
                        <div className="flex gap-1">
                          <button onClick={() => promoteM.mutate(r.id)} className="text-[10px] text-xhs border border-xhs/30 rounded-full px-2 py-0.5 hover:bg-xhs-soft">入库</button>
                          <button onClick={() => rejectM.mutate(r.id)} className="text-[10px] text-stone-400 border border-stone-200 rounded-full px-2 py-0.5">丢弃</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {activeSession && !results.length && <div className="text-center text-stone-400 py-12">该搜索无结果</div>}
      {!activeSession && selectedRef && sessions.length > 0 && <div className="text-center text-stone-400 py-8">选择上方搜索历史查看结果</div>}
      {/* 大图查看器（一帖多图翻页） */}
      {viewResult && (() => {
        const allImgs: string[] = viewResult.allImages || (viewResult.imageUrl ? [viewResult.imageUrl] : []);
        const img = allImgs[viewImgIdx] || '';
        return (
          <div className="fixed inset-0 bg-black/92 z-[60] flex flex-col" onClick={() => { setViewResult(null); setViewImgIdx(0); }}>
            <div className="flex items-center justify-between px-4 md:px-6 pt-4 text-white/80 text-xs md:text-sm shrink-0" onClick={e => e.stopPropagation()}>
              <span className="truncate">{viewResult.title || '未命名'} · {viewResult.author || ''}</span>
              <span className="shrink-0 ml-2">{viewImgIdx + 1}/{allImgs.length} · ←/→ 翻图 · ESC 关闭</span>
            </div>
            <div className="flex-1 overflow-y-auto flex justify-center p-3 md:p-6" onClick={() => { setViewResult(null); setViewImgIdx(0); }}>
              <div className="my-auto flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
                <div className="relative">
                  <img src={img} referrerPolicy="no-referrer" className="max-h-[72vh] max-w-full rounded-xl object-contain shadow-2xl" alt="" />
                  {allImgs.length > 1 && <button onClick={() => setViewImgIdx(i => (i - 1 + allImgs.length) % allImgs.length)} className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs">‹</button>}
                  {allImgs.length > 1 && <button onClick={() => setViewImgIdx(i => (i + 1) % allImgs.length)} className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs">›</button>}
                </div>
                {viewResult.tags?.length > 0 && <div className="flex gap-1.5 flex-wrap justify-center">{viewResult.tags.map((t: string, i: number) => <span key={i} className="text-[12px] text-xhs bg-xhs-soft px-2 py-0.5 rounded-full">{t}</span>)}</div>}
                <a href={viewResult.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-white/50 border border-white/15 rounded-full px-3 py-1 hover:bg-white/10">查看原帖 →</a>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
