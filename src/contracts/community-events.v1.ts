import { z } from 'zod';

export const EVENT_ALBUM_SOURCE_SERVICE_ID = 'official.community-events.album-source.v1';
export const EVENT_ALBUM_SOURCE_LIST_METHOD = 'listCandidates';
export const EVENT_ALBUM_SOURCE_RESOLVE_METHOD = 'resolve';

export const EVENT_SUBGROUP_OWNERSHIP_SERVICE_ID = 'official.community-events.subgroup-ownership.v1';
export const EVENT_SUBGROUP_OWNERSHIP_RESOLVE_METHOD = 'resolve';

export const EVENT_ALBUM_SOURCE_DEFAULT_LIMIT = 12;
export const EVENT_ALBUM_SOURCE_MAX_LIMIT = 24;
export const EVENT_ALBUM_SOURCE_DEFAULT_LOOKBACK_DAYS = 180;
export const EVENT_ALBUM_SOURCE_DEFAULT_LOOKAHEAD_DAYS = 60;

export const eventAlbumSourceListInputSchema = z.object({
  referenceTime: z.string().datetime().optional(),
  lookbackDays: z.number().int().min(0).max(730).default(EVENT_ALBUM_SOURCE_DEFAULT_LOOKBACK_DAYS),
  lookaheadDays: z.number().int().min(0).max(730).default(EVENT_ALBUM_SOURCE_DEFAULT_LOOKAHEAD_DAYS),
  limit: z.number().int().min(1).max(EVENT_ALBUM_SOURCE_MAX_LIMIT).default(EVENT_ALBUM_SOURCE_DEFAULT_LIMIT)
}).strict();

export const eventAlbumSourceResolveInputSchema = z.object({
  eventId: z.string().trim().min(1).max(128)
}).strict();

export const eventAlbumSourceSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(512),
  startsAt: z.string().datetime(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().trim().min(1).max(128),
  place: z.string().trim().min(1).max(2048),
  eventStatus: z.enum(['active', 'completed'])
}).strict();

export const eventAlbumSourceListOutputSchema = z.object({
  generatedAt: z.string().datetime(),
  candidates: z.array(eventAlbumSourceSchema).max(EVENT_ALBUM_SOURCE_MAX_LIMIT)
}).strict();

export const eventAlbumSourceResolveOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    event: eventAlbumSourceSchema
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['not_found', 'wrong_scope', 'ineligible'])
  }).strict()
]);

export const eventSubgroupOwnershipResolveInputSchema = z.object({
  subgroupChatId: z.string().trim().min(1).max(256)
}).strict();

export const eventSubgroupOwnershipResolveOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unowned') }).strict(),
  z.object({
    kind: z.literal('owned'),
    eventId: z.string().trim().min(1).max(128)
  }).strict(),
  z.object({
    kind: z.literal('ambiguous'),
    eventIds: z.array(z.string().trim().min(1).max(128)).min(2)
  }).strict()
]);

export type EventAlbumSourceListInput = z.infer<typeof eventAlbumSourceListInputSchema>;
export type EventAlbumSource = z.infer<typeof eventAlbumSourceSchema>;
export type EventAlbumSourceListOutput = z.infer<typeof eventAlbumSourceListOutputSchema>;
export type EventAlbumSourceResolveInput = z.infer<typeof eventAlbumSourceResolveInputSchema>;
export type EventAlbumSourceResolveOutput = z.infer<typeof eventAlbumSourceResolveOutputSchema>;
export type EventSubgroupOwnershipResolveInput = z.infer<typeof eventSubgroupOwnershipResolveInputSchema>;
export type EventSubgroupOwnershipResolveOutput = z.infer<typeof eventSubgroupOwnershipResolveOutputSchema>;
