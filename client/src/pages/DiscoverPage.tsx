import { useState, useEffect, useCallback } from 'react';
import { useMihuashiFilterChips, useStartDiscover, useDiscoverTask, useDiscoverResults, useReviewDiscover, usePromoteDiscover, useRejectDiscover, useReferences, useUploadReference, useDeleteReference } from '../hooks';

const PLATFORM_LABEL: Record<string, string> = { mihuashi: '米画师' };
// 米画师页面真实筛选 chip 按 category 分组展示
const CAT_ORDER = ['画风', '类型'];
const CAT_LABEL: Record<string, string> = { '画风': '画风 / 技法', '类型': '作品类别' };
const TIER_LABEL: Record<string, { label: string; cls: string }> = {
  tier1: { label: '待复核', cls: 'text-stone-500 bg-stone-100' },
  tier2: { label: '已复核', cls: 'text-sky-600 bg-sky-50' },
  promoted: { label: '已入库', cls: 'text-emerald-600 bg-emerald-50' },
  rejected: { label: '已丢弃', cls: 'text-stone-400 bg-stone-100 line-through' },
};

export function DiscoverPage() {
  const chipsQ = useMihuashiFilterChips();
  const refsQ = useReferences();
  const upload = useUploadReference();
  const deleteRef = useDeleteReference();
  const startM = useStartDiscover();
  const reviewM = useReviewDiscover();
  const promoteM = usePromoteDiscover();
  const rejectM = useRejectDiscover();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedRef, setSelectedRef] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [viewResult, setViewResult] = useState<any>(null);
  const [viewIdx, setViewIdx] = useState(0);

  const taskQ = useDiscoverTask(sessionId);
  const resultsQ = useDiscoverResults(taskQ.data?.status === 'ok' ? (sessionId ?? 0) : 0);
  const ref = (refsQ.data ?? []).find(r => r.id === selectedRef);

  // 按.category 分组（chip 已是页面真实可点的，无 config 里的"平涂"等点不了的）
  const allChips = chipsQ.data ?? [];
  const byCat = new Map<string, string[]>();
  for (const c of allChips) {
    const arr = byCat.get(c.category) ?? [];
    arr.push(c.name);
    byCat.set(c.category, arr);
  }
  const catRows = CAT_ORDER.filter(c => byCat.has(c));

  // 参考图上传（可选）：上传后 image 模式，CLIP 按相似度排序；关键词仍来自下方米画师标签
  const loadFile = useCallback((f: File | null) => {
    if (!f) return;
    upload.mutate(f, { onSuccess: (r) => setSelectedRef(r.id) });
  }, [upload]);
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

  const toggle = (name: string) => setSelected(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const doSearch = () => {
    if (!selected.size) return;
    startM.mutate({ referenceId: selectedRef, tags: [...selected].map(label => ({ label })), platforms: ['mihuashi'] }, { onSuccess: (r) => setSessionId(r.sessionId) });
  };

  const task = taskQ.data;
  const running = task?.status === 'running';
  const results = resultsQ.data ?? [];
  const viewImgs: string[] = viewResult?.allImages?.length ? viewResult.allImages : (viewResult?.imageUrl ? [viewResult.imageUrl] : []);
  useEffect(() => {
    if (!viewResult) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewResult(null);
      else if (e.key === 'ArrowLeft') setViewIdx(i => (i - 1 + viewImgs.length) % viewImgs.length);
      else if (e.key === 'ArrowRight') setViewIdx(i => (i + 1) % viewImgs.length);
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [viewResult, viewImgs.length]);

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {/* 配置区 */}
      <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
        <h2 className="font-semibold text-stone-800 text-[15px] mb-1">发现 · 按画风搜米画师作品</h2>
        <p className="text-xs text-stone-400 mb-3">选米画师原生画风标签 → 去米画师召回作品 → AI 质检过滤广告/照片/低质 → 复核入库。标签与米画师一致，保证搜得到。</p>
        <div className="flex-1 min-w-0">
          {/* 参考图（可选）：上传后 image 模式，CLIP 按相似度排序。关键词仍来自下方米画师标签 */}
          <div className="flex items-center gap-3 mb-2">
            {ref ? (
              <div className="relative w-16 h-16 shrink-0">
                <img src={ref.imageUrl} className="w-16 h-16 object-cover rounded-lg border-2 border-xhs" alt="参考图" />
                <button onClick={() => setSelectedRef(null)} className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-stone-700 text-white text-xs flex items-center justify-center shadow" title="清除参考图">×</button>
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[9px] bg-violet-600 text-white rounded-full px-1.5 py-0.5 whitespace-nowrap">CLIP相似</span>
              </div>
            ) : (
              <div onClick={() => document.getElementById('discover-ref-file')?.click()}
                onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0] ?? null); }}
                className="w-16 h-16 shrink-0 border-2 border-dashed border-stone-200 rounded-lg flex items-center justify-center text-center cursor-pointer hover:border-xhs">
                <span className="text-[10px] text-stone-400 px-1 leading-tight">{upload.isPending ? '…' : '📋参考图\n可选'}</span>
                <input id="discover-ref-file" type="file" accept="image/*" className="hidden" onChange={e => loadFile(e.target.files?.[0] ?? null)} />
              </div>
            )}
            <span className="text-[11px] text-stone-400">可选：上传参考图后按 CLIP 视觉相似度排序结果；搜索关键词仍来自下方米画师标签</span>
          </div>

          {/* 米画师页面真实筛选 chip，按 category 分组 */}
          <div className="text-[12px] text-stone-500 mb-1">画风标签（点击多选，可跨组组合{chipsQ.isPending ? '，加载中…' : ''}）</div>
          <div className="space-y-1 max-h-52 overflow-auto pr-1">
            {catRows.map(cat => {
              const names = byCat.get(cat) ?? [];
              return (
                <div key={cat} className="flex items-start gap-2">
                  <span className="text-[11px] text-stone-400 w-16 shrink-0 pt-0.5">{CAT_LABEL[cat] || cat}</span>
                  <div className="flex gap-1 flex-wrap">
                    {names.map(name => {
                      const on = selected.has(name);
                      return <span key={name} onClick={() => toggle(name)}
                        className={`text-[12px] px-2.5 py-0.5 rounded-full cursor-pointer border ${on ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200 hover:border-xhs'}`}>{name}</span>;
                    })}
                  </div>
                </div>
              );
            })}
            {!catRows.length && <span className="text-[11px] text-stone-400">{chipsQ.isPending ? '正在拉取米画师筛选标签…' : '标签加载失败，请稍后重试'}</span>}
          </div>

          {/* 搜索 */}
          <div className="flex items-center gap-3 flex-wrap mt-3">
            <span className="text-[11px] text-stone-400">采集平台：米画师</span>
            <button onClick={doSearch} disabled={running || startM.isPending || !selected.size}
              className="text-[13px] bg-xhs text-white rounded-full px-5 py-2 font-medium disabled:opacity-40">
              {startM.isPending ? '发起中…' : running ? '搜索中…' : '🔍 按标签搜米画师'}
            </button>
            {selected.size > 0 && <span className="text-[11px] text-stone-400">已选 {selected.size} 个标签</span>}
          </div>
        </div>
      </div>

      {/* 进度条 */}
      {task && running && (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex items-center justify-between text-[13px] text-stone-600 mb-2">
            <span>搜索质检中…</span>
            <span className="text-stone-400">{task.done}/{task.total || '…'} 张</span>
          </div>
          <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
            <div className="h-full bg-xhs transition-all" style={{ width: task.total ? `${Math.round(task.done / task.total * 100)}%` : '8%' }} />
          </div>
          <div className="text-[11px] text-stone-400 mt-1.5">量大时约需数分钟，可离开稍后回来看结果</div>
        </div>
      )}
      {task && task.status === 'failed' && <div className="text-center text-rose-500 text-sm py-6">搜索失败，请重试</div>}

      {/* 漏斗：让"0 结果/结果少"能看清卡在哪个环节 */}
      {task && (task.stats || task.status === 'ok') && task.stats && (
        <div className="bg-white rounded-2xl p-3 border border-stone-100 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500">
          <span>召回 <b className="text-stone-600">{task.stats.recalled}</b></span>
          <span>· 去重后 {task.stats.unique}</span>
          {task.stats.dedup > 0 && <span>· 库内重复 -{task.stats.dedup}</span>}
          {task.stats.downloadFail > 0 && <span>· 下载失败 -{task.stats.downloadFail}</span>}
          {task.stats.notArtwork > 0 && <span>· 非绘画 -{task.stats.notArtwork}</span>}
          {task.stats.lowQuality > 0 && <span>· 低质 -{task.stats.lowQuality}</span>}
          {task.stats.lowSimilarity > 0 && <span>· 画风不符 -{task.stats.lowSimilarity}</span>}
          <span>· 保留 <b className="text-emerald-600">{task.stats.kept}</b></span>
          {task.stats.aiSkipped > 0 && <span className="text-amber-600">⚠ {task.stats.aiSkipped} 张未经 AI 质检（未配置 AI_API_KEY 或调用失败），请人工甄别</span>}
          {task.stats.embedSkipped > 0 && <span className="text-amber-600">⚠ 本次未做视觉精排（CLIP 不可用），仅按质量排序</span>}
        </div>
      )}

      {/* 结果 */}
      {task?.status === 'ok' && (
        <div>
          <div className="text-[13px] text-stone-500 mb-2 px-1">{task.mode === 'image' && !task.stats?.embedSkipped ? '按画风相似度×质量排序' : '按质量分排序'} · {results.length} 张（AI 已过滤广告/照片/低质）</div>
          {!results.length && <div className="text-center text-stone-400 py-12">
            {task.stats && task.stats.recalled === 0
              ? '平台没搜到内容，换个画风标签试试'
              : task.stats && task.stats.unique > 0
              ? '召回的图都被去重或质检过滤了，试试放宽画风'
              : '没有符合质量的结果，换个画风标签试试'}
          </div>}
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {results.map(r => (
              <div key={r.id} className="mb-2.5 break-inside-avoid bg-white rounded-xl overflow-hidden border border-stone-100 card-hover">
                <div className="relative cursor-zoom-in" onClick={() => { setViewResult(r); setViewIdx(0); }}>
                  <img src={r.imageUrl || ''} referrerPolicy="no-referrer" className="w-full object-cover" style={{ aspectRatio: '3/4' }}
                    onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} alt="" />
                  {r.similarity != null && <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-violet-600/90 text-white" title="与参考图的画风相似度">似 {(r.similarity * 100).toFixed(0)}</span>}
                  {r.quality != null && <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white">质 {r.quality.toFixed(0)}</span>}
                  <span className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-white">{PLATFORM_LABEL[r.platform] || r.platform}</span>
                </div>
                <div className="p-2">
                  <div className="text-[11px] text-stone-600 truncate">{r.title || '未命名'}</div>
                  <div className="text-[10px] text-stone-400">画师：{r.author || '未知'}</div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${TIER_LABEL[r.tier]?.cls || ''}`}>{TIER_LABEL[r.tier]?.label || r.tier}</span>
                    {r.tier === 'tier1' && (
                      <div className="flex gap-1">
                        <button onClick={() => promoteM.mutate(r.id)} disabled={promoteM.isPending} className="text-[10px] text-xhs border border-xhs/30 rounded-full px-2 py-0.5 hover:bg-xhs-soft">入库</button>
                        <button onClick={() => rejectM.mutate(r.id)} className="text-[10px] text-stone-400 border border-stone-200 rounded-full px-2 py-0.5">丢弃</button>
                      </div>
                    )}
                    {r.tier === 'promoted' && <span className="text-[10px] text-emerald-600">✓ 已入库</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 大图查看 */}
      {viewResult && viewImgs.length > 0 && (
        <div className="fixed inset-0 bg-black/92 z-[60] flex flex-col" onClick={() => setViewResult(null)}>
          <div className="flex items-center justify-between px-4 md:px-6 pt-4 text-white/80 text-xs md:text-sm shrink-0" onClick={e => e.stopPropagation()}>
            <span className="truncate">{viewResult.title || '未命名'} · 画师：{viewResult.author || '未知'} · {PLATFORM_LABEL[viewResult.platform] || viewResult.platform}</span>
            <span className="shrink-0 ml-2">{viewIdx + 1}/{viewImgs.length} · ←/→ · ESC</span>
          </div>
          <div className="flex-1 overflow-y-auto flex justify-center p-3 md:p-6" onClick={() => setViewResult(null)}>
            <div className="my-auto flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
              <div className="relative">
                <img src={viewImgs[viewIdx]} referrerPolicy="no-referrer" className="max-h-[74vh] max-w-full rounded-xl object-contain shadow-2xl" alt="" />
                {viewImgs.length > 1 && <button onClick={() => setViewIdx(i => (i - 1 + viewImgs.length) % viewImgs.length)} className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs">‹</button>}
                {viewImgs.length > 1 && <button onClick={() => setViewIdx(i => (i + 1) % viewImgs.length)} className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/45 text-white text-xl hover:bg-xhs">›</button>}
              </div>
              {viewResult.sourceUrl && <a href={viewResult.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-white/50 border border-white/15 rounded-full px-3 py-1 hover:bg-white/10">查看原页 →</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
