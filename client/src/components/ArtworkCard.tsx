import type { Artwork } from '../api';

function aspectOf(w?: number | null, h?: number | null): string {
  if (w && h) return `${w} / ${h}`;
  return '3 / 4';
}

export function ArtworkCard({ art, index, onOpen, onHover }: {
  art: Artwork; index: number; onOpen: (i: number) => void; onHover?: (i: number | null) => void;
}) {
  const styleTag = art.tags.find(t => t.label)?.label;
  const subTags = art.tags.slice(0, 3).map(t => t.label);
  return (
    <div
      className="rounded-2xl overflow-hidden bg-white border border-stone-100 card-hover cursor-pointer"
      onClick={() => onOpen(index)}
      onMouseEnter={() => onHover?.(index)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="relative overflow-hidden" style={{ aspectRatio: aspectOf(art.width, art.height) }}>
        <img src={art.thumbUrl || art.imageUrl} alt={art.title || ''} className="thumb-img absolute inset-0 w-full h-full object-cover" loading="lazy" />
        {/* 顶部小标 */}
        <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-white backdrop-blur z-10">{art.orientation}屏</span>
        {styleTag && <span className="absolute top-2 left-12 text-[10px] px-1.5 py-0.5 rounded bg-xhs/85 text-white backdrop-blur z-10">{styleTag}</span>}
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(index); }}
          className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-black/40 text-white text-xs flex items-center justify-center hover:bg-xhs"
          title="放大全屏"
        >⤢</button>
        {/* 底部渐变 + 标题 */}
        <div className="absolute bottom-0 inset-x-0 p-2.5 bg-gradient-to-t from-black/65 via-black/20 to-transparent">
          <div className="text-white text-[13px] font-medium line-clamp-2 drop-shadow-sm">{art.title || '未命名'}</div>
        </div>
      </div>
      {/* 底部信息 */}
      <div className="px-2.5 py-2 flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-xhs shrink-0" />
        <span className="text-[11px] text-stone-500 truncate flex-1">{art.artistName || '未关联画师'}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${art.tagStatus === 'confirmed' ? 'text-emerald-600 bg-emerald-50' : 'text-amber-600 bg-amber-50'}`}>
          {art.tagStatus === 'confirmed' ? '已确认' : '待复核'}
        </span>
        <div className="flex gap-1 shrink-0 max-w-[40%]">
          {subTags.slice(0, 1).map((t, i) => <span key={i} className="text-[10px] text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">{t}</span>)}
        </div>
      </div>
    </div>
  );
}
