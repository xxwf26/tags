import { useState, useEffect, useCallback } from 'react';
import { useReferences, useUploadReference, useUpdateReferenceTags, useStartSearch, useSearchSessions, useSearchResults, useReviewSearchResult, usePromoteSearchResult, useRejectSearchResult, useTags } from '../hooks';
import { tagsByTopDim } from '../api';

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
  const [editTags, setEditTags] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [activeSession, setActiveSession] = useState<number | null>(null);

  const startSearchM = useStartSearch();
  const sessionsQ = useSearchSessions(selectedRef ?? 0);
  const resultsQ = useSearchResults(activeSession ?? 0);
  const reviewM = useReviewSearchResult();
  const promoteM = usePromoteSearchResult();
  const rejectM = useRejectSearchResult();

  const ref = (refsQ.data ?? []).find(r => r.id === selectedRef);
  const byDim = tagsByTopDim(tagsQ.data ?? []);

  const loadFile = useCallback((f: File | null) => {
    if (!f) return;
    upload.mutate(f, { onSuccess: (r) => { setSelectedRef(r.id); setEditTags(new Set((r.aiTags ?? []).map(t => t.tagId))); } });
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

  // 选中参考图时初始化标签
  useEffect(() => {
    if (ref) setEditTags(new Set((ref.manualTags ?? ref.aiTags ?? []).map(t => t.tagId)));
  }, [selectedRef]);

  const toggleTag = (id: number) => { const s = new Set(editTags); s.has(id) ? s.delete(id) : s.add(id); setEditTags(s); };
  const saveTags = () => { if (selectedRef) updateTags.mutate({ id: selectedRef, manualTags: [...editTags].map(id => { const t = (ref?.aiTags ?? []).find(a => a.tagId === id); return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null }; }) }); };

  const doSearch = async () => {
    if (!selectedRef) return;
    setSearching(true);
    const tags = [...editTags].map(id => { const t = (ref?.aiTags ?? []).find(a => a.tagId === id); return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null }; });
    startSearchM.mutate({ referenceId: selectedRef, tags, platforms: ['mihuashi'] }, {
      onSuccess: (r) => { setActiveSession(r.sessionId); setSearching(false); },
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
              <button key={r.id} onClick={() => { setSelectedRef(r.id); setActiveSession(null); }}
                className={`w-14 h-14 rounded-lg overflow-hidden border-2 ${selectedRef === r.id ? 'border-xhs' : 'border-stone-200'}`}>
                <img src={r.imageUrl} className="w-full h-full object-cover" alt="" />
              </button>
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
              <div className="text-sm font-medium text-stone-700 mb-1">AI 标签（可调整）</div>
              <div className="space-y-1.5 max-h-40 overflow-auto">
                {DIM_ROWS.map(row => {
                  const tags = byDim.get(row.code)?.tags ?? [];
                  if (!tags.length) return null;
                  return (
                    <div key={row.code} className="flex items-start gap-2">
                      <span className="text-[11px] text-stone-400 w-14 shrink-0 pt-0.5">{row.label}</span>
                      <div className="flex gap-1 flex-wrap">
                        {tags.map(t => (
                          <span key={t.id} onClick={() => toggleTag(t.id)}
                            className={`text-[11px] px-2 py-0.5 rounded-full cursor-pointer border ${editTags.has(t.id) ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200'}`}>{t.label}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={saveTags} className="text-[12px] text-stone-600 border border-stone-200 rounded-full px-3 py-1.5 hover:bg-stone-50">保存标签</button>
                <button onClick={doSearch} disabled={searching}
                  className="text-[12px] bg-xhs text-white rounded-full px-4 py-1.5 font-medium disabled:opacity-50">
                  {searching ? '搜索中…（约30-60秒）' : '🔍 按标签搜索'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 搜索历史（session 文件夹） */}
      {selectedRef && sessions.length > 0 && (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <h3 className="font-semibold text-stone-700 text-[14px] mb-2">搜索历史（不覆盖，标新增）</h3>
          <div className="flex gap-2 flex-wrap">
            {sessions.map((s, i) => (
              <button key={s.id} onClick={() => setActiveSession(s.id)}
                className={`text-[12px] px-3 py-1.5 rounded-full border ${activeSession === s.id ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-600 border-stone-200'}`}>
                第{i + 1}次 · {s.resultCount}张{s.newCount > 0 ? `（${s.newCount}新增）` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 搜索结果 */}
      {activeSession && results.length > 0 && (
        <div>
          <div className="text-[13px] text-stone-500 mb-2 px-1">结果 {results.length} 张（<span className="text-xhs">{results.filter(r => r.isNew).length} 新增</span>）</div>
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {results.map(r => (
              <div key={r.id} className="mb-2.5 break-inside-avoid bg-white rounded-xl overflow-hidden border border-stone-100 card-hover">
                <div className="relative">
                  <img src={r.imageUrl || ''} referrerPolicy="no-referrer" className="w-full object-cover" alt="" style={{ aspectRatio: '3/4' }} onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} />
                  {r.isNew ? <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-xhs text-white">NEW</span> : null}
                  <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-white">{r.platform}</span>
                </div>
                <div className="p-2">
                  <div className="text-[11px] text-stone-600 truncate">{r.title || '未命名'}</div>
                  {r.author && <div className="text-[10px] text-stone-400">作者：{r.author}</div>}
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
            ))}
          </div>
        </div>
      )}
      {activeSession && !results.length && <div className="text-center text-stone-400 py-12">该搜索无结果</div>}
      {!activeSession && selectedRef && sessions.length > 0 && <div className="text-center text-stone-400 py-8">选择上方搜索历史查看结果</div>}
    </div>
  );
}
