import { useState, useEffect, useCallback } from 'react';
import { useReferences, useUploadReference, useStartDiscover, useDiscoverSessions, useDiscoverResults, useDiscoverSessionsList, useReviewDiscover, usePromoteDiscover, useRejectDiscover, useDeleteReference, useAbortDiscover } from '../hooks';

const PLATFORMS = [
  { key: 'mihuashi', label: '米画师' },
  { key: 'weibo', label: '微博' },
];
const PLATFORM_LABEL: Record<string, string> = { mihuashi: '米画师', weibo: '微博', xiaohongshu: '小红书' };
// 米画师官方标签（其站内筛选只认这些原词，故直接以它为准；对小红书/微博也通用作关键词）。
// 分两个维度：画风 + 类型，与米画师页面上的两个下拉一致。
const MIHUASHI_TAG_ROWS = [
  { label: '画风', tags: ['日系', '平涂', '萌系', '厚涂', '赛璐璐', '古风', '中国风', '童趣', '写实系', '韩系', '少女漫画', '欧美系', '水彩', '美式卡通', '白描', '科幻风', '像素风', '水墨', '硬派'] },
  { label: '类型', tags: ['头像', '插图', 'Q版', '自设/OC', '立绘', '角色设计', '壁纸', '封面', '场景', '海报', '概念设计', '印花', '图标', 'Live2D', 'CG', '和纸胶带', '像素图', '卡牌', '条漫', 'UI', '版型', '分镜', '抱枕', '特效'] },
];
// 全部米画师标签（供 AI 参考图预选时过滤——只预选命中米画师标签的）
const MIHUASHI_ALL_TAGS = new Set(MIHUASHI_TAG_ROWS.flatMap(r => r.tags));
const TIER_LABEL: Record<string, { label: string; cls: string }> = {
  tier1: { label: '待复核', cls: 'text-stone-500 bg-stone-100' },
  tier2: { label: '已复核', cls: 'text-sky-600 bg-sky-50' },
  promoted: { label: '已入库', cls: 'text-emerald-600 bg-emerald-50' },
  rejected: { label: '已丢弃', cls: 'text-stone-400 bg-stone-100 line-through' },
};
const STATUS_BADGE: Record<string, string> = {
  running: 'bg-amber-100 text-amber-700',
  ok: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
};
const STATUS_TEXT: Record<string, string> = { running: '搜索中', ok: '完成', failed: '失败' };

// 多 session 持久化：session 列表(id+标签)存 localStorage，切页面不丢，支持并行多版本寻源
const LS_KEY = 'discover-sessions';
type SessionMeta = { id: number; label: string };
const loadSessions = (): SessionMeta[] => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const saveSessions = (ss: SessionMeta[]) => localStorage.setItem(LS_KEY, JSON.stringify(ss));

export function DiscoverPage() {
  const refsQ = useReferences();
  const upload = useUploadReference();
  const startM = useStartDiscover();
  const abortM = useAbortDiscover();
  const reviewM = useReviewDiscover();
  const promoteM = usePromoteDiscover();
  const rejectM = useRejectDiscover();
  const deleteRef = useDeleteReference();

  const [selectedRef, setSelectedRef] = useState<number | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(['mihuashi']));
  const [sessions, setSessions] = useState<SessionMeta[]>(loadSessions);
  const [activeId, setActiveId] = useState<number | null>(() => { const s = loadSessions(); return s[s.length - 1]?.id ?? null; });
  const [viewResult, setViewResult] = useState<any>(null);
  const [viewIdx, setViewIdx] = useState(0);

  // 并行轮询所有 session 的任务状态（running 的自动刷新，完成的停）
  const sessionQueries = useDiscoverSessions(sessions.map(s => s.id));
  const taskById = new Map<number, any>(sessions.map((s, i) => [s.id, sessionQueries[i]?.data]));
  const activeTask = activeId ? (taskById.get(activeId) ?? null) : null;
  const activeMeta = sessions.find(s => s.id === activeId);
  // ok（正常完成）与 failed（被终止）都可能有结果：终止时保留了已完成部分
  const hasResults = activeTask?.status === 'ok' || activeTask?.status === 'failed';
  const resultsQ = useDiscoverResults(hasResults ? (activeId ?? 0) : 0);
  const historyQ = useDiscoverSessionsList();
  const ref = (refsQ.data ?? []).find(r => r.id === selectedRef);

  // 上传参考图 → AI 建议标签预勾选（只保留命中米画师标签的，避免选到搜不到的词）
  const loadFile = useCallback((f: File | null) => {
    if (!f) return;
    upload.mutate(f, { onSuccess: (r) => {
      setSelectedRef(r.id);
      setSelectedLabels(new Set((r.aiTags ?? []).map(t => t.label).filter(l => l && MIHUASHI_ALL_TAGS.has(l))));
    } });
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

  const toggleLabel = (l: string) => setSelectedLabels(s => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n; });
  const togglePlatform = (k: string) => setPlatforms(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 发起搜索：新建一个 session 加入列表并切过去（不影响已在跑的其它 session，支持并行）
  const doSearch = () => {
    if (!platforms.size) return;
    const labels = [...selectedLabels];
    const tags = labels.map(label => ({ label }));
    startM.mutate({ referenceId: selectedRef, tags, platforms: [...platforms] }, { onSuccess: (r) => {
      const label = labels.length ? labels.join('+') : (selectedRef ? '参考图' : `#${r.sessionId}`);
      setSessions(prev => { const next = [...prev, { id: r.sessionId, label }]; saveSessions(next); return next; });
      setActiveId(r.sessionId);
    } });
  };
  const removeSession = (id: number) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id); saveSessions(next);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };
  // 从历史列表重开一次搜索：加入标签栏并切过去（已在不重复加）
  const reopenSession = (id: number, label: string) => {
    setSessions(prev => {
      if (prev.some(s => s.id === id)) return prev;
      const next = [...prev, { id, label }]; saveSessions(next); return next;
    });
    setActiveId(id);
  };

  const anyRunning = sessions.some(s => taskById.get(s.id)?.status === 'running');
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
        <h2 className="font-semibold text-stone-800 text-[15px] mb-1">发现 · 按画风搜作品</h2>
        <p className="text-xs text-stone-400 mb-3">上传参考图（AI 自动识别画风标签）<b>或</b>直接选画风标签 → 用标签去多平台搜帖子 → AI 质检过滤广告/照片 → 复核入库。可同时发起多个不同标签的搜索（并行寻源）。</p>
        <div className="flex gap-4 flex-wrap">
          {/* 参考图入口 */}
          <div className="shrink-0">
            {ref ? (
              <div className="relative w-28 h-28">
                <img src={ref.imageUrl} className="w-28 h-28 object-cover rounded-xl border-2 border-xhs" alt="参考图" />
                <button onClick={() => setSelectedRef(null)} className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-stone-700 text-white text-sm flex items-center justify-center shadow" title="清除参考图，改用纯标签搜">×</button>
                <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[9px] bg-xhs text-white rounded-full px-2 py-0.5 whitespace-nowrap">AI 识别画风</span>
              </div>
            ) : (
              <div onClick={() => document.getElementById('discover-file')?.click()}
                onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0] ?? null); }}
                className="w-28 h-28 border-2 border-dashed border-stone-200 rounded-xl flex items-center justify-center text-center cursor-pointer hover:border-xhs hover:bg-xhs-soft/30">
                <span className="text-[11px] text-stone-400 px-2 whitespace-pre-line">{upload.isPending ? 'AI识别中…' : '📋 可选\n拖入参考图\nAI建议画风'}</span>
                <input id="discover-file" type="file" accept="image/*" className="hidden" onChange={e => loadFile(e.target.files?.[0] ?? null)} />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            {/* 米画师官方标签（画风 + 类型两组），点击多选可组合 */}
            <div className="text-[12px] text-stone-500 mb-1">画风 / 类型标签（点击多选，可组合{upload.isPending ? '，AI 建议中…' : ref ? '，已按参考图预选' : ''}）</div>
            <div className="space-y-1 max-h-40 overflow-auto pr-1">
              {MIHUASHI_TAG_ROWS.map(row => (
                <div key={row.label} className="flex items-start gap-2">
                  <span className="text-[11px] text-stone-400 w-8 shrink-0 pt-0.5">{row.label}</span>
                  <div className="flex gap-1 flex-wrap">
                    {row.tags.map(t => {
                      const on = selectedLabels.has(t);
                      return <span key={t} onClick={() => toggleLabel(t)}
                        className={`text-[12px] px-2.5 py-0.5 rounded-full cursor-pointer border ${on ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200 hover:border-xhs'}`}>{t}</span>;
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* 平台 + 搜索 */}
            <div className="flex items-center gap-3 flex-wrap mt-3">
              <div className="flex gap-1.5">
                {PLATFORMS.map(p => {
                  const on = platforms.has(p.key);
                  return <span key={p.key} onClick={() => togglePlatform(p.key)}
                    className={`text-[12px] px-2.5 py-1 rounded-full cursor-pointer border ${on ? 'bg-stone-700 text-white border-stone-700' : 'bg-white text-stone-500 border-stone-200'}`}>{p.label}</span>;
                })}
              </div>
              <button onClick={doSearch} disabled={startM.isPending || (!selectedRef && !selectedLabels.size) || !platforms.size}
                className="text-[13px] bg-xhs text-white rounded-full px-5 py-2 font-medium disabled:opacity-40">
                {startM.isPending ? '发起中…' : anyRunning ? '🔍 再发起一个（并行）' : (selectedRef ? '🔍 按识别的画风搜' : '🔍 按标签搜作品')}
              </button>
            </div>
            {/* 米画师限流提示 */}
            <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
              ⚠ 米画师反爬限流：短时间连搜多个标签会被挡（返回0结果）。建议一次搜1-2个标签，两次搜索间隔1-2分钟，别一次性狂搜。
            </div>
          </div>
        </div>
      </div>

      {/* 多 session 标签栏：并行寻源时切换查看不同搜索；切页面回来不丢 */}
      {sessions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-3">
          {sessions.map(s => {
            const t = taskById.get(s.id);
            const st = t?.status || 'running';
            const on = s.id === activeId;
            return (
              <div key={s.id} className={`flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full border cursor-pointer text-[12px] ${on ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-600 border-stone-200 hover:border-xhs'}`} onClick={() => setActiveId(s.id)}>
                <span className="max-w-[180px] truncate">{s.label}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${on ? 'bg-white/25 text-white' : STATUS_BADGE[st] || ''}`}>{STATUS_TEXT[st] || st}{t?.resultCount != null ? ` ${t.resultCount}` : ''}</span>
                <button onClick={e => { e.stopPropagation(); removeSession(s.id); }} className={`w-4 h-4 rounded-full text-[11px] flex items-center justify-center ${on ? 'hover:bg-white/25' : 'hover:bg-stone-100'}`} title="移出列表（不删库）">×</button>
              </div>
            );
          })}
        </div>
      )}

      {/* 进度条（当前 session） */}
      {activeTask && activeTask.status === 'running' && (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex items-center justify-between text-[13px] text-stone-600 mb-2">
            <span>搜索质检中… · {activeMeta?.label}</span>
            <div className="flex items-center gap-3">
              <span className="text-stone-400">{activeTask.done}/{activeTask.total || '…'} 张</span>
              {activeId && (
                <button onClick={() => abortM.mutate(activeId)} disabled={abortM.isPending}
                  className="text-[12px] text-rose-500 border border-rose-300 rounded-full px-3 py-1 hover:bg-rose-50 disabled:opacity-40">⏹ 终止</button>
              )}
            </div>
          </div>
          <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
            <div className="h-full bg-xhs transition-all" style={{ width: activeTask.total ? `${Math.round(activeTask.done / activeTask.total * 100)}%` : '8%' }} />
          </div>
          <div className="text-[11px] text-stone-400 mt-1.5">量大时约需数分钟，可离开稍后回来看结果；可同时再发起别的标签搜索</div>
        </div>
      )}
      {activeTask && activeTask.status === 'failed' && <div className="text-center text-rose-500 text-sm py-6">搜索已终止或失败{results.length ? '（下方为已完成部分的结果）' : ''}</div>}

      {/* 结果（当前 session：正常完成 ok，或被终止 failed 的已完成部分） */}
      {activeTask && hasResults && (results.length > 0 || activeTask.status === 'ok') && (
        <div>
          {/* 漏斗：让"0 结果 / 结果少"能看清卡在哪个环节 */}
          {activeTask.stats && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-400 mb-2 px-1">
              <span>召回 <b className="text-stone-600">{activeTask.stats.recalled}</b></span>
              <span>· 去重后 {activeTask.stats.unique}</span>
              {activeTask.stats.dedup > 0 && <span>· 库内重复 -{activeTask.stats.dedup}</span>}
              {activeTask.stats.downloadFail > 0 && <span>· 下载失败 -{activeTask.stats.downloadFail}</span>}
              {activeTask.stats.notArtwork > 0 && <span>· 非绘画 -{activeTask.stats.notArtwork}</span>}
              {activeTask.stats.lowQuality > 0 && <span>· 低质 -{activeTask.stats.lowQuality}</span>}
              {activeTask.stats.lowSimilarity > 0 && <span>· 画风不符 -{activeTask.stats.lowSimilarity}</span>}
              <span>· 保留 <b className="text-emerald-600">{activeTask.stats.kept}</b></span>
              {activeTask.stats.aiSkipped > 0 && <span className="text-amber-600">⚠ {activeTask.stats.aiSkipped} 张未经 AI 质检（未配置 AI_API_KEY 或调用失败），请人工甄别</span>}
              {activeTask.stats.embedSkipped > 0 && <span className="text-amber-600">⚠ 本次未做视觉精排（CLIP 不可用），仅按质量排序</span>}
            </div>
          )}
          <div className="text-[13px] text-stone-500 mb-2 px-1">{activeTask.mode === 'image' && !activeTask.stats?.embedSkipped ? '按画风相似度×质量排序' : '按质量分排序'} · {results.length} 张（AI 已过滤广告/照片/低质）</div>
          {!results.length && (
            <div className="text-center py-12">
              {activeTask.stats && activeTask.stats.recalled === 0
                ? <div className="text-amber-600 text-sm">⚠ 召回0张——可能被米画师限流了（短时间搜太多）。请等 1-2 分钟再试，别一次性连搜多个标签。</div>
                : activeTask.stats && activeTask.stats.unique > 0
                ? <div className="text-stone-400 text-sm">召回的图都被去重或质检过滤了，试试放宽画风或换平台</div>
                : <div className="text-stone-400 text-sm">没有符合质量的结果，换个画风或平台试试</div>}
            </div>
          )}
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {results.map(r => (
              <div key={r.id} className="mb-2.5 break-inside-avoid bg-white rounded-xl overflow-hidden border border-stone-100 card-hover">
                <div className="relative cursor-zoom-in" onClick={() => { setViewResult(r); setViewIdx(0); }}>
                  <img src={r.imageUrl || ''} referrerPolicy="no-referrer" className="w-full object-cover" style={{ aspectRatio: '3/4' }}
                    onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} alt="" />
                  {r.quality != null
                    ? <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white">质 {r.quality.toFixed(0)}</span>
                    : <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/80 text-white" title="未经 AI 质检，请人工甄别">未检</span>}
                  {r.similarity != null && <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-xhs/80 text-white" title="与参考图的画风相似度">似 {(r.similarity * 100).toFixed(0)}</span>}
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
      {!activeTask && sessions.length === 0 && <div className="text-center text-stone-400 text-sm py-10">选画风标签后点搜索，结果会出现在这里（可并行多个）</div>}

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

      {/* 发现历史列表：从数据库加载全部历史发现搜索，点击重开 */}
      {(historyQ.data ?? []).length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] text-stone-400 mb-1.5">发现历史（点击重开某次搜索）</div>
          <div className="space-y-1.5">
            {(historyQ.data ?? []).map(h => {
              const inTabs = sessions.some(s => s.id === h.id);
              const st = h.status || 'running';
              return (
                <div key={h.id} className={`flex items-center gap-2 border rounded-lg p-2 cursor-pointer transition-colors ${activeId === h.id ? 'border-xhs bg-xhs-soft/30' : 'border-stone-200 hover:border-stone-300'}`} onClick={() => reopenSession(h.id, h.tags?.join('+') || `#${h.id}`)}>
                  <span className="text-[12px] text-stone-700 flex-1 min-w-0 truncate">{h.tags?.join('+') || `#${h.id}`}{h.mode === 'image' ? ' · 参考图' : ''}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${STATUS_BADGE[st] || ''}`}>{STATUS_TEXT[st] || st}</span>
                  <span className="text-[10px] text-stone-400">{h.resultCount} 张</span>
                  <span className="text-[10px] text-stone-300 hidden md:inline">{new Date(h.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  {inTabs && <span className="text-[9px] text-xhs">已在列表</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 历史参考图快捷复用 */}
      {(refsQ.data ?? []).length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] text-stone-400 mb-1.5">历史参考图</div>
          <div className="flex gap-2 flex-wrap">
            {(refsQ.data ?? []).map(r => (
              <div key={r.id} className="relative">
                <button onClick={() => { setSelectedRef(r.id); setSelectedLabels(new Set((r.aiTags ?? []).map(t => t.label).filter(l => MIHUASHI_ALL_TAGS.has(l)))); }}
                  className={`block w-14 h-14 rounded-lg overflow-hidden border-2 ${selectedRef === r.id ? 'border-xhs' : 'border-stone-200'}`}>
                  <img src={r.imageUrl} className="w-full h-full object-cover" alt="" />
                </button>
                <button onClick={() => { if (confirm('删除此参考图？')) { deleteRef.mutate(r.id); if (selectedRef === r.id) setSelectedRef(null); } }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-rose-500 text-white text-xs flex items-center justify-center shadow" title="删除">×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
