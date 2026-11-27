import { z } from 'zod';
import type { ManagedGroupCapabilities } from '@wabs/plugin-sdk/managed-group-plugin';
import { isPluginServiceNotInvokedError, type PluginServiceCallContext } from '@wabs/plugin-sdk/services';
import type { ServicePluginContext } from '@wabs/plugin-sdk/service-plugin';
import {
  EVENT_ALBUM_SOURCE_LIST_METHOD,
  EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
  EVENT_ALBUM_SOURCE_SERVICE_ID,
  eventAlbumSourceListOutputSchema,
  eventAlbumSourceResolveOutputSchema,
  type EventAlbumSource
} from './contracts/community-events.v1';

const capabilityId = 'gallery.media.upload.v1';
const kind = 'gallery.event-albums.v1';
const eventsPluginId = 'official.community-events';
export type EventAlbumContext = ServicePluginContext & Pick<ManagedGroupCapabilities, 'catalog'>;
const inputSchema = z.discriminatedUnion('operation', [
  z.object({ capabilityId: z.literal(capabilityId), operation: z.literal('invoke'),
    args: z.array(z.string().max(2000)).max(64) }).strict(),
  z.object({ capabilityId: z.literal(capabilityId), operation: z.literal('choice'),
    choiceId: z.string().min(1).max(512) }).strict()
]);

const albumSchema = z.object({
  eventId: z.string().min(1).max(128),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().min(1).max(500),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  place: z.string().min(1).max(500)
}).strict();
const outputSchema = z.object({
  kind: z.literal(kind),
  payload: z.union([
    z.object({ candidates: z.array(albumSchema).max(24) }).strict(),
    z.object({ selected: albumSchema.nullable() }).strict()
  ])
}).strict().nullable();

export function registerEventAlbumContext(context: EventAlbumContext) {
  return {
    serviceId: 'official.piwigo-gallery.capability-context.v1',
    methods: [{
      name: 'prepare',
      access: 'read' as const,
      inputSchema,
      outputSchema,
      async handler(raw: unknown, call: PluginServiceCallContext): Promise<z.infer<typeof outputSchema>> {
        if (call.callerPluginId !== 'official.integration-manager' || !call.actorIdentityId) return null;
        const input = inputSchema.parse(raw);
        const binding = {
          serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
          scopeId: call.scopeId,
          actorIdentityId: call.actorIdentityId,
          groupWid: call.groupWid,
          signal: call.signal
        };
        if (input.operation === 'invoke') {
          if (input.args.length > 0 && !(input.args.length === 1 && input.args[0]?.toLowerCase() === 'upload')) {
            return null;
          }
          const response = await readEvents(context, {
            ...binding, method: EVENT_ALBUM_SOURCE_LIST_METHOD, input: {}
          });
          const candidates = response === undefined ? [] :
            eventAlbumSourceListOutputSchema.parse(response).candidates.flatMap(event => {
              const source = galleryEvent(event);
              return source ? [source] : [];
            });
          return { kind, payload: { candidates } };
        }
        const match = /^(?:confirm:)?event-source:([a-f0-9]{64}):(.+)$/u.exec(input.choiceId);
        if (!match) return null;
        const [, revision, eventId] = match;
        const response = await readEvents(context, {
          ...binding, method: EVENT_ALBUM_SOURCE_RESOLVE_METHOD, input: { eventId }
        });
        const resolved = response === undefined ? undefined : eventAlbumSourceResolveOutputSchema.parse(response);
        const event = resolved?.kind === 'found' ? resolved.event : undefined;
        const selected = event && event.eventId === eventId && event.revision === revision ? galleryEvent(event) : null;
        return { kind, payload: { selected } };
      }
    }]
  };
}

async function readEvents(
  context: EventAlbumContext,
  input: Parameters<NonNullable<ServicePluginContext['services']>['call']>[0]
): Promise<unknown> {
  if (context.catalog && (await context.catalog.configFor(
    'official.piwigo-gallery', input.scopeId, input.actorIdentityId
  )).eventAlbumsEnabled === false) return undefined;
  if (context.catalog && (!await context.catalog.enabledFor(eventsPluginId, input.scopeId) ||
    (await context.catalog.configFor(eventsPluginId, input.scopeId, input.actorIdentityId)).enabled === false)) return undefined;
  try {
    return await context.services?.call(input);
  } catch (error) {
    if (isPluginServiceNotInvokedError(error)) return undefined;
    throw error;
  }
}

function galleryEvent(event: EventAlbumSource): z.infer<typeof albumSchema> | null {
  // Piwigo uses this reference and revision to bind retries to the same album.
  if (Buffer.byteLength(event.eventId, 'utf8') > 191 || /[\x00-\x1f\x7f]/u.test(event.eventId)) return null;
  const title = [...event.title.replace(/\s+/gu, ' ')].slice(0, 255).join('').trim();
  const place = [...event.place.replace(/\s+/gu, ' ')].slice(0, 255).join('').trim();
  const parsed = albumSchema.safeParse({ eventId: event.eventId, revision: event.revision, title,
    localDate: event.localDate, place });
  return parsed.success ? parsed.data : null;
}
