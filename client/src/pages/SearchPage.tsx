import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { SearchResult, SearchArtistGroup } from '../api';
import { useReferences, useUploadReference, useUpdateReferenceTags, useStartSearch, useSearchSessions, useSearchResults, useSearchResultsByArtist, useReviewSearchResult, usePromoteSearchResult, useRejectSearchResult, useDeleteReference, useTags } from '../hooks';
import { tagsByTopDim, proxyImg } from '../api';
const BASE = '/api';
const SEARCH_REF_KEY = 'search:ref';
const SEARCH_SESSION_KEY = 'search:session';
const SEARCH_HISTORY_EXPANDED_KEY = 'search:historyExpanded';
const HISTORY_COLLAPSED_COUNT = 3;   // 收起时默认展示的最近搜索条数

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
  // 活动参考图 + session 持久化：切页/刷新后接续后台搜索进程的进度与结果
  const [selectedRef, setSelectedRef] = useState<number | null>(() => {
    const v = localStorage.getItem(SEARCH_REF_KEY); return v ? Number(v) : null;
  });
  const [tagModes, setTagModes] = useState<Record<number, 'must' | 'fuzzy'>>({});
  const [xhsCookie, setXhsCookie] = useState('');
  const [cookieSaved, setCookieSaved] = useState(false);
  const [cookieCheck, setCookieCheck] = useState<{ status: string; error?: string } | null>(null);
  const [cookieProbing, setCookieProbing] = useState(false);
  const refreshCookieCheck = useCallback(() => {
    fetch(BASE + '/settings/xhs-cookie-check').then(res => res.json()).then(setCookieCheck).catch(() => {});
  }, []);
  useEffect(() => { refreshCookieCheck(); }, [cookieSaved, refreshCookieCheck]);
  const probeCookie = () => {
    setCookieProbing(true);
    fetch(BASE + '/settings/xhs-cookie-check?probe=1').then(res => res.json()).then(r => { setCookieCheck(r); setCookieProbing(false); }).catch(() => setCookieProbing(false));
  };
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(['xiaohongshu']));
  const [wideNet, setWideNet] = useState(true); // 约稿广撒网：并行搜约稿身份词最大范围捞画师
  const [activeSession, setActiveSession] = useState<number | null>(() => {
    const v = localStorage.getItem(SEARCH_SESSION_KEY); return v ? Number(v) : null;
  });
  const [viewResult, setViewResult] = useState<any>(null);
  const [viewImgIdx, setViewImgIdx] = useState(0);
  // 米画师同名反查：按画师卡 key 存候选面板状态（按需触发，plain fetch 不进 react-query）
  type MhsHit = { profileId: number; name: string | null; avatarUrl: string | null; profileUrl: string | null; isVerified: boolean; credit: string | null; scheduleState: string | null; inviteOpenDate: string | null; artworks: { mhsId: number; imageUrl: string; likes: number | null }[] };
  const [mhsLookup, setMhsLookup] = useState<Record<string, { loading: boolean; artists: MhsHit[] | null }>>({});
  const doMhsLookup = useCallback((key: string, name: string) => {
    setMhsLookup(prev => (prev[key] && !prev[key].artists ? prev : { ...prev, [key]: { loading: true, artists: null } }));
    fetch(BASE + '/search/mhs-artist-search?name=' + encodeURIComponent(name))
      .then(res => res.json())
      .then((r: { artists: MhsHit[] }) => setMhsLookup(prev => ({ ...prev, [key]: { loading: false, artists: r.artists || [] } })))
      .catch(() => setMhsLookup(prev => ({ ...prev, [key]: { loading: false, artists: [] } })));
  }, []);
  // 搜索历史折叠：默认收起（只显示最近几条），状态持久化
  const [historyExpanded, setHistoryExpanded] = useState(() => localStorage.getItem(SEARCH_HISTORY_EXPANDED_KEY) === '1');
  useEffect(() => { localStorage.setItem(SEARCH_HISTORY_EXPANDED_KEY, historyExpanded ? '1' : '0'); }, [historyExpanded]);

  // 同步到 localStorage（切页恢复用）
  useEffect(() => {
    if (selectedRef) localStorage.setItem(SEARCH_REF_KEY, String(selectedRef)); else localStorage.removeItem(SEARCH_REF_KEY);
  }, [selectedRef]);
  useEffect(() => {
    if (activeSession) localStorage.setItem(SEARCH_SESSION_KEY, String(activeSession)); else localStorage.removeItem(SEARCH_SESSION_KEY);
  }, [activeSession]);

  const startSearchM = useStartSearch();
  const sessionsQ = useSearchSessions(selectedRef ?? 0);
  const refetchSessions = sessionsQ.refetch;
  const sessions = sessionsQ.data ?? [];
  // 进度/运行态从轮询到的 session 派生（取代旧的本地 searching/progress state + 手写 setInterval）
  const activeData = sessions.find(s => s.id === activeSession);
  const running = activeData?.status === 'running';
  const progress: { stage?: string; total?: number; processed?: number; kwDone?: number; kwTotal?: number; authorsFound?: number; artists?: number; aggAuthors?: number; droppedByCap?: number; startTime: string } | null = (activeData?.searchTags as any)?.progress ?? null;
  const busy = running || startSearchM.isPending;
  // 分阶段进度文案：召回(搜帖子)→甄别(判画师)。召回是最慢阶段，必须给反馈不能干等。
  const progressLabel = (() => {
    if (!busy) return '🔍 按标签搜索';
    if (!progress) return '正在启动…';
    if (progress.stage === 'recall') {
      const done = progress.kwDone ?? 0, total = progress.kwTotal ?? 0;
      return `搜索帖子 ${done}/${total} 组关键词${progress.authorsFound ? `（已聚合 ${progress.authorsFound} 位作者）` : ''}`;
    }
    if (progress.stage === 'judge' && (progress.total ?? 0) > 0) {
      const pct = Math.round((progress.processed ?? 0) / progress.total! * 100);
      return `甄别画师 ${progress.processed ?? 0}/${progress.total}（${pct}%）· 已找到 ${progress.artists ?? 0} 位`;
    }
    return '搜索中…';
  })();
  const resultsQ = useSearchResults(activeSession ?? 0, undefined, running);
  const artistsQ = useSearchResultsByArtist(activeSession ?? 0, undefined, running);
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

  // 切换参考图前自动保存当前标签（不丢失）
  const prevRefRef = useRef<number | null>(null);
  const progressRef = useRef<{ processed: number; ts: number } | null>(null);
  // effect 依赖只有 [selectedRef]，闭包里的 tagModes 是上次切换时建立的旧值；
  // 用 ref 持有最新 tagModes，保存旧图标签时读 ref，避免存进过期的标签集合。
  const tagModesRef = useRef(tagModes);
  tagModesRef.current = tagModes;
  useEffect(() => {
    // 切换走之前，把当前标签存到旧参考图
    if (prevRefRef.current !== null && prevRefRef.current !== selectedRef) {
      const prevRef = (refsQ.data ?? []).find(r => r.id === prevRefRef.current);
      if (prevRef) {
        const allTags: { id: number; label: string; dimensionId: number }[] = [];
        for (const top of (tagsQ.data ?? [])) {
          for (const t of top.tags) allTags.push({ id: t.id, label: t.label, dimensionId: top.id });
          for (const sub of top.children) for (const t of sub.tags) allTags.push({ id: t.id, label: t.label, dimensionId: sub.id });
        }
        const manualTags = Object.keys(tagModesRef.current).map(id => {
          const t = allTags.find(a => a.id === Number(id));
          return { tagId: Number(id), label: t?.label ?? '', dimensionId: t?.dimensionId ?? null };
        });
        fetch(BASE + '/reference/' + prevRefRef.current + '/tags', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualTags }),
        });
      }
    }
    prevRefRef.current = selectedRef;

    // 加载新参考图的标签
    if (ref) {
      const modes: Record<number, 'must' | 'fuzzy'> = {};
      (ref.manualTags ?? ref.aiTags ?? []).forEach(t => { modes[t.tagId] = 'fuzzy'; });
      setTagModes(modes);
    }
  }, [selectedRef]);

  // 从其他参考图导入标签（合并）
  const [showMerge, setShowMerge] = useState(false);
  const mergeTags = (fromRefId: number) => {
    const fromRef = (refsQ.data ?? []).find(r => r.id === fromRefId);
    if (!fromRef) return;
    const m = { ...tagModes };
    (fromRef.aiTags ?? []).forEach(t => { if (!m[t.tagId]) m[t.tagId] = 'fuzzy'; });
    setTagModes(m);
    setShowMerge(false);
  };

  // 单击三态循环：未选 → 模糊 → 必中 → 未选
  const cycleTag = (id: number) => {
    const m = { ...tagModes };
    const cur = m[id];
    if (!cur) m[id] = 'fuzzy';
    else if (cur === 'fuzzy') m[id] = 'must';
    else delete m[id];
    setTagModes(m);
  };
  const selectedIds = Object.keys(tagModes).map(Number);
  const togglePlatform = (k: string) => setPlatforms(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); if (!n.size) n.add(k); return n; });
  const PLATFORM_OPTS = [{ key: 'xiaohongshu', label: '小红书' }];
  const saveTags = () => { if (selectedRef) updateTags.mutate({ id: selectedRef, manualTags: selectedIds.map(id => { const t = (ref?.aiTags ?? []).find(a => a.tagId === id); return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null }; }) }); };

  const doSearch = async () => {
    // cookie 预检：失效/缺登录态直接提示，不白跑（item 5）
    const cs = cookieCheck?.status;
    if (cs === 'missing' || cs === 'no_session' || cs === 'expired') {
      alert(cs === 'missing' ? '小红书 cookie 未设置，请先在上方粘贴或扫码登录。' : cs === 'expired' ? '小红书 cookie 已失效，请重新获取（F12 → Network → Cookie）或扫码登录。' : 'cookie 缺少 web_session 登录态，请重新粘贴完整 cookie 或扫码登录。');
      return;
    }
    // 参考图可选：无图纯标签搜也允许（referenceId 传 0，后端归一为无图会话）
    // 从 tag tree 查 label（不依赖 aiTags，避免乱码/空）
    const allTags: { id: number; label: string; dimensionId: number }[] = [];
    for (const top of (tagsQ.data ?? [])) {
      for (const t of top.tags) allTags.push({ id: t.id, label: t.label, dimensionId: top.id });
      for (const sub of top.children) {
        for (const t of sub.tags) allTags.push({ id: t.id, label: t.label, dimensionId: sub.id });
      }
    }
    const tags = selectedIds.map(id => {
      const t = allTags.find(a => a.id === id);
      return { tagId: id, label: t?.label ?? '', dimensionId: t?.dimensionId ?? null, mode: tagModes[id] };
    });
    // 空标签兜底：所有维度标签都当搜索词。一个标签都没选、又没开广撒网 → 搜不出东西，
    // 提示而非静默搜"插画"（开了广撒网则用约稿身份词，允许无标签）。
    if (!tags.length && !wideNet) {
      alert('未选择任何标签。请至少选一个标签（画风/技法/题材/用途/色调/人物均可作搜索词），或开启「约稿广撒网」用约稿词捞画师。');
      return;
    }
    // 只记录 activeSession，进度/结果轮询由 useSearchSessions / useSearchResults 的 refetchInterval 接管
    // （切页/刷新也能接续，不再依赖组件内的 setInterval）
    startSearchM.mutate({ referenceId: selectedRef ?? 0, tags, platforms: [...platforms], wideNet }, {
      onSuccess: (r) => { setActiveSession(r.sessionId); refetchSessions(); },
    });
  };
  // 继续搜索更多：往已有 session 加结果（不新建记录），用非 genre 标签做关键词
  const doContinueSearch = async () => {
    if (!activeSession) return;
    fetch(BASE + '/search/continue/' + activeSession, { method: 'POST' })
      .then(r => r.json())
      .then(() => { refetchSessions(); })
      .catch(() => {});
  };

  const results = resultsQ.data ?? [];
  const artistGroups: SearchArtistGroup[] = artistsQ.data ?? [];
  // 排序/筛选（item 1）：画师多了要能挑
  const [sortBy, setSortBy] = useState<'default' | 'artRatio' | 'count' | 'styleTags'>('default');
  const [filterText, setFilterText] = useState('');
  const shownGroups = useMemo(() => {
    let gs = artistGroups;
    const q = filterText.trim().toLowerCase();
    if (q) gs = gs.filter(g => (g.author || '').toLowerCase().includes(q) || (g.style || '').toLowerCase().includes(q) || g.styleTags.some(t => t.toLowerCase().includes(q)));
    if (sortBy === 'artRatio') gs = [...gs].sort((a, b) => (b.artRatio ?? 0) - (a.artRatio ?? 0));
    else if (sortBy === 'count') gs = [...gs].sort((a, b) => b.count - a.count);
    else if (sortBy === 'styleTags') gs = [...gs].sort((a, b) => b.styleTags.length - a.styleTags.length);
    return gs;
  }, [artistGroups, sortBy, filterText]);

  const saveCookie = () => {
    if (!xhsCookie.trim()) return;
    fetch(BASE + '/settings/xhs-cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: xhsCookie.trim() }) })
      .then(() => { setCookieSaved(true); setXhsCookie(''); setTimeout(() => setCookieSaved(false), 2000); });
  };
  const [qrLogin, setQrLogin] = useState<{ pending: boolean; msg: string }>({ pending: false, msg: '' });
  const qrLoginXhs = () => {
    setQrLogin({ pending: true, msg: '请在弹出的浏览器窗口中扫码登录小红书…' });
    fetch(BASE + '/settings/xhs-login', { method: 'POST' })
      .then(r => r.json())
      .then(r => {
        if (r.success) { setQrLogin({ pending: false, msg: '✓ 登录成功，cookie已保存' }); setCookieSaved(true); setTimeout(() => setCookieSaved(false), 2000); }
        else { setQrLogin({ pending: false, msg: '✗ ' + (r.error || '登录失败') }); }
      })
      .catch(() => setQrLogin({ pending: false, msg: '✗ 请求失败，请重试' }));
  };

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {/* 小红书 Cookie 管理 */}
      <div className="bg-white rounded-2xl p-3 border border-stone-100 mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-stone-500 shrink-0">🔑 小红书 Cookie：</span>
        {(() => {
          const s = cookieCheck?.status;
          const map: Record<string, { txt: string; cls: string }> = {
            missing: { txt: '未设置（搜索无结果）', cls: 'text-rose-500 bg-rose-50' },
            no_session: { txt: '缺少登录态 web_session', cls: 'text-rose-500 bg-rose-50' },
            expired: { txt: '已失效，请更新', cls: 'text-rose-500 bg-rose-50' },
            ok: { txt: '已设置（未验证）', cls: 'text-emerald-600 bg-emerald-50' },
            error: { txt: '检测失败', cls: 'text-amber-600 bg-amber-50' },
          };
          const m = map[s || ''] || { txt: '检测中…', cls: 'text-stone-400 bg-stone-50' };
          return <span className={`text-[11px] px-2 py-0.5 rounded-full ${m.cls}`}>{m.txt}</span>;
        })()}
        <button onClick={probeCookie} disabled={cookieProbing} className="text-[11px] text-stone-500 border border-stone-200 rounded-full px-2 py-0.5 hover:bg-stone-50 disabled:opacity-40">{cookieProbing ? '测试中…' : '🧪 测试'}</button>
        <input value={xhsCookie} onChange={e => setXhsCookie(e.target.value)} placeholder="粘贴小红书 cookie（F12 → Network → Cookie 请求头）" className="flex-1 min-w-[200px] text-[12px] border border-stone-200 rounded-full px-3 py-1.5" />
        <button onClick={saveCookie} disabled={!xhsCookie.trim()} className="text-[12px] bg-xhs text-white rounded-full px-3 py-1.5 font-medium disabled:opacity-40">{cookieSaved ? '✓ 已保存' : '保存'}</button>
        <button onClick={qrLoginXhs} disabled={qrLogin.pending} className="text-[12px] bg-violet-600 text-white rounded-full px-3 py-1.5 font-medium disabled:opacity-40">{qrLogin.pending ? '等待扫码…' : '📱 扫码登录'}</button>
        {qrLogin.msg && <span className={`text-[11px] ${qrLogin.pending ? 'text-violet-600' : qrLogin.msg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-500'}`}>{qrLogin.msg}</span>}
      </div>

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

      {/* 标签选择 + 搜索：常驻可用。参考图可选（选中则显示缩略图 + 自动预填标签）。 */}
      {(
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex gap-4">
            {ref && <img src={ref.imageUrl} className="w-32 h-32 object-cover rounded-xl shrink-0" alt="参考图" />}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-sm font-medium text-stone-700">{ref ? 'AI 画风标签' : '画风标签'}</div>
                {selectedIds.length > 0 && (
                  <button onClick={() => setTagModes({})} className="text-[11px] text-stone-400 hover:text-rose-500 transition-colors">✕ 清除全部（{selectedIds.length}）</button>
                )}
              </div>
              {/* 图例：所有维度标签都作搜索词；必中/模糊决定用哪些词搜 */}
              <div className="flex items-center gap-3 mb-2 text-[11px] text-stone-500 flex-wrap">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-xhs inline-block"></span>必中：只用这些词搜（更聚焦）</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-100 border border-amber-300 inline-block"></span>模糊：没有必中词时才用它搜</span>
                <span className="text-stone-400">各维度标签均作搜索词 · 单击切换：未选 → 模糊 → 必中 → 未选</span>
              </div>
              <div className="space-y-2 max-h-44 overflow-auto pr-1">
                {DIM_ROWS.map(row => {
                  const tags = byDim.get(row.code)?.tags ?? [];
                  if (!tags.length) return null;
                  return (
                    <div key={row.code} className="flex items-start gap-2">
                      <span className="text-[11px] text-stone-400 w-10 shrink-0 pt-1">{row.label}</span>
                      <div className="flex gap-1.5 flex-wrap">
                        {tags.map(t => {
                          const mode = tagModes[t.id];
                          const cls = !mode
                            ? 'bg-white text-stone-500 border-stone-200 hover:border-stone-300'
                            : mode === 'must'
                              ? 'bg-xhs text-white border-xhs'
                              : 'bg-amber-100 text-amber-700 border-amber-300';
                          const tip = !mode ? '点击选中为模糊' : mode === 'fuzzy' ? '点击切换为必中' : '点击取消';
                          return (
                            <span key={t.id} onClick={() => cycleTag(t.id)} title={tip}
                              className={`text-[12px] px-2.5 py-1 rounded-full cursor-pointer border transition-colors select-none ${cls}`}>
                              {t.label}{mode && <span className="text-[9px] ml-0.5 opacity-80">{mode === 'must' ? '·必中' : '·模糊'}</span>}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* 平台选择 */}
              <div className="flex items-center gap-2 mt-2 text-[11px] text-stone-500">
                <span>采集平台：</span>
                {PLATFORM_OPTS.map(p => {
                  const on = platforms.has(p.key);
                  return <span key={p.key} onClick={() => togglePlatform(p.key)}
                    className={`px-2.5 py-0.5 rounded-full cursor-pointer border ${on ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200'}`}>{p.label}</span>;
                })}
              </div>
              {/* 约稿广撒网：并行搜"约稿/接稿/原画师…"身份词，最大范围捞画师（甲方/路人靠判画师号剔除） */}
              <div className="flex items-center gap-2 mt-2 text-[11px] text-stone-500">
                <span onClick={() => setWideNet(v => !v)}
                  className={`px-2.5 py-0.5 rounded-full cursor-pointer border ${wideNet ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200'}`}>🎯 约稿广撒网 {wideNet ? '开' : '关'}</span>
                <span className="text-stone-400">额外搜约稿/接稿/原画师等身份词，捞出更多画师</span>
              </div>
              <div className="flex gap-2 mt-2 flex-wrap items-center">
                <button onClick={doSearch} disabled={busy}
                  className="text-[12px] bg-xhs text-white rounded-full px-4 py-1.5 font-medium disabled:opacity-50">
                  {progressLabel}
                </button>
                {running && progress?.stage === 'judge' && (progress.total ?? 0) > 0 && (() => {
                  const total = progress.total!, processed = progress.processed ?? 0;
                  const now = Date.now();
                  const prev = progressRef.current;
                  let etaStr = '';
                  // 只在 processed 变化时更新 ref（否则时间戳刷新但进度没动，速度算出来是0）
                  if (!prev || prev.processed !== processed) {
                    if (prev && prev.processed < processed && now > prev.ts) {
                      const recentSpeed = (processed - prev.processed) / ((now - prev.ts) / 1000);
                      if (recentSpeed > 0) {
                        const remaining = Math.round((total - processed) / recentSpeed);
                        etaStr = remaining > 60 ? `~${Math.ceil(remaining / 60)}分钟` : `~${remaining}秒`;
                      }
                    }
                    progressRef.current = { processed, ts: now };
                  }
                  // 兜底：processed >= 3 但没有最近速度时，用总平均（至少有数字）
                  if (!etaStr && processed >= 3) {
                    const elapsed = (now - new Date(progress.startTime).getTime()) / 1000;
                    const avgSpeed = processed / elapsed;
                    if (avgSpeed > 0) {
                      const remaining = Math.round((total - processed) / avgSpeed);
                      etaStr = remaining > 60 ? `~${Math.ceil(remaining / 60)}分钟` : `~${remaining}秒`;
                    }
                  }
                  return etaStr ? <span className="text-[11px] text-stone-500">剩余 {etaStr}</span> : null;
                })()}
                {running && activeSession && (
                  <button onClick={() => {
                    fetch(BASE + '/search/abort/' + activeSession, { method: 'POST' }).then(() => refetchSessions());
                  }} className="text-[12px] text-rose-500 border border-rose-300 rounded-full px-3 py-1.5 hover:bg-rose-50">⏹ 终止</button>
                )}
                {!running && activeData && (activeData.searchTags as any)?.tags?.length > 0 && (
                  <button onClick={doContinueSearch} disabled={startSearchM.isPending}
                    title="用同样的标签接着往下反查「本次因数量上限没查到的候选作者」，结果追加到当前这次搜索里（不新建记录、已查过的作者自动跳过）。适合还有较多未反查作者、想再多挖一批画师时用。"
                    className="text-[12px] bg-violet-600 text-white rounded-full px-3 py-1.5 font-medium disabled:opacity-40">
                    {startSearchM.isPending ? '发起中…' : `🔍 继续搜索更多${(progress?.droppedByCap ?? 0) > 0 ? `（还有 ${progress!.droppedByCap} 位未查）` : ''}`}
                  </button>
                )}
                {(refsQ.data ?? []).length > 1 && (
                  <button onClick={() => setShowMerge(!showMerge)}
                    className="text-[12px] text-stone-500 border border-stone-200 rounded-full px-3 py-1.5 hover:bg-stone-50">📎 从其他参考图导入标签</button>
                )}
              </div>
              {/* 继续搜索含义提示：常驻小字，不用 hover 也能看懂 */}
              {!running && activeData && (activeData.searchTags as any)?.tags?.length > 0 && (
                <div className="text-[11px] text-stone-400 mt-1.5">
                  💡「继续搜索更多」= 用相同标签接着反查本次没查完的候选作者，结果追加到这次搜索（不新建记录、已查过的自动跳过）。
                  {(progress?.droppedByCap ?? 0) > 0
                    ? <span className="text-amber-600">本次还有 {progress!.droppedByCap} 位候选作者未反查，可继续挖。</span>
                    : <span>本次候选已基本查完，继续搜索新增有限。</span>}
                </div>
              )}
              {showMerge && (
                <div className="flex gap-2 mt-2 flex-wrap items-center">
                  <span className="text-[11px] text-stone-400">选择要导入标签的参考图（合并到当前）：</span>
                  {(refsQ.data ?? []).filter(r => r.id !== selectedRef).map(r => (
                    <button key={r.id} onClick={() => mergeTags(r.id)}
                      className="flex items-center gap-1.5 text-[11px] border border-stone-200 rounded-full px-2 py-1 hover:border-xhs">
                      <img src={r.imageUrl} className="w-6 h-6 rounded object-cover" alt="" />
                      <span>{(r.aiTags ?? []).length} 标签</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 搜索历史（session 文件夹，区分管理）。无图会话 referenceId 传 0。可折叠：默认只显示最近几条。 */}
      {sessions.length > 0 && (() => {
        const canCollapse = sessions.length > HISTORY_COLLAPSED_COUNT;
        // 收起时只展示最近 N 条；若当前查看的 session 不在其中，也把它带上（否则看不到自己在看哪次）
        let shown = sessions;
        if (canCollapse && !historyExpanded) {
          shown = sessions.slice(0, HISTORY_COLLAPSED_COUNT);
          if (activeSession && !shown.some(s => s.id === activeSession)) {
            const act = sessions.find(s => s.id === activeSession);
            if (act) shown = [...shown, act];
          }
        }
        const hiddenCount = sessions.length - shown.length;
        return (
        <div className="bg-white rounded-2xl p-4 border border-stone-100 mb-3">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => canCollapse && setHistoryExpanded(v => !v)}
              className={`flex items-center gap-1.5 ${canCollapse ? 'cursor-pointer hover:text-xhs' : 'cursor-default'}`}>
              {canCollapse && <span className="text-stone-400 text-[11px] transition-transform">{historyExpanded ? '▾' : '▸'}</span>}
              <h3 className="font-semibold text-stone-700 text-[14px]">搜索历史（{sessions.length} 次，不覆盖）</h3>
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-stone-400">每次搜索独立保留，标新增</span>
              <button onClick={() => { if (confirm('清空所有搜索历史及其结果？')) { fetch(BASE + '/search/sessions-all?referenceId=' + (selectedRef ?? 0), { method: 'DELETE' }).then(() => { refetchSessions(); setActiveSession(null); }); } }}
                className="text-[11px] text-rose-500 border border-rose-200 rounded-full px-2 py-0.5 hover:bg-rose-50">清空全部</button>
            </div>
          </div>
          <div className="space-y-2">
            {shown.map((s) => {
              const i = sessions.findIndex(x => x.id === s.id);   // 全量列表里的真实序号，保证编号正确
              const rawTags = (s.searchTags as any)?.tags ?? s.searchTags ?? [];
              const sessionName = (s.searchTags as any)?.name;
              // 兼容两种历史结构：寻源写 [{label,mode,...}]，发现写 ["日系",...]（同表 source 混存的遗留）
              const tagItems: { label: string; mode?: string }[] = Array.isArray(rawTags)
                ? rawTags.map((t: any) => typeof t === 'string' ? { label: t } : { label: t?.label, mode: t?.mode }).filter((t: any) => t.label)
                : [];
              const ratio = (s.searchTags as any)?.fuzzyRatio;
              return (
                <div key={s.id} className={`border rounded-lg p-3 cursor-pointer transition-colors relative group ${activeSession === s.id ? 'border-xhs bg-xhs-soft/30' : 'border-stone-200 hover:border-stone-300'}`}
                  onClick={() => setActiveSession(s.id)}>
                  <button onClick={(e) => { e.stopPropagation(); if (confirm(`删除本次搜索记录？\n将删除：搜索记录 + ${s.resultCount} 张结果 + 已下载的图片文件\n已入库的作品不会被删除。`)) { fetch(BASE + '/search/sessions/' + s.id, { method: 'DELETE' }).then(() => { refetchSessions(); if (activeSession === s.id) setActiveSession(null); }); } }}
                    className="absolute top-2 right-2 w-5 h-5 rounded-full bg-rose-100 text-rose-500 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10" title="删除此搜索">×</button>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-stone-700">{sessionName || `第 ${sessions.length - i} 次搜索`}</span>
                      <button onClick={(e) => { e.stopPropagation(); const name = prompt('给这次搜索起个名字：', sessionName || `第 ${sessions.length - i} 次搜索`); if (name !== null) { fetch(BASE + '/search/sessions/' + s.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(() => refetchSessions()); } }}
                        className="text-[10px] text-stone-400 hover:text-xhs cursor-pointer" title="重命名">✏重命名</button>
                      <span className="text-[10px] text-stone-400">{s.status === 'running' ? '⏳进行中' : s.status === 'failed' ? '⚠已终止' : new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      {s.newCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-xhs text-white">{s.newCount} 新增</span>}
                    </div>
                    <span className="text-[12px] text-stone-500">{s.resultCount} 张结果</span>
                  </div>
                  <div className="flex gap-1 flex-wrap mt-1.5">
                    {tagItems.map((t, j: number) => (
                      <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded ${t.mode === 'must' ? 'bg-xhs/10 text-xhs' : 'bg-amber-100 text-amber-700'}`}>{t.label}{t.mode === 'must' ? '' : '·模'}</span>
                    ))}
                    {ratio != null && <span className="text-[10px] text-stone-400">模糊比例 {Math.round(ratio * 100)}%</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {canCollapse && (
            <button onClick={() => setHistoryExpanded(v => !v)}
              className="w-full mt-2 text-[12px] text-stone-500 hover:text-xhs py-1.5 rounded-lg hover:bg-stone-50 transition-colors">
              {historyExpanded ? '收起 ▴' : `展开全部 ${sessions.length} 次${hiddenCount > 0 ? `（还有 ${hiddenCount} 次）` : ''} ▾`}
            </button>
          )}
        </div>
        );
      })()}

      {/* 搜索结果：按画师聚合（寻源目标是找画师建联，不是攒作品） */}
      {activeSession && artistGroups.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 px-1 gap-2 flex-wrap">
            <div className="text-[13px] text-stone-500">
              找到 <span className="text-xhs font-medium">{artistGroups.length}</span> 位画师（共 {results.length} 张代表作）{filterText.trim() && <span className="text-stone-400">· 筛选后 {shownGroups.length}</span>}
              {(progress?.aggAuthors ?? 0) > 0 && (
                <span className="text-stone-400">
                  {' '}· 本次共聚合 {progress!.aggAuthors} 位候选作者、反查 {progress!.total ?? 0} 位
                  {(progress?.droppedByCap ?? 0) > 0 && <span className="text-amber-600">，还有 {progress!.droppedByCap} 位未反查</span>}
                </span>
              )}
            </div>
            {/* 排序/筛选（item 1） */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <input value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="筛选画师名/画风…" className="w-36 text-[11px] border border-stone-200 rounded-full px-2.5 py-1" />
              {([['default', '默认'], ['artRatio', '画作占比'], ['count', '代表作数'], ['styleTags', '命中标签']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setSortBy(k)} className={`px-2 py-1 rounded-full border ${sortBy === k ? 'bg-xhs text-white border-xhs' : 'bg-white text-stone-500 border-stone-200'}`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5">
            {shownGroups.map((g, gi) => (
              <div key={g.authorUrl || g.author || gi} className="bg-white rounded-xl border border-stone-100 p-3 card-hover">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-[13px] font-semibold text-stone-700">{g.author || '未知作者'}</span>
                  {g.alreadyInLibrary && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700" title="该画师已在画师库中（跨搜索去重）">已在库</span>}
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-xhs-soft text-xhs">{g.count} 张代表作</span>
                  {g.artRatio != null && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600">画作占比 {Math.round(g.artRatio * 100)}%</span>}
                  {g.style && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">画风：{g.style}</span>}
                  {g.authorUrl && <a href={g.authorUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-600 hover:underline">主页 ↗</a>}
                  {g.styleTags.length > 0 && <span className="text-[10px] text-stone-400">命中：{g.styleTags.slice(0, 6).join(' / ')}</span>}
                  {/* 米画师同名反查：小红书画师才有意义（米画师卡本身不查），用昵称去米画师搜同名账号供人工对图确认 */}
                  {g.author && g.platform !== 'mihuashi' && (() => {
                    const key = g.authorUrl || g.author || String(gi);
                    const st = mhsLookup[key];
                    return (
                      <button onClick={() => doMhsLookup(key, g.author!)} disabled={st?.loading}
                        className="text-[11px] text-orange-600 border border-orange-300/60 rounded-full px-2.5 py-0.5 hover:bg-orange-50 disabled:opacity-40"
                        title="用小红书昵称去米画师搜同名画师账号（撞名≠同一人，请对图确认）">
                        {st?.loading ? '查询中…' : '🔍 查米画师同名'}
                      </button>
                    );
                  })()}
                  {/* 两步入库：① 复核 tier1→tier2（人工挑选满意的画师）② 入库建联 tier2→promoted（建画师记录+存主页链接）。
                      按画师整组的状态显示对应按钮，避免对同一行并发 review+promote。
                      入库串行（mutateAsync 逐个 await）：同画师多张代表作若并发 promote，会同时 findOrCreateArtist
                      查不到→各自插入→产生 N 个同名重复画师。串行后第一张建好画师，其余复用。 */}
                  {(() => {
                    const t1 = g.results.filter(r => r.tier === 'tier1');
                    const t2 = g.results.filter(r => r.tier === 'tier2');
                    const runSerial = async (rows: typeof g.results, m: typeof promoteM) => {
                      for (const r of rows) { try { await m.mutateAsync(r.id); } catch { /* 单张失败不阻断其余 */ } }
                    };
                    if (t1.length > 0) return (
                      <div className="ml-auto flex items-center gap-1.5">
                        <button onClick={() => runSerial(t1, rejectM)}
                          className="text-[11px] text-stone-400 border border-stone-200 rounded-full px-2.5 py-0.5 hover:bg-stone-50">丢弃</button>
                        <button onClick={() => runSerial(t1, reviewM)}
                          className="text-[11px] text-sky-600 border border-sky-300/60 rounded-full px-2.5 py-0.5 hover:bg-sky-50">复核</button>
                      </div>
                    );
                    if (t2.length > 0) return (
                      <button onClick={() => runSerial(t2, promoteM)}
                        className="ml-auto text-[11px] text-xhs border border-xhs/30 rounded-full px-2.5 py-0.5 hover:bg-xhs-soft">入库建联</button>
                    );
                    // 无待处理项：区分「已入库」与「全部丢弃」——不能一律当已入库
                    if (g.results.some(r => r.tier === 'promoted')) return <span className="ml-auto text-[11px] text-emerald-600">✓ 已入库</span>;
                    return <span className="ml-auto text-[11px] text-stone-400">已丢弃</span>;
                  })()}
                </div>
                {(() => {
                  const COMM: Record<string, string> = { open: '🟢 可约', full: '🔴 档期满', commercial_only: '💼 仅商稿' };
                  const c = g.contact || {};
                  const hasContact = c.wechat || c.qq || c.email;
                  const commLabel = g.commission && g.commission !== 'unknown' ? COMM[g.commission] : null;
                  if (!hasContact && !commLabel && !g.bio) return null;
                  return (
                    <div className="flex items-center gap-2 flex-wrap mb-2 text-[11px]">
                      {commLabel && <span className="px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-600">{commLabel}</span>}
                      {c.wechat && <span className="px-1.5 py-0.5 rounded-full bg-green-50 text-green-700" title="微信">微信 {c.wechat}</span>}
                      {c.qq && <span className="px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700" title="QQ">QQ {c.qq}</span>}
                      {c.email && <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700" title="邮箱">✉ {c.email}</span>}
                      {g.bio && <span className="text-stone-400 truncate max-w-[420px]" title={g.bio}>简介：{g.bio}</span>}
                    </div>
                  );
                })()}
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {g.results.map(r => (
                    <div key={r.id} className="relative shrink-0 cursor-pointer" onClick={() => { setViewResult(r); const cover = r.imageUrl || ''; const list: string[] = (r as any).allImages?.length ? (r as any).allImages : (cover ? [cover] : []); const idx = list.indexOf(cover); setViewImgIdx(idx >= 0 ? idx : 0); }}>
                      <img src={proxyImg(r.imageUrl)} className="h-28 rounded-lg object-cover border border-stone-100" style={{ maxWidth: 160 }} alt="" onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} />
                      {r.tier === 'promoted' && <span className="absolute top-1 right-1 text-[10px] px-1 rounded bg-emerald-500 text-white">✓</span>}
                      {r.tier === 'tier2' && <span className="absolute top-1 right-1 text-[9px] px-1 rounded bg-sky-500 text-white">复核</span>}
                      {r.tier === 'rejected' && <span className="absolute top-1 right-1 text-[9px] px-1 rounded bg-stone-400 text-white">弃</span>}
                    </div>
                  ))}
                </div>
                {/* 米画师同名候选面板：查过才显示。样图与上方小红书代表作对图确认是不是同一人 */}
                {(() => {
                  const key = g.authorUrl || g.author || String(gi);
                  const st = mhsLookup[key];
                  if (!st || st.loading || st.artists === null) return null;
                  if (!st.artists.length) return (
                    <div className="mt-2 pt-2 border-t border-dashed border-orange-200 text-[11px] text-stone-400">米画师未搜到「{g.author}」的同名画师</div>
                  );
                  return (
                    <div className="mt-2 pt-2 border-t border-dashed border-orange-200 space-y-2">
                      <div className="text-[11px] text-orange-600 font-medium">米画师同名候选 {st.artists.length} 位（对图确认是否同一人 · 撞名不代表同人）</div>
                      {st.artists.map(a => (
                        <div key={a.profileId} className="flex gap-2 items-start bg-orange-50/40 rounded-lg p-2">
                          {a.avatarUrl && <img src={proxyImg(a.avatarUrl)} className="w-9 h-9 rounded-full object-cover shrink-0 border border-orange-100" alt="" onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} />}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                              <span className="font-semibold text-stone-700 truncate max-w-[160px]">{a.name || '未命名'}</span>
                              {a.isVerified && <span className="px-1 rounded bg-sky-100 text-sky-600 text-[10px]">已认证</span>}
                              {a.credit && <span className="text-stone-500">{a.credit}</span>}
                              {a.inviteOpenDate ? <span className="text-emerald-600">下次开约 {String(a.inviteOpenDate).slice(0, 10)}</span> : a.scheduleState && a.scheduleState !== 'unset' && <span className="text-stone-400">档期 {a.scheduleState}</span>}
                              {a.profileUrl && <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">主页 ↗</a>}
                            </div>
                            {a.artworks.length > 0 && (
                              <div className="flex gap-1.5 overflow-x-auto mt-1.5 pb-1">
                                {a.artworks.map(w => (
                                  <img key={w.mhsId} src={proxyImg(w.imageUrl)} className="h-20 rounded object-cover border border-orange-100 shrink-0" style={{ maxWidth: 120 }} alt="" onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} />
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}
      {activeSession && !running && !artistGroups.length && <div className="text-center text-stone-400 py-12">该搜索未找到画师</div>}
      {!activeSession && sessions.length > 0 && <div className="text-center text-stone-400 py-8">选择上方搜索历史查看结果</div>}
      {/* 大图查看器（一帖多图翻页） */}
      {viewResult && (() => {
        const rawAll: string[] = viewResult.allImages || [];
        // 封面(imageUrl)必须在列表里且作为打开默认图，避免"封面≠大图"。旧数据 allImages 是外链不含本地封面 → 前置封面。
        const allImgs: string[] = rawAll.includes(viewResult.imageUrl) ? rawAll : (viewResult.imageUrl ? [viewResult.imageUrl, ...rawAll] : rawAll);
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
                  <img src={proxyImg(img)} className="max-h-[72vh] max-w-full rounded-xl object-contain shadow-2xl" alt="" />
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
