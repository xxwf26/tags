import { useState } from 'react';
import type { TagNode } from '../api';
import { tagsByTopDim } from '../api';

const ORIENT_HINT = 'X6→横屏 · X3·恋语→竖屏';
const EXTRA_ROWS: { code: string; label: string }[] = [
  { code: 'technique', label: '绘制技巧' },
  { code: 'subject', label: '题材' },
  { code: 'usage', label: '用途' },
  { code: 'tone', label: '色调' },
  { code: 'character', label: '人物' },
];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <span onClick={onClick}
      className={`shrink-0 text-[12px] px-3 py-1 rounded-full cursor-pointer border transition-colors ${
        active ? 'bg-xhs text-white border-xhs font-medium' : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'}`}>
      {children}
    </span>
  );
}

export function FilterBar({ tree, orient, setOrient, selected, toggleTag, onClear }: {
  tree: TagNode[];
  orient: string; setOrient: (o: string) => void;
  selected: Set<number>; toggleTag: (id: number) => void; onClear: () => void;
}) {
  const byDim = tagsByTopDim(tree);
  const [more, setMore] = useState(false);
  const genreTags = byDim.get('genre')?.tags ?? [];
  const hasFilter = selected.size > 0 || orient !== '全部';

  return (
    <div className="bg-white rounded-2xl p-3 border border-stone-100">
      {/* 主行：朝向 | 画风 | 更多 */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin pb-1">
        <div className="flex gap-1 shrink-0">
          {['全部', '横', '竖'].map(o => (
            <Chip key={o} active={orient === o} onClick={() => setOrient(o)}>{o === '全部' ? '全部' : o + '屏'}</Chip>
          ))}
        </div>
        <span className="text-stone-200 shrink-0">|</span>
        <div className="flex gap-1.5 shrink-0">
          {genreTags.map(t => <Chip key={t.id} active={selected.has(t.id)} onClick={() => toggleTag(t.id)}>{t.label}</Chip>)}
        </div>
        <button onClick={() => setMore(v => !v)} className="ml-auto shrink-0 text-[12px] text-stone-500 px-2 py-1 hover:text-stone-800">
          更多筛选 {more ? '▴' : '▾'}
        </button>
      </div>

      {/* 展开区：二级+辅助维度 */}
      {more && (
        <div className="mt-2.5 pt-2.5 border-t border-stone-100 space-y-2">
          {EXTRA_ROWS.map(row => {
            const tags = byDim.get(row.code)?.tags ?? [];
            if (!tags.length) return null;
            return (
              <div key={row.code} className="flex items-start gap-2">
                <span className="text-[11px] text-stone-400 w-16 shrink-0 pt-1">{row.label}</span>
                <div className="flex gap-1.5 flex-wrap">
                  {tags.map(t => <Chip key={t.id} active={selected.has(t.id)} onClick={() => toggleTag(t.id)}>{t.label}</Chip>)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3 mt-2 px-0.5">
        <span className="text-[11px] text-stone-300">{ORIENT_HINT}</span>
        {hasFilter && <button onClick={onClear} className="text-[11px] text-xhs">清除筛选</button>}
      </div>
    </div>
  );
}
