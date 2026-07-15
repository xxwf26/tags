// API 客户端 + 类型
export type TagMini = { id: number; label: string; aliases?: string[] | null; note?: string | null };
export type TagNode = {
  id: number; code: string | null; name: string | null; parentId: number | null; sort: number | null;
  children: TagNode[]; tags: TagMini[];
};
export type ArtworkTag = { id: number; label: string; dimensionId: number; source: string };
export type Artwork = {
  id: number; title: string | null; imageUrl: string; thumbUrl: string | null;
  width: number | null; height: number | null; orientation: '横' | '竖' | '方';
  tags: ArtworkTag[]; artistId: number | null; artistName: string | null;
  tagStatus: 'pending' | 'confirmed'; aiTagged: number; tagConfidence: number | null;
};
export type StyleDistItem = { style: string; count: number; h: number; v: number; both: boolean; missingOrient: string | null };
export type Artist = {
  id: number; name: string; bio: string | null; engageStatus: string; commission: string;
  links: any; drawingHabit: any; engageNote?: string | null; styleHint?: string[] | null;
  total: number; styleDist?: StyleDistItem[]; styleCount?: number; topStyle?: string | null; missingStyles?: string[];
  coverThumbs?: string[];
  tags?: ArtworkTag[]; platforms?: string[]; orientations?: string[];
};

const BASE = '/api';

export async function fetchTags(): Promise<TagNode[]> {
  const r = await fetch(BASE + '/tags');
  if (!r.ok) throw new Error('tags failed');
  return r.json();
}
export async function fetchTagsAll(): Promise<TagNode[]> {
  const r = await fetch(BASE + '/tags?all=1');
  if (!r.ok) throw new Error('tags failed');
  return r.json();
}
export async function fetchArtworks(p: { tags?: number[]; orient?: string; kw?: string; artistId?: number; sort?: string }): Promise<Artwork[]> {
  const q = new URLSearchParams();
  if (p.tags?.length) q.set('tags', p.tags.join(','));
  if (p.orient && p.orient !== '全部') q.set('orient', p.orient);
  if (p.kw) q.set('kw', p.kw);
  if (p.artistId) q.set('artistId', String(p.artistId));
  if (p.sort) q.set('sort', p.sort);
  const r = await fetch(BASE + '/artworks?' + q.toString());
  if (!r.ok) throw new Error('artworks failed');
  return r.json();
}
export async function fetchArtists(): Promise<Artist[]> {
  const r = await fetch(BASE + '/artists');
  if (!r.ok) throw new Error('artists failed');
  return r.json();
}
export async function fetchArtist(id: number): Promise<Artist> {
  const r = await fetch(BASE + '/artists/' + id);
  if (!r.ok) throw new Error('artist failed');
  return r.json();
}
export async function updateEngage(id: number, body: { engageStatus?: string; engageNote?: string }): Promise<Artist> {
  const r = await fetch(BASE + '/artists/' + id + '/engage', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('update engage failed');
  return r.json();
}
export async function createArtwork(fd: FormData): Promise<Artwork> {
  const r = await fetch(BASE + '/artworks', { method: 'POST', body: fd });
  if (!r.ok) throw new Error('create failed');
  return r.json();
}
export async function deleteArtwork(id: number): Promise<{ id: number; deleted: boolean }> {
  const r = await fetch(BASE + '/artworks/' + id, { method: 'DELETE' });
  if (!r.ok) throw new Error('delete failed');
  return r.json();
}
export async function setArtworkTags(id: number, tagIds: number[]): Promise<Artwork> {
  const r = await fetch(BASE + '/artworks/' + id + '/tags', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagIds }),
  });
  if (!r.ok) throw new Error('set tags failed');
  return r.json();
}
export async function tagArtwork(id: number) {
  const r = await fetch(BASE + '/tagging/artwork/' + id, { method: 'POST' });
  if (!r.ok) throw new Error('tag failed');
  return r.json();
}
export async function tagBatch() {
  const r = await fetch(BASE + '/tagging/batch', { method: 'POST' });
  if (!r.ok) throw new Error('batch failed');
  return r.json();
}
export async function confirmArtwork(id: number) {
  const r = await fetch(BASE + '/tagging/artwork/' + id + '/confirm', { method: 'POST' });
  if (!r.ok) throw new Error('confirm failed');
  return r.json();
}
export type Candidate = {
  id: number; sourcePlatform: string; sourceUrl: string; artistName: string | null;
  raw: { noteId?: string; title: string; desc: string; tags: string[]; images: { url: string; width: number | null; height: number | null }[] };
  status: string; promotedArtistId: number | null; dedup?: boolean;
};
export async function crawlNote(input: string): Promise<{ total: number; results: any[] }> {
  const r = await fetch(BASE + '/crawl/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input }) });
  if (!r.ok) throw new Error('crawl failed');
  return r.json();
}
export async function fetchCandidates(status = 'pending'): Promise<Candidate[]> {
  const r = await fetch(BASE + '/candidates?status=' + status);
  if (!r.ok) throw new Error('candidates failed');
  return r.json();
}
export async function promoteCandidate(id: number, body: { artistId?: number; newArtist?: boolean }) {
  const r = await fetch(BASE + '/candidates/' + id + '/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('promote failed');
  return r.json();
}
export async function rejectCandidate(id: number) {
  const r = await fetch(BASE + '/candidates/' + id + '/reject', { method: 'POST' });
  if (!r.ok) throw new Error('reject failed');
  return r.json();
}
export async function crawlMihuashi(tag: string, limit = 30) {
  const r = await fetch(BASE + '/crawl/mihuashi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, limit }) });
  if (!r.ok) throw new Error('mihuashi crawl failed');
  return r.json();
}
export async function fetchMihuashiTags(): Promise<{ id: number; name: string; type: string }[]> {
  const r = await fetch(BASE + '/mihuashi/tags');
  if (!r.ok) throw new Error('mihuashi tags failed');
  return r.json();
}
export type SimilarArtwork = Artwork & { distance: number };
export async function searchByImage(file: File): Promise<SimilarArtwork[]> {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(BASE + '/artworks/similar', { method: 'POST', body: fd });
  if (!r.ok) throw new Error('similar failed');
  return r.json();
}
// 标签体系配置 CRUD
export async function createTag(body: { dimensionId: number; label: string; aliases?: string[] }) {
  const r = await fetch(BASE + '/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('createTag failed');
  return r.json();
}
export async function updateTag(id: number, body: { label?: string; aliases?: string[]; enabled?: number }) {
  const r = await fetch(BASE + '/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('updateTag failed');
  return r.json();
}
export async function deleteTag(id: number) {
  const r = await fetch(BASE + '/tags/' + id, { method: 'DELETE' });
  if (!r.ok) throw new Error('deleteTag failed');
  return r.json();
}
export async function createDimension(body: { parentId?: number | null; code: string; name: string }) {
  const r = await fetch(BASE + '/dimensions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('createDimension failed');
  return r.json();
}

// 按顶层维度聚合标签（genre 的子维度标签收拢到 genre 下）
export function tagsByTopDim(tree: TagNode[]) {
  const map = new Map<string, { dim: TagNode; tags: TagMini[] }>();
  for (const top of tree) {
    const all: TagMini[] = [];
    const collect = (d: TagNode) => { all.push(...d.tags); d.children.forEach(collect); };
    collect(top);
    map.set(top.code || top.name || '', { dim: top, tags: all });
  }
  return map;
}

export type Operation = {
  id: number; type: string; targetType: string | null; targetId: number | null;
  summary: string | null; payload: any; undoable: number; undone: number; createdAt: string;
};
export async function fetchOperations(limit = 100): Promise<Operation[]> {
  const r = await fetch(BASE + '/operations?limit=' + limit);
  if (!r.ok) throw new Error('operations failed');
  return r.json();
}
export async function undoOperation(id: number) {
  const r = await fetch(BASE + '/operations/' + id + '/undo', { method: 'POST' });
  if (!r.ok) throw new Error('undo failed');
  return r.json();
}
export async function redoOperation(id: number) {
  const r = await fetch(BASE + '/operations/' + id + '/redo', { method: 'POST' });
  if (!r.ok) throw new Error('redo failed');
  return r.json();
}

// ============ 寻源功能 ============
export type ReferenceImage = {
  id: number; imageUrl: string; imageHash: string | null; width: number | null; height: number | null;
  aiTags: { tagId: number; label: string; dimensionId: number | null; confidence: number }[] | null;
  manualTags: { tagId: number; label: string; dimensionId: number | null }[] | null;
  status: string; createdAt: string;
};
export type SearchSession = {
  id: number; referenceImageId: number; parentSessionId: number | null;
  searchTags: any; platforms: string[]; status: string; resultCount: number; newCount: number; createdAt: string;
};
export type SearchResult = {
  id: number; sessionId: number; referenceImageId: number; platform: string;
  sourceUrl: string | null; imageUrl: string | null; title: string | null; author: string | null;
  tags: string[]; aiTags: any; imageHash: string | null; isNew: number;
  tier: 'tier1' | 'tier2' | 'promoted' | 'rejected'; promotedArtworkId: number | null; createdAt: string;
};
export async function uploadReference(file: File): Promise<ReferenceImage> {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(BASE + '/reference/upload', { method: 'POST', body: fd });
  if (!r.ok) throw new Error('upload failed');
  return r.json();
}
export async function fetchReferences(): Promise<ReferenceImage[]> {
  const r = await fetch(BASE + '/reference'); if (!r.ok) throw new Error('ref failed'); return r.json();
}
export async function fetchReference(id: number): Promise<ReferenceImage> {
  const r = await fetch(BASE + '/reference/' + id); if (!r.ok) throw new Error('ref failed'); return r.json();
}
export async function updateReferenceTags(id: number, manualTags: any[]) {
  const r = await fetch(BASE + '/reference/' + id + '/tags', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualTags }) });
  if (!r.ok) throw new Error('update tags failed'); return r.json();
}
export async function startSearch(body: { referenceId: number; tags: any[]; platforms?: string[]; fuzzyRatio?: number }) {
  const r = await fetch(BASE + '/search/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('search failed'); return r.json();
}
export async function fetchSearchSessions(referenceId: number): Promise<SearchSession[]> {
  const r = await fetch(BASE + '/search/sessions?referenceId=' + referenceId); if (!r.ok) throw new Error('sessions failed'); return r.json();
}
export async function fetchSearchResults(sessionId: number, tier?: string): Promise<SearchResult[]> {
  const q = tier ? '&tier=' + tier : '';
  const r = await fetch(BASE + '/search/results?sessionId=' + sessionId + q); if (!r.ok) throw new Error('results failed'); return r.json();
}
export async function reviewSearchResult(id: number) {
  const r = await fetch(BASE + '/search/results/' + id + '/review', { method: 'POST' }); if (!r.ok) throw new Error('review failed'); return r.json();
}
export async function promoteSearchResult(id: number) {
  const r = await fetch(BASE + '/search/results/' + id + '/promote', { method: 'POST' }); if (!r.ok) throw new Error('promote failed'); return r.json();
}
export async function rejectSearchResult(id: number) {
  const r = await fetch(BASE + '/search/results/' + id + '/reject', { method: 'POST' }); if (!r.ok) throw new Error('reject failed'); return r.json();
}
