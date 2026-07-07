import type {
  PluginJobEvent,
  PluginMessageEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import { parsePiwigoGalleryConfig } from './config';
import { PIWIGO_GALLERY_FINALIZE_JOB, PIWIGO_GALLERY_PLUGIN_ID } from './manifest';
import { PiwigoGalleryClient } from './piwigoClient';
import {
  clearActiveBatch,
  getActiveBatchForActorWids,
  getBatch,
  resolveGalleryConnection,
  saveBatch,
  type GalleryBatchFile,
  type GalleryUploadBatch
} from './store';

const batchMutationLocks = new Map<string, Promise<unknown>>();

export function createPiwigoGalleryHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  return {
    async onMessage(event) {
      return handleMessage(context, event);
    },
    async onPluginJob(job) {
      if (job.jobName === PIWIGO_GALLERY_FINALIZE_JOB) {
        return finalizeBatch(context, job);
      }
    }
  };
}

async function handleMessage(
  context: PluginRuntimeContext,
  event: PluginMessageEvent
): Promise<PluginAction[] | void> {
  const config = parsePiwigoGalleryConfig(await context.configFor(event.scopeId, event.actorWid));
  if (!config.enabled || event.isCommandLike) {
    return;
  }
  const batch = await getActiveBatchForActorWids(context.dataStore, event.scopeId, event.message.chatId, eventActorWids(event));
  if (!batch || batch.status !== 'collecting') {
    return;
  }
  if (!event.message.hasMedia) {
    return;
  }
  if (event.message.type.toLowerCase() !== 'document') {
    return [await reply(context, event, 'official.piwigo-gallery.sendAsDocument')];
  }
  if (!context.mediaStore) {
    return [await reply(context, event, 'official.piwigo-gallery.failed', {
      reason: await t(context, event.scopeId, event.actorWid, 'official.piwigo-gallery.error.mediaRuntimeUnavailable')
    })];
  }

  const staged = await context.mediaStore.stageMessage(event.message.id, {
    fallbackFilename: fallbackFilename(event.message.mediaMimeType),
    allowedExtensions: batch.acceptedExtensions,
    maxBytes: batch.maxFileBytes
  });
  if (!staged.ok) {
    const key = staged.reason === 'too-large'
      ? 'official.piwigo-gallery.fileTooLarge'
      : staged.reason === 'not-found'
        ? 'official.piwigo-gallery.mediaUnavailable'
        : 'official.piwigo-gallery.fileRejected';
    return [await reply(context, event, key)];
  }

  const file: GalleryBatchFile = {
    mediaId: staged.media.id,
    messageId: event.message.id,
    filename: staged.media.filename,
    mimeType: staged.media.mimeType,
    sizeBytes: staged.media.sizeBytes,
    status: 'staged'
  };
  const append = await appendStagedFile(context, event, batch.id, file);
  if (!append || append.duplicate) {
    return;
  }

  return [
    {
      type: 'message.sendText',
      chatId: event.message.chatId,
      quotedMessageId: event.message.id,
      text: await t(context, event.scopeId, event.actorWid, 'official.piwigo-gallery.documentStaged', {
        count: String(append.fileCount)
      })
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: event.scopeId,
      runAt: append.autoFinalizeAt,
      payload: { batchId: batch.id }
    }
  ];
}

async function appendStagedFile(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  batchId: string,
  file: GalleryBatchFile
): Promise<{ fileCount: number; autoFinalizeAt: Date; duplicate: boolean } | undefined> {
  const lockKey = `${event.scopeId}:${batchId}`;
  return withBatchMutationLock(lockKey, async () => {
    const batch = await getBatch(context.dataStore, event.scopeId, batchId);
    if (!batch || batch.status !== 'collecting') {
      await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
      return undefined;
    }
    if (batch.files.some((existing) => existing.messageId === file.messageId)) {
      await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
      return {
        fileCount: batch.files.length,
        autoFinalizeAt: new Date(batch.autoFinalizeAt),
        duplicate: true
      };
    }

    const now = new Date();
    const autoFinalizeAt = new Date(now.getTime() + batch.autoFinalizeMinutes * 60_000);
    batch.files.push(file);
    batch.updatedAt = now.toISOString();
    batch.autoFinalizeAt = autoFinalizeAt.toISOString();
    await saveBatch(context.dataStore, batch);
    return {
      fileCount: batch.files.length,
      autoFinalizeAt,
      duplicate: false
    };
  });
}

async function withBatchMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = batchMutationLocks.get(key) ?? Promise.resolve();
  let current!: Promise<T>;
  current = (async () => {
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      if (batchMutationLocks.get(key) === current) {
        batchMutationLocks.delete(key);
      }
    }
  })();
  batchMutationLocks.set(key, current);
  return current;
}

async function finalizeBatch(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const batchId = batchIdFromPayload(job.payload);
  if (!batchId) {
    return [{ type: 'audit.record', action: 'piwigo-gallery.finalize.skipped', metadataJson: { reason: 'missing batchId' } }];
  }
  const batch = await getBatch(context.dataStore, job.scopeId, batchId);
  if (!batch || (batch.status !== 'collecting' && batch.status !== 'uploading')) {
    return;
  }

  const forced = forcedFromPayload(job.payload);
  const autoFinalizeAt = new Date(batch.autoFinalizeAt);
  if (!forced && batch.status === 'collecting' && autoFinalizeAt.getTime() > Date.now() + 1000) {
    return [{
      type: 'plugin.enqueueJob',
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: batch.scopeId,
      runAt: autoFinalizeAt,
      payload: { batchId: batch.id }
    }];
  }

  if (batch.files.filter((file) => file.status === 'staged').length === 0) {
    batch.status = batch.files.length === 0 ? 'expired' : 'completed';
    batch.updatedAt = new Date().toISOString();
    await saveBatch(context.dataStore, batch);
    await clearActiveBatch(context.dataStore, batch);
    return [{
      type: 'message.sendText',
      chatId: batch.chatId,
      text: await t(context, batch.scopeId, batch.actorWid, batch.files.length === 0
        ? 'official.piwigo-gallery.expiredEmpty'
        : 'official.piwigo-gallery.completed', {
          uploaded: String(batch.files.length),
          album: batch.albumLabel ?? ''
        })
    }];
  }

  const config = parsePiwigoGalleryConfig(await context.configFor(batch.scopeId, batch.actorWid));
  const connection = await resolveGalleryConnection(
    context.dataStore,
    config,
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    return failBatch(context, batch, 'Gallery connection is not configured.');
  }
  if (!context.mediaStore) {
    return failBatch(context, batch, 'Media runtime unavailable.');
  }

  batch.status = 'uploading';
  batch.updatedAt = new Date().toISOString();
  await saveBatch(context.dataStore, batch);

  const client = new PiwigoGalleryClient(connection);
  for (const file of batch.files) {
    if (file.status === 'uploaded') {
      continue;
    }
    const stored = await context.mediaStore.read(file.mediaId);
    if (!stored) {
      return failBatch(context, batch, `Staged file missing: ${file.filename}`);
    }
    try {
      const result = await client.uploadForJid({
        whatsappJid: batch.piwigoLinkedWid ?? batch.actorWid,
        scopeId: batch.scopeId,
        onde: batch.onde,
        quando: batch.quando,
        withUserIds: batch.withUserIds,
        filename: file.filename,
        mimeType: file.mimeType,
        buffer: stored.buffer
      });
      file.status = 'uploaded';
      file.imageId = result.image_id;
      file.url = result.url;
      file.uploadedAt = new Date().toISOString();
      batch.albumLabel = result.category_label;
      batch.updatedAt = new Date().toISOString();
      await saveBatch(context.dataStore, batch);
      await context.mediaStore.delete(file.mediaId).catch(() => undefined);
    } catch (error) {
      return failBatch(context, batch, errorMessage(error));
    }
  }

  batch.status = 'completed';
  batch.updatedAt = new Date().toISOString();
  await saveBatch(context.dataStore, batch);
  await clearActiveBatch(context.dataStore, batch);
  return [{
    type: 'message.sendText',
    chatId: batch.chatId,
    text: await t(context, batch.scopeId, batch.actorWid, 'official.piwigo-gallery.completed', {
      uploaded: String(batch.files.filter((file) => file.status === 'uploaded').length),
      album: batch.albumLabel ?? ''
    })
  }];
}

async function failBatch(
  context: PluginRuntimeContext,
  batch: GalleryUploadBatch,
  reason: string
): Promise<PluginAction[]> {
  batch.status = 'failed';
  batch.error = reason;
  batch.updatedAt = new Date().toISOString();
  await saveBatch(context.dataStore, batch);
  await clearActiveBatch(context.dataStore, batch);
  for (const file of batch.files.filter((entry) => entry.status === 'staged')) {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
  }
  return [{
    type: 'message.sendText',
    chatId: batch.chatId,
    text: await t(context, batch.scopeId, batch.actorWid, 'official.piwigo-gallery.failed', { reason })
  }];
}

function eventActorWids(event: PluginMessageEvent): string[] {
  return uniqueWids([event.actorWid, event.message.senderWid, event.message.authorWid, ...(event.actorAliases ?? [])]);
}

function uniqueWids(wids: Array<string | null | undefined>): string[] {
  return [...new Set(wids.map((wid) => wid?.trim().toLowerCase() ?? '').filter(Boolean))];
}

function batchIdFromPayload(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'batchId' in payload && typeof (payload as { batchId?: unknown }).batchId === 'string'
    ? (payload as { batchId: string }).batchId
    : undefined;
}

function forcedFromPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'forced' in payload && (payload as { forced?: unknown }).forced === true;
}

function fallbackFilename(mimeType: string | undefined): string | undefined {
  const ext = extensionForMime(mimeType);
  return ext ? `whatsapp-document.${ext}` : undefined;
}

function extensionForMime(mimeType: string | undefined): string | undefined {
  switch ((mimeType ?? '').toLowerCase().split(';')[0]) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'video/mp4': return 'mp4';
    case 'video/quicktime': return 'mov';
    case 'video/webm': return 'webm';
    case 'video/x-matroska': return 'mkv';
    default: return undefined;
  }
}

async function reply(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  key: string,
  params: Record<string, string> = {}
): Promise<PluginAction> {
  return {
    type: 'message.sendText',
    chatId: event.message.chatId,
    quotedMessageId: event.message.id,
    text: await t(context, event.scopeId, event.actorWid, key, params)
  };
}

async function t(
  context: PluginRuntimeContext,
  scopeId: string,
  actorWid: string,
  key: string,
  params: Record<string, string> = {}
): Promise<string> {
  const translator = await context.i18n.translatorForIdentity(actorWid, scopeId);
  return translator(key, params);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
