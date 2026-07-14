import { useState } from 'react';
import { useTags, useArtworks, useTagArtwork, useTagBatch, useConfirmArtwork, useDeleteArtwork, useSetArtworkTags } from '../hooks';
import { FilterBar } from '../components/FilterBar';
import { ArtworkCard } from '../components/ArtworkCard';
import { Viewer } from '../components/Viewer';

export function GalleryPage({ kw = '', setKw }: { kw?: string; setKw?: (s: string) => void }) {
  const tagsQ = useTags();
  const [orient, setOrient] = useState('全部');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewerIdx, setViewerIdx] = useState<number | null>(null);

  const artworksQ = useArtworks({ tags: [...selected], orient, kw });
  const tagM = useTagArtwork();
  const batchM = useTagBatch();
  const confirmM = useConfirmArtwork();
  const delM = useDeleteArtwork();
  const setTagsM = useSetArtworkTags();

  const toggleTag = (id: number) => {
    const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s);
  };
  const clear = () => { setSelected(new Set()); setOrient('全部'); };

  const list = artworksQ.data ?? [];

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {setKw && (
        <input value={kw} onChange={e => setKw(e.target.value)} placeholder="🔍 搜标题 / 画风 / 画师"
          className="md:hidden w-full mb-2.5 bg-stone-100 rounded-full px-4 py-2 text-sm outline-none" />
      )}
      <div className="mb-2.5 sticky top-14 z-20">
        {tagsQ.data && (
          <FilterBar tree={tagsQ.data} orient={orient} setOrient={setOrient} selected={selected} toggleTag={toggleTag} onClear={clear} />
        )}
      </div>

      <div className="flex items-center justify-between mb-2.5 px-1">
        <span className="text-[13px] text-stone-500">共 <b className="text-stone-700">{list.length}</b> 张作品{selected.size > 0 ? '（筛选中）' : ''}</span>
        <button onClick={() => batchM.mutate()} disabled={batchM.isPending}
          className="text-[12px] text-xhs border border-xhs/30 rounded-full px-3 py-1 hover:bg-xhs-soft disabled:opacity-40">
          {batchM.isPending ? '批量打标中…' : '🤖 AI 批量打标未标'}
        </button>
      </div>

      {artworksQ.isLoading && <div className="text-center text-stone-400 py-20">加载中…</div>}
      {artworksQ.isError && <div className="text-center text-rose-500 py-20">加载失败（后端是否已启动？）</div>}

      {list.length > 0 && (
        orient === '全部' ? (
          <div className="space-y-5">
            {[['横', '横屏'], ['竖', '竖屏']].map(([o, label]) => {
              const sub = list.filter(a => a.orientation === o);
              if (!sub.length) return null;
              return (
                <div key={o}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[13px] font-semibold text-stone-700 px-2.5 py-0.5 rounded-full bg-stone-100">{label}</span>
                    <span className="text-[11px] text-stone-400">{sub.length} 张</span>
                  </div>
                  <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
                    {sub.map(a => <ArtworkCard key={a.id} art={a} index={list.indexOf(a)} onOpen={setViewerIdx} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="masonry columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6">
            {list.map((a, i) => <ArtworkCard key={a.id} art={a} index={i} onOpen={setViewerIdx} />)}
          </div>
        )
      )}

      {!artworksQ.isLoading && list.length === 0 && !artworksQ.isError && (
        <div className="text-center py-20">
          <div className="text-5xl mb-3">🎨</div>
          <div className="text-stone-400 text-sm">还没有作品，点右上角「＋ 录作品」开始录入</div>
        </div>
      )}

      {viewerIdx != null && (
        <Viewer list={list} index={viewerIdx} onClose={() => setViewerIdx(null)}
          onNav={d => setViewerIdx(v => (v! + d + list.length) % list.length)}
          onTag={(id) => tagM.mutate(id)} onConfirm={(id) => confirmM.mutate(id)} tagging={tagM.isPending}
          onDelete={(id) => delM.mutate(id)}
          onSaveTags={(id, tagIds) => setTagsM.mutate({ id, tagIds })} savingTags={setTagsM.isPending}
          tagTree={tagsQ.data} />
      )}
    </div>
  );
}
