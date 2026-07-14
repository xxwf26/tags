import { useOperations, useUndoOperation } from '../hooks';

const TYPE_LABEL: Record<string, string> = {
  artwork_create: '录入作品', artwork_delete: '删除作品', artwork_confirm: '确认复核',
  artist_create: '新建画师', artist_engage: '更新建联', crawl_import: '爬取入库',
  promote: '候选转正', undo: '撤销操作',
};

function timeOf(s: string) {
  const d = new Date(s);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function AdminPage() {
  const opsQ = useOperations(200);
  const undo = useUndoOperation();
  const ops = opsQ.data ?? [];

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      <h2 className="font-semibold text-stone-800 text-[15px] mb-3">操作记录 <span className="text-xs text-stone-400 font-normal">（最近 200 条；删除可撤销，恢复后作品回到库）</span></h2>

      {opsQ.isLoading && <div className="text-center text-stone-400 py-12">加载中…</div>}

      {ops.length > 0 && (
        <div className="bg-white rounded-2xl border border-stone-100 overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_auto_auto] gap-2 px-4 py-2 text-[11px] text-stone-400 border-b border-stone-100 bg-stone-50">
            <span>时间</span><span>操作</span><span className="hidden md:block">对象</span><span>动作</span>
          </div>
          {ops.map(op => {
            const canUndo = op.undoable && !op.undone;
            return (
              <div key={op.id} className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_auto_auto] gap-2 px-4 py-2.5 text-[13px] border-b border-stone-50 items-center">
                <span className="text-stone-400 text-[12px] whitespace-nowrap">{timeOf(op.createdAt)}</span>
                <span className="text-stone-700">
                  <span className="inline-block text-[11px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 mr-2">{TYPE_LABEL[op.type] || op.type}</span>
                  {op.summary}
                </span>
                <span className="hidden md:block text-[12px] text-stone-400">{op.targetType ? `${op.targetType}#${op.targetId ?? ''}` : ''}</span>
                <span>
                  {canUndo ? (
                    <button onClick={() => undo.mutate(op.id)} disabled={undo.isPending}
                      className="text-[12px] text-xhs border border-xhs/30 rounded-full px-2.5 py-1 hover:bg-xhs-soft disabled:opacity-40">撤销</button>
                  ) : op.undone ? (
                    <span className="text-[11px] text-stone-400">已撤销</span>
                  ) : (
                    <span className="text-[11px] text-stone-300">—</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!opsQ.isLoading && !ops.length && <div className="text-center text-stone-400 py-12">暂无操作记录</div>}
    </div>
  );
}
