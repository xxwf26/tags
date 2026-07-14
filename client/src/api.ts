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
};
export type StyleDistItem = { style: string; count: number; h: number; v: number; both: boolean; missingOrient: string | null };
export type Artist = {
  id: number; name: string; bio: string | null; engageStatus: string; commission: string;
  links: any; drawingHabit: any; engageNote?: string | null;
  total: number; styleDist: StyleDistItem[]; styleCount?: number; topStyle?: string | null; missingStyles?: string[];
};

const BASE = '/api';

export async function fetchTags(): Promise<TagNode[]> {
  const r = await fetch(BASE + '/tags');
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
export async function createArtwork(fd: FormData): Promise<Artwork> {
  const r = await fetch(BASE + '/artworks', { method: 'POST', body: fd });
  if (!r.ok) throw new Error('create failed');
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
