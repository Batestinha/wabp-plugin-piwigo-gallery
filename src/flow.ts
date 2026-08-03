import type { FlowDefinition } from '../../../adminBot/flows/flowTypes';
import type { FlowSessionSnapshot } from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import type { PiwigoPerson } from './piwigoClient';

export const PIWIGO_GALLERY_UPLOAD_FLOW_TYPE = 'official.piwigo-gallery.upload.v1';

interface GalleryFlowCopy {
  where: string;
  when: string;
  with: string;
  confirm: string;
  yes: string;
  no: string;
}

interface GalleryFlowStateData {
  copy: GalleryFlowCopy;
  people: PiwigoPerson[];
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
        promptForState: (state) => galleryFlowStateData(state.data)?.copy.confirm
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
  targetLabel?: string | undefined;
}): Record<string, unknown> {
  return {
    gallery: {
      copy: {
        where: input.t('official.piwigo-gallery.flow.where'),
        when: input.t('official.piwigo-gallery.flow.when'),
        with: input.t('official.piwigo-gallery.flow.with'),
        confirm: input.t('official.piwigo-gallery.flow.confirm'),
        yes: input.t('official.piwigo-gallery.flow.yes'),
        no: input.t('official.piwigo-gallery.flow.no')
      },
      people: input.people.map((person) => ({ id: person.id, label: person.label })),
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
} | undefined {
  const onde = typeof snapshot.state.data.onde === 'string' ? snapshot.state.data.onde.trim() : '';
  const quando = typeof snapshot.state.data.quando === 'string' ? snapshot.state.data.quando.trim() : '';
  const rawWith = Array.isArray(snapshot.state.data.com) ? snapshot.state.data.com : [];
  const withUserIds = rawWith.map((entry) => Number(entry)).filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  if (!onde || !/^\d{2}-\d{2}-\d{4}$/.test(quando) || withUserIds.length === 0) {
    return undefined;
  }
  return { onde, quando, withUserIds };
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
  const targetLabel = typeof gallery.targetLabel === 'string' ? gallery.targetLabel.trim() : '';
  return {
    copy: copy as unknown as GalleryFlowCopy,
    people,
    ...(targetLabel ? { targetLabel } : {})
  };
}
