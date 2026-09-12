import type {
  PluginJobEvent,
  PluginMessageEvent,
  PluginRuntimeHooks
} from './runtime';
import type { PluginRuntimeContext } from './runtime';
import type { PluginAction } from '../../../../packages/plugin-sdk/src/actions';
import { randomUUID } from 'node:crypto';
import { enqueuePluginJob } from '../../../../packages/plugin-sdk/src/jobs';
import {
  galleryConnectionDefaultsFromAppConfig,
  parsePiwigoGalleryConfig,
  renderPiwigoAlbumAnnouncementTemplate,
  renderPiwigoMediaDumpDocumentsHint
} from './config';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_FINALIZE_JOB,
  PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB,
  PIWIGO_GALLERY_PERMISSIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import {
  PiwigoApiError,
  PiwigoGalleryClient,
  supportsPiwigoEventAlbumSource,
  supportsPiwigoUploadIdempotency,
  type PiwigoStatusResult
} from './piwigoClient';
import {
  appendBatchFile,
  batchFilesPendingCleanup,
  bindAlbumAnnouncementTarget,
  beginAlbumAnnouncementFileDelivery,
  beginBatchFileUpload,
  beginBatchTerminalNotification,
  claimAlbumAnnouncement,
  claimBatchFinalization,
  completeAlbumAnnouncement,
  completeAlbumAnnouncementFileDelivery,
  completeBatchFileCleanup,
  completeBatchFinalization,
  completeBatchTerminalNotification,
  getAlbumAnnouncement,
  getActiveBatch,
  getActiveBatchAcrossScopes,
  getBatch,
  markBatchFileFailed,
  markBatchFileUploaded,
  recordAlbumAnnouncementDownloadFailure,
  recordBatchFileUploadFailure,
  releaseBatchFinalizationClaim,
  renewAlbumAnnouncementClaim,
  renewBatchFinalizationClaim,
  resolveGalleryConnection,
  type PiwigoAlbumAnnouncement,
  type PiwigoAlbumAnnouncementFile,
  type GalleryBatchFile,
  type GalleryBatchFileFailureCode,
  type GalleryUploadBatch
} from './store';
import {
  prepareAndReconcileGalleryDatabase,
  preparedGalleryDatabase,
  reconcileGalleryUploadDrafts
} from './storageRuntime';
import { PIWIGO_GALLERY_UPLOAD_FLOW_TYPE } from './flow';
import {
  FederatedTopomareGalleryPrincipalResolver,
  type TopomareGalleryPrincipal
} from './topomarePrincipal';
import {
  EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
  EVENT_ALBUM_SOURCE_SERVICE_ID,
  type EventAlbumSourceResolveOutput
} from './contracts/community-events.v1';

const MEDIA_DUMP_REMINDER_COOLDOWN_SECONDS = 15 * 60;
const MEDIA_DUMP_ALBUM_REPLY_DELAY_MS = 5_000;
const FINALIZATION_CLAIM_MS = 60 * 60_000;
const ANNOUNCEMENT_CLAIM_MS = 15 * 60_000;
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 30_000;
const UPLOAD_RETRY_MAX_MS = 5 * 60_000;
const ANNOUNCEMENT_DOWNLOAD_MAX_ATTEMPTS = 4;
const ANNOUNCEMENT_DOWNLOAD_RETRY_BASE_MS = 30_000;
const ANNOUNCEMENT_DOWNLOAD_RETRY_MAX_MS = 5 * 60_000;

interface MediaDumpHintPayload {
  chatId: string;
  messageId: string;
  actorIdentityId: string;
  actorDisplayName?: string | undefined;
  chatSurface: 'group' | 'private';
}

interface ReleaseReadyGalleryBatchSubject {
  client: PiwigoGalleryClient;
  principal: TopomareGalleryPrincipal;
  integrationStatus: PiwigoStatusResult;
}

class GalleryBatchPreflightError extends Error {
  constructor(
    readonly userMessageKey: string,
    message: string,
    options?: ErrorOptions | undefined
  ) {
    super(message, options);
    this.name = 'GalleryBatchPreflightError';
  }
}

export function createPiwigoGalleryHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  const databasePreparation = prepareAndReconcileGalleryDatabase(
    context.databases,
    {
      enqueueJob: (job) => enqueuePluginJob(context, {
        pluginId: PIWIGO_GALLERY_PLUGIN_ID,
        ...job
      })
    }
  ).then(async (database) => {
    const flowEngine = context.flowEngine;
    if (flowEngine) {
      try {
        const draftRecovery = await reconcileGalleryUploadDrafts(database, flowEngine);
        logDraftReconciliation(context, draftRecovery, 'pre-ready');
      } catch (error) {
        context.logger.warn({ err: error }, 'Piwigo gallery pre-ready upload draft reconciliation deferred');
      }
      void (async () => {
        await flowEngine.whenTransportReady();
        await flowEngine.recoverActiveStepPrompts({
          flowType: PIWIGO_GALLERY_UPLOAD_FLOW_TYPE
        });
        const draftRecovery = await reconcileGalleryUploadDrafts(database, flowEngine);
        logDraftReconciliation(context, draftRecovery, 'post-ready');
      })().catch((error: unknown) => {
        context.logger.warn({ err: error }, 'Piwigo gallery post-ready upload draft reconciliation deferred');
      });
    }
    return database;
  });
  void databasePreparation.catch((error: unknown) => {
    context.logger.error({ err: error }, 'Piwigo gallery database preparation failed');
  });
  return {
    async resolvePrivateMessageRoute(event) {
      const actorIdentityId = event.actorIdentityId.trim();
      if (!actorIdentityId) {
        return;
      }
      const database = await databasePreparation;
      const batch = getActiveBatchAcrossScopes(
        database,
        event.chatId,
        actorIdentityId
      );
      if (
        !batch
        || batch.status !== 'collecting'
        || new Date(batch.autoFinalizeAt).getTime() <= event.receivedAt.getTime()
      ) {
        return;
      }
      return {
        scopeId: batch.scopeId,
        ...(batch.groupId ? { groupId: batch.groupId } : {}),
        groupWid: batch.groupWid
      };
    },
    async onMessage(event) {
      await databasePreparation;
      return handleMessage(context, event);
    },
    async onPluginJob(job) {
      await databasePreparation;
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

function logDraftReconciliation(
  context: PluginRuntimeContext,
  result: Awaited<ReturnType<typeof reconcileGalleryUploadDrafts>>,
  phase: 'pre-ready' | 'post-ready'
): void {
  if (result.pruned.length === 0 && result.lookupFailures.length === 0) {
    return;
  }
  context.logger.info({
    phase,
    prunedFlowSessionIds: result.pruned,
    lookupFailureFlowSessionIds: result.lookupFailures
  }, 'Piwigo gallery upload drafts reconciled with durable flows');
}

async function handleMessage(
  context: PluginRuntimeContext,
  event: PluginMessageEvent
): Promise<PluginAction[] | void> {
  if (event.message.fromMe) {
    return;
  }
  const actorIdentityId = event.actorIdentityId.trim();
  const actorWid = event.actorWid.trim();
  if (!actorIdentityId || !actorWid) {
    return;
  }
  const config = parsePiwigoGalleryConfig(await context.configFor(event.scopeId, actorIdentityId));
  if (!config.enabled || event.isCommandLike) {
    return;
  }
  const messageType = normalizedMessageType(event.message.type);
  if (messageType === 'album') {
    if (!await actorCanUpload(context, {
      scopeId: event.scopeId,
      actorIdentityId,
      groupId: event.groupId,
      groupWid: event.groupWid ?? event.message.chatId,
      allowScopeMemberUploads: config.access.allowScopeMemberUploads
    })) {
      return;
    }
    return [enqueueMediaDumpHint(event, actorIdentityId)];
  }
  if (!event.message.hasMedia) {
    return;
  }
  const db = await preparedGalleryDatabase(context.databases);
  const batch = getActiveBatch(db, event.scopeId, event.message.chatId, actorIdentityId);
  const activeUpload = batch?.status === 'collecting';
  if (
    activeUpload
    && event.message.context === 'private'
    && !await actorCanUpload(context, {
      scopeId: batch.scopeId,
      actorIdentityId,
      groupId: batch.groupId,
      groupWid: batch.groupWid,
      allowScopeMemberUploads: config.access.allowScopeMemberUploads
    })
  ) {
    return;
  }
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
        reason: await t(context, event.scopeId, event.actorIdentityId, 'official.piwigo-gallery.error.mediaRuntimeUnavailable')
    })];
  }

  try {
    await releaseReadyGalleryBatchSubject(context, batch);
  } catch (error) {
    context.logger.warn({
      err: error,
      batchId: batch.id,
      scopeId: batch.scopeId,
      actorIdentityId: batch.actorIdentityId
    }, 'Piwigo gallery subject preflight blocked media staging');
    const reasonKey = galleryBatchPreflightMessageKey(error);
    return [await reply(context, event, 'official.piwigo-gallery.failed', {
      reason: await t(context, event.scopeId, event.actorIdentityId, reasonKey)
    })];
  }

  const declaredSizeBytes = event.message.media?.sizeBytes;
  if (declaredSizeBytes !== undefined && declaredSizeBytes > batch.maxFileBytes) {
    return [await reply(context, event, 'official.piwigo-gallery.fileTooLarge')];
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
      text: await t(context, event.scopeId, event.actorIdentityId, 'official.piwigo-gallery.documentStaged', {
        count: String(append.fileCount),
        minutes: String(batch.autoFinalizeMinutes)
      })
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: event.scopeId,
      runAt: append.autoFinalizeAt,
      payload: { batchId: batch.id, deadlineGeneration: append.deadlineGeneration },
      dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:${append.deadlineGeneration}`
    }
  ];
}

function enqueueMediaDumpHint(
  event: PluginMessageEvent,
  actorIdentityId: string
): PluginAction {
  const actorDisplayName = event.message.senderDisplayName?.trim()
    || event.actor.identityAddress.displayName?.trim()
    || undefined;
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB,
    scopeId: event.scopeId,
    runAt: new Date(event.receivedAt.getTime() + MEDIA_DUMP_ALBUM_REPLY_DELAY_MS),
    payload: {
      chatId: event.message.chatId,
      messageId: event.message.id,
      actorIdentityId,
      ...(actorDisplayName ? { actorDisplayName } : {}),
      chatSurface: event.message.context
    },
    dedupeKey: `${PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB}:${event.scopeId}:${event.message.chatId}:${actorIdentityId}:${event.message.id}`
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
  const config = parsePiwigoGalleryConfig(await context.configFor(job.scopeId, payload.actorIdentityId));
  if (!config.enabled) {
    return;
  }
  if (!await actorCanUpload(context, {
    scopeId: job.scopeId,
    actorIdentityId: payload.actorIdentityId,
    ...(job.groupId?.trim() ? { groupId: job.groupId.trim() } : {}),
    ...(job.groupWid?.trim()
      ? { groupWid: job.groupWid.trim() }
      : payload.chatSurface === 'group'
        ? { groupWid: payload.chatId }
        : {}),
    allowScopeMemberUploads: config.access.allowScopeMemberUploads
  })) {
    return;
  }
  const key = mediaDumpReminderKey(job.scopeId, payload.chatId, payload.actorIdentityId);
  if (await context.ephemeralStore.get(key)) {
    return;
  }
  const source = config.mediaDumpDocumentsHint.trim()
    ? config.mediaDumpDocumentsHint.trim()
    : await t(context, job.scopeId, payload.actorIdentityId, 'official.piwigo-gallery.mediaDumpDocumentsHint');
  await context.ephemeralStore.set(key, {
    messageId: payload.messageId,
    remindedAt: job.runAt.toISOString()
  }, MEDIA_DUMP_REMINDER_COOLDOWN_SECONDS);
  let text: string;
  try {
    text = renderPiwigoMediaDumpDocumentsHint(source, {
      actorDisplayName: payload.actorDisplayName,
      isGroup: payload.chatSurface === 'group' ? 'true' : undefined,
      isPrivate: payload.chatSurface === 'private' ? 'true' : undefined
    }).trim();
  } catch {
    return [{
      type: 'audit.record',
      action: 'piwigo-gallery.media-dump-hint.skipped',
      metadataJson: { reason: 'template-invalid' }
    }];
  }
  if (!text) {
    return;
  }
  return [{
    type: 'message.sendText',
    chatId: payload.chatId,
    quotedMessageId: payload.messageId,
    text
  }];
}

async function actorCanUpload(
  context: PluginRuntimeContext,
  input: {
    scopeId: string;
    actorIdentityId: string;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    allowScopeMemberUploads: boolean;
  }
): Promise<boolean> {
  if (!context.explainPermission) {
    return true;
  }
  const decision = await context.explainPermission?.({
    actorIdentityId: input.actorIdentityId,
    action: PIWIGO_GALLERY_PERMISSIONS.upload,
    scopeId: input.scopeId,
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.groupWid ? { groupWid: input.groupWid } : {}),
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(input.allowScopeMemberUploads ? { allowCurrentManagedGroupMember: true } : {})
  });
  return decision?.allowed === true;
}

async function appendStagedFile(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  batchId: string,
  file: GalleryBatchFile
): Promise<{
  fileCount: number;
  autoFinalizeAt: Date;
  deadlineGeneration: number;
  duplicate: boolean;
} | undefined> {
  const db = await preparedGalleryDatabase(context.databases);
  const current = getBatch(db, event.scopeId, batchId);
  if (!current || current.status !== 'collecting') {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
    return undefined;
  }
  const acceptedAt = new Date();
  const autoFinalizeAt = new Date(acceptedAt.getTime() + current.autoFinalizeMinutes * 60_000);
  let result: ReturnType<typeof appendBatchFile>;
  try {
    result = appendBatchFile(db, {
      scopeId: event.scopeId,
      batchId,
      file,
      acceptedAt: acceptedAt.toISOString(),
      autoFinalizeAt: autoFinalizeAt.toISOString()
    });
  } catch (error) {
    try {
      await context.mediaStore?.delete(file.mediaId);
    } catch (cleanupError) {
      context.logger.warn({
        err: cleanupError,
        mediaId: file.mediaId,
        batchId
      }, 'Piwigo gallery media staged before a failed database append could not be removed');
    }
    throw error;
  }
  if (result.kind !== 'appended' && result.kind !== 'duplicate') {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
    return undefined;
  }
  if (
    result.kind === 'duplicate' &&
    !result.batch.files.some((existing) => existing.messageId === file.messageId && existing.mediaId === file.mediaId)
  ) {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
  }
  return {
    fileCount: result.fileCount,
    autoFinalizeAt: new Date(result.batch.autoFinalizeAt),
    deadlineGeneration: result.batch.deadlineGeneration,
    duplicate: result.kind === 'duplicate'
  };
}

async function releaseReadyGalleryBatchSubject(
  context: PluginRuntimeContext,
  batch: GalleryUploadBatch
): Promise<ReleaseReadyGalleryBatchSubject> {
  const config = parsePiwigoGalleryConfig(
    await context.configFor(batch.scopeId, batch.actorIdentityId)
  );
  let connection;
  try {
    connection = await resolveGalleryConnection(
      config,
      galleryConnectionDefaultsFromAppConfig(context.config)
    );
  } catch (error) {
    throw new GalleryBatchPreflightError(
      'official.piwigo-gallery.error.connectionNotConfigured',
      'Gallery connection configuration failed validation.',
      { cause: error }
    );
  }
  if (!connection) {
    throw new GalleryBatchPreflightError(
      'official.piwigo-gallery.error.connectionNotConfigured',
      'Gallery connection is not configured.'
    );
  }

  const client = new PiwigoGalleryClient(connection);
  let integrationStatus: PiwigoStatusResult;
  try {
    integrationStatus = await client.preflight();
  } catch (error) {
    throw new GalleryBatchPreflightError(
      userFacingPiwigoErrorKey(error),
      'Piwigo Gallery release preflight failed.',
      { cause: error }
    );
  }

  try {
    if (batch.topomareUserId === null || batch.piwigoUserId === null) {
      throw new Error('Gallery upload has no immutable Topomare/Piwigo subject binding.');
    }
    const principal = await new FederatedTopomareGalleryPrincipalResolver(
      connection.topomareOidcIssuer,
      connection.topomareWabpProviderNamespace,
      context.identityAccess
    ).resolveForIdentity(batch.actorIdentityId);
    if (
      principal.topomareUserId !== batch.topomareUserId
      || principal.wabpIdentityId !== batch.actorIdentityId
    ) {
      throw new Error('Gallery upload subject no longer matches the captured Topomare principal.');
    }
    const people = await client.people(principal, batch.scopeId);
    if (people.piwigoUserId !== batch.piwigoUserId) {
      throw new Error('Gallery upload Piwigo shadow-user binding changed after capture.');
    }
    await assertCurrentEventAlbumSource(context, batch);
    return { client, principal, integrationStatus };
  } catch (error) {
    const status = error instanceof PiwigoApiError
      ? error.piwigoCode ?? error.httpStatus
      : undefined;
    const userMessageKey = status === undefined || status === 401 || status === 403 || status === 404
      ? 'official.piwigo-gallery.error.identityMismatch'
      : userFacingPiwigoErrorKey(error);
    throw new GalleryBatchPreflightError(
      userMessageKey,
      'Gallery upload subject revalidation failed.',
      { cause: error }
    );
  }
}

function galleryBatchPreflightMessageKey(error: unknown): string {
  return error instanceof GalleryBatchPreflightError
    ? error.userMessageKey
    : userFacingPiwigoErrorKey(error);
}

async function finalizeBatch(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const batchId = batchIdFromPayload(job.payload);
  if (!batchId) {
    return [{ type: 'audit.record', action: 'piwigo-gallery.finalize.skipped', metadataJson: { reason: 'missing batchId' } }];
  }
  const db = await preparedGalleryDatabase(context.databases);
  let current = getBatch(db, job.scopeId, batchId);
  if (!current) {
    return;
  }
  if (batchPhaseFromPayload(job.payload) === 'notification-delivered') {
    const attemptId = batchNotificationAttemptIdFromPayload(job.payload);
    if (attemptId) {
      const acknowledged = completeBatchTerminalNotification(db, {
        scopeId: job.scopeId,
        batchId,
        attemptId,
        deliveredAt: new Date().toISOString()
      });
      current = 'batch' in acknowledged ? acknowledged.batch : current;
      if (acknowledged.kind === 'delivered' || acknowledged.kind === 'already_delivered') {
        const actions = await terminalBatchMaintenanceActions(context, db, current);
        return [{
          type: 'audit.record',
          action: 'piwigo-gallery.finalize.notification-delivered',
          metadataJson: { batchId, attemptId }
        }, ...actions];
      }
    }
  }
  if (current.status !== 'collecting' && current.status !== 'finalizing') {
    const actions = await terminalBatchMaintenanceActions(context, db, current);
    return actions.length > 0 ? actions : undefined;
  }
  const forced = forcedFromPayload(job.payload);
  const deadlineGeneration = deadlineGenerationFromPayload(job.payload) ?? current.deadlineGeneration;
  const claimedAt = new Date();
  let releaseReadySubject: ReleaseReadyGalleryBatchSubject | undefined;
  const claimWouldMutate = current.deadlineGeneration === deadlineGeneration && (
    current.status === 'collecting'
      ? forced || current.autoFinalizeAt <= claimedAt.toISOString()
      : !current.finalizationClaimExpiresAt
        || current.finalizationClaimExpiresAt <= claimedAt.toISOString()
  );
  if (
    claimWouldMutate
    && current.files.some((file) => file.status !== 'uploaded' && file.status !== 'failed')
  ) {
    // A finalization claim changes durable batch state. Validate both release
    // readiness and the immutable subject before that mutation, then validate
    // the release again immediately before each staged file enters uploading.
    releaseReadySubject = await releaseReadyGalleryBatchSubject(context, current);
  }
  const claimId = randomUUID();
  const claim = claimBatchFinalization(db, {
    scopeId: job.scopeId,
    batchId,
    deadlineGeneration,
    claimId,
    claimedAt: claimedAt.toISOString(),
    claimExpiresAt: new Date(claimedAt.getTime() + FINALIZATION_CLAIM_MS).toISOString(),
    forced
  });
  if (claim.kind === 'not_due') {
    return [batchDeadlineRecoveryAction(claim.batch, {
      reason: 'not-due',
      sourceDeadlineGeneration: deadlineGeneration
    })];
  }
  if (claim.kind === 'stale_deadline') {
    return [
      {
        type: 'audit.record',
        action: 'piwigo-gallery.finalize.stale-deadline',
        metadataJson: {
          batchId,
          jobDeadlineGeneration: deadlineGeneration,
          currentDeadlineGeneration: claim.batch.deadlineGeneration
        }
      },
      batchDeadlineRecoveryAction(claim.batch, {
        reason: 'stale-deadline',
        sourceDeadlineGeneration: deadlineGeneration
      })
    ];
  }
  if (claim.kind === 'already_claimed') {
    await enqueueBatchClaimRecovery(context, job, claim.batch);
    return;
  }
  if (claim.kind !== 'claimed') {
    return;
  }
  let batch = claim.batch;

  if (batch.files.every((file) => file.status === 'uploaded' || file.status === 'failed')) {
    return completeBatchUploadResults(context, db, batch, claimId);
  }
  await enqueueBatchClaimRecovery(context, job, batch);

  if (!context.mediaStore) {
    return failBatch(
      context,
      db,
      batch,
      claimId,
      await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.error.mediaRuntimeUnavailable')
    );
  }

  releaseReadySubject ??= await releaseReadyGalleryBatchSubject(context, batch);
  const { client, principal, integrationStatus } = releaseReadySubject;
  const uploadIdempotencySupported = supportsPiwigoUploadIdempotency(integrationStatus);
  const eventAlbumSourceSupported = supportsPiwigoEventAlbumSource(integrationStatus);
  for (const file of batch.files) {
    if (file.status === 'uploaded' || file.status === 'failed') {
      continue;
    }
    const renewed = renewBatchFinalizationLease(db, batch, claimId);
    if (renewed.kind !== 'renewed') {
      return;
    }
    batch = renewed.batch;
    let activeFile = batch.files.find((candidate) => candidate.messageId === file.messageId);
    if (!activeFile || activeFile.status === 'uploaded' || activeFile.status === 'failed') {
      continue;
    }
    if (
      activeFile.status === 'uploading' &&
      activeFile.uploadNextRetryAt &&
      activeFile.uploadNextRetryAt > new Date().toISOString()
    ) {
      const released = releaseBatchFinalizationClaim(db, {
        scopeId: batch.scopeId,
        batchId: batch.id,
        claimId,
        releasedAt: new Date().toISOString()
      });
      if (released.kind !== 'released') {
        return;
      }
      const releasedFile = released.batch.files.find((candidate) => candidate.messageId === file.messageId);
      return releasedFile
        ? [batchUploadRetryAction(released.batch, releasedFile, `early-reschedule:${randomUUID()}`)]
        : undefined;
    }
    const storedFile = context.mediaStore.openFile
      ? await context.mediaStore.openFile(activeFile.mediaId)
      : undefined;
    const stored = storedFile ? undefined : await context.mediaStore.read(activeFile.mediaId);
    if (!storedFile && !stored) {
      return failBatch(
        context,
        db,
        batch,
        claimId,
        await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.error.stagedFileMissing', {
          filename: activeFile.filename
        })
      );
    }
    if (activeFile.status === 'staged') {
      try {
        await withBatchLeaseHeartbeat(db, batch, claimId, () => client.preflight());
      } catch (error) {
        return failBatch(
          context,
          db,
          batch,
          claimId,
          await t(context, batch.scopeId, batch.actorIdentityId, userFacingPiwigoErrorKey(error)),
          `Piwigo preflight failed before upload state was mutated: ${errorMessage(error)}`
        );
      }
      const started = beginBatchFileUpload(db, {
        scopeId: batch.scopeId,
        batchId: batch.id,
        messageId: activeFile.messageId,
        claimId,
        attemptId: `v4:${randomUUID()}`,
        startedAt: new Date().toISOString()
      });
      if (started.kind !== 'uploading') {
        return;
      }
      batch = started.batch;
      activeFile = started.file;
    }
    const attemptId = activeFile.uploadAttemptId;
    if (!attemptId) {
      return failBatch(
        context,
        db,
        batch,
        claimId,
        await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.error.serviceUnavailable'),
        `Uploading file ${activeFile.filename} has no durable attempt ID.`
      );
    }
    if (!uploadIdempotencySupported) {
      return failBatch(
        context,
        db,
        batch,
        claimId,
        await t(
          context,
          batch.scopeId,
          batch.actorIdentityId,
          'official.piwigo-gallery.error.uploadIdempotencyUnsupported'
        ),
        'Piwigo did not advertise upload idempotency; upload was not attempted.'
      );
    }
    if (batch.albumSource.kind === 'community-event' && !eventAlbumSourceSupported) {
      return failBatch(
        context,
        db,
        batch,
        claimId,
        await t(
          context,
          batch.scopeId,
          batch.actorIdentityId,
          'official.piwigo-gallery.error.eventAlbumSourceUnsupported'
        ),
        'Piwigo did not advertise event album source support; upload was not attempted.'
      );
    }
    try {
      const result = await withBatchLeaseHeartbeat(db, batch, claimId, () =>
        client.uploadForSubject({
          idempotencyKey: attemptId,
          principal,
          piwigoUserId: batch.piwigoUserId!,
          scopeId: batch.scopeId,
          onde: batch.onde,
          quando: batch.quando,
          withUserIds: batch.withUserIds,
          albumSource: batch.albumSource,
          filename: activeFile.filename,
          mimeType: activeFile.mimeType,
          ...(storedFile ? { path: storedFile.path } : { buffer: stored!.buffer })
        })
      );
      const marked = markBatchFileUploaded(db, {
        scopeId: batch.scopeId,
        batchId: batch.id,
        messageId: activeFile.messageId,
        claimId,
        attemptId,
        imageId: result.imageId,
        url: result.url,
        albumLabel: result.categoryLabel,
        uploadedAt: new Date().toISOString()
      });
      if (marked.kind !== 'uploaded' && marked.kind !== 'already_uploaded') {
        return;
      }
      batch = marked.batch;
      await cleanupBatchMedia(context, db, batch);
    } catch (error) {
      if (isAmbiguousPiwigoOutcome(error)) {
        return deferAmbiguousBatchUpload(context, db, batch, activeFile, claimId, error);
      }
      const failed = markBatchFileFailed(db, {
        scopeId: batch.scopeId,
        batchId: batch.id,
        messageId: activeFile.messageId,
        claimId,
        attemptId,
        failureCode: failureCodeForPiwigoError(error),
        error: errorMessage(error),
        failedAt: new Date().toISOString()
      });
      if (failed.kind !== 'failed' && failed.kind !== 'already_failed') {
        return;
      }
      batch = failed.batch;
      await cleanupBatchMedia(context, db, batch);
    }
  }
  return completeBatchUploadResults(context, db, batch, claimId);
}

async function completeBatchUploadResults(
  context: PluginRuntimeContext,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch,
  claimId: string
): Promise<PluginAction[]> {
  const uploaded = batch.files.filter((file) => file.status === 'uploaded');
  const failed = batch.files.filter((file) => file.status === 'failed');
  const empty = batch.files.length === 0;
  const status = empty ? 'expired' : failed.length > 0 ? 'failed' : 'completed';
  const notificationText = empty
    ? await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.expiredEmpty')
    : failed.length > 0
      ? await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.completedWithFailures', {
          uploaded: String(uploaded.length),
          total: String(batch.files.length),
          failed: String(failed.length),
          failedFiles: failed.map((file) => file.filename).join(', ')
        })
      : await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.completed', {
          uploaded: String(uploaded.length),
          album: batch.albumLabel ?? ''
        });
  const auditReason = failed.length > 0
    ? failed.map((file) => `${file.filename}: ${file.uploadLastError ?? file.failureCode ?? 'rejected'}`).join('; ')
    : undefined;
  const completed = completeBatchFinalization(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    claimId,
    status,
    completedAt: new Date().toISOString(),
    ...(batch.albumLabel ? { albumLabel: batch.albumLabel } : {}),
    ...(auditReason ? { error: auditReason } : {}),
    notification: {
      text: notificationText,
      deliveryKey: batchTerminalNotificationKey(batch)
    }
  });
  if (completed.kind !== 'completed') {
    return [];
  }
  const actions = await terminalBatchMaintenanceActions(context, db, completed.batch);
  if (failed.length > 0) {
    actions.unshift({
      type: 'audit.record',
      action: 'piwigo-gallery.finalize.partial',
      metadataJson: {
        batchId: batch.id,
        scopeId: batch.scopeId,
        uploaded: uploaded.length,
        failed: failed.map((file) => ({
          messageId: file.messageId,
          filename: file.filename,
          failureCode: file.failureCode,
          reason: file.uploadLastError
        }))
      }
    });
  }
  return actions;
}

async function assertCurrentEventAlbumSource(
  context: PluginRuntimeContext,
  batch: GalleryUploadBatch
): Promise<void> {
  if (batch.albumSource.kind === 'manual') {
    return;
  }
  if (!context.services) {
    throw new Error('Community-event album-source service is unavailable at finalization.');
  }
  const output = await context.services.call<EventAlbumSourceResolveOutput>({
    serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
    method: EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
    scopeId: batch.scopeId,
    actorIdentityId: batch.actorIdentityId,
    ...(batch.groupId ? { groupId: batch.groupId } : {}),
    groupWid: batch.groupWid,
    input: { eventId: batch.albumSource.eventId }
  });
  if (output.kind !== 'found') {
    throw new Error('Community-event album source is no longer authorized for this gallery scope.');
  }
  const current = output.event;
  const captured = batch.albumSource;
  if (
    current.eventId !== captured.eventId
    || current.revision !== captured.revision
    || current.title !== captured.title
    || current.startsAt !== captured.startsAt
    || current.localDate !== captured.localDate
    || current.localTime !== captured.localTime
    || current.timezone !== captured.timezone
    || current.place !== captured.place
    || current.eventStatus !== captured.eventStatus
  ) {
    throw new Error('Community-event album source changed after the immutable upload snapshot was captured.');
  }
}

async function deferAmbiguousBatchUpload(
  context: PluginRuntimeContext,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch,
  file: GalleryBatchFile,
  claimId: string,
  error: unknown
): Promise<PluginAction[]> {
  const attemptId = file.uploadAttemptId;
  if (!attemptId) {
    return failBatch(
      context,
      db,
      batch,
      claimId,
      await t(context, batch.scopeId, batch.actorIdentityId, 'official.piwigo-gallery.error.serviceUnavailable'),
      `Uploading file ${file.filename} has no durable attempt ID.`
    );
  }
  const failedAt = new Date();
  const attemptNumber = (file.uploadRetryCount ?? 0) + 1;
  const exhausted = attemptNumber >= UPLOAD_MAX_ATTEMPTS;
  const retryAt = exhausted
    ? undefined
    : new Date(failedAt.getTime() + uploadRetryDelayMs(attemptNumber)).toISOString();
  const recorded = recordBatchFileUploadFailure(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    messageId: file.messageId,
    claimId,
    attemptId,
    failedAt: failedAt.toISOString(),
    error: errorMessage(error),
    ...(retryAt ? { retryAt } : {})
  });
  if (recorded.kind !== 'recorded') {
    return [];
  }
  if (exhausted) {
    return failBatch(
      context,
      db,
      recorded.batch,
      claimId,
      await t(
        context,
        batch.scopeId,
        batch.actorIdentityId,
        'official.piwigo-gallery.error.uploadRetriesExhausted'
      ),
      `Piwigo upload ${attemptId} remained ambiguous after ${attemptNumber} attempts: ${errorMessage(error)}`
    );
  }
  return [
    {
      type: 'audit.record',
      action: 'piwigo-gallery.finalize.upload-retry-deferred',
      metadataJson: {
        batchId: recorded.batch.id,
        messageId: file.messageId,
        attemptId,
        attemptNumber,
        retryAt,
        reason: errorMessage(error)
      }
    },
    batchUploadRetryAction(recorded.batch, recorded.file)
  ];
}

function batchUploadRetryAction(
  batch: GalleryUploadBatch,
  file: GalleryBatchFile,
  dedupeVariant?: string
): PluginAction {
  const attemptId = file.uploadAttemptId;
  const retryAt = file.uploadNextRetryAt;
  if (!attemptId || !retryAt) {
    throw new Error(`Piwigo upload retry state is incomplete for ${batch.id}/${file.messageId}.`);
  }
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId: batch.scopeId,
    runAt: new Date(retryAt),
    payload: {
      batchId: batch.id,
      deadlineGeneration: batch.deadlineGeneration,
      forced: true,
      uploadRetryAttemptId: attemptId,
      uploadRetryCount: file.uploadRetryCount ?? 0
    },
    dedupeKey: [
      PIWIGO_GALLERY_FINALIZE_JOB,
      batch.id,
      batch.deadlineGeneration,
      'upload-retry',
      file.messageId,
      attemptId,
      file.uploadRetryCount ?? 0,
      dedupeVariant
    ].filter((part) => part !== undefined).join(':'),
    abortBatchOnFailure: true
  };
}

function uploadRetryDelayMs(attemptNumber: number): number {
  return Math.min(
    UPLOAD_RETRY_MAX_MS,
    UPLOAD_RETRY_BASE_MS * (2 ** Math.max(0, attemptNumber - 1))
  );
}

function isAmbiguousPiwigoOutcome(error: unknown): boolean {
  if (!(error instanceof PiwigoApiError)) {
    return true;
  }
  const status = error.piwigoCode ?? error.httpStatus;
  return error.ambiguousOutcome ||
    status === 408 ||
    status === 423 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500);
}

function failureCodeForPiwigoError(error: unknown): GalleryBatchFileFailureCode {
  if (error instanceof PiwigoApiError && (error.piwigoCode ?? error.httpStatus) === 413) {
    return 'too-large';
  }
  return 'request-rejected';
}

async function failBatch(
  context: PluginRuntimeContext,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch,
  claimId: string,
  userReason: string,
  auditReason = userReason
): Promise<PluginAction[]> {
  const notificationText = await t(
    context,
    batch.scopeId,
    batch.actorIdentityId,
    'official.piwigo-gallery.failed',
    { reason: userReason }
  );
  const completed = completeBatchFinalization(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    claimId,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: auditReason,
    notification: {
      text: notificationText,
      deliveryKey: batchTerminalNotificationKey(batch)
    }
  });
  if (completed.kind !== 'completed') {
    return [];
  }
  const actions = await terminalBatchMaintenanceActions(context, db, completed.batch);
  actions.unshift({
      type: 'audit.record',
      action: 'piwigo-gallery.finalize.failed',
      metadataJson: {
        batchId: completed.batch.id,
        scopeId: completed.batch.scopeId,
        reason: auditReason
      }
  });
  return actions;
}

function renewBatchFinalizationLease(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch,
  claimId: string
) {
  const renewedAt = new Date();
  return renewBatchFinalizationClaim(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    claimId,
    renewedAt: renewedAt.toISOString(),
    claimExpiresAt: new Date(renewedAt.getTime() + FINALIZATION_CLAIM_MS).toISOString()
  });
}

async function withBatchLeaseHeartbeat<T>(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch,
  claimId: string,
  operation: () => Promise<T>
): Promise<T> {
  let heartbeatError: Error | undefined;
  const heartbeat = () => {
    try {
      const renewed = renewBatchFinalizationLease(db, batch, claimId);
      if (renewed.kind !== 'renewed') {
        heartbeatError = new Error(`Piwigo gallery finalization lease was lost for batch ${batch.id}.`);
      }
    } catch (error) {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
    }
  };
  heartbeat();
  if (heartbeatError) throw heartbeatError;
  const interval = setInterval(heartbeat, Math.max(1_000, Math.floor(FINALIZATION_CLAIM_MS / 3)));
  interval.unref?.();
  try {
    const result = await operation();
    heartbeat();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(interval);
  }
}

async function cleanupBatchMedia(
  context: PluginRuntimeContext,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch
): Promise<number> {
  if (!context.mediaStore) {
    return batchFilesPendingCleanup(db, batch.scopeId, batch.id).length;
  }
  for (const file of batchFilesPendingCleanup(db, batch.scopeId, batch.id)) {
    try {
      await context.mediaStore.delete(file.mediaId);
      completeBatchFileCleanup(db, {
        scopeId: batch.scopeId,
        batchId: batch.id,
        messageId: file.messageId,
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      context.logger.warn({
        err: error,
        batchId: batch.id,
        mediaId: file.mediaId
      }, 'Piwigo gallery staged media cleanup will be retried');
    }
  }
  return batchFilesPendingCleanup(db, batch.scopeId, batch.id).length;
}

async function terminalBatchMaintenanceActions(
  context: PluginRuntimeContext,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch
): Promise<PluginAction[]> {
  const cleanupRemaining = await cleanupBatchMedia(context, db, batch);
  const refreshed = getBatch(db, batch.scopeId, batch.id) ?? batch;
  const actions = dispatchBatchTerminalNotification(db, refreshed);
  if (cleanupRemaining > 0) {
    actions.push(batchCleanupRecoveryAction(refreshed));
  }
  return actions;
}

function dispatchBatchTerminalNotification(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  batch: GalleryUploadBatch
): PluginAction[] {
  if (!batch.terminalNotification || batch.terminalNotification.status === 'delivered') {
    return [];
  }
  const attemptId = randomUUID();
  const started = beginBatchTerminalNotification(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    attemptId,
    startedAt: new Date().toISOString()
  });
  if (started.kind !== 'dispatching') {
    return [];
  }
  return [
    {
      type: 'message.sendText',
      chatId: started.batch.collectionChatId,
      text: started.notification.text,
      idempotencyKey: started.notification.deliveryKey,
      requiredRemoteChatId: started.batch.collectionChatId,
      abortBatchOnFailure: true
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: started.batch.scopeId,
      runAt: new Date(),
      payload: {
        batchId: started.batch.id,
        deadlineGeneration: started.batch.deadlineGeneration,
        phase: 'notification-delivered',
        notificationAttemptId: attemptId
      },
      dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${started.batch.id}:notification-delivered:${attemptId}`,
      abortBatchOnFailure: true
    }
  ];
}

function batchTerminalNotificationKey(batch: Pick<GalleryUploadBatch, 'id' | 'scopeId'>): string {
  return `gallery-batch-terminal:${batch.scopeId}:${batch.id}`;
}

function batchCleanupRecoveryAction(batch: GalleryUploadBatch): PluginAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId: batch.scopeId,
    runAt: new Date(Date.now() + 60_000),
    payload: {
      batchId: batch.id,
      deadlineGeneration: batch.deadlineGeneration,
      phase: 'cleanup'
    },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:cleanup:${batch.deadlineGeneration}:${randomUUID()}`,
    abortBatchOnFailure: true
  };
}

async function announceNewAlbum(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const announcementId = announcementIdFromPayload(job.payload);
  if (!announcementId) {
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { reason: 'missing announcementId' } }];
  }
  const db = await preparedGalleryDatabase(context.databases);
  const phase = announcementPhaseFromPayload(job.payload);
  if (phase === 'complete') {
    const claimId = announcementClaimIdFromPayload(job.payload);
    if (!claimId) {
      return [{
        type: 'audit.record',
        action: 'piwigo-gallery.announce.completion-skipped',
        metadataJson: { announcementId, reason: 'missing claimId' }
      }];
    }
    const completed = completeAlbumAnnouncement(db, {
      scopeId: job.scopeId,
      announcementId,
      claimId,
      status: 'announced',
      completedAt: new Date().toISOString()
    });
    return completed
      ? [{
          type: 'audit.record',
          action: 'piwigo-gallery.announce.completed',
          metadataJson: { announcementId, claimId }
        }]
      : undefined;
  }
  if (phase === 'file-delivered') {
    const claimId = announcementClaimIdFromPayload(job.payload);
    const position = announcementPositionFromPayload(job.payload);
    if (!claimId || position === undefined) {
      return [{
        type: 'audit.record',
        action: 'piwigo-gallery.announce.file-completion-skipped',
        metadataJson: { announcementId, reason: 'missing claimId or position' }
      }];
    }
    const delivered = completeAlbumAnnouncementFileDelivery(db, {
      scopeId: job.scopeId,
      announcementId,
      claimId,
      position,
      deliveredAt: new Date().toISOString()
    });
    if (delivered.kind !== 'delivered' && delivered.kind !== 'already_delivered') {
      return;
    }
    return dispatchNextAnnouncementFile(context, job, db, delivered.announcement, claimId);
  }
  let current = getAlbumAnnouncement(db, job.scopeId, announcementId);
  if (!current || current.status !== 'pending') {
    return;
  }
  if (!current.announcementGroupWid) {
    const config = parsePiwigoGalleryConfig(await context.configFor(current.scopeId));
    const legacyTarget = announcementGroupWidFromPayload(job.payload) ?? job.groupWid ??
      config.announcementGroupWid ??
      await context.communityAnnouncementGroupWidForScope?.(current.scopeId);
    if (legacyTarget && await announcementTargetBelongsToScope(context, current.scopeId, legacyTarget)) {
      current = bindAlbumAnnouncementTarget(db, {
        scopeId: current.scopeId,
        announcementId: current.id,
        announcementGroupWid: legacyTarget
      }) ?? current;
    }
  }
  const claimedAt = new Date();
  const claimId = randomUUID();
  const claim = claimAlbumAnnouncement(db, {
    scopeId: job.scopeId,
    announcementId,
    claimId,
    claimedAt: claimedAt.toISOString(),
    claimExpiresAt: new Date(claimedAt.getTime() + ANNOUNCEMENT_CLAIM_MS).toISOString()
  });
  if (claim.kind === 'not_due') {
    return [{
      type: 'plugin.enqueueJob',
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
      scopeId: job.scopeId,
      runAt: announcementDueAt(claim.announcement),
      payload: { announcementId },
      dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcementId}:recovery:not-due:${announcementDueAt(claim.announcement).toISOString()}`,
      abortBatchOnFailure: true
    }];
  }
  if (claim.kind === 'already_claimed') {
    return [announcementClaimRecoveryAction(claim.announcement)];
  }
  if (claim.kind !== 'claimed') {
    return;
  }
  return dispatchNextAnnouncementFile(context, job, db, claim.announcement, claimId);
}

async function dispatchNextAnnouncementFile(
  context: PluginRuntimeContext,
  job: PluginJobEvent,
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  announcement: PiwigoAlbumAnnouncement,
  claimId: string
): Promise<PluginAction[] | void> {
  const announcementId = announcement.id;

  const config = parsePiwigoGalleryConfig(await context.configFor(announcement.scopeId));
  const announcementGroupWid = announcement.announcementGroupWid;
  if (!config.newAlbumAnnouncementsEnabled || !announcementGroupWid) {
    markAnnouncement(db, announcement, claimId, 'skipped', 'New album announcements are not configured.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { announcementId, reason: 'not configured' } }];
  }
  if (!await announcementTargetBelongsToScope(context, announcement.scopeId, announcementGroupWid)) {
    markAnnouncement(
      db,
      announcement,
      claimId,
      'skipped',
      'The captured announcement group no longer belongs to this scope.'
    );
    return [{
      type: 'audit.record',
      action: 'piwigo-gallery.announce.skipped',
      metadataJson: { announcementId, reason: 'captured target no longer belongs to scope' }
    }];
  }

  const selected = selectAnnouncementFiles(announcement.files);
  if (selected.length === 0) {
    markAnnouncement(db, announcement, claimId, 'skipped', 'No supported image or video files were provided.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.skipped', metadataJson: { announcementId, reason: 'no supported media' } }];
  }

  const next = selected.find((file) => file.deliveryStatus === 'dispatching') ??
    selected.find((file) => file.deliveryStatus !== 'delivered');
  if (!next) {
    const completed = completeAlbumAnnouncement(db, {
      scopeId: announcement.scopeId,
      announcementId,
      claimId,
      status: 'announced',
      completedAt: new Date().toISOString()
    });
    return completed
      ? [{
          type: 'audit.record',
          action: 'piwigo-gallery.announce.completed',
          metadataJson: { announcementId, claimId, deliveredFiles: selected.length }
        }]
      : undefined;
  }
  if (next.position === undefined) {
    markAnnouncement(db, announcement, claimId, 'failed', 'Announcement media position is missing.');
    return [{
      type: 'audit.record',
      action: 'piwigo-gallery.announce.failed',
      metadataJson: { announcementId, reason: 'announcement media position is missing' }
    }];
  }
  if (next.imageId === undefined) {
    markAnnouncement(
      db,
      announcement,
      claimId,
      'failed',
      'Announcement media is missing an immutable Piwigo image ID.'
    );
    return [{
      type: 'audit.record',
      action: 'piwigo-gallery.announce.failed',
      metadataJson: { announcementId, reason: 'announcement media image ID is missing' }
      }];
  }
  if (!next.sha256 || !/^[a-f0-9]{64}$/.test(next.sha256)) {
    markAnnouncement(
      db,
      announcement,
      claimId,
      'failed',
      'Announcement media is missing its immutable SHA-256 digest.'
    );
    return [{
      type: 'audit.record',
      action: 'piwigo-gallery.announce.failed',
      metadataJson: { announcementId, reason: 'announcement media SHA-256 digest is missing' }
    }];
  }
  const expectedSha256 = next.sha256;

  const connection = await resolveGalleryConnection(
    config,
    galleryConnectionDefaultsFromAppConfig(context.config)
  );
  if (!connection) {
    markAnnouncement(db, announcement, claimId, 'failed', 'Gallery connection is not configured.');
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.failed', metadataJson: { announcementId, reason: 'connection not configured' } }];
  }

  try {
    const client = new PiwigoGalleryClient(connection);
    const renewed = renewAlbumAnnouncementLease(db, announcement, claimId);
    if (renewed.kind !== 'renewed') {
      return;
    }
    announcement = renewed.announcement;
    const started = beginAlbumAnnouncementFileDelivery(db, {
      scopeId: announcement.scopeId,
      announcementId,
      claimId,
      position: next.position,
      startedAt: new Date().toISOString()
    });
    if (
      started.kind !== 'dispatching' &&
      started.kind !== 'resumed' &&
      started.kind !== 'already_dispatching'
    ) {
      return;
    }
    announcement = started.announcement;
    const imageId = started.file.imageId;
    if (imageId === undefined) {
      markAnnouncement(
        db,
        announcement,
        claimId,
        'failed',
        'Announcement media is missing an immutable Piwigo image ID.'
      );
      return [{
        type: 'audit.record',
        action: 'piwigo-gallery.announce.failed',
        metadataJson: { announcementId, reason: 'announcement media image ID is missing' }
      }];
    }
    const file = await withAlbumAnnouncementLeaseHeartbeat(db, announcement, claimId, () =>
      client.downloadForAnnouncement({ imageId, expectedSha256 })
    );
    const captionValues = {
      album: announcement.albumName,
      site: announcement.siteLabel,
      user: announcement.userDisplayName
    };
    const caption = await albumAnnouncementCaption(context, announcement, config.newAlbumAnnouncementTemplate, captionValues);
    return [
      announcementClaimRecoveryAction(announcement),
      {
        type: 'message.sendMedia',
        chatId: announcementGroupWid,
        file: {
          filename: file.filename,
          mimeType: file.mimeType,
          buffer: file.buffer
        },
        ...(selected[0]?.position === next.position && caption ? { caption } : {}),
        waitUntilMsgSent: true,
        abortBatchOnFailure: true,
        idempotencyKey: announcementFileIdempotencyKey(announcement, next.position)
      },
      {
        type: 'plugin.enqueueJob',
        pluginId: PIWIGO_GALLERY_PLUGIN_ID,
        jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
        scopeId: announcement.scopeId,
        runAt: new Date(),
        payload: {
          announcementId,
          phase: 'file-delivered',
          claimId,
          position: next.position,
          announcementGroupWid
        },
        dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcementId}:file-delivered:${next.position}:${claimId}`,
        abortBatchOnFailure: true
      }
    ];
  } catch (error) {
    const reason = errorMessage(error);
    if (isTransientPiwigoDownloadError(error)) {
      const failedAt = new Date();
      const nextAttempt = (announcement.downloadRetryCount ?? 0) + 1;
      const retryAt = new Date(
        failedAt.getTime() + announcementDownloadRetryDelayMs(nextAttempt)
      );
      const recorded = recordAlbumAnnouncementDownloadFailure(db, {
        scopeId: announcement.scopeId,
        announcementId,
        claimId,
        position: next.position,
        failedAt: failedAt.toISOString(),
        error: reason,
        retryAt: retryAt.toISOString(),
        maxAttempts: ANNOUNCEMENT_DOWNLOAD_MAX_ATTEMPTS
      });
      if (recorded.kind === 'retry_scheduled') {
        return [
          {
            type: 'audit.record',
            action: 'piwigo-gallery.announce.download-retry-scheduled',
            metadataJson: {
              announcementId,
              position: next.position,
              retryCount: recorded.announcement.downloadRetryCount,
              retryAt: recorded.announcement.downloadNextRetryAt,
              reason
            }
          },
          announcementDownloadRetryAction(recorded.announcement, next.position, claimId)
        ];
      }
      if (recorded.kind === 'exhausted') {
        return [{
          type: 'audit.record',
          action: 'piwigo-gallery.announce.failed',
          metadataJson: {
            announcementId,
            position: next.position,
            retryCount: recorded.announcement.downloadRetryCount,
            reason
          }
        }];
      }
      return;
    }
    markAnnouncement(db, announcement, claimId, 'failed', reason);
    return [{ type: 'audit.record', action: 'piwigo-gallery.announce.failed', metadataJson: { announcementId, reason } }];
  }
}

function announcementDownloadRetryAction(
  announcement: PiwigoAlbumAnnouncement,
  position: number,
  sourceClaimId: string
): PluginAction {
  const retryAt = announcement.downloadNextRetryAt;
  if (!retryAt) {
    throw new Error(`Piwigo album announcement ${announcement.id} has no download retry schedule.`);
  }
  const retryCount = announcement.downloadRetryCount ?? 0;
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    scopeId: announcement.scopeId,
    runAt: new Date(retryAt),
    payload: {
      announcementId: announcement.id,
      recoveryReason: 'download-retry',
      retryCount,
      position,
      sourceClaimId
    },
    // This identity is deliberately distinct from the callback job that is
    // still active while its returned actions are being executed by BullMQ.
    dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcement.id}:download-retry:${position}:${sourceClaimId}:${retryCount}:${retryAt}`,
    abortBatchOnFailure: true
  };
}

function announcementDownloadRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(10, attempt - 1));
  return Math.min(
    ANNOUNCEMENT_DOWNLOAD_RETRY_MAX_MS,
    ANNOUNCEMENT_DOWNLOAD_RETRY_BASE_MS * (2 ** exponent)
  );
}

function isTransientPiwigoDownloadError(error: unknown): boolean {
  if (error instanceof PiwigoApiError) {
    if (error.ambiguousOutcome) return true;
    // Piwigo reports application errors in a successful HTTP response, so the
    // API code is authoritative when both values are present.
    const status = error.piwigoCode ?? error.httpStatus;
    return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
  }
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError;
  }
  return false;
}

function announcementFileIdempotencyKey(
  announcement: Pick<PiwigoAlbumAnnouncement, 'id' | 'scopeId'>,
  position: number
): string {
  return `album-announcement:${announcement.scopeId}:${announcement.id}:file:${position}`;
}

function announcementDueAt(announcement: PiwigoAlbumAnnouncement): Date {
  return new Date(
    announcement.downloadNextRetryAt &&
      new Date(announcement.downloadNextRetryAt).getTime() > new Date(announcement.announceAt).getTime()
      ? announcement.downloadNextRetryAt
      : announcement.announceAt
  );
}

function renewAlbumAnnouncementLease(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  announcement: PiwigoAlbumAnnouncement,
  claimId: string
) {
  const now = new Date();
  return renewAlbumAnnouncementClaim(db, {
    scopeId: announcement.scopeId,
    announcementId: announcement.id,
    claimId,
    claimExpiresAt: new Date(now.getTime() + ANNOUNCEMENT_CLAIM_MS).toISOString()
  });
}

async function withAlbumAnnouncementLeaseHeartbeat<T>(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  announcement: PiwigoAlbumAnnouncement,
  claimId: string,
  operation: () => Promise<T>
): Promise<T> {
  let heartbeatError: Error | undefined;
  const heartbeat = () => {
    try {
      if (renewAlbumAnnouncementLease(db, announcement, claimId).kind !== 'renewed') {
        heartbeatError = new Error(`Piwigo album announcement lease was lost for ${announcement.id}.`);
      }
    } catch (error) {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
    }
  };
  heartbeat();
  if (heartbeatError) throw heartbeatError;
  const interval = setInterval(heartbeat, Math.max(1_000, Math.floor(ANNOUNCEMENT_CLAIM_MS / 3)));
  interval.unref?.();
  try {
    const result = await operation();
    heartbeat();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(interval);
  }
}

function batchDeadlineRecoveryAction(
  batch: GalleryUploadBatch,
  input: { reason: 'not-due' | 'stale-deadline'; sourceDeadlineGeneration: number }
): PluginAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId: batch.scopeId,
    runAt: new Date(batch.autoFinalizeAt),
    payload: {
      batchId: batch.id,
      deadlineGeneration: batch.deadlineGeneration,
      recoveryReason: input.reason,
      sourceDeadlineGeneration: input.sourceDeadlineGeneration
    },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:${batch.deadlineGeneration}:recovery:${input.reason}:${input.sourceDeadlineGeneration}`,
    abortBatchOnFailure: true
  };
}

async function enqueueBatchClaimRecovery(
  context: PluginRuntimeContext,
  job: PluginJobEvent,
  batch: GalleryUploadBatch
): Promise<void> {
  const claimId = batch.finalizationClaimId;
  const claimExpiresAt = batch.finalizationClaimExpiresAt;
  if (!claimId || !claimExpiresAt) {
    return;
  }
  await enqueuePluginJob(context, {
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId: batch.scopeId,
    ...(job.groupId ? { groupId: job.groupId } : {}),
    ...(job.groupWid ? { groupWid: job.groupWid } : {}),
    runAt: new Date(claimExpiresAt),
    payload: {
      batchId: batch.id,
      deadlineGeneration: batch.deadlineGeneration,
      recoveryClaimId: claimId
    },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:${batch.deadlineGeneration}:claim-recovery:${claimId}:${claimExpiresAt}`
  });
}

function announcementClaimRecoveryAction(announcement: PiwigoAlbumAnnouncement): PluginAction {
  const claimId = announcement.claimId;
  const claimExpiresAt = announcement.claimExpiresAt;
  if (!claimId || !claimExpiresAt) {
    throw new Error(`Piwigo album announcement ${announcement.id} has no active claim lease.`);
  }
  return {
    type: 'plugin.enqueueJob',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    scopeId: announcement.scopeId,
    runAt: new Date(claimExpiresAt),
    payload: {
      announcementId: announcement.id,
      recoveryClaimId: claimId
    },
    dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcement.id}:claim-recovery:${claimId}:${claimExpiresAt}`,
    abortBatchOnFailure: true
  };
}

async function albumAnnouncementCaption(
  context: PluginRuntimeContext,
  announcement: PiwigoAlbumAnnouncement,
  configuredTemplate: string,
  values: Record<'album' | 'site' | 'user', string>
): Promise<string> {
  const source = configuredTemplate
    || (await context.i18n.translatorForScope(announcement.scopeId))(
      'official.piwigo-gallery.albumAnnouncementCaption'
    );
  try {
    return renderPiwigoAlbumAnnouncementTemplate(source, values).trim();
  } catch {
    context.logger.warn({
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      scopeId: announcement.scopeId,
      announcementId: announcement.id,
      field: 'newAlbumAnnouncementTemplate'
    }, 'Piwigo album announcement caption template is invalid; sending media without a caption');
    return '';
  }
}

async function announcementTargetBelongsToScope(
  context: PluginRuntimeContext,
  scopeId: string,
  groupWid: string
): Promise<boolean> {
  if (!groupWid.toLowerCase().endsWith('@g.us')) return false;
  const groups = await context.coveredGroupsForScope?.(scopeId);
  return groups?.some((group) => group.groupWid.toLowerCase() === groupWid.toLowerCase()) ?? true;
}

function markAnnouncement(
  db: Awaited<ReturnType<typeof preparedGalleryDatabase>>,
  announcement: PiwigoAlbumAnnouncement,
  claimId: string,
  status: Exclude<PiwigoAlbumAnnouncement['status'], 'pending'>,
  error?: string | undefined
): void {
  completeAlbumAnnouncement(db, {
    scopeId: announcement.scopeId,
    announcementId: announcement.id,
    claimId,
    status,
    completedAt: new Date().toISOString(),
    ...(error ? { error } : {})
  });
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

function normalizedMessageType(type: string | undefined): string {
  return (type ?? 'unknown').trim().toLowerCase();
}

function mediaDumpHintPayloadFromJob(payload: unknown): MediaDumpHintPayload | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.chatId !== 'string'
    || typeof value.messageId !== 'string'
    || typeof value.actorIdentityId !== 'string'
  ) {
    return undefined;
  }
  const chatId = value.chatId.trim();
  const messageId = value.messageId.trim();
  const actorIdentityId = value.actorIdentityId.trim();
  if (!chatId || !messageId || !actorIdentityId) {
    return undefined;
  }
  return {
    chatId,
    messageId,
    actorIdentityId,
    ...(typeof value.actorDisplayName === 'string' && value.actorDisplayName.trim()
      ? { actorDisplayName: value.actorDisplayName.trim() }
      : {}),
    chatSurface: value.chatSurface === 'private'
      ? 'private'
      : value.chatSurface === 'group'
        ? 'group'
        : chatId.toLowerCase().endsWith('@g.us')
          ? 'group'
          : 'private'
  };
}

function mediaDumpReminderKey(scopeId: string, chatId: string, actorIdentityId: string): string {
  return `media-dump-reminder:${scopeId}:${chatId}:${actorIdentityId}`;
}

function batchIdFromPayload(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'batchId' in payload && typeof (payload as { batchId?: unknown }).batchId === 'string'
    ? (payload as { batchId: string }).batchId
    : undefined;
}

function forcedFromPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'forced' in payload && (payload as { forced?: unknown }).forced === true;
}

function batchPhaseFromPayload(payload: unknown): 'finalize' | 'cleanup' | 'notification-delivered' {
  if (typeof payload !== 'object' || payload === null || !('phase' in payload)) {
    return 'finalize';
  }
  const phase = (payload as { phase?: unknown }).phase;
  return phase === 'cleanup' || phase === 'notification-delivered' ? phase : 'finalize';
}

function batchNotificationAttemptIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('notificationAttemptId' in payload)) {
    return undefined;
  }
  const attemptId = (payload as { notificationAttemptId?: unknown }).notificationAttemptId;
  return typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : undefined;
}

function deadlineGenerationFromPayload(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || !('deadlineGeneration' in payload)) {
    return undefined;
  }
  const value = (payload as { deadlineGeneration?: unknown }).deadlineGeneration;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function announcementIdFromPayload(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'announcementId' in payload && typeof (payload as { announcementId?: unknown }).announcementId === 'string'
    ? (payload as { announcementId: string }).announcementId
    : undefined;
}

function announcementPhaseFromPayload(payload: unknown): 'deliver' | 'file-delivered' | 'complete' {
  if (typeof payload !== 'object' || payload === null || !('phase' in payload)) {
    return 'deliver';
  }
  const phase = (payload as { phase?: unknown }).phase;
  return phase === 'complete' || phase === 'file-delivered' ? phase : 'deliver';
}

function announcementClaimIdFromPayload(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'claimId' in payload && typeof (payload as { claimId?: unknown }).claimId === 'string'
    ? (payload as { claimId: string }).claimId
    : undefined;
}

function announcementPositionFromPayload(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || !('position' in payload)) {
    return undefined;
  }
  const position = (payload as { position?: unknown }).position;
  return typeof position === 'number' && Number.isSafeInteger(position) && position >= 0
    ? position
    : undefined;
}

function announcementGroupWidFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('announcementGroupWid' in payload)) {
    return undefined;
  }
  const groupWid = (payload as { announcementGroupWid?: unknown }).announcementGroupWid;
  return typeof groupWid === 'string' && groupWid.endsWith('@g.us') ? groupWid : undefined;
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
    text: await t(context, event.scopeId, event.actorIdentityId, key, params)
  };
}

async function t(
  context: PluginRuntimeContext,
  scopeId: string,
  actorIdentityId: string,
  key: string,
  params: Record<string, string> = {}
): Promise<string> {
  const translator = await context.i18n.translatorForIdentity(actorIdentityId, scopeId);
  return translator(key, params);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userFacingPiwigoErrorKey(error: unknown): string {
  const status = error instanceof PiwigoApiError ? error.piwigoCode ?? error.httpStatus : undefined;
  return status !== undefined && status >= 400 && status < 500
    ? 'official.piwigo-gallery.error.requestRejected'
    : 'official.piwigo-gallery.error.serviceUnavailable';
}
