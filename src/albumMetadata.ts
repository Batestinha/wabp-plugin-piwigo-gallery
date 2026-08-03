import { z } from 'zod';
import { eventAlbumSourceSchema } from '../community-events/serviceApi';

export const galleryAlbumSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  eventAlbumSourceSchema.extend({ kind: z.literal('community-event') }).strict()
]);

export type GalleryAlbumSource = z.infer<typeof galleryAlbumSourceSchema>;

export function manualGalleryAlbumSource(): GalleryAlbumSource {
  return { kind: 'manual' };
}

export function galleryAlbumSourceRef(source: GalleryAlbumSource): string | undefined {
  return source.kind === 'community-event' ? source.eventId : undefined;
}

export function galleryAlbumSourceSnapshot(source: GalleryAlbumSource): string | undefined {
  return source.kind === 'community-event' ? JSON.stringify(source) : undefined;
}

export function parseGalleryAlbumSource(input: {
  kind?: string | null | undefined;
  ref?: string | null | undefined;
  snapshotJson?: string | null | undefined;
}): GalleryAlbumSource {
  if (!input.kind || input.kind === 'manual') {
    return manualGalleryAlbumSource();
  }
  if (input.kind !== 'community-event' || !input.ref || !input.snapshotJson) {
    throw new Error(`Invalid gallery album source row: ${input.kind}`);
  }
  const parsed = galleryAlbumSourceSchema.parse(JSON.parse(input.snapshotJson));
  if (parsed.kind !== 'community-event' || parsed.eventId !== input.ref) {
    throw new Error('Gallery album source reference does not match its snapshot.');
  }
  return parsed;
}
