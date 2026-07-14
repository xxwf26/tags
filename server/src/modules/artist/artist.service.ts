import { Injectable } from '@nestjs/common';
import { db, schema } from '../../database/db.js';
import { eq, inArray, desc } from 'drizzle-orm';

@Injectable()
export class ArtistService {
  async list() {
    const artists = await db.select().from(schema.artists);
    // 批量取每人作品封面（一次查全部作品，按画师归组，各取前 4 张）—— 避免 N+1
    const allWorks = await db.select({
      id: schema.artworks.id, artistId: schema.artworks.artistId,
      thumbUrl: schema.artworks.thumbUrl, imageUrl: schema.artworks.imageUrl,
    }).from(schema.artworks).orderBy(desc(schema.artworks.id));
    const coversByArtist = new Map<number, string[]>();
    const countByArtist = new Map<number, number>();
    for (const w of allWorks) {
      if (w.artistId == null) continue;
      countByArtist.set(w.artistId, (countByArtist.get(w.artistId) ?? 0) + 1);
      const arr = coversByArtist.get(w.artistId) ?? [];
      if (arr.length < 4) arr.push(w.thumbUrl || w.imageUrl);
      coversByArtist.set(w.artistId, arr);
    }
    return artists.map(a => ({
      ...a,
      total: countByArtist.get(a.id) ?? 0,
      coverThumbs: coversByArtist.get(a.id) ?? [],
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
    return this.getOne(id);
  }

  async create(body: { name: string; bio?: string; links?: any }) {
    const [r] = await db.insert(schema.artists).values({
      name: body.name,
      bio: body.bio ?? null,
      links: body.links ?? null,
    });
    const [a] = await db.select().from(schema.artists).where(eq(schema.artists.id, (r as any).insertId));
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
    const works = await db.select().from(schema.artworks).where(eq(schema.artworks.artistId, artistId));
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
