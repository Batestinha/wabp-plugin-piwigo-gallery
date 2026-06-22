import { randomUUID } from 'node:crypto';
import type { FlowDefinition } from '../../../adminBot/flows/flowTypes';
import type { FlowSessionSnapshot } from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import type { PiwigoPerson } from './piwigoClient';

export function createGalleryUploadFlowDefinition(input: {
  t: TranslateFn;
  people: PiwigoPerson[];
}): FlowDefinition {
  const flowType = `official.piwigo-gallery.upload.${randomUUID()}`;
  return {
    flowType,
    initialStepId: 'onde',
    context: 'group',
    timeoutMinutes: 30,
    completionReply: input.t('official.piwigo-gallery.flow.complete'),
    steps: {
      onde: {
        id: 'onde',
        kind: 'text',
        prompt: input.t('official.piwigo-gallery.flow.where'),
        nextStepId: 'quando'
      },
      quando: {
        id: 'quando',
        kind: 'text',
        prompt: input.t('official.piwigo-gallery.flow.when'),
        nextStepId: 'com'
      },
      com: {
        id: 'com',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.with'),
        options: input.people.map((person) => ({ label: person.label, value: person.id })),
        minSelections: 1,
        maxSelections: input.people.length,
        presentation: 'text',
        nextStepId: 'confirmar'
      },
      confirmar: {
        id: 'confirmar',
        kind: 'choice',
        prompt: input.t('official.piwigo-gallery.flow.confirm'),
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' }
        ],
        minSelections: 1,
        maxSelections: 1,
        presentation: 'text'
      }
    }
  };
}

export function galleryConfirmPurpose(flowType: string): string {
  return `flow.${flowType}.confirmar`;
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
