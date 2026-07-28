import type {
  PluginJobEvent,
  PluginMessageEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import { parsePiwigoGalleryConfig } from './config';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_FINALIZE_JOB,
  PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB,
  PIWIGO_GALLERY_PERMISSIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import { PiwigoGalleryClient } from './piwigoClient';
import {
  clearActiveBatch,
  getAlbumAnnouncement,
  getActiveBatchForActorWids,
  getBatch,
  resolveGalleryConnection,
  saveAlbumAnnouncement,
  saveBatch,
  type PiwigoAlbumAnnouncement,
  type PiwigoAlbumAnnouncementFile,
  type GalleryBatchFile,
  type GalleryUploadBatch
} from './store';

const batchMutationLocks = new Map<string, Promise<unknown>>();
const MEDIA_DUMP_REMINDER_COOLDOWN_SECONDS = 15 * 60;
const MEDIA_DUMP_ALBUM_REPLY_DELAY_MS = 5_000;

interface MediaDumpHintPayload {
  chatId: string;
  messageId: string;
  actorWid: string;
  actorAliases: string[];
}

export function createPiwigoGalleryHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  return {
    async onMessage(event) {
      return handleMessage(context, event);
    },
    async onPluginJob(job) {
      if (job.jobName === PIWIGO_GALLERY_FINALIZE_JOB) {
        return finalizeBatch(context, job);
      }
      if (job.jobName === PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB) {
        return announceNewAlbum(context, job);
      }
      if (job.jobName === PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB) {
        return sendMediaDumpHint(context, job);
      }
    }
  };
}

async function handleMessage(
  context: PluginRuntimeContext,
  event: PluginMessageEvent
): Promise<PluginAction[] | void> {
  if (event.message.fromMe) {
    return;
  }
  const config = parsePiwigoGalleryConfig(await context.configFor(event.scopeId, event.actorWid));
  if (!config.enabled || event.isCommandLike) {
    return;
  }
  const messageType = normalizedMessageType(event.message.type);
  if (messageType === 'album') {
    if (!await actorCanUpload(context, {
      scopeId: event.scopeId,
      actorWid: event.actorWid,
      groupId: event.groupId,
      groupWid: event.groupWid ?? event.message.chatId,
      allowScopeMemberUploads: config.access.allowScopeMemberUploads
    })) {
      return;
    }
    return [enqueueMediaDumpHint(event)];
  }
  if (!event.message.hasMedia) {
    return;
  }
  const batch = await getActiveBatchForActorWids(context.dataStore, event.scopeId, event.message.chatId, eventActorWids(event));
  const activeUpload = batch?.status === 'collecting';
  if (messageType !== 'document') {
    if (!activeUpload) {
      return;
    }
    return [await reply(context, event, 'official.piwigo-gallery.sendAsDocument')];
  }
  if (!activeUpload) {
    return;
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

function enqueueMediaDumpHint(event: PluginMessageEvent): PluginAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB,
    scopeId: event.scopeId,
    runAt: new Date(event.receivedAt.getTime() + MEDIA_DUMP_ALBUM_REPLY_DELAY_MS),
    payload: {
      chatId: event.message.chatId,
      messageId: event.message.id,
      actorWid: event.actorWid,
      actorAliases: event.actorAliases ?? []
    },
    dedupeKey: `${PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB}:${event.scopeId}:${event.message.chatId}:${event.message.id}`
  };
}

async function sendMediaDumpHint(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const payload = mediaDumpHintPayloadFromJob(job.payload);
  if (!payload) {
    return [{ type: 'audit.record', action: 'piwigo-gallery.media-dump-hint.skipped', metadataJson: { reason: 'invalid payload' } }];
  }
  const config = parsePiwigoGalleryConfig(await context.configFor(job.scopeId, payload.actorWid));
  if (!config.enabled) {
    return;
  }
  if (!await actorCanUpload(context, {
    scopeId: job.scopeId,
    actorWid: payload.actorWid,
    groupWid: payload.chatId,
    allowScopeMemberUploads: config.access.allowScopeMemberUploads
  })) {
    return;
  }
  const key = mediaDumpReminderKey(job.scopeId, payload.chatId, mediaDumpPayloadActorWids(payload), payload.actorWid);
  if (await context.ephemeralStore.get(key)) {
    return;
  }
  await context.ephemeralStore.set(key, {
    messageId: payload.messageId,
    remindedAt: job.runAt.toISOString()
  }, MEDIA_DUMP_REMINDER_COOLDOWN_SECONDS);
  return [{
    type: 'message.sendText',
    chatId: payload.chatId,
    quotedMessageId: payload.messageId,
    text: config.mediaDumpDocumentsHint.trim()
      ? config.mediaDumpDocumentsHint.trim()
      : await t(context, job.scopeId, payload.actorWid, 'official.piwigo-gallery.mediaDumpDocumentsHint')
  }];
}

async function actorCanUpload(
  context: PluginRuntimeContext,
  input: {
    scopeId: string;
    actorWid: string;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    allowScopeMemberUploads: boolean;
  }
): Promise<boolean> {
  if (!context.explainPermission) {
    return true;
  }
  const decision = await context.explainPermission?.({
    actorWid: input.actorWid,
    action: PIWIGO_GALLERY_PERMISSIONS.upload,
    scopeId: input.scopeId,
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.groupWid ? { groupWid: input.groupWid } : {}),
    requiresCurrentManagedGroupMembership: true,
    ...(input.allowScopeMemberUploads ? { allowCurrentManagedGroupMember: true } : {})
  });
  return decision?.allowed === true;
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
  return [{
    type: 'message.sendText',
    chatId: batch.chatId,
    text: await t(context, batch.scopeId, batch.actorWid, 'official.piwigo-gallery.failed', { reason })
  }];
}

async function announceNewAlbum(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const announcementId = announcementIdFromPayload(job.payload);
  if (!announcementId) {
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { reason: 'missing announcementId' } }];
  }
  const announcement = await getAlbumAnnouncement(context.dataStore, job.scopeId, announcementId);
  if (!announcement || announcement.status !== 'pending') {
    return;
  }

  const config = parsePiwigoGalleryConfig(await context.configFor(announcement.scopeId));
  const announcementGroupWid = job.groupWid ?? config.announcementGroupWid;
  if (!config.newAlbumAnnouncementsEnabled || !announcementGroupWid) {
    await markAnnouncement(context, announcement, 'skipped', 'New album announcements are not configured.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { announcementId, reason: 'not configured' } }];
  }

  const selected = selectAnnouncementFiles(announcement.files);
  if (selected.length === 0) {
    await markAnnouncement(context, announcement, 'skipped', 'No supported image or video files were provided.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { announcementId, reason: 'no supported media' } }];
  }

  const connection = await resolveGalleryConnection(
    context.dataStore,
    config,
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    await markAnnouncement(context, announcement, 'failed', 'Gallery connection is not configured.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.failed', metadataJson: { announcementId, reason: 'connection not configured' } }];
  }

  try {
    const client = new PiwigoGalleryClient(connection);
    const files = await Promise.all(selected.map((file) => client.downloadForBot({
      ...(file.imageId !== undefined ? { imageId: file.imageId } : {}),
      ...(file.fileId ? { fileId: file.fileId } : {}),
      ...(file.downloadToken ? { downloadToken: file.downloadToken } : {})
    })));
    const caption = `New album ${announcement.albumName} added to ${announcement.siteLabel} by ${announcement.userDisplayName}`;
    announcement.status = 'announced';
    announcement.announcedAt = new Date().toISOString();
    await saveAlbumAnnouncement(context.dataStore, announcement);
    return files.map((file, index) => ({
      type: 'message.sendMedia' as const,
      chatId: announcementGroupWid,
      file: {
        filename: file.filename,
        mimeType: file.mimeType,
        buffer: file.buffer
      },
      ...(index === 0 ? { caption } : {}),
      waitUntilMsgSent: true
    }));
  } catch (error) {
    const reason = errorMessage(error);
    await markAnnouncement(context, announcement, 'failed', reason);
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.failed', metadataJson: { announcementId, reason } }];
  }
}

async function markAnnouncement(
  context: PluginRuntimeContext,
  announcement: PiwigoAlbumAnnouncement,
  status: PiwigoAlbumAnnouncement['status'],
  error: string
): Promise<void> {
  announcement.status = status;
  announcement.error = error;
  await saveAlbumAnnouncement(context.dataStore, announcement);
}

function selectAnnouncementFiles(files: PiwigoAlbumAnnouncementFile[]): PiwigoAlbumAnnouncementFile[] {
  const candidates = files.filter((file) => isSupportedAnnouncementMedia(file) && hasDownloadReference(file));
  const videos = candidates.filter((file) => isVideoMime(file.mimeType));
  const videoSlots = Math.min(2, videos.length);
  const imageSlots = 5 - videoSlots;
  const selected = new Set<PiwigoAlbumAnnouncementFile>([
    ...videos.slice(0, videoSlots),
    ...candidates.filter((file) => !isVideoMime(file.mimeType)).slice(0, imageSlots)
  ]);
  return candidates.filter((file) => selected.has(file)).slice(0, 5);
}

function isSupportedAnnouncementMedia(file: Pick<PiwigoAlbumAnnouncementFile, 'mimeType'>): boolean {
  const mimeType = file.mimeType.toLowerCase();
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}

function isVideoMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('video/');
}

function hasDownloadReference(file: PiwigoAlbumAnnouncementFile): boolean {
  return file.imageId !== undefined || Boolean(file.fileId || file.downloadToken);
}

function eventActorWids(event: PluginMessageEvent): string[] {
  return uniqueWids([event.actorWid, event.message.senderWid, event.message.authorWid, ...(event.actorAliases ?? [])]);
}

function normalizedMessageType(type: string | undefined): string {
  return (type ?? 'unknown').trim().toLowerCase();
}

function mediaDumpHintPayloadFromJob(payload: unknown): MediaDumpHintPayload | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.chatId !== 'string' || typeof value.messageId !== 'string' || typeof value.actorWid !== 'string') {
    return undefined;
  }
  const actorAliases = Array.isArray(value.actorAliases)
    ? value.actorAliases.filter((alias): alias is string => typeof alias === 'string')
    : [];
  return {
    chatId: value.chatId,
    messageId: value.messageId,
    actorWid: value.actorWid,
    actorAliases
  };
}

function mediaDumpPayloadActorWids(payload: MediaDumpHintPayload): string[] {
  return uniqueWids([payload.actorWid, ...payload.actorAliases]);
}

function mediaDumpReminderKey(scopeId: string, chatId: string, actorWids: string[], actorWid: string): string {
  return `media-dump-reminder:${scopeId}:${chatId}:${mediaDumpActorKey(actorWids, actorWid)}`;
}

function mediaDumpActorKey(actorWids: string[], actorWid: string): string {
  return actorWids[0] ?? actorWid.trim().toLowerCase();
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

function announcementIdFromPayload(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'announcementId' in payload && typeof (payload as { announcementId?: unknown }).announcementId === 'string'
    ? (payload as { announcementId: string }).announcementId
    : undefined;
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
