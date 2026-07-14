import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchTags, fetchTagsAll, fetchArtworks, fetchArtists, fetchArtist, createArtwork, updateEngage, tagArtwork, tagBatch, confirmArtwork, crawlNote, fetchCandidates, promoteCandidate, rejectCandidate, searchByImage, createTag, updateTag, deleteTag, createDimension, type Artwork, type Artist } from './api';

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: fetchTags });
}
export function useTagsAll() {
  return useQuery({ queryKey: ['tags', 'all'], queryFn: fetchTagsAll });
}
export function useArtworks(p: { tags?: number[]; orient?: string; kw?: string; artistId?: number; sort?: string }) {
  return useQuery({ queryKey: ['artworks', p], queryFn: () => fetchArtworks(p) });
}
export function useArtists() {
  return useQuery({ queryKey: ['artists'], queryFn: fetchArtists });
}
export function useArtist(id?: number) {
  return useQuery({ queryKey: ['artist', id], queryFn: () => fetchArtist(id!), enabled: !!id });
}
export function useUpdateEngage(id: number) {
  const qc = useQueryClient();
  return useMutation<Artist, Error, { engageStatus?: string; engageNote?: string }>({
    mutationFn: (body) => updateEngage(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artist', id] }); qc.invalidateQueries({ queryKey: ['artists'] }); },
  });
}
export function useCreateArtwork() {
  const qc = useQueryClient();
  return useMutation<Artwork, Error, FormData>({
    mutationFn: createArtwork,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); qc.invalidateQueries({ queryKey: ['artist'] }); },
  });
}
export function useTagArtwork() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => tagArtwork(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artist'] }); } });
}
export function useTagBatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => tagBatch(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); qc.invalidateQueries({ queryKey: ['artist'] }); } });
}
export function useConfirmArtwork() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => confirmArtwork(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artist'] }); } });
}
export function useCandidates(status = 'pending') {
  return useQuery({ queryKey: ['candidates', status], queryFn: () => fetchCandidates(status) });
}
export function useCrawlNote() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: crawlNote, onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }) });
}
export function usePromoteCandidate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, body }: { id: number; body: { artistId?: number; newArtist?: boolean } }) => promoteCandidate(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['candidates'] }); qc.invalidateQueries({ queryKey: ['artists'] }); qc.invalidateQueries({ queryKey: ['artworks'] }); } });
}
export function useRejectCandidate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => rejectCandidate(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }) });
}
export function useImageSearch() {
  return useMutation({ mutationFn: (file: File) => searchByImage(file) });
}
export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createTag, onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }) });
}
export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, body }: { id: number; body: any }) => updateTag(id, body), onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }) });
}
export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => deleteTag(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }) });
}
export function useCreateDimension() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createDimension, onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }) });
}
