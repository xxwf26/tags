import { Injectable } from '@nestjs/common';
import { db, schema } from '../../database/db.js';
import { eq, and, inArray, like, isNotNull } from 'drizzle-orm';
import { join } from 'node:path';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { aHash, hamming, DEDUP_THRESHOLD } from '../imghash/imghash.js';

function deriveOrientation(width?: number, height?: number): '横' | '竖' | '方' {
  if (!width || !height) return '横';
  if (width > height * 1.1) return '横';
  if (height > width * 1.1) return '竖';
  return '方';
}

@Injectable()
export class ArtworkService {
  // 多维筛选：tags=tagId,tagId（跨维度与、同维度或）；orient；kw；artistId
  async list(query: Record<string, string>) {
    const { tags, orient, kw, artistId, sort } = query;
    const conds: any[] = [];
    if (orient && orient !== '全部') conds.push(eq(schema.artworks.orientation, orient as '横' | '竖' | '方'));
    if (artistId) conds.push(eq(schema.artworks.artistId, Number(artistId)));
    if (kw) conds.push(like(schema.artworks.title, `%${kw}%`));

    if (tags) {
      const ids = tags.split(',').map(Number).filter(Boolean);
      if (ids.length) {
        const dims = await db.select().from(schema.tagDimensions);
        const dimById = new Map(dims.map(d => [d.id, d]));
        const rootOf = (dimId: number): number => {
          let d = dimById.get(dimId); let cur = dimId;
          while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
          return cur;
        };
        const tagRows = await db.select().from(schema.tags).where(inArray(schema.tags.id, ids));
        const rootByTag = new Map(tagRows.map(t => [t.id, rootOf(t.dimensionId)]));
        const rootDims = new Set([...rootByTag.values()]);
        const ats = await db.select().from(schema.artworkTags).where(inArray(schema.artworkTags.tagId, ids));
        const hits = new Map<number, Set<number>>();
        for (const at of ats) {
          const root = rootByTag.get(at.tagId);
          if (root == null) continue;
          const s = hits.get(at.artworkId) ?? new Set<number>();
          s.add(root); hits.set(at.artworkId, s);
        }
        const allowed = [...hits.entries()].filter(([, s]) => s.size === rootDims.size).map(([id]) => id);
        if (!allowed.length) return [];
        conds.push(inArray(schema.artworks.id, allowed));
      }
    }

    const rows = conds.length
      ? await db.select().from(schema.artworks).where(and(...conds))
      : await db.select().from(schema.artworks);
    rows.sort((a, b) => sort === 'old' ? a.id - b.id : b.id - a.id);

    return this.attachTagsAndArtist(rows);
  }

  async getOne(id: number) {
    const [row] = await db.select().from(schema.artworks).where(eq(schema.artworks.id, id));
    if (!row) return null;
    const [withTags] = await this.attachTagsAndArtist([row]);
    return withTags;
  }

  async create(data: {
    artistId?: number; artistName?: string; title?: string; width?: number; height?: number;
    sourceUrl?: string; tagIds: number[]; file: Express.Multer.File;
  }) {
    // 解析画师：优先 artistId；否则按名字查/建（新作者自动入库）
    let artistId = data.artistId ?? null;
    if (!artistId && data.artistName) {
      const all = await db.select().from(schema.artists);
      const ex = all.find(a => (a.name || '').trim() === data.artistName!.trim());
      if (ex) artistId = ex.id;
      else {
        const [r] = await db.insert(schema.artists).values({ name: data.artistName.trim() });
        artistId = (r as any).insertId;
      }
    }
    const orientation = deriveOrientation(data.width, data.height);
    const ext = data.file.originalname.split('.').pop() || 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, filename), data.file.buffer);

    // 感知哈希 + 近重复检测
    let imageHash: string | null = null;
    let duplicateOf: number | null = null;
    try {
      imageHash = await aHash(data.file.buffer);
      if (imageHash) {
        const all = await db.select({ id: schema.artworks.id, hash: schema.artworks.imageHash })
          .from(schema.artworks).where(isNotNull(schema.artworks.imageHash));
        const dup = all.find(a => a.hash && hamming(imageHash!, a.hash) <= DEDUP_THRESHOLD);
        if (dup) duplicateOf = dup.id;
      }
    } catch {}

    const [art] = await db.insert(schema.artworks).values({
      artistId: artistId || null,
      title: data.title || null,
      imageUrl: `/uploads/${filename}`,
      thumbUrl: `/uploads/${filename}`,
      width: data.width || null,
      height: data.height || null,
      orientation,
      imageHash,
      sourcePlatform: 'manual',
      sourceUrl: data.sourceUrl || null,
      tagStatus: 'confirmed',
    });
    const artId = (art as any).insertId;
    if (data.tagIds?.length) {
      await db.insert(schema.artworkTags).values(
        data.tagIds.map(tagId => ({ artworkId: artId, tagId, source: 'manual' as const, confidence: 1 }))
      );
    }
    const out = await this.getOne(artId);
    return duplicateOf ? { ...out, duplicateOf } : out;
  }

  // 硬删作品：删关联标签 + 删记录 + 删 uploads 图文件
  async remove(id: number) {
    const [row] = await db.select().from(schema.artworks).where(eq(schema.artworks.id, id));
    if (!row) throw new Error('作品不存在');
    await db.delete(schema.artworkTags).where(eq(schema.artworkTags.artworkId, id));
    await db.delete(schema.artworks).where(eq(schema.artworks.id, id));
    // 删本地图文件（仅删 /uploads 下的、非外链）
    for (const p of [row.imageUrl, row.thumbUrl]) {
      if (p && p.startsWith('/uploads/')) {
        try { await unlink(join(process.cwd(), p.replace(/^\//, ''))); } catch {}
      }
    }
    return { id, deleted: true };
  }

  // 以图搜图：给定图 buffer，找海明距离 ≤ 阈值的作品
  async similarByImage(buf: Buffer) {
    const hash = await aHash(buf);
    const all = await db.select().from(schema.artworks).where(isNotNull(schema.artworks.imageHash));
    return all
      .map(a => ({ ...a, distance: hamming(hash, a.imageHash!) }))
      .filter(a => a.distance <= DEDUP_THRESHOLD * 2)
      .sort((a, b) => a.distance - b.distance);
  }
  // 按已有作品 id 找相似
  async similarById(id: number) {
    const [me] = await db.select().from(schema.artworks).where(eq(schema.artworks.id, id));
    if (!me?.imageHash) return [];
    const all = await db.select().from(schema.artworks).where(isNotNull(schema.artworks.imageHash));
    return all
      .filter(a => a.id !== id)
      .map(a => ({ ...a, distance: hamming(me.imageHash!, a.imageHash!) }))
      .filter(a => a.distance <= DEDUP_THRESHOLD * 2)
      .sort((a, b) => a.distance - b.distance);
  }

  private async attachTagsAndArtist(rows: any[]) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const ats = await db.select().from(schema.artworkTags).where(inArray(schema.artworkTags.artworkId, ids));
    const tagIds = [...new Set(ats.map(a => a.tagId))];
    const tagRows = tagIds.length ? await db.select().from(schema.tags).where(inArray(schema.tags.id, tagIds)) : [];
    const tagById = new Map(tagRows.map(t => [t.id, t]));
    const tagsByArt = new Map<number, any[]>();
    for (const at of ats) {
      const t = tagById.get(at.tagId); if (!t) continue;
      const arr = tagsByArt.get(at.artworkId) ?? [];
      arr.push({ id: t.id, label: t.label, dimensionId: t.dimensionId, source: at.source });
      tagsByArt.set(at.artworkId, arr);
    }
    const artistIds = [...new Set(rows.map(r => r.artistId).filter(Boolean))];
    const artistRows = artistIds.length ? await db.select().from(schema.artists).where(inArray(schema.artists.id, artistIds)) : [];
    const artistById = new Map(artistRows.map(a => [a.id, a.name]));
    return rows.map(r => ({
      ...r, tags: tagsByArt.get(r.id) ?? [], artistName: artistById.get(r.artistId) ?? null,
    }));
  }
}
