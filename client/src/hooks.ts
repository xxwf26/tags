import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchTags, fetchArtworks, fetchArtists, fetchArtist, createArtwork, type Artwork } from './api';

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: fetchTags });
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
export function useCreateArtwork() {
  const qc = useQueryClient();
  return useMutation<Artwork, Error, FormData>({
    mutationFn: createArtwork,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['artworks'] }); qc.invalidateQueries({ queryKey: ['artists'] }); qc.invalidateQueries({ queryKey: ['artist'] }); },
  });
}
