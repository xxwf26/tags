import { useState } from 'react';
import { useCandidates, useCrawlNote, usePromoteCandidate, useRejectCandidate, useArtists, useMihuashiTags, useCrawlMihuashi } from '../hooks';

export function DiscoverPage() {
  const [input, setInput] = useState('');
  const crawl = useCrawlNote();
  const promote = usePromoteCandidate();
  const reject = useRejectCandidate();
  const artistsQ = useArtists();
  const candsQ = useCandidates('pending');
  const mhsTagsQ = useMihuashiTags();
  const mhsCrawl = useCrawlMihuashi();
  const [mhsTag, setMhsTag] = useState('日系');
  const [mhsLimit, setMhsLimit] = useState(20);
  // 每个候选的转正选项：artistId 选择
  const [choice, setChoice] = useState<Record<number, { artistId: string; newArtist: boolean }>>({});

  const submit = () => { if (input.trim()) { crawl.mutate(input.trim(), { onSuccess: () => setInput('') }); } };
  const getChoice = (id: number) => choice[id] ?? { artistId: '', newArtist: true };

  return (
    <div className="max-w-[1600px] mx-auto px-3 md:px-6 py-3">
      <div className="bg-white rounded-2xl p-5 border border-stone-100">
        <h2 className="font-semibold text-stone-800 text-[15px] mb-1">外部采集 · 发现</h2>
        <p className="text-xs text-stone-400 mb-3">贴小红书笔记链接（<b>可多条，一行一个或空格分隔</b>）→ SSR 抓取入候选队列 → 复核转正入库（自动 AI 打标）</p>
        <div className="flex gap-2">
          <textarea value={input} onChange={e => setInput(e.target.value)} rows={3}
            placeholder={"https://www.xiaohongshu.com/explore/...\nhttps://www.xiaohongshu.com/explore/...\n可贴多条笔记链接或整段分享文本"}
            className="flex-1 border border-stone-200 rounded-xl px-4 py-2 text-sm focus:border-xhs outline-none resize-y" />
          <button onClick={submit} disabled={crawl.isPending}
            className="bg-xhs text-white text-sm px-5 py-2 rounded-full font-medium disabled:opacity-50 self-start">
            {crawl.isPending ? '采集中…' : '批量采集'}
          </button>
        </div>
        {crawl.isError && <div className="text-xs text-rose-500 mt-2">采集失败：{(crawl.error as Error).message}</div>}
        {crawl.data && (
          <div className="text-xs text-stone-500 mt-2">
            共 {crawl.data.total} 条链接，成功 {crawl.data.results.filter((r: any) => !r.error).length}，失败 {crawl.data.results.filter((r: any) => r.error).length}
          </div>
        )}
      </div>

      {/* 米画师按画风批量搜（playwright 驱动，免登录） */}
      <div className="bg-white rounded-2xl p-5 border border-stone-100 mt-3">
        <h2 className="font-semibold text-stone-800 text-[15px] mb-1">米画师 · 按画风批量搜</h2>
        <p className="text-xs text-stone-400 mb-3">选画风标签 → playwright 驱动米画师页面抓取作品 → 入候选队列（免登录，绕过签名）</p>
        <div className="flex gap-2 flex-wrap items-center">
          <select value={mhsTag} onChange={e => setMhsTag(e.target.value)} className="text-[13px] border border-stone-200 rounded-full px-3 py-2">
            {(mhsTagsQ.data ?? []).map(t => <option key={t.id} value={t.name}>{t.name}（{t.type === 'skill_tag' ? '画风' : '类别'}）</option>)}
          </select>
          <label className="text-[12px] text-stone-500">数量
            <input type="number" value={mhsLimit} min={5} max={60} onChange={e => setMhsLimit(Number(e.target.value))}
              className="w-16 ml-1 border border-stone-200 rounded-full px-2 py-1 text-center" />
          </label>
          <button onClick={() => mhsCrawl.mutate({ tag: mhsTag, limit: mhsLimit })} disabled={mhsCrawl.isPending}
            className="bg-xhs text-white text-sm px-5 py-2 rounded-full font-medium disabled:opacity-50">
            {mhsCrawl.isPending ? '搜集中…（约30-60秒）' : '🔍 按画风搜集'}
          </button>
          {mhsCrawl.data && <span className="text-xs text-stone-500">抓到 {mhsCrawl.data.total} 张 → 候选队列</span>}
          {mhsCrawl.isError && <span className="text-xs text-rose-500">失败：{(mhsCrawl.error as Error).message}</span>}
        </div>
      </div>

      <div className="flex items-center justify-between mb-2.5 mt-4 px-1">
        <span className="text-[13px] text-stone-500">待复核候选 <b className="text-stone-700">{candsQ.data?.length ?? 0}</b></span>
      </div>

      <div className="space-y-3">
        {candsQ.data?.map(c => {
          const ch = getChoice(c.id);
          return (
            <div key={c.id} className="bg-white rounded-2xl p-4 border border-stone-100">
              <div className="flex gap-4">
                {/* 缩略图 */}
                <div className="flex gap-2 shrink-0">
                  {c.raw.images.slice(0, 4).map((im, i) => (
                    <img key={i} src={im.url} referrerPolicy="no-referrer"
                      className="w-20 h-20 object-cover rounded-lg bg-stone-100"
                      onError={e => ((e.target as HTMLImageElement).style.opacity = '0.3')} alt="" />
                  ))}
                </div>
                {/* 信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-stone-800 text-sm">{c.raw.title}</span>
                    <span className="text-[11px] text-stone-400">{c.raw.images.length} 张图</span>
                  </div>
                  <div className="text-[12px] text-stone-500 mt-0.5">画师：{c.artistName || '未知'} · 来源：小红书</div>
                  <div className="flex gap-1 flex-wrap mt-1.5">
                    {c.raw.tags.map((t, i) => <span key={i} className="text-[10px] text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">{t}</span>)}
                  </div>
                </div>
              </div>
              {/* 操作：转正 / 丢弃 */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-stone-100 flex-wrap">
                <label className="flex items-center gap-1 text-[12px] text-stone-600">
                  <input type="checkbox" checked={ch.newArtist} className="accent-[#FF2442]"
                    onChange={e => setChoice(s => ({ ...s, [c.id]: { ...ch, newArtist: e.target.checked, artistId: e.target.checked ? '' : ch.artistId } }))} />
                  新建画师「{c.artistName}」
                </label>
                {!ch.newArtist && (
                  <select value={ch.artistId} onChange={e => setChoice(s => ({ ...s, [c.id]: { ...ch, artistId: e.target.value } }))}
                    className="text-[12px] border border-stone-200 rounded-full px-2 py-1">
                    <option value="">选择已有画师…</option>
                    {artistsQ.data?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
                <button
                  onClick={() => promote.mutate({ id: c.id, body: ch.newArtist ? { newArtist: true } : { artistId: Number(ch.artistId) } })}
                  disabled={promote.isPending || (!ch.newArtist && !ch.artistId)}
                  className="ml-auto bg-xhs text-white text-[12px] px-4 py-1.5 rounded-full font-medium disabled:opacity-40">
                  {promote.isPending ? '转正中…' : '转正入库（含 AI 打标）'}
                </button>
                <button onClick={() => reject.mutate(c.id)}
                  className="text-[12px] text-stone-500 border border-stone-200 px-3 py-1.5 rounded-full hover:bg-stone-50">丢弃</button>
              </div>
            </div>
          );
        })}
        {!candsQ.isLoading && !candsQ.data?.length && (
          <div className="text-center py-16">
            <div className="text-5xl mb-3">🔍</div>
            <div className="text-stone-400 text-sm">没有待复核候选，贴个小红书笔记链接开始采集</div>
          </div>
        )}
      </div>
    </div>
  );
}
