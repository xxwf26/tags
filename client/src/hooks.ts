import { useQuery, useMutation, useQueryClient, useQueries } from '@tanstack/react-query';
import { fetchTags, fetchTagsAll, fetchArtworks, fetchArtists, fetchArtist, createArtwork, deleteArtwork, setArtworkTags, updateEngage, tagArtwork, tagBatch, confirmArtwork, searchByImage, createTag, updateTag, deleteTag, createDimension, fetchMihuashiFilterChips, fetchOperations, undoOperation, redoOperation, type Artwork, type Artist, uploadReference, fetchReferences, updateReferenceTags, startSearch, fetchSearchSessions, fetchSearchResults, reviewSearchResult, promoteSearchResult, rejectSearchResult, deleteReference, startDiscover, fetchDiscoverTask, fetchDiscoverResults, reviewDiscover, promoteDiscover, rejectDiscover } from './api'

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
export function useDeleteArtwork() {
  const qc = useQueryClient();
  return useMutation<{ id: number; deleted: boolean }, Error, number>({
    mutationFn: (id) => deleteArtwork(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); qc.invalidateQueries({ queryKey: ['artist'] }); },
  });
}
export function useSetArtworkTags() {
  const qc = useQueryClient();
  return useMutation<Artwork, Error, { id: number; tagIds: number[] }>({
    mutationFn: ({ id, tagIds }) => setArtworkTags(id, tagIds),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artist'] }); },
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
export function useMihuashiFilterChips() {
  return useQuery({ queryKey: ['mihuashi-filter-chips'], queryFn: fetchMihuashiFilterChips, staleTime: 600000 });
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
export function useOperations(limit = 100) {
  return useQuery({ queryKey: ['operations', limit], queryFn: () => fetchOperations(limit) });
}
export function useUndoOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => undoOperation(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['operations'] }); qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); },
  });
}
export function useRedoOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => redoOperation(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['operations'] }); qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); },
  });
}

// ============ 寻源功能 ============
export function useReferences() {
  return useQuery({ queryKey: ['references'], queryFn: fetchReferences });
}
export function useUploadReference() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (file: File) => uploadReference(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['references'] }) });
}
export function useUpdateReferenceTags() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, manualTags }: { id: number; manualTags: any[] }) => updateReferenceTags(id, manualTags),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['references'] }) });
}
export function useStartSearch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: startSearch,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['search-sessions'] }); qc.invalidateQueries({ queryKey: ['search-results'] }); } });
}
export function useSearchSessions(referenceId: number) {
  return useQuery({ queryKey: ['search-sessions', referenceId], queryFn: () => fetchSearchSessions(referenceId), enabled: !!referenceId });
}
export function useSearchResults(sessionId: number, tier?: string) {
  return useQuery({ queryKey: ['search-results', sessionId, tier], queryFn: () => fetchSearchResults(sessionId, tier), enabled: !!sessionId });
}
export function useReviewSearchResult() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => reviewSearchResult(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search-results'] }) });
}
export function usePromoteSearchResult() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => promoteSearchResult(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['search-results'] }); qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); } });
}
export function useRejectSearchResult() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => rejectSearchResult(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search-results'] }) });
}
export function useDeleteReference() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => deleteReference(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['references'] }); qc.invalidateQueries({ queryKey: ['search-sessions'] }); } });
}

// ============ 发现（按画风搜作品，独立于寻源） ============
export function useStartDiscover() {
  return useMutation({ mutationFn: startDiscover });
}
export function useDiscoverTask(sessionId: number | null) {
  return useQuery({
    queryKey: ['discover-task', sessionId],
    queryFn: () => fetchDiscoverTask(sessionId!),
    enabled: !!sessionId,
    refetchInterval: (q) => (q.state.data && q.state.data.status === 'running' ? 1500 : false),
  });
}
// 并行轮询多个发现 session 的任务状态（支持多版本并行寻源）。running 的每 1.5s 刷新，完成的停。
export function useDiscoverSessions(ids: number[]) {
  return useQueries({
    queries: ids.map(id => ({
      queryKey: ['discover-task', id],
      queryFn: () => fetchDiscoverTask(id),
      enabled: !!id,
      refetchInterval: (q: any) => (q.state.data && q.state.data.status === 'running' ? 2000 : false),
    })),
  });
}
export function useDiscoverResults(sessionId: number, tier?: string) {
  return useQuery({ queryKey: ['discover-results', sessionId, tier], queryFn: () => fetchDiscoverResults(sessionId, tier), enabled: !!sessionId });
}
export function useReviewDiscover() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => reviewDiscover(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discover-results'] }) });
}
export function usePromoteDiscover() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => promoteDiscover(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discover-results'] }); qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); } });
}
export function useRejectDiscover() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => rejectDiscover(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discover-results'] }) });
}
