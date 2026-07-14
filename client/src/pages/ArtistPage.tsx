import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useArtist, useTags, useArtworks, useTagArtwork, useConfirmArtwork } from '../hooks';
import { FilterBar } from '../components/FilterBar';
import { ArtworkCard } from '../components/ArtworkCard';
import { Viewer } from '../components/Viewer';

const ENGAGE: Record<string, string> = {
  cooperated: '合作', pending: '待定', rejected: '不合作',
  no_availability: '暂无档期', unreachable: '无法建联',
  contacted: '已接触', negotiating: '沟通中',
};
const ENGAGE_CLS: Record<string, string> = {
  cooperated: 'text-xhs bg-xhs-soft', pending: 'text-amber-600 bg-amber-50',
  rejected: 'text-stone-400 bg-stone-100', no_availability: 'text-sky-600 bg-sky-50',
  unreachable: 'text-stone-400 bg-stone-100', contacted: 'text-violet-600 bg-violet-50',
  negotiating: 'text-violet-600 bg-violet-50',
};
const COMMISSION: Record<string, string> = { open: '接稿中', full: '档期满', commercial_only: '仅商稿', unknown: '未知' };

export function ArtistPage() {
  const { id } = useParams();
  const artistId = Number(id);
  const artistQ = useArtist(artistId);
  const tagsQ = useTags();
  const [orient, setOrient] = useState('全部');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewerIdx, setViewerIdx] = useState<number | null>(null);

  const artworksQ = useArtworks({ artistId, tags: [...selected], orient });
  const allQ = useArtworks({ artistId }); // 全量作品，用于高频标签聚合
  const tagM = useTagArtwork();
  const confirmM = useConfirmArtwork();

  // 按维度统计高频标签（画画习惯聚合）
  const tagTree = tagsQ.data ?? [];
  const dimName = new Map<number, string>();
  const rootOf = (dimId: number, tree: any[]): number => {
    for (const t of tree) { if (t.id === dimId) return t.id; for (const c of t.children) if (c.id === dimId) return t.id; }
    return dimId;
  };
  const counts = new Map<number, number>(); // rootDimId/tagId? 用 label
  const byRoot = new Map<string, { label: string; n: number }[]>();
  for (const w of allQ.data ?? []) {
    for (const tg of w.tags) {
      const root = rootOf(tg.dimensionId, tagTree);
      const key = `${root}`;
      const arr = byRoot.get(key) ?? [];
      const ex = arr.find(x => x.label === tg.label);
      if (ex) ex.n++; else arr.push({ label: tg.label, n: 1 });
      byRoot.set(key, arr);
    }
  }
  const rootName = (rid: number) => tagTree.find(t => t.id === rid)?.name || '';
  const habitDims = [...byRoot.entries()]
    .map(([rid, arr]) => ({ name: rootName(Number(rid)), tags: arr.sort((a, b) => b.n - a.n).slice(0, 4) }))
    .filter(d => d.name && d.name !== '画风');
  const toggleTag = (tid: number) => { const s = new Set(selected); s.has(tid) ? s.delete(tid) : s.add(tid); setSelected(s); };
  const clear = () => { setSelected(new Set()); setOrient('全部'); };

  if (artistQ.isLoading) return <div className="text-center text-stone-400 py-16">加载中…</div>;
  if (artistQ.isError || !artistQ.data) return <div className="text-center text-rose-500 py-16">画师不存在</div>;
  const a = artistQ.data;
  const list = artworksQ.data ?? [];
  const total = a.total || 1;
  const habit = a.drawingHabit || {};

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {/* 头部 */}
      <div className="bg-white rounded-2xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center bg-xhs text-white text-2xl font-bold">{a.name.slice(0, 1)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-stone-800">{a.name}</h1>
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${ENGAGE_CLS[a.engageStatus] || ''}`}>{ENGAGE[a.engageStatus] || a.engageStatus}</span>
              <span className="text-[11px] text-stone-500 bg-stone-100 px-2 py-0.5 rounded-full">{COMMISSION[a.commission] || a.commission}</span>
            </div>
            <div className="text-[13px] text-stone-500 mt-0.5">{a.bio}</div>
            <div className="flex items-center gap-4 mt-2 text-[13px]">
              <span><b className="text-stone-800">{a.total}</b> <span className="text-stone-400">作品</span></span>
              <span><b className="text-stone-800">{a.styleDist?.length || 0}</b> <span className="text-stone-400">画风</span></span>
            </div>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap mt-4">
          {['更新频率 ' + (habit.update_frequency || ''), habit.active_time, habit.style_trend, habit.commission_signal].filter(Boolean).map((t, i) => (
            <span key={i} className="text-[11px] text-stone-500 bg-stone-50 px-2 py-1 rounded">{t}</span>
          ))}
        </div>
      </div>

      {/* 画风分布 */}
      <div className="bg-white rounded-2xl p-5 mt-3">
        <h2 className="font-semibold text-stone-800 text-[15px] mb-3">画风分布 <span className="text-xs text-stone-400 font-normal">（点图例筛选）</span></h2>
        <div className="h-7 rounded-full overflow-hidden flex">
          {a.styleDist?.filter(s => s.style !== '未分类').map(s => {
            const pct = (s.count / total * 100).toFixed(1);
            return <div key={s.style} className="h-full flex items-center justify-center text-[10px] text-white font-medium bg-xhs/80" style={{ width: pct + '%', opacity: 0.5 + 0.5 * (s.count / total) }}>{Number(pct) > 12 ? s.style : ''}</div>;
          })}
        </div>
        <div className="flex gap-3 mt-3 flex-wrap">
          {a.styleDist?.map(s => (
            <div key={s.style} className="flex items-center gap-1.5 text-[13px] rounded-lg px-2 py-1">
              <span className="text-stone-700">{s.style}</span>
              <span className="text-stone-400">{s.count}张 · 横{s.h}·竖{s.v}</span>
              {!s.both && s.style !== '未分类' && <span className="text-[10px] text-xhs">缺{s.missingOrient}屏</span>}
            </div>
          ))}
        </div>
      </div>

      {/* 高频标签聚合（画画习惯，从作品统计） */}
      {habitDims.length > 0 && (
        <div className="bg-white rounded-2xl p-5 mt-3">
          <h2 className="font-semibold text-stone-800 text-[15px] mb-3">高频标签 <span className="text-xs text-stone-400 font-normal">（按作品聚合的画画习惯）</span></h2>
          <div className="space-y-2">
            {habitDims.map(d => (
              <div key={d.name} className="flex items-start gap-2">
                <span className="text-[11px] text-stone-400 w-20 shrink-0 pt-1">{d.name}</span>
                <div className="flex gap-1.5 flex-wrap">
                  {d.tags.map(t => (
                    <span key={t.label} className="text-[12px] text-stone-700 bg-stone-100 px-2 py-0.5 rounded-full">{t.label} <span className="text-stone-400">{t.n}</span></span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 筛选 */}
      <div className="mt-3">
        {tagsQ.data && <FilterBar tree={tagsQ.data} orient={orient} setOrient={setOrient} selected={selected} toggleTag={toggleTag} onClear={clear} />}
      </div>

      {/* 作品 */}
      <div className="mt-3">
        <div className="text-[13px] text-stone-500 mb-2 px-1">作品 <b className="text-stone-700">{list.length}</b> 张</div>
        {list.length === 0 ? (
          <div className="text-center text-stone-400 py-16">该画师暂无符合筛选条件的作品</div>
        ) : orient === '全部' ? (
          <div className="space-y-5">
            {[['横', '横屏'], ['竖', '竖屏']].map(([o, label]) => {
              const sub = list.filter(x => x.orientation === o);
              if (!sub.length) return null;
              return (
                <div key={o}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[13px] font-semibold text-stone-700 px-2.5 py-0.5 rounded-full bg-stone-100">{label}</span>
                    <span className="text-[11px] text-stone-400">{sub.length} 张</span>
                  </div>
                  <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
                    {sub.map(x => <ArtworkCard key={x.id} art={x} index={list.indexOf(x)} onOpen={setViewerIdx} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {list.map((x, i) => <ArtworkCard key={x.id} art={x} index={i} onOpen={setViewerIdx} />)}
          </div>
        )}
      </div>

      {viewerIdx != null && (
        <Viewer list={list} index={viewerIdx} onClose={() => setViewerIdx(null)}
          onNav={d => setViewerIdx(v => (v! + d + list.length) % list.length)}
          onTag={(id) => tagM.mutate(id)} onConfirm={(id) => confirmM.mutate(id)} tagging={tagM.isPending} />
      )}
    </div>
  );
}
