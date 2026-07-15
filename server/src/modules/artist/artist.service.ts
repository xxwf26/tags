import { Injectable } from '@nestjs/common';
import { db, schema } from '../../database/db.js';
import { eq, inArray, desc, isNull, and } from 'drizzle-orm';
import { logOperation } from '../operation/op.js';

@Injectable()
export class ArtistService {
  async list() {
    const artists = await db.select().from(schema.artists);
    // 批量取每人作品（一次查全部，按画师归组）：封面/计数/平台来源/朝向
    const allWorks = await db.select({
      id: schema.artworks.id, artistId: schema.artworks.artistId,
      thumbUrl: schema.artworks.thumbUrl, imageUrl: schema.artworks.imageUrl,
      sourcePlatform: schema.artworks.sourcePlatform, orientation: schema.artworks.orientation,
    }).from(schema.artworks).where(isNull(schema.artworks.deletedAt)).orderBy(desc(schema.artworks.id));
    const coversByArtist = new Map<number, string[]>();
    const countByArtist = new Map<number, number>();
    const platformsByArtist = new Map<number, Set<string>>();
    const orientsByArtist = new Map<number, Set<string>>();
    const artistOf = new Map<number, number>(); // workId -> artistId
    for (const w of allWorks) {
      if (w.artistId == null) continue;
      countByArtist.set(w.artistId, (countByArtist.get(w.artistId) ?? 0) + 1);
      const arr = coversByArtist.get(w.artistId) ?? [];
      if (arr.length < 4) arr.push(w.thumbUrl || w.imageUrl);
      coversByArtist.set(w.artistId, arr);
      if (w.sourcePlatform) {
        let s = platformsByArtist.get(w.artistId); if (!s) { s = new Set<string>(); platformsByArtist.set(w.artistId, s); }
        s.add(w.sourcePlatform);
      }
      if (w.orientation) {
        let s = orientsByArtist.get(w.artistId); if (!s) { s = new Set<string>(); orientsByArtist.set(w.artistId, s); }
        s.add(w.orientation);
      }
      artistOf.set(w.id, w.artistId);
    }
    // 作品标签并集（按画师归组）
    const workIds = allWorks.map(w => w.id);
    const ats = workIds.length ? await db.select().from(schema.artworkTags).where(inArray(schema.artworkTags.artworkId, workIds)) : [];
    const tagIds = [...new Set(ats.map(a => a.tagId))];
    const tagRows = tagIds.length ? await db.select().from(schema.tags).where(inArray(schema.tags.id, tagIds)) : [];
    const tagById = new Map(tagRows.map(t => [t.id, t]));
    const tagsByArtist = new Map<number, Set<number>>();
    for (const at of ats) {
      const aid = artistOf.get(at.artworkId);
      if (aid == null) continue;
      const s = tagsByArtist.get(aid) ?? new Set<number>();
      s.add(at.tagId); tagsByArtist.set(aid, s);
    }
    return artists.map(a => ({
      ...a,
      total: countByArtist.get(a.id) ?? 0,
      coverThumbs: coversByArtist.get(a.id) ?? [],
      platforms: [...(platformsByArtist.get(a.id) ?? [])],
      orientations: [...(orientsByArtist.get(a.id) ?? [])],
      tags: [...(tagsByArtist.get(a.id) ?? [])].map(id => ({ id, label: tagById.get(id)?.label ?? '', dimensionId: tagById.get(id)?.dimensionId ?? null })),
    }));
  }

  async getOne(id: number) {
    const [a] = await db.select().from(schema.artists).where(eq(schema.artists.id, id));
    if (!a) return null;
    const dist = await this.styleDistribution(id);
    return { ...a, total: dist.total, styleDist: dist.styles, missingStyles: dist.missing };
  }

  async updateEngage(id: number, body: { engageStatus?: string; engageNote?: string }) {
    const patch: any = {};
    if (body.engageStatus) patch.engageStatus = body.engageStatus;
    if (body.engageNote !== undefined) patch.engageNote = body.engageNote;
    await db.update(schema.artists).set(patch).where(eq(schema.artists.id, id));
    await logOperation({ type: 'artist_engage', targetType: 'artist', targetId: id, summary: `更新建联状态：${body.engageStatus || ''}` });
    return this.getOne(id);
  }

  async create(body: { name: string; bio?: string; links?: any }) {
    const [r] = await db.insert(schema.artists).values({
      name: body.name,
      bio: body.bio ?? null,
      links: body.links ?? null,
    });
    const [a] = await db.select().from(schema.artists).where(eq(schema.artists.id, (r as any).insertId));
    await logOperation({ type: 'artist_create', targetType: 'artist', targetId: a?.id, summary: `新建画师「${body.name}」` });
    return a;
  }

  // 按名字查画师；不存在则新建（录入作品时作者可能未入库）
  async findOrCreateByName(name: string) {
    const all = await db.select().from(schema.artists);
    const ex = all.find(a => (a.name || '').trim() === name.trim());
    if (ex) return ex;
    return this.create({ name: name.trim() });
  }

  // 画风分布：按作品 genre 标签聚合 + 横竖计数 + 缺横/缺竖标记
  private async styleDistribution(artistId: number) {
    const works = await db.select().from(schema.artworks).where(and(eq(schema.artworks.artistId, artistId), isNull(schema.artworks.deletedAt)));
    const workIds = works.map(w => w.id);
    if (!workIds.length) return { total: 0, styles: [], missing: [] };

    // 所有作品标签
    const ats = await db.select().from(schema.artworkTags).where(inArray(schema.artworkTags.artworkId, workIds));
    const tagIds = [...new Set(ats.map(a => a.tagId))];
    const tagRows = tagIds.length ? await db.select().from(schema.tags).where(inArray(schema.tags.id, tagIds)) : [];
    const dims = await db.select().from(schema.tagDimensions);
    const dimById = new Map(dims.map(d => [d.id, d]));
    const rootOf = (dimId: number): number => {
      let d = dimById.get(dimId); let cur = dimId;
      while (d && d.parentId) { cur = d.parentId; d = dimById.get(cur); }
      return cur;
    };
    // 哪些维度 id 是 genre 顶层（code=genre）
    const genreDim = dims.find(d => d.code === 'genre' && !d.parentId);
    const genreSubIds = genreDim ? dims.filter(d => d.parentId === genreDim.id).map(d => d.id) : [];
    const genreDimIds = new Set([genreDim?.id, ...genreSubIds].filter(Boolean) as number[]);
    const isGenreTag = (dimId: number) => genreDimIds.has(rootOf(dimId)) || genreDimIds.has(dimId);

    // 作品 → genre 标签
    const genreByWork = new Map<number, string[]>();
    for (const at of ats) {
      const t = tagRows.find(x => x.id === at.tagId); if (!t) continue;
      if (!isGenreTag(t.dimensionId)) continue;
      const arr = genreByWork.get(at.artworkId) ?? [];
      arr.push(t.label); genreByWork.set(at.artworkId, arr);
    }

    const counts = new Map<string, { style: string; count: number; h: number; v: number }>();
    for (const w of works) {
      const labels = genreByWork.get(w.id) ?? ['未分类'];
      for (const style of labels) {
        const e = counts.get(style) ?? { style, count: 0, h: 0, v: 0 };
        e.count++;
        if (w.orientation === '横') e.h++; else if (w.orientation === '竖') e.v++;
        counts.set(style, e);
      }
    }
    const styles = [...counts.values()]
      .map(e => ({ ...e, both: e.h > 0 && e.v > 0, missingOrient: e.h === 0 ? '横' : e.v === 0 ? '竖' : null }))
      .sort((a, b) => b.count - a.count);
    return { total: works.length, styles, missing: [] };
  }
}
