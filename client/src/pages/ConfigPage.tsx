import { useState } from 'react';
import { useTagsAll, useCreateTag, useUpdateTag, useDeleteTag, useCreateDimension } from '../hooks';
import type { TagNode } from '../api';

export function ConfigPage() {
  const tagsQ = useTagsAll();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();
  const createDim = useCreateDimension();

  const tree = tagsQ.data ?? [];
  const [newTag, setNewTag] = useState<{ dimId: string; label: string }>({ dimId: '', label: '' });
  const [newSub, setNewSub] = useState<{ parentId: string; name: string }>({ parentId: '', name: '' });
  const [editAliases, setEditAliases] = useState<Record<number, string>>({});

  // 所有可挂标签的维度（顶层 + 子维度）
  const allDims: { id: number; path: string }[] = [];
  for (const top of tree) {
    allDims.push({ id: top.id, path: top.name || top.code || '' });
    for (const sub of top.children) allDims.push({ id: sub.id, path: `${top.name}/${sub.name}` });
  }

  const submitTag = () => {
    if (!newTag.dimId || !newTag.label.trim()) return;
    createTag.mutate({ dimensionId: Number(newTag.dimId), label: newTag.label.trim() }, { onSuccess: () => setNewTag({ dimId: '', label: '' }) });
  };
  const submitSub = () => {
    if (!newSub.parentId || !newSub.name.trim()) return;
    createDim.mutate({ parentId: Number(newSub.parentId), code: `genre_${Date.now()}`, name: newSub.name.trim() }, { onSuccess: () => setNewSub({ parentId: '', name: '' }) });
  };
  const saveAliases = (id: number) => {
    const v = editAliases[id] ?? '';
    updateTag.mutate({ id, body: { aliases: v.split(/[,，]/).map(s => s.trim()).filter(Boolean) } });
    setEditAliases(s => { const c = { ...s }; delete c[id]; return c; });
  };

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      <h2 className="font-semibold text-stone-800 text-[15px] mb-3">标签体系配置 <span className="text-xs text-stone-400 font-normal">（6 维两级白名单 · AI 只能从中选 · 删除=禁用，有作品在用则不物理删）</span></h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {tree.map(top => (
          <div key={top.id} className="bg-white rounded-2xl p-4 border border-stone-100">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-stone-800 text-[14px]">{top.name}</h3>
              <span className="text-[11px] text-stone-400">{top.code}</span>
              <span className="text-[11px] text-stone-400 ml-auto">顶层维度 id={top.id}</span>
            </div>

            {top.children.length > 0 && (
              <div className="space-y-2.5">
                {top.children.map(sub => (
                  <div key={sub.id} className="border-l-2 border-xhs/30 pl-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[13px] font-medium text-stone-700">{sub.name}</span>
                      <span className="text-[10px] text-stone-400">子维度 id={sub.id}</span>
                    </div>
                    <TagList tags={sub.tags} editAliases={editAliases} setEditAliases={setEditAliases}
                      onSave={saveAliases} onToggle={(t: any) => updateTag.mutate({ id: t.id, body: { enabled: t.enabled ? 0 : 1 } })}
                      onDelete={(t: any) => deleteTag.mutate(t.id)} />
                  </div>
                ))}
              </div>
            )}

            {top.children.length === 0 && (
              <TagList tags={top.tags} editAliases={editAliases} setEditAliases={setEditAliases}
                onSave={saveAliases} onToggle={(t: any) => updateTag.mutate({ id: t.id, body: { enabled: t.enabled ? 0 : 1 } })}
                onDelete={(t: any) => deleteTag.mutate(t.id)} />
            )}

            {/* 给该顶层加子维度（仅 genre 类两级维度需要） */}
            {top.children.length > 0 && (
              <div className="flex gap-1.5 mt-3 pt-3 border-t border-stone-100">
                <input value={newSub.parentId === String(top.id) ? newSub.name : ''} placeholder={`在「${top.name}」下加子维度…`}
                  onChange={e => setNewSub({ parentId: String(top.id), name: e.target.value })}
                  className="flex-1 text-[12px] border border-stone-200 rounded-full px-3 py-1.5" />
                {newSub.parentId === String(top.id) && (
                  <button onClick={submitSub} className="text-[12px] text-xhs border border-xhs/30 rounded-full px-3 py-1.5">加子维度</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 新增标签 */}
      <div className="bg-white rounded-2xl p-4 border border-stone-100 mt-3">
        <h3 className="font-semibold text-stone-800 text-[14px] mb-2">新增标签</h3>
        <div className="flex gap-2 flex-wrap items-center">
          <select value={newTag.dimId} onChange={e => setNewTag({ ...newTag, dimId: e.target.value })}
            className="text-[13px] border border-stone-200 rounded-full px-3 py-1.5">
            <option value="">选择维度…</option>
            {allDims.map(d => <option key={d.id} value={d.id}>{d.path}</option>)}
          </select>
          <input value={newTag.label} onChange={e => setNewTag({ ...newTag, label: e.target.value })} placeholder="标签名（如 水墨）"
            className="flex-1 min-w-[160px] text-[13px] border border-stone-200 rounded-full px-3 py-1.5" />
          <button onClick={submitTag} disabled={!newTag.dimId || !newTag.label.trim()}
            className="text-[13px] bg-xhs text-white rounded-full px-4 py-1.5 font-medium disabled:opacity-40">新增</button>
        </div>
      </div>
    </div>
  );
}

function TagList({ tags, editAliases, setEditAliases, onSave, onToggle, onDelete }: any) {
  return (
    <div className="flex flex-col gap-1.5">
      {tags.map((t: any) => (
        <div key={t.id} className="flex items-center gap-1.5 flex-wrap text-[12px]">
          <span className={`px-2 py-0.5 rounded-full ${t.enabled === 0 ? 'text-stone-400 bg-stone-100 line-through' : 'text-stone-700 bg-stone-50'}`}>{t.label}</span>
          <input value={editAliases[t.id] ?? (t.aliases || []).join('，')}
            onChange={e => setEditAliases((s: any) => ({ ...s, [t.id]: e.target.value }))}
            placeholder="别名（逗号分隔）"
            className="flex-1 min-w-[100px] text-[11px] border border-stone-200 rounded px-2 py-0.5" />
          <button onClick={() => onSave(t.id)} className="text-[11px] text-xhs">存别名</button>
          <button onClick={() => onToggle(t)} className="text-[11px] text-stone-500">{t.enabled === 0 ? '启用' : '禁用'}</button>
          <button onClick={() => onDelete(t)} className="text-[11px] text-rose-400">删除</button>
        </div>
      ))}
      {!tags.length && <span className="text-[11px] text-stone-300">无标签</span>}
    </div>
  );
}
