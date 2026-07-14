import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useArtists } from '../hooks';
import type { Artist } from '../api';

const ENGAGE: Record<string, string> = {
  cooperated: '合作', pending: '待定', rejected: '不合作',
  no_availability: '暂无档期', unreachable: '无法建联',
  contacted: '已接触', negotiating: '沟通中',
};
const ENGAGE_CLS: Record<string, string> = {
  cooperated: 'text-white bg-xhs', pending: 'text-amber-700 bg-amber-100',
  rejected: 'text-stone-500 bg-stone-200', no_availability: 'text-sky-700 bg-sky-100',
  unreachable: 'text-stone-500 bg-stone-200', contacted: 'text-violet-700 bg-violet-100',
  negotiating: 'text-violet-700 bg-violet-100',
};
const PLATFORM_LABEL: Record<string, string> = { xiaohongshu: '小红书', mihuashi: '米画师', weibo: '微博', other: '其他' };
const ENGAGE_ORDER = ['pending', 'cooperated', 'contacted', 'negotiating', 'no_availability', 'rejected', 'unreachable'];
// 头像渐变（按名字散列取色）
const AVATAR_GRADS = [
  'from-rose-400 to-orange-300', 'from-violet-400 to-indigo-300', 'from-sky-400 to-cyan-300',
  'from-emerald-400 to-teal-300', 'from-amber-400 to-yellow-300', 'from-fuchsia-400 to-pink-300',
];
function gradOf(name: string) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_GRADS[h % AVATAR_GRADS.length];
}
function platformsOf(a: Artist): string[] {
  const links = a.links || {};
  return Object.keys(links).filter(k => Array.isArray(links[k]) && links[k].length);
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 text-[12px] px-3 py-1 rounded-full cursor-pointer border transition-all ${
        active ? 'bg-xhs text-white border-xhs font-medium shadow-sm shadow-xhs/30' : 'bg-white text-stone-600 border-stone-200 hover:border-xhs/50 hover:text-xhs'}`}>
      {children}
    </button>
  );
}

function ArtistCard({ a }: { a: Artist }) {
  const plats = platformsOf(a);
  const styles = a.styleHint ?? [];
  const covers = a.coverThumbs ?? [];
  return (
    <Link to={`/artist/${a.id}`} className="group bg-white rounded-2xl overflow-hidden border border-stone-100 card-hover block">
      {/* 作品预览区 */}
      {covers.length > 0 ? (
        <div className={`grid gap-0.5 aspect-[4/3] ${covers.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {covers.slice(0, 4).map((src, i) => (
            <div key={i} className={`overflow-hidden bg-stone-100 ${covers.length === 3 && i === 0 ? 'row-span-2' : ''}`}>
              <img src={src} alt="" loading="lazy" className="w-full h-full object-cover thumb-img" />
            </div>
          ))}
        </div>
      ) : (
        <div className={`aspect-[4/3] bg-gradient-to-br ${gradOf(a.name)} flex items-center justify-center`}>
          <span className="text-white/90 text-4xl font-bold drop-shadow">{a.name.slice(0, 1)}</span>
        </div>
      )}
      {/* 信息区 */}
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-stone-800 text-[14px] truncate flex-1">{a.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${ENGAGE_CLS[a.engageStatus] || 'text-stone-500 bg-stone-100'}`}>{ENGAGE[a.engageStatus] || a.engageStatus}</span>
        </div>
        {styles.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-2">
            {styles.slice(0, 4).map(s => <span key={s} className="text-[10px] text-xhs bg-xhs-soft px-1.5 py-0.5 rounded">{s}</span>)}
          </div>
        )}
        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-stone-400">
          {plats.length ? plats.map(p => <span key={p} className="bg-stone-100 px-1.5 py-0.5 rounded">{PLATFORM_LABEL[p] || p}</span>) : <span>无链接</span>}
          <span className="ml-auto text-stone-500 shrink-0">{a.total > 0 ? `${a.total} 作品` : '待采集'}</span>
        </div>
      </div>
    </Link>
  );
}

export function ArtistsPage() {
  const artistsQ = useArtists();
  const [engage, setEngage] = useState('全部');
  const [platform, setPlatform] = useState('全部');
  const [style, setStyle] = useState('全部');
  const [kw, setKw] = useState('');

  const all = artistsQ.data ?? [];

  const styleOptions = useMemo(() => {
    const s = new Set<string>();
    for (const a of all) (a.styleHint ?? []).forEach(g => s.add(g));
    return [...s];
  }, [all]);

  const list = useMemo(() => all.filter(a => {
    if (engage !== '全部' && a.engageStatus !== engage) return false;
    if (platform !== '全部' && !platformsOf(a).includes(platform)) return false;
    if (style !== '全部' && !(a.styleHint ?? []).includes(style)) return false;
    if (kw && !a.name.toLowerCase().includes(kw.toLowerCase())) return false;
    return true;
  }), [all, engage, platform, style, kw]);

  // 有作品的排前面（视觉更饱满）
  const sorted = useMemo(() => [...list].sort((a, b) => (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0)), [list]);

  const hasFilter = engage !== '全部' || platform !== '全部' || style !== '全部' || !!kw;
  const clear = () => { setEngage('全部'); setPlatform('全部'); setStyle('全部'); setKw(''); };
  const withWorks = all.filter(a => a.total > 0).length;

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      {/* 筛选条 */}
      <div className="bg-white rounded-2xl p-3 border border-stone-100 sticky top-14 z-20 space-y-2 shadow-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-300 text-[13px]">🔍</span>
            <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜画师名称"
              className="text-[13px] bg-stone-100 rounded-full pl-8 pr-3.5 py-1.5 w-48 focus:outline-none focus:bg-stone-200/60" />
          </div>
          <span className="text-stone-200">|</span>
          <span className="text-[11px] text-stone-400 shrink-0">建联</span>
          <Chip active={engage === '全部'} onClick={() => setEngage('全部')}>全部</Chip>
          {ENGAGE_ORDER.map(s => <Chip key={s} active={engage === s} onClick={() => setEngage(s)}>{ENGAGE[s]}</Chip>)}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-stone-400 shrink-0 w-8 md:w-auto">平台</span>
          <Chip active={platform === '全部'} onClick={() => setPlatform('全部')}>全部</Chip>
          {['xiaohongshu', 'mihuashi', 'weibo'].map(p => <Chip key={p} active={platform === p} onClick={() => setPlatform(p)}>{PLATFORM_LABEL[p]}</Chip>)}
          {styleOptions.length > 0 && <><span className="text-stone-200 mx-1">|</span><span className="text-[11px] text-stone-400 shrink-0">画风</span>
            <Chip active={style === '全部'} onClick={() => setStyle('全部')}>全部</Chip>
            {styleOptions.map(s => <Chip key={s} active={style === s} onClick={() => setStyle(s)}>{s}</Chip>)}</>}
        </div>
      </div>

      <div className="flex items-center justify-between my-3 px-1">
        <span className="text-[13px] text-stone-500">共 <b className="text-stone-700">{list.length}</b> 位画师{hasFilter ? '（筛选中）' : ''} · <span className="text-stone-400">{withWorks} 位有作品</span></span>
        {hasFilter && <button onClick={clear} className="text-[12px] text-xhs hover:underline">清除筛选</button>}
      </div>

      {artistsQ.isLoading && <div className="text-center text-stone-400 py-20">加载中…</div>}
      {artistsQ.isError && <div className="text-center text-rose-500 py-20">加载失败（后端是否已启动？）</div>}

      {sorted.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {sorted.map(a => <ArtistCard key={a.id} a={a} />)}
        </div>
      )}

      {!artistsQ.isLoading && list.length === 0 && !artistsQ.isError && (
        <div className="text-center py-20">
          <div className="text-5xl mb-3">🧑‍🎨</div>
          <div className="text-stone-400 text-sm">{hasFilter ? '没有符合筛选条件的画师' : '还没有画师数据'}</div>
        </div>
      )}
    </div>
  );
}
