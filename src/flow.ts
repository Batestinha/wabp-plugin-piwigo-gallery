import type { FlowDefinition } from '@wabs/plugin-sdk/flow-types';
import type { FlowSessionSnapshot } from './runtime';
import type { TranslateFn } from '@wabs/plugin-sdk/i18n';
import type { PiwigoPerson } from './piwigoClient';
import type { EventAlbumSource } from './contracts/community-events.v1';
import { manualGalleryAlbumSource, type GalleryAlbumSource } from './albumMetadata';

export const PIWIGO_GALLERY_UPLOAD_FLOW_TYPE = 'official.piwigo-gallery.upload.v1';

interface GalleryFlowCopy {
  source?: string | undefined;
  sourceManual?: string | undefined;
  sourceEvent?: string | undefined;
  event?: string | undefined;
  where: string;
  when: string;
  with: string;
  confirm: string;
  confirmWhere?: string | undefined;
  confirmWhen?: string | undefined;
  confirmEvent?: string | undefined;
  yes: string;
  no: string;
}

interface GalleryEventCandidate extends EventAlbumSource {
  label: string;
}

interface GalleryFlowStateData {
  copy: GalleryFlowCopy;
  people: PiwigoPerson[];
  eventCandidates: GalleryEventCandidate[];
  targetLabel?: string | undefined;
}

export function createGalleryUploadFlowDefinition(input: {
  t: TranslateFn;
}): FlowDefinition {
  return {
    flowType: PIWIGO_GALLERY_UPLOAD_FLOW_TYPE,
    t: input.t,
    initialStepId: 'onde',
    context: 'private',
    timeoutMinutes: 30,
    completionReply: false,
    steps: {
      source: {
        id: 'source',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.source'),
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.source
          ?? input.t('official.piwigo-gallery.flow.source'),
        optionsForState: (state) => {
          const copy = galleryFlowStateData(state.data)?.copy;
          return [
            {
              label: copy?.sourceManual ?? input.t('official.piwigo-gallery.flow.source.manual'),
              value: 'manual'
            },
            {
              label: copy?.sourceEvent ?? input.t('official.piwigo-gallery.flow.source.event'),
              value: 'community-event'
            }
          ];
        },
        minSelections: 1,
        maxSelections: 1,
        nextStepIdByValue: {
          manual: 'onde',
          'community-event': 'event'
        }
      },
      event: {
        id: 'event',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.event'),
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.event
          ?? input.t('official.piwigo-gallery.flow.event'),
        optionsForState: (state) => (galleryFlowStateData(state.data)?.eventCandidates ?? [])
          .map((event) => ({ label: event.label, value: event.eventId })),
        minSelections: 1,
        maxSelections: 1,
        nextStepId: 'com'
      },
      onde: {
        id: 'onde',
        kind: 'text',
        prompt: input.t('official.piwigo-gallery.flow.where'),
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.where
          ?? input.t('official.piwigo-gallery.flow.where'),
        nextStepId: 'quando'
      },
      quando: {
        id: 'quando',
        kind: 'text',
        prompt: input.t('official.piwigo-gallery.flow.when'),
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.when
          ?? input.t('official.piwigo-gallery.flow.when'),
        nextStepId: 'com'
      },
      com: {
        id: 'com',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.with'),
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.with
          ?? input.t('official.piwigo-gallery.flow.with'),
        optionsForState: (state) => (galleryFlowStateData(state.data)?.people ?? [])
          .map((person) => ({ label: person.label, value: person.id })),
        minSelections: 1,
        maxSelectionsForState: (state) => galleryFlowStateData(state.data)?.people.length,
        nextStepId: 'confirmar'
      },
      confirmar: {
        id: 'confirmar',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.confirm'),
        promptForState: (state) => galleryConfirmationPrompt(state.data)
          ?? input.t('official.piwigo-gallery.flow.confirm'),
        optionsForState: (state) => {
          const copy = galleryFlowStateData(state.data)?.copy;
          return [
            { label: copy?.yes ?? input.t('official.piwigo-gallery.flow.yes'), value: 'yes' },
            { label: copy?.no ?? input.t('official.piwigo-gallery.flow.no'), value: 'no' }
          ];
        },
        minSelections: 1,
        maxSelections: 1
      }
    }
  };
}

export function galleryUploadFlowInitialData(input: {
  t: TranslateFn;
  people: PiwigoPerson[];
  eventCandidates?: EventAlbumSource[] | undefined;
  targetLabel?: string | undefined;
}): Record<string, unknown> {
  return {
    gallery: {
      copy: {
        source: input.t('official.piwigo-gallery.flow.source'),
        sourceManual: input.t('official.piwigo-gallery.flow.source.manual'),
        sourceEvent: input.t('official.piwigo-gallery.flow.source.event'),
        event: input.t('official.piwigo-gallery.flow.event'),
        where: input.t('official.piwigo-gallery.flow.where'),
        when: input.t('official.piwigo-gallery.flow.when'),
        with: input.t('official.piwigo-gallery.flow.with'),
        confirm: input.t('official.piwigo-gallery.flow.confirm'),
        confirmWhere: input.t('official.piwigo-gallery.flow.confirm.where'),
        confirmWhen: input.t('official.piwigo-gallery.flow.confirm.when'),
        confirmEvent: input.t('official.piwigo-gallery.flow.confirm.event'),
        yes: input.t('official.piwigo-gallery.flow.yes'),
        no: input.t('official.piwigo-gallery.flow.no')
      },
      people: input.people.map((person) => ({ id: person.id, label: person.label })),
      eventCandidates: (input.eventCandidates ?? []).map((event) => ({
        ...event,
        label: input.t('official.piwigo-gallery.flow.event.choice', {
          title: event.title,
          date: displayDate(event.localDate),
          place: event.place,
          eventId: event.eventId
        })
      })),
      ...(input.targetLabel?.trim() ? { targetLabel: input.targetLabel.trim() } : {})
    } satisfies GalleryFlowStateData
  };
}

export function galleryFlowTargetLabel(snapshot: FlowSessionSnapshot): string | undefined {
  return galleryFlowStateData(snapshot.state.data)?.targetLabel;
}

export function galleryConfirmPurpose(): string {
  return `flow.${PIWIGO_GALLERY_UPLOAD_FLOW_TYPE}.confirmar`;
}

export function galleryUploadBatchId(flowSessionId: string): string {
  const normalized = flowSessionId.trim();
  if (!normalized) {
    throw new Error('A gallery upload flow session ID is required.');
  }
  return `gallery-flow-${normalized}`;
}

export function galleryFlowConfirmed(snapshot: FlowSessionSnapshot): boolean {
  const value = snapshot.state.data.confirmar;
  return Array.isArray(value) ? value.includes('yes') : value === 'yes';
}

export function galleryFlowAnswers(snapshot: FlowSessionSnapshot): {
  onde: string;
  quando: string;
  withUserIds: number[];
  albumSource: GalleryAlbumSource;
} | undefined {
  const gallery = galleryFlowStateData(snapshot.state.data);
  const source = selectedValue(snapshot.state.data.source) ?? 'manual';
  let onde = typeof snapshot.state.data.onde === 'string' ? snapshot.state.data.onde.trim() : '';
  let quando = typeof snapshot.state.data.quando === 'string' ? snapshot.state.data.quando.trim() : '';
  let albumSource = manualGalleryAlbumSource();
  if (source === 'community-event') {
    const eventId = selectedValue(snapshot.state.data.event);
    const event = gallery?.eventCandidates.find((candidate) => candidate.eventId === eventId);
    if (!event) {
      return undefined;
    }
    onde = event.place;
    quando = displayDate(event.localDate);
    albumSource = {
      kind: 'community-event',
      eventId: event.eventId,
      revision: event.revision,
      title: event.title,
      startsAt: event.startsAt,
      localDate: event.localDate,
      ...(event.localTime ? { localTime: event.localTime } : {}),
      timezone: event.timezone,
      place: event.place,
      eventStatus: event.eventStatus
    };
  } else if (source !== 'manual') {
    return undefined;
  }
  const rawWith = Array.isArray(snapshot.state.data.com) ? snapshot.state.data.com : [];
  const withUserIds = rawWith.map((entry) => Number(entry)).filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  if (!onde || !/^\d{2}-\d{2}-\d{4}$/.test(quando) || withUserIds.length === 0) {
    return undefined;
  }
  return { onde, quando, withUserIds, albumSource };
}

function galleryFlowStateData(data: Record<string, unknown>): GalleryFlowStateData | undefined {
  if (typeof data.gallery !== 'object' || data.gallery === null) {
    return undefined;
  }
  const gallery = data.gallery as Record<string, unknown>;
  if (typeof gallery.copy !== 'object' || gallery.copy === null || !Array.isArray(gallery.people)) {
    return undefined;
  }
  const copy = gallery.copy as Record<string, unknown>;
  const requiredCopy = ['where', 'when', 'with', 'confirm', 'yes', 'no'] as const;
  if (!requiredCopy.every((key) => typeof copy[key] === 'string')) {
    return undefined;
  }
  const people = gallery.people.flatMap((person) => {
    if (typeof person !== 'object' || person === null) {
      return [];
    }
    const candidate = person as Record<string, unknown>;
    return Number.isSafeInteger(candidate.id) && Number(candidate.id) > 0 && typeof candidate.label === 'string'
      ? [{ id: Number(candidate.id), label: candidate.label }]
      : [];
  });
  if (people.length === 0) {
    return undefined;
  }
  const eventCandidates = Array.isArray(gallery.eventCandidates)
    ? gallery.eventCandidates.flatMap((event) => {
        const parsed = eventCandidate(event);
        return parsed ? [parsed] : [];
      })
    : [];
  const targetLabel = typeof gallery.targetLabel === 'string' ? gallery.targetLabel.trim() : '';
  return {
    copy: copy as unknown as GalleryFlowCopy,
    people,
    eventCandidates,
    ...(targetLabel ? { targetLabel } : {})
  };
}

function galleryConfirmationPrompt(data: Record<string, unknown>): string | undefined {
  const gallery = galleryFlowStateData(data);
  if (!gallery) {
    return undefined;
  }
  const source = selectedValue(data.source) ?? 'manual';
  const eventId = selectedValue(data.event);
  const event = gallery.eventCandidates.find((candidate) => candidate.eventId === eventId);
  const onde = source === 'community-event'
    ? event?.place
    : typeof data.onde === 'string' ? data.onde.trim() : undefined;
  const quando = source === 'community-event'
    ? event ? displayDate(event.localDate) : undefined
    : typeof data.quando === 'string' ? data.quando.trim() : undefined;
  if (!onde || !quando) {
    return gallery.copy.confirm;
  }
  if (!gallery.copy.confirmWhere || !gallery.copy.confirmWhen) {
    return gallery.copy.confirm;
  }
  return [
    gallery.copy.confirm,
    '',
    ...(event ? [`${gallery.copy.confirmEvent ?? gallery.copy.event ?? gallery.copy.confirm}: ${event.title}`] : []),
    `${gallery.copy.confirmWhere ?? gallery.copy.where}: ${onde}`,
    `${gallery.copy.confirmWhen ?? gallery.copy.when}: ${quando}`
  ].join('\n');
}

function eventCandidate(input: unknown): GalleryEventCandidate | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.eventId !== 'string'
    || typeof candidate.revision !== 'string'
    || typeof candidate.title !== 'string'
    || typeof candidate.startsAt !== 'string'
    || typeof candidate.localDate !== 'string'
    || typeof candidate.timezone !== 'string'
    || typeof candidate.place !== 'string'
    || typeof candidate.label !== 'string'
    || (candidate.eventStatus !== 'active' && candidate.eventStatus !== 'completed')
  ) {
    return undefined;
  }
  return candidate as unknown as GalleryEventCandidate;
}

function selectedValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function displayDate(localDate: string): string {
  const match = localDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}
