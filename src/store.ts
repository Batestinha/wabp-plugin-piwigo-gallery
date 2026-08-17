import { z } from 'zod';
import type {
  PluginDatabase,
  PluginDatabaseRegistry,
  PluginDatabaseRow
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { GalleryConnection, GalleryConnectionDefaults, PiwigoGalleryConfig } from './config';
import { configConnection } from './config';
import { PIWIGO_GALLERY_DATABASE } from './manifest';
import {
  galleryAlbumSourceRef,
  galleryAlbumSourceSnapshot,
  parseGalleryAlbumSource,
  type GalleryAlbumSource
} from './albumMetadata';

export type GalleryUploadBatchStatus =
  | 'collecting'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface GalleryUploadDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  groupId?: string | undefined;
  /** Exact physical managed-group target. It is immutable after insertion. */
  groupWid: string;
  /** Exact physical managed-group provenance. It must be the same group as groupWid. */
  chatId: string;
  /** Exact chat where documents are collected. */
  collectionChatId: string;
  actorWid: string;
  actorIdentityId: string;
  topomareUserId: string;
  /** Immutable Piwigo shadow-user binding affirmed by central authorization. */
  piwigoUserId: number;
  actorLabel: string;
  acceptedExtensions: string[];
  maxFileBytes: number;
  autoFinalizeMinutes: number;
  createdAt: string;
  updatedAt?: string | undefined;
  version?: number | undefined;
}

export interface StoredGalleryUploadDraft extends GalleryUploadDraft {
  collectionChatId: string;
  updatedAt: string;
  version: number;
}

export interface GalleryBatchFile {
  mediaId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'staged' | 'uploading' | 'uploaded' | 'failed';
  acceptedAt?: string | undefined;
  uploadAttemptId?: string | undefined;
  uploadStartedAt?: string | undefined;
  uploadRetryCount?: number | undefined;
  uploadNextRetryAt?: string | undefined;
  uploadLastError?: string | undefined;
  failureCode?: GalleryBatchFileFailureCode | undefined;
  failedAt?: string | undefined;
  imageId?: number | undefined;
  url?: string | undefined;
  uploadedAt?: string | undefined;
  cleanupPending?: boolean | undefined;
  cleanupCompletedAt?: string | undefined;
}

export type GalleryBatchFileFailureCode = 'too-large' | 'request-rejected';

export interface GalleryUploadBatch {
  id: string;
  status: GalleryUploadBatchStatus;
  scopeId: string;
  groupId?: string | undefined;
  /** Exact physical managed-group target. It is immutable after insertion. */
  groupWid: string;
  /** Exact physical managed-group provenance. It must be the same group as groupWid. */
  chatId: string;
  /** Exact chat where documents are collected. */
  collectionChatId: string;
  actorWid: string;
  actorIdentityId: string;
  /** Historical terminal rows may predate the atomic Topomare cutover. */
  topomareUserId: string | null;
  /** Historical terminal rows may predate the atomic Topomare cutover. */
  piwigoUserId: number | null;
  actorLabel: string;
  onde: string;
  quando: string;
  withUserIds: number[];
  albumSource: GalleryAlbumSource;
  acceptedExtensions: string[];
  maxFileBytes: number;
  autoFinalizeMinutes: number;
  files: GalleryBatchFile[];
  createdAt: string;
  updatedAt: string;
  autoFinalizeAt: string;
  lastAcceptedAt?: string | undefined;
  deadlineGeneration?: number | undefined;
  version?: number | undefined;
  finalizationClaimId?: string | undefined;
  finalizationClaimedAt?: string | undefined;
  finalizationClaimExpiresAt?: string | undefined;
  albumLabel?: string | undefined;
  error?: string | undefined;
  terminalNotification?: GalleryBatchTerminalNotification | undefined;
}

export interface GalleryBatchTerminalNotification {
  text: string;
  status: 'pending' | 'dispatching' | 'delivered';
  deliveryKey: string;
  attemptId?: string | undefined;
  startedAt?: string | undefined;
  deliveredAt?: string | undefined;
}

export interface StoredGalleryUploadBatch extends GalleryUploadBatch {
  deadlineGeneration: number;
  version: number;
}

export type NewGalleryUploadBatch = Omit<
  GalleryUploadBatch,
  'topomareUserId' | 'piwigoUserId'
> & {
  topomareUserId: string;
  piwigoUserId: number;
};

export interface PiwigoAlbumAnnouncementFile {
  position?: number | undefined;
  imageId?: number | undefined;
  fileId?: string | undefined;
  downloadToken?: string | undefined;
  sha256?: string | undefined;
  filename: string;
  mimeType: string;
  deliveryStatus?: 'pending' | 'dispatching' | 'delivered' | undefined;
  deliveryClaimId?: string | undefined;
  deliveryStartedAt?: string | undefined;
  deliveredAt?: string | undefined;
}

export interface PiwigoAlbumAnnouncement {
  id: string;
  dedupeKey: string;
  scopeId: string;
  /** Resolved physical WhatsApp group captured when the callback is accepted. */
  announcementGroupWid?: string | undefined;
  albumId?: string | undefined;
  albumName: string;
  siteLabel: string;
  userDisplayName: string;
  files: PiwigoAlbumAnnouncementFile[];
  observedAt: string;
  announceAt: string;
  status: 'pending' | 'announced' | 'skipped' | 'failed';
  error?: string | undefined;
  announcedAt?: string | undefined;
  claimId?: string | undefined;
  claimExpiresAt?: string | undefined;
  downloadRetryCount?: number | undefined;
  downloadNextRetryAt?: string | undefined;
  downloadLastError?: string | undefined;
  version?: number | undefined;
}

export interface StoredPiwigoAlbumAnnouncement extends PiwigoAlbumAnnouncement {
  downloadRetryCount: number;
  version: number;
}

interface DraftRow extends PluginDatabaseRow {
  flow_session_id: string;
  flow_type: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string;
  chat_id: string;
  collection_chat_id: string;
  actor_wid: string;
  actor_identity_id: string | null;
  topomare_user_id: string | null;
  piwigo_user_id: number | null;
  actor_label: string;
  accepted_extensions_json: string;
  max_file_bytes: number;
  auto_finalize_minutes: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface BatchRow extends PluginDatabaseRow {
  id: string;
  status: GalleryUploadBatchStatus;
  scope_id: string;
  group_id: string | null;
  group_wid: string;
  chat_id: string;
  collection_chat_id: string;
  actor_wid: string;
  actor_identity_id: string | null;
  topomare_user_id: string | null;
  piwigo_user_id: number | null;
  actor_label: string;
  onde: string;
  quando: string;
  with_user_ids_json: string;
  source_kind: GalleryAlbumSource['kind'];
  source_ref: string | null;
  source_snapshot_json: string | null;
  accepted_extensions_json: string;
  max_file_bytes: number;
  auto_finalize_minutes: number;
  created_at: string;
  updated_at: string;
  auto_finalize_at: string;
  last_accepted_at: string | null;
  deadline_generation: number;
  version: number;
  finalization_claim_id: string | null;
  finalization_claimed_at: string | null;
  finalization_claim_expires_at: string | null;
  album_label: string | null;
  error: string | null;
  terminal_notification_text: string | null;
  terminal_notification_status: GalleryBatchTerminalNotification['status'] | null;
  terminal_notification_delivery_key: string | null;
  terminal_notification_attempt_id: string | null;
  terminal_notification_started_at: string | null;
  terminal_notification_delivered_at: string | null;
}

interface BatchFileRow extends PluginDatabaseRow {
  batch_id: string;
  media_id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: GalleryBatchFile['status'];
  image_id: number | null;
  url: string | null;
  accepted_at: string;
  upload_attempt_id: string | null;
  upload_started_at: string | null;
  upload_retry_count: number;
  upload_next_retry_at: string | null;
  upload_last_error: string | null;
  failure_code: GalleryBatchFileFailureCode | null;
  failed_at: string | null;
  uploaded_at: string | null;
  cleanup_pending: number;
  cleanup_completed_at: string | null;
}

interface AnnouncementRow extends PluginDatabaseRow {
  id: string;
  dedupe_key: string;
  scope_id: string;
  announcement_group_wid: string | null;
  album_id: string | null;
  album_name: string;
  site_label: string;
  user_display_name: string;
  observed_at: string;
  announce_at: string;
  status: PiwigoAlbumAnnouncement['status'];
  error: string | null;
  announced_at: string | null;
  claim_id: string | null;
  claim_expires_at: string | null;
  download_retry_count: number;
  download_next_retry_at: string | null;
  download_last_error: string | null;
  version: number;
}

interface AnnouncementFileRow extends PluginDatabaseRow {
  position: number;
  image_id: number | null;
  file_id: string | null;
  download_token: string | null;
  sha256: string | null;
  filename: string;
  mime_type: string;
  delivery_status: NonNullable<PiwigoAlbumAnnouncementFile['deliveryStatus']>;
  delivery_claim_id: string | null;
  delivery_started_at: string | null;
  delivered_at: string | null;
}

export class GalleryStorageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GalleryStorageConflictError';
  }
}

export class GalleryStorageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GalleryStorageInvariantError';
  }
}

export function galleryDatabase(registry: PluginDatabaseRegistry | undefined): PluginDatabase {
  if (!registry) {
    throw new Error('official.piwigo-gallery requires its account-scoped plugin database registry.');
  }
  return registry.open(PIWIGO_GALLERY_DATABASE);
}

export async function resolveGalleryConnection(
  config: PiwigoGalleryConfig,
  defaults: GalleryConnectionDefaults
): Promise<GalleryConnection | undefined> {
  return configConnection(config, defaults);
}

export function saveDraft(db: PluginDatabase, draft: GalleryUploadDraft): StoredGalleryUploadDraft {
  assertExactTarget(draft.groupWid, draft.chatId);
  const actorIdentityId = requireActorIdentityId(draft);
  const updatedAt = draft.updatedAt ?? draft.createdAt;
  return db.transaction(() => {
    const existing = getDraft(db, draft.scopeId, draft.flowSessionId);
    const collectionChatId = normalizeCollectionChatId(draft.collectionChatId);
    if (existing) {
      assertSameTarget(existing, { ...draft, collectionChatId }, 'gallery upload draft');
      const result = db.run(
        `UPDATE gallery_upload_drafts
            SET flow_type = ?, actor_label = ?,
                accepted_extensions_json = ?, max_file_bytes = ?, auto_finalize_minutes = ?,
                updated_at = ?, version = version + 1
          WHERE flow_session_id = ? AND scope_id = ? AND version = ?`,
        draft.flowType,
        draft.actorLabel,
        JSON.stringify(uniqueStrings(draft.acceptedExtensions)),
        draft.maxFileBytes,
        draft.autoFinalizeMinutes,
        updatedAt,
        draft.flowSessionId,
        draft.scopeId,
        draft.version ?? existing.version
      );
      if (result.changes !== 1) {
        throw new GalleryStorageConflictError(`Gallery upload draft ${draft.flowSessionId} changed concurrently.`);
      }
    } else {
      db.run(
        `INSERT INTO gallery_upload_drafts (
          flow_session_id, flow_type, scope_id, group_id, group_wid, chat_id, collection_chat_id, actor_wid,
          actor_identity_id, topomare_user_id, piwigo_user_id, actor_label,
          accepted_extensions_json, max_file_bytes, auto_finalize_minutes,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        draft.flowSessionId,
        draft.flowType,
        draft.scopeId,
        draft.groupId ?? null,
        normalizeWid(draft.groupWid),
        normalizeWid(draft.chatId),
        collectionChatId,
        normalizeWid(draft.actorWid),
        actorIdentityId,
        requireTopomareUserId(draft.topomareUserId),
        requirePiwigoUserId(draft.piwigoUserId),
        draft.actorLabel,
        JSON.stringify(uniqueStrings(draft.acceptedExtensions)),
        draft.maxFileBytes,
        draft.autoFinalizeMinutes,
        draft.createdAt,
        updatedAt
      );
    }
    return requireDraft(db, draft.scopeId, draft.flowSessionId);
  });
}

export function getDraft(
  db: PluginDatabase,
  scopeId: string,
  flowSessionId: string
): StoredGalleryUploadDraft | undefined {
  const row = db.get<DraftRow>(
    'SELECT * FROM gallery_upload_drafts WHERE flow_session_id = ? AND scope_id = ?',
    flowSessionId,
    scopeId
  );
  return row ? draftFromRow(row) : undefined;
}

export function listDrafts(db: PluginDatabase): StoredGalleryUploadDraft[] {
  return db.all<DraftRow>(
    'SELECT * FROM gallery_upload_drafts ORDER BY created_at ASC, flow_session_id ASC'
  ).map(draftFromRow);
}

export function deleteDraft(db: PluginDatabase, scopeId: string, flowSessionId: string): number {
  return db.run(
    'DELETE FROM gallery_upload_drafts WHERE flow_session_id = ? AND scope_id = ?',
    flowSessionId,
    scopeId
  ).changes;
}

export function createBatch(
  db: PluginDatabase,
  batch: NewGalleryUploadBatch,
  options: { draftFlowSessionId?: string | undefined } = {}
): StoredGalleryUploadBatch {
  if (batch.status !== 'collecting') {
    throw new GalleryStorageInvariantError('New gallery upload batches must start in collecting state.');
  }
  for (const file of batch.files) {
    if (
      file.status !== 'staged' ||
      file.uploadAttemptId !== undefined ||
      file.uploadStartedAt !== undefined ||
      file.imageId !== undefined ||
      file.url !== undefined ||
      file.uploadedAt !== undefined ||
      file.failedAt !== undefined
    ) {
      throw new GalleryStorageInvariantError(
        'New gallery upload batch files must start as unattempted staged media.'
      );
    }
  }
  assertExactTarget(batch.groupWid, batch.chatId);
  const actorIdentityId = requireActorIdentityId(batch);
  const storedBatch = {
    ...batch,
    collectionChatId: normalizeCollectionChatId(batch.collectionChatId)
  };
  return db.transaction(() => {
    const active = activeBatchIdentityClaim(
      db,
      storedBatch.scopeId,
      storedBatch.collectionChatId,
      actorIdentityId
    );
    if (active && active.batch_id !== batch.id) {
      throw new GalleryStorageConflictError(
        `Identity ${actorIdentityId} already has active gallery upload ${active.batch_id} in ${storedBatch.collectionChatId}.`
      );
    }
    insertBatch(db, storedBatch);
    db.run(
      `INSERT INTO gallery_active_batch_identities
        (scope_id, collection_chat_id, actor_identity_id, batch_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      storedBatch.scopeId,
      storedBatch.collectionChatId,
      actorIdentityId,
      storedBatch.id,
      storedBatch.createdAt
    );
    if (options.draftFlowSessionId) {
      const deleted = deleteDraft(db, batch.scopeId, options.draftFlowSessionId);
      if (deleted !== 1) {
        throw new GalleryStorageConflictError(
          `Gallery upload draft ${options.draftFlowSessionId} disappeared before batch creation.`
        );
      }
    }
    return requireBatch(db, batch.scopeId, batch.id);
  });
}

export function getBatch(
  db: PluginDatabase,
  scopeId: string,
  batchId: string
): StoredGalleryUploadBatch | undefined {
  const row = db.get<BatchRow>(
    'SELECT * FROM gallery_upload_batches WHERE id = ? AND scope_id = ?',
    batchId,
    scopeId
  );
  return row ? batchFromRow(db, row) : undefined;
}

export function getActiveBatch(
  db: PluginDatabase,
  scopeId: string,
  chatId: string,
  actorIdentityId: string
): StoredGalleryUploadBatch | undefined {
  const normalizedActorIdentityId = normalizeIdentityId(actorIdentityId);
  const active = db.get<{ batch_id: string }>(
    `SELECT batch_id FROM gallery_active_batch_identities
      WHERE scope_id = ? AND collection_chat_id = ? AND actor_identity_id = ?`,
    scopeId,
    normalizeCollectionChatId(chatId),
    normalizedActorIdentityId
  );
  const batch = active?.batch_id ? getBatch(db, scopeId, active.batch_id) : undefined;
  if (batch && batch.actorIdentityId !== normalizedActorIdentityId) {
    throw new GalleryStorageInvariantError(
      `Active gallery upload ${batch.id} has a mismatched identity ownership claim.`
    );
  }
  return batch;
}

export function getActiveBatchAcrossScopes(
  db: PluginDatabase,
  collectionChatId: string,
  actorIdentityId: string
): StoredGalleryUploadBatch | undefined {
  const normalizedChatId = normalizeCollectionChatId(collectionChatId);
  const normalizedActorIdentityId = normalizeIdentityId(actorIdentityId);
  const matches = db.all<{ scope_id: string; batch_id: string }>(
    `SELECT scope_id, batch_id FROM gallery_active_batch_identities
      WHERE collection_chat_id = ? AND actor_identity_id = ?`,
    normalizedChatId,
    normalizedActorIdentityId
  );
  if (matches.length > 1) {
    throw new GalleryStorageInvariantError(
      `Multiple active gallery uploads matched the collection inbox ${normalizedChatId}.`
    );
  }
  const match = matches[0];
  const batch = match ? getBatch(db, match.scope_id, match.batch_id) : undefined;
  if (batch && batch.actorIdentityId !== normalizedActorIdentityId) {
    throw new GalleryStorageInvariantError(
      `Active gallery upload ${batch.id} has a mismatched identity ownership claim.`
    );
  }
  return batch;
}

export function clearActiveBatch(db: PluginDatabase, batch: Pick<GalleryUploadBatch, 'id'>): number {
  return db.run('DELETE FROM gallery_active_batch_identities WHERE batch_id = ?', batch.id).changes;
}

export type AppendBatchFileResult =
  | { kind: 'appended'; batch: StoredGalleryUploadBatch; fileCount: number }
  | { kind: 'duplicate'; batch: StoredGalleryUploadBatch; fileCount: number }
  | { kind: 'missing' }
  | { kind: 'not_collecting'; batch: StoredGalleryUploadBatch }
  | { kind: 'version_conflict'; batch: StoredGalleryUploadBatch };

export function appendBatchFile(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  file: GalleryBatchFile;
  acceptedAt: string;
  autoFinalizeAt: string;
  expectedVersion?: number | undefined;
}): AppendBatchFileResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) {
      return { kind: 'missing' };
    }
    if (batch.status !== 'collecting') {
      return { kind: 'not_collecting', batch };
    }
    if (input.expectedVersion !== undefined && batch.version !== input.expectedVersion) {
      return { kind: 'version_conflict', batch };
    }
    const duplicate = db.get(
      'SELECT message_id FROM gallery_upload_batch_files WHERE batch_id = ? AND message_id = ?',
      input.batchId,
      input.file.messageId
    );
    if (duplicate) {
      return { kind: 'duplicate', batch, fileCount: batch.files.length };
    }
    db.run(
      `INSERT INTO gallery_upload_batch_files (
        batch_id, media_id, message_id, filename, mime_type, size_bytes, status,
        image_id, url, accepted_at, upload_attempt_id, upload_started_at, uploaded_at,
        cleanup_pending, cleanup_completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'staged', NULL, NULL, ?, NULL, NULL, NULL, 0, NULL)`,
      input.batchId,
      input.file.mediaId,
      input.file.messageId,
      input.file.filename,
      input.file.mimeType,
      input.file.sizeBytes,
      input.acceptedAt
    );
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET updated_at = ?, auto_finalize_at = ?, last_accepted_at = ?,
              deadline_generation = deadline_generation + 1, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'collecting' AND version = ?`,
      input.acceptedAt,
      input.autoFinalizeAt,
      input.acceptedAt,
      input.batchId,
      input.scopeId,
      batch.version
    );
    if (updated.changes !== 1) {
      throw new GalleryStorageConflictError(`Gallery upload batch ${input.batchId} changed during file append.`);
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return { kind: 'appended', batch: stored, fileCount: stored.files.length };
  });
}

export type RequestBatchFinalizationResult =
  | { kind: 'queued'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'no_files'; batch: StoredGalleryUploadBatch }
  | { kind: 'not_collecting'; batch: StoredGalleryUploadBatch }
  | { kind: 'version_conflict'; batch: StoredGalleryUploadBatch };

export function requestBatchFinalization(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  requestedAt: string;
  expectedVersion?: number | undefined;
}): RequestBatchFinalizationResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'collecting') return { kind: 'not_collecting', batch };
    if (input.expectedVersion !== undefined && input.expectedVersion !== batch.version) {
      return { kind: 'version_conflict', batch };
    }
    if (batch.files.every((file) => file.status !== 'staged')) {
      return { kind: 'no_files', batch };
    }
    db.run(
      `UPDATE gallery_upload_batches
          SET auto_finalize_at = ?, updated_at = ?, deadline_generation = deadline_generation + 1,
              version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'collecting' AND version = ?`,
      input.requestedAt,
      input.requestedAt,
      input.batchId,
      input.scopeId,
      batch.version
    );
    return { kind: 'queued', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export type ClaimBatchFinalizationResult =
  | { kind: 'claimed'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'stale_deadline'; batch: StoredGalleryUploadBatch }
  | { kind: 'not_due'; batch: StoredGalleryUploadBatch }
  | { kind: 'already_claimed'; batch: StoredGalleryUploadBatch }
  | { kind: 'terminal'; batch: StoredGalleryUploadBatch };

export function claimBatchFinalization(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  deadlineGeneration: number;
  claimId: string;
  claimedAt: string;
  claimExpiresAt: string;
  forced?: boolean | undefined;
}): ClaimBatchFinalizationResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.deadlineGeneration !== input.deadlineGeneration) {
      return { kind: 'stale_deadline', batch };
    }
    if (isTerminalBatchStatus(batch.status)) {
      return { kind: 'terminal', batch };
    }
    if (batch.status === 'finalizing') {
      if (batch.finalizationClaimId === input.claimId) {
        return { kind: 'claimed', batch };
      }
      if (batch.finalizationClaimExpiresAt && batch.finalizationClaimExpiresAt > input.claimedAt) {
        return { kind: 'already_claimed', batch };
      }
    } else if (!input.forced && batch.autoFinalizeAt > input.claimedAt) {
      return { kind: 'not_due', batch };
    }
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET status = 'finalizing', finalization_claim_id = ?, finalization_claimed_at = ?,
              finalization_claim_expires_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND version = ?
          AND deadline_generation = ? AND status IN ('collecting', 'finalizing')`,
      input.claimId,
      input.claimedAt,
      input.claimExpiresAt,
      input.claimedAt,
      input.batchId,
      input.scopeId,
      batch.version,
      input.deadlineGeneration
    );
    if (updated.changes !== 1) {
      throw new GalleryStorageConflictError(`Gallery upload batch ${input.batchId} changed during finalization claim.`);
    }
    return { kind: 'claimed', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export type MarkBatchFileUploadedResult =
  | { kind: 'uploaded'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'already_uploaded'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch }
  | { kind: 'file_missing'; batch: StoredGalleryUploadBatch };

export type MarkBatchFileFailedResult =
  | { kind: 'failed'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'already_failed'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch }
  | { kind: 'file_missing'; batch: StoredGalleryUploadBatch }
  | { kind: 'attempt_lost'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile };

export type BeginBatchFileUploadResult =
  | { kind: 'uploading'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'already_uploading'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'already_uploaded'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch }
  | { kind: 'file_missing'; batch: StoredGalleryUploadBatch };

/**
 * Persists the ambiguity boundary before the first byte is sent to Piwigo.
 * An `uploading` file may be replayed only with this exact attempt ID after
 * the remote advertises the matching idempotency contract.
 */
export function beginBatchFileUpload(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  claimId: string;
  attemptId: string;
  startedAt: string;
}): BeginBatchFileUploadResult {
  const attemptId = requireUploadAttemptId(input.attemptId);
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const file = batch.files.find((candidate) => candidate.messageId === input.messageId);
    if (!file) return { kind: 'file_missing', batch };
    if (file.status === 'uploaded') return { kind: 'already_uploaded', batch, file };
    if (file.status === 'uploading') {
      if (file.uploadAttemptId !== attemptId) {
        throw new GalleryStorageInvariantError(
          `Gallery upload file ${input.messageId} already has a different durable v4 idempotency key.`
        );
      }
      return { kind: 'already_uploading', batch, file };
    }
    const updatedFile = db.run(
      `UPDATE gallery_upload_batch_files
          SET status = 'uploading', upload_attempt_id = ?, upload_started_at = ?,
              upload_retry_count = 0, upload_next_retry_at = NULL, upload_last_error = NULL
        WHERE batch_id = ? AND message_id = ? AND status = 'staged'`,
      attemptId,
      input.startedAt,
      input.batchId,
      input.messageId
    );
    const updatedBatch = db.run(
      `UPDATE gallery_upload_batches
          SET updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing'
          AND finalization_claim_id = ? AND version = ?`,
      input.startedAt,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updatedFile.changes !== 1 || updatedBatch.changes !== 1) {
      throw new GalleryStorageConflictError(`Gallery upload file ${input.messageId} changed while dispatching.`);
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'uploading',
      batch: stored,
      file: stored.files.find((candidate) => candidate.messageId === input.messageId)!
    };
  });
}

export type RecordBatchFileUploadFailureResult =
  | { kind: 'recorded'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch }
  | { kind: 'file_missing'; batch: StoredGalleryUploadBatch }
  | { kind: 'attempt_lost'; batch: StoredGalleryUploadBatch; file: GalleryBatchFile };

/**
 * Durably records an ambiguous remote outcome. When retryAt is present the
 * current lease is released atomically so the scheduled retry can claim the
 * batch without waiting for lease expiry.
 */
export function recordBatchFileUploadFailure(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  claimId: string;
  attemptId: string;
  failedAt: string;
  error: string;
  retryAt?: string | undefined;
}): RecordBatchFileUploadFailureResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const file = batch.files.find((candidate) => candidate.messageId === input.messageId);
    if (!file) return { kind: 'file_missing', batch };
    if (file.status !== 'uploading' || file.uploadAttemptId !== input.attemptId) {
      return { kind: 'attempt_lost', batch, file };
    }
    const updatedFile = db.run(
      `UPDATE gallery_upload_batch_files
          SET upload_retry_count = upload_retry_count + 1,
              upload_next_retry_at = ?, upload_last_error = ?
        WHERE batch_id = ? AND message_id = ? AND status = 'uploading'
          AND upload_attempt_id = ?`,
      input.retryAt ?? null,
      input.error,
      input.batchId,
      input.messageId,
      input.attemptId
    );
    const updatedBatch = db.run(
      `UPDATE gallery_upload_batches
          SET updated_at = ?, version = version + 1,
              finalization_claim_id = CASE WHEN ? IS NULL THEN finalization_claim_id ELSE NULL END,
              finalization_claimed_at = CASE WHEN ? IS NULL THEN finalization_claimed_at ELSE NULL END,
              finalization_claim_expires_at = CASE WHEN ? IS NULL THEN finalization_claim_expires_at ELSE NULL END
        WHERE id = ? AND scope_id = ? AND status = 'finalizing'
          AND finalization_claim_id = ? AND version = ?`,
      input.failedAt,
      input.retryAt ?? null,
      input.retryAt ?? null,
      input.retryAt ?? null,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updatedFile.changes !== 1 || updatedBatch.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Gallery upload file ${input.messageId} changed while recording a retry.`
      );
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'recorded',
      batch: stored,
      file: stored.files.find((candidate) => candidate.messageId === input.messageId)!
    };
  });
}

export type ReleaseBatchFinalizationClaimResult =
  | { kind: 'released'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch };

export function releaseBatchFinalizationClaim(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  claimId: string;
  releasedAt: string;
}): ReleaseBatchFinalizationClaimResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET finalization_claim_id = NULL, finalization_claimed_at = NULL,
              finalization_claim_expires_at = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing'
          AND finalization_claim_id = ? AND version = ?`,
      input.releasedAt,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updated.changes !== 1) {
      return { kind: 'claim_lost', batch: requireBatch(db, input.scopeId, input.batchId) };
    }
    return { kind: 'released', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export type RenewBatchFinalizationClaimResult =
  | { kind: 'renewed'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch };

export function renewBatchFinalizationClaim(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  claimId: string;
  renewedAt: string;
  claimExpiresAt: string;
}): RenewBatchFinalizationClaimResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET finalization_claim_expires_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing'
          AND finalization_claim_id = ? AND version = ?`,
      input.claimExpiresAt,
      input.renewedAt,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updated.changes !== 1) {
      return { kind: 'claim_lost', batch: requireBatch(db, input.scopeId, input.batchId) };
    }
    return { kind: 'renewed', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export function markBatchFileUploaded(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  claimId: string;
  attemptId: string;
  imageId: number;
  url?: string | undefined;
  albumLabel?: string | undefined;
  uploadedAt: string;
}): MarkBatchFileUploadedResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const file = batch.files.find((candidate) => candidate.messageId === input.messageId);
    if (!file) return { kind: 'file_missing', batch };
    if (file.status === 'uploaded') return { kind: 'already_uploaded', batch, file };
    if (file.status !== 'uploading' || file.uploadAttemptId !== input.attemptId) {
      return { kind: 'claim_lost', batch };
    }
    const updatedFile = db.run(
      `UPDATE gallery_upload_batch_files
          SET status = 'uploaded', image_id = ?, url = ?, uploaded_at = ?, cleanup_pending = 1,
              cleanup_completed_at = NULL, upload_next_retry_at = NULL, upload_last_error = NULL
        WHERE batch_id = ? AND message_id = ? AND status = 'uploading' AND upload_attempt_id = ?`,
      input.imageId,
      input.url ?? null,
      input.uploadedAt,
      input.batchId,
      input.messageId,
      input.attemptId
    );
    const updatedBatch = db.run(
      `UPDATE gallery_upload_batches
          SET album_label = COALESCE(?, album_label), updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing' AND finalization_claim_id = ?
          AND version = ?`,
      input.albumLabel ?? null,
      input.uploadedAt,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updatedFile.changes !== 1 || updatedBatch.changes !== 1) {
      throw new GalleryStorageConflictError(`Gallery upload file ${input.messageId} changed while acknowledging upload.`);
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'uploaded',
      batch: stored,
      file: stored.files.find((candidate) => candidate.messageId === input.messageId)!
    };
  });
}

/** Records a confirmed, non-retryable rejection and leaves the batch claim active. */
export function markBatchFileFailed(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  claimId: string;
  attemptId: string;
  failureCode: GalleryBatchFileFailureCode;
  error: string;
  failedAt: string;
}): MarkBatchFileFailedResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    const file = batch.files.find((candidate) => candidate.messageId === input.messageId);
    if (!file) return { kind: 'file_missing', batch };
    if (file.status === 'failed') return { kind: 'already_failed', batch, file };
    if (file.status !== 'uploading' || file.uploadAttemptId !== input.attemptId) {
      return { kind: 'attempt_lost', batch, file };
    }
    const updatedFile = db.run(
      `UPDATE gallery_upload_batch_files
          SET status = 'failed', failure_code = ?, failed_at = ?, upload_last_error = ?,
              upload_next_retry_at = NULL, cleanup_pending = 1, cleanup_completed_at = NULL
        WHERE batch_id = ? AND message_id = ? AND status = 'uploading'
          AND upload_attempt_id = ?`,
      input.failureCode,
      input.failedAt,
      input.error,
      input.batchId,
      input.messageId,
      input.attemptId
    );
    const updatedBatch = db.run(
      `UPDATE gallery_upload_batches
          SET updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing'
          AND finalization_claim_id = ? AND version = ?`,
      input.failedAt,
      input.batchId,
      input.scopeId,
      input.claimId,
      batch.version
    );
    if (updatedFile.changes !== 1 || updatedBatch.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Gallery upload file ${input.messageId} changed while recording a confirmed failure.`
      );
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'failed',
      batch: stored,
      file: stored.files.find((candidate) => candidate.messageId === input.messageId)!
    };
  });
}

export function completeBatchFileCleanup(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  completedAt: string;
}): boolean {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return false;
    const cleaned = db.run(
      `UPDATE gallery_upload_batch_files
          SET cleanup_pending = 0, cleanup_completed_at = ?
        WHERE batch_id = ? AND message_id = ? AND cleanup_pending = 1`,
      input.completedAt,
      input.batchId,
      input.messageId
    );
    if (cleaned.changes === 1) {
      db.run(
        `UPDATE gallery_upload_batches SET version = version + 1, updated_at = ?
          WHERE id = ? AND scope_id = ?`,
        input.completedAt,
        input.batchId,
        input.scopeId
      );
    }
    return cleaned.changes === 1;
  });
}

export function batchFilesPendingCleanup(
  db: PluginDatabase,
  scopeId: string,
  batchId: string
): GalleryBatchFile[] {
  return getBatch(db, scopeId, batchId)?.files.filter((file) => file.cleanupPending) ?? [];
}

export type BeginBatchTerminalNotificationResult =
  | { kind: 'dispatching'; batch: StoredGalleryUploadBatch; notification: GalleryBatchTerminalNotification }
  | { kind: 'missing' }
  | { kind: 'not_terminal'; batch: StoredGalleryUploadBatch }
  | { kind: 'no_notification'; batch: StoredGalleryUploadBatch }
  | { kind: 'already_delivered'; batch: StoredGalleryUploadBatch; notification: GalleryBatchTerminalNotification };

export function beginBatchTerminalNotification(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  attemptId: string;
  startedAt: string;
}): BeginBatchTerminalNotificationResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (!isTerminalBatchStatus(batch.status)) return { kind: 'not_terminal', batch };
    if (!batch.terminalNotification) return { kind: 'no_notification', batch };
    if (batch.terminalNotification.status === 'delivered') {
      return { kind: 'already_delivered', batch, notification: batch.terminalNotification };
    }
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET terminal_notification_status = 'dispatching',
              terminal_notification_attempt_id = ?, terminal_notification_started_at = ?,
              terminal_notification_delivered_at = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND version = ?
          AND terminal_notification_status IN ('pending', 'dispatching')`,
      input.attemptId,
      input.startedAt,
      input.startedAt,
      input.batchId,
      input.scopeId,
      batch.version
    );
    if (updated.changes !== 1) {
      throw new GalleryStorageConflictError(`Gallery batch ${input.batchId} notification changed while dispatching.`);
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'dispatching',
      batch: stored,
      notification: stored.terminalNotification!
    };
  });
}

export type CompleteBatchTerminalNotificationResult =
  | { kind: 'delivered'; batch: StoredGalleryUploadBatch; notification: GalleryBatchTerminalNotification }
  | { kind: 'already_delivered'; batch: StoredGalleryUploadBatch; notification: GalleryBatchTerminalNotification }
  | { kind: 'missing' }
  | { kind: 'no_notification'; batch: StoredGalleryUploadBatch }
  | { kind: 'attempt_lost'; batch: StoredGalleryUploadBatch; notification: GalleryBatchTerminalNotification };

export function completeBatchTerminalNotification(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  attemptId: string;
  deliveredAt: string;
}): CompleteBatchTerminalNotificationResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (!batch.terminalNotification) return { kind: 'no_notification', batch };
    if (batch.terminalNotification.status === 'delivered') {
      return { kind: 'already_delivered', batch, notification: batch.terminalNotification };
    }
    if (
      batch.terminalNotification.status !== 'dispatching' ||
      batch.terminalNotification.attemptId !== input.attemptId
    ) {
      return { kind: 'attempt_lost', batch, notification: batch.terminalNotification };
    }
    const updated = db.run(
      `UPDATE gallery_upload_batches
          SET terminal_notification_status = 'delivered', terminal_notification_delivered_at = ?,
              updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND version = ?
          AND terminal_notification_status = 'dispatching'
          AND terminal_notification_attempt_id = ?`,
      input.deliveredAt,
      input.deliveredAt,
      input.batchId,
      input.scopeId,
      batch.version,
      input.attemptId
    );
    if (updated.changes !== 1) {
      return {
        kind: 'attempt_lost',
        batch: requireBatch(db, input.scopeId, input.batchId),
        notification: batch.terminalNotification
      };
    }
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return { kind: 'delivered', batch: stored, notification: stored.terminalNotification! };
  });
}

export type CompleteBatchResult =
  | { kind: 'completed'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; batch: StoredGalleryUploadBatch }
  | { kind: 'staged_files_remain'; batch: StoredGalleryUploadBatch }
  | { kind: 'already_terminal'; batch: StoredGalleryUploadBatch };

export function completeBatchFinalization(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  claimId: string;
  status: 'completed' | 'expired' | 'failed';
  completedAt: string;
  albumLabel?: string | undefined;
  error?: string | undefined;
  notification?: {
    text: string;
    deliveryKey: string;
  } | undefined;
}): CompleteBatchResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (isTerminalBatchStatus(batch.status)) return { kind: 'already_terminal', batch };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    if (input.status === 'completed' && batch.files.some((file) => file.status !== 'uploaded')) {
      return { kind: 'staged_files_remain', batch };
    }
    if (input.status === 'expired' && batch.files.length > 0) {
      throw new GalleryStorageInvariantError('Only an empty gallery upload batch may expire.');
    }
    if (input.status === 'failed') {
      db.run(
        `UPDATE gallery_upload_batch_files
            SET cleanup_pending = 1, cleanup_completed_at = NULL
          WHERE batch_id = ? AND cleanup_pending = 0 AND cleanup_completed_at IS NULL`,
        input.batchId
      );
    }
    db.run(
      `UPDATE gallery_upload_batches
          SET status = ?, updated_at = ?, deadline_generation = deadline_generation + 1,
              version = version + 1, finalization_claim_id = NULL,
              finalization_claimed_at = NULL, finalization_claim_expires_at = NULL,
              album_label = COALESCE(?, album_label), error = ?,
              terminal_notification_text = ?, terminal_notification_status = ?,
              terminal_notification_delivery_key = ?, terminal_notification_attempt_id = NULL,
              terminal_notification_started_at = NULL, terminal_notification_delivered_at = NULL
        WHERE id = ? AND scope_id = ? AND status = 'finalizing' AND finalization_claim_id = ?`,
      input.status,
      input.completedAt,
      input.albumLabel ?? null,
      input.error ?? null,
      input.notification?.text ?? null,
      input.notification ? 'pending' : null,
      input.notification?.deliveryKey ?? null,
      input.batchId,
      input.scopeId,
      input.claimId
    );
    clearActiveBatch(db, batch);
    return { kind: 'completed', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export type CancelBatchResult =
  | { kind: 'cancelled'; batch: StoredGalleryUploadBatch }
  | { kind: 'missing' }
  | { kind: 'already_terminal'; batch: StoredGalleryUploadBatch }
  | { kind: 'version_conflict'; batch: StoredGalleryUploadBatch };

export function cancelBatch(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  cancelledAt: string;
  expectedVersion?: number | undefined;
}): CancelBatchResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (isTerminalBatchStatus(batch.status)) return { kind: 'already_terminal', batch };
    if (input.expectedVersion !== undefined && input.expectedVersion !== batch.version) {
      return { kind: 'version_conflict', batch };
    }
    db.run(
      `UPDATE gallery_upload_batch_files
          SET cleanup_pending = 1, cleanup_completed_at = NULL
        WHERE batch_id = ? AND cleanup_pending = 0`,
      input.batchId
    );
    db.run(
      `UPDATE gallery_upload_batches
          SET status = 'cancelled', updated_at = ?, deadline_generation = deadline_generation + 1,
              version = version + 1, finalization_claim_id = NULL,
              finalization_claimed_at = NULL, finalization_claim_expires_at = NULL
        WHERE id = ? AND scope_id = ? AND version = ? AND status IN ('collecting', 'finalizing')`,
      input.cancelledAt,
      input.batchId,
      input.scopeId,
      batch.version
    );
    clearActiveBatch(db, batch);
    return { kind: 'cancelled', batch: requireBatch(db, input.scopeId, input.batchId) };
  });
}

export function saveAlbumAnnouncement(
  db: PluginDatabase,
  announcement: PiwigoAlbumAnnouncement,
  expectedVersion?: number | undefined
): StoredPiwigoAlbumAnnouncement {
  return db.transaction(() => {
    const existing = getAlbumAnnouncement(db, announcement.scopeId, announcement.id);
    const announcementGroupWid = announcement.announcementGroupWid
      ? normalizeAnnouncementGroupWid(announcement.announcementGroupWid)
      : existing?.announcementGroupWid;
    if (
      existing?.announcementGroupWid &&
      announcementGroupWid &&
      normalizeWid(existing.announcementGroupWid) !== announcementGroupWid
    ) {
      throw new GalleryStorageInvariantError(
        `Album announcement ${announcement.id} target cannot be changed after capture.`
      );
    }
    if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new GalleryStorageConflictError(`Album announcement ${announcement.id} changed concurrently.`);
    }
    if (existing) {
      const updated = db.run(
        `UPDATE gallery_album_announcements
            SET announcement_group_wid = ?, album_id = ?, album_name = ?, site_label = ?, user_display_name = ?,
                observed_at = ?, announce_at = ?, status = ?, error = ?, announced_at = ?,
                claim_id = ?, claim_expires_at = ?, download_retry_count = ?,
                download_next_retry_at = ?, download_last_error = ?, version = version + 1
          WHERE id = ? AND scope_id = ? AND version = ?`,
        announcementGroupWid ?? null,
        announcement.albumId ?? null,
        announcement.albumName,
        announcement.siteLabel,
        announcement.userDisplayName,
        announcement.observedAt,
        announcement.announceAt,
        announcement.status,
        announcement.error ?? null,
        announcement.announcedAt ?? null,
        announcement.claimId ?? null,
        announcement.claimExpiresAt ?? null,
        announcement.downloadRetryCount ?? existing.downloadRetryCount,
        announcement.downloadNextRetryAt ?? existing.downloadNextRetryAt ?? null,
        announcement.downloadLastError ?? existing.downloadLastError ?? null,
        announcement.id,
        announcement.scopeId,
        expectedVersion ?? existing.version
      );
      if (updated.changes !== 1) {
        throw new GalleryStorageConflictError(`Album announcement ${announcement.id} changed concurrently.`);
      }
    } else {
      db.run(
        `INSERT INTO gallery_album_announcements (
          id, dedupe_key, scope_id, announcement_group_wid, album_id, album_name, site_label,
          user_display_name, observed_at, announce_at, status, error, announced_at, claim_id,
          claim_expires_at, download_retry_count, download_next_retry_at, download_last_error, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        announcement.id,
        announcement.dedupeKey,
        announcement.scopeId,
        announcementGroupWid ?? null,
        announcement.albumId ?? null,
        announcement.albumName,
        announcement.siteLabel,
        announcement.userDisplayName,
        announcement.observedAt,
        announcement.announceAt,
        announcement.status,
        announcement.error ?? null,
        announcement.announcedAt ?? null,
        announcement.claimId ?? null,
        announcement.claimExpiresAt ?? null,
        announcement.downloadRetryCount ?? 0,
        announcement.downloadNextRetryAt ?? null,
        announcement.downloadLastError ?? null
      );
    }
    db.run('DELETE FROM gallery_album_announcement_files WHERE announcement_id = ?', announcement.id);
    announcement.files.forEach((file, position) => insertAnnouncementFile(db, announcement.id, file, position));
    return requireAnnouncement(db, announcement.scopeId, announcement.id);
  });
}

export function getAlbumAnnouncement(
  db: PluginDatabase,
  scopeId: string,
  announcementId: string
): StoredPiwigoAlbumAnnouncement | undefined {
  const row = db.get<AnnouncementRow>(
    'SELECT * FROM gallery_album_announcements WHERE id = ? AND scope_id = ?',
    announcementId,
    scopeId
  );
  return row ? announcementFromRow(db, row) : undefined;
}

export function getAlbumAnnouncementByDedupeKey(
  db: PluginDatabase,
  scopeId: string,
  dedupeKey: string
): StoredPiwigoAlbumAnnouncement | undefined {
  const row = db.get<AnnouncementRow>(
    'SELECT * FROM gallery_album_announcements WHERE scope_id = ? AND dedupe_key = ?',
    scopeId,
    dedupeKey
  );
  return row ? announcementFromRow(db, row) : undefined;
}

/**
 * Backfills the immutable target for rows created before target persistence was
 * introduced. New callback rows are inserted with this value already present.
 */
export function bindAlbumAnnouncementTarget(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  announcementGroupWid: string;
}): StoredPiwigoAlbumAnnouncement | undefined {
  const announcementGroupWid = normalizeAnnouncementGroupWid(input.announcementGroupWid);
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return undefined;
    if (announcement.announcementGroupWid) {
      if (normalizeWid(announcement.announcementGroupWid) !== announcementGroupWid) {
        throw new GalleryStorageInvariantError(
          `Album announcement ${input.announcementId} target cannot be changed after capture.`
        );
      }
      return announcement;
    }
    const updated = db.run(
      `UPDATE gallery_album_announcements
          SET announcement_group_wid = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND announcement_group_wid IS NULL AND version = ?`,
      announcementGroupWid,
      input.announcementId,
      input.scopeId,
      announcement.version
    );
    if (updated.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Album announcement ${input.announcementId} changed while binding its target.`
      );
    }
    return requireAnnouncement(db, input.scopeId, input.announcementId);
  });
}

export type ClaimAlbumAnnouncementResult =
  | { kind: 'claimed'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'missing' }
  | { kind: 'not_pending'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'not_due'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'already_claimed'; announcement: StoredPiwigoAlbumAnnouncement };

export function claimAlbumAnnouncement(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  claimedAt: string;
  claimExpiresAt: string;
}): ClaimAlbumAnnouncementResult {
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return { kind: 'missing' };
    if (announcement.status !== 'pending') return { kind: 'not_pending', announcement };
    if (announcement.announceAt > input.claimedAt) return { kind: 'not_due', announcement };
    if (announcement.downloadNextRetryAt && announcement.downloadNextRetryAt > input.claimedAt) {
      return { kind: 'not_due', announcement };
    }
    if (
      announcement.claimId &&
      announcement.claimId !== input.claimId &&
      announcement.claimExpiresAt &&
      announcement.claimExpiresAt > input.claimedAt
    ) {
      return { kind: 'already_claimed', announcement };
    }
    db.run(
      `UPDATE gallery_album_announcements
          SET claim_id = ?, claim_expires_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending' AND version = ?`,
      input.claimId,
      input.claimExpiresAt,
      input.announcementId,
      input.scopeId,
      announcement.version
    );
    return {
      kind: 'claimed',
      announcement: requireAnnouncement(db, input.scopeId, input.announcementId)
    };
  });
}

export type RenewAlbumAnnouncementClaimResult =
  | { kind: 'renewed'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; announcement: StoredPiwigoAlbumAnnouncement };

export function renewAlbumAnnouncementClaim(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  claimExpiresAt: string;
}): RenewAlbumAnnouncementClaimResult {
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return { kind: 'missing' };
    if (announcement.status !== 'pending' || announcement.claimId !== input.claimId) {
      return { kind: 'claim_lost', announcement };
    }
    const updated = db.run(
      `UPDATE gallery_album_announcements
          SET claim_expires_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending'
          AND claim_id = ? AND version = ?`,
      input.claimExpiresAt,
      input.announcementId,
      input.scopeId,
      input.claimId,
      announcement.version
    );
    if (updated.changes !== 1) {
      return {
        kind: 'claim_lost',
        announcement: requireAnnouncement(db, input.scopeId, input.announcementId)
      };
    }
    return {
      kind: 'renewed',
      announcement: requireAnnouncement(db, input.scopeId, input.announcementId)
    };
  });
}

export type BeginAlbumAnnouncementFileDeliveryResult =
  | { kind: 'dispatching'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'resumed'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'already_dispatching'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'already_delivered'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'file_missing'; announcement: StoredPiwigoAlbumAnnouncement };

export function beginAlbumAnnouncementFileDelivery(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  position: number;
  startedAt: string;
}): BeginAlbumAnnouncementFileDeliveryResult {
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return { kind: 'missing' };
    if (announcement.status !== 'pending' || announcement.claimId !== input.claimId) {
      return { kind: 'claim_lost', announcement };
    }
    const file = announcement.files.find((candidate) => candidate.position === input.position);
    if (!file) return { kind: 'file_missing', announcement };
    if (file.deliveryStatus === 'delivered') {
      return { kind: 'already_delivered', announcement, file };
    }
    if (file.deliveryStatus === 'dispatching' && file.deliveryClaimId === input.claimId) {
      return { kind: 'already_dispatching', announcement, file };
    }
    const resuming = file.deliveryStatus === 'dispatching';
    const updatedFile = db.run(
      `UPDATE gallery_album_announcement_files
          SET delivery_status = 'dispatching', delivery_claim_id = ?,
              delivery_started_at = COALESCE(delivery_started_at, ?)
        WHERE announcement_id = ? AND position = ? AND delivery_status = ?`,
      input.claimId,
      input.startedAt,
      input.announcementId,
      input.position,
      resuming ? 'dispatching' : 'pending'
    );
    const updatedAnnouncement = db.run(
      `UPDATE gallery_album_announcements
          SET version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending'
          AND claim_id = ? AND version = ?`,
      input.announcementId,
      input.scopeId,
      input.claimId,
      announcement.version
    );
    if (updatedFile.changes !== 1 || updatedAnnouncement.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Album announcement ${input.announcementId} file ${input.position} changed while dispatching.`
      );
    }
    const stored = requireAnnouncement(db, input.scopeId, input.announcementId);
    return {
      kind: resuming ? 'resumed' : 'dispatching',
      announcement: stored,
      file: stored.files.find((candidate) => candidate.position === input.position)!
    };
  });
}

export type CompleteAlbumAnnouncementFileDeliveryResult =
  | { kind: 'delivered'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'already_delivered'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'file_missing'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'not_dispatching'; announcement: StoredPiwigoAlbumAnnouncement; file: PiwigoAlbumAnnouncementFile };

export function completeAlbumAnnouncementFileDelivery(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  position: number;
  deliveredAt: string;
}): CompleteAlbumAnnouncementFileDeliveryResult {
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return { kind: 'missing' };
    if (announcement.status !== 'pending' || announcement.claimId !== input.claimId) {
      return { kind: 'claim_lost', announcement };
    }
    const file = announcement.files.find((candidate) => candidate.position === input.position);
    if (!file) return { kind: 'file_missing', announcement };
    if (file.deliveryStatus === 'delivered') {
      return { kind: 'already_delivered', announcement, file };
    }
    if (file.deliveryStatus !== 'dispatching' || file.deliveryClaimId !== input.claimId) {
      return { kind: 'not_dispatching', announcement, file };
    }
    const updatedFile = db.run(
      `UPDATE gallery_album_announcement_files
          SET delivery_status = 'delivered', delivered_at = ?
        WHERE announcement_id = ? AND position = ? AND delivery_status = 'dispatching'
          AND delivery_claim_id = ?`,
      input.deliveredAt,
      input.announcementId,
      input.position,
      input.claimId
    );
    const updatedAnnouncement = db.run(
      `UPDATE gallery_album_announcements
          SET download_retry_count = 0, download_next_retry_at = NULL,
              download_last_error = NULL, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending'
          AND claim_id = ? AND version = ?`,
      input.announcementId,
      input.scopeId,
      input.claimId,
      announcement.version
    );
    if (updatedFile.changes !== 1 || updatedAnnouncement.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Album announcement ${input.announcementId} file ${input.position} changed while acknowledging delivery.`
      );
    }
    const stored = requireAnnouncement(db, input.scopeId, input.announcementId);
    return {
      kind: 'delivered',
      announcement: stored,
      file: stored.files.find((candidate) => candidate.position === input.position)!
    };
  });
}

export type RecordAlbumAnnouncementDownloadFailureResult =
  | { kind: 'retry_scheduled'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'exhausted'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'missing' }
  | { kind: 'claim_lost'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'file_missing'; announcement: StoredPiwigoAlbumAnnouncement }
  | { kind: 'not_dispatching'; announcement: StoredPiwigoAlbumAnnouncement };

/**
 * Records a read-only Piwigo download failure and releases the claim only when
 * another bounded attempt is allowed. No WhatsApp media action has been
 * emitted at this point, so the file delivery marker can safely return to
 * pending.
 */
export function recordAlbumAnnouncementDownloadFailure(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  position: number;
  failedAt: string;
  error: string;
  retryAt: string;
  maxAttempts: number;
}): RecordAlbumAnnouncementDownloadFailureResult {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new GalleryStorageInvariantError('Album announcement download maxAttempts must be positive.');
  }
  return db.transaction(() => {
    const announcement = getAlbumAnnouncement(db, input.scopeId, input.announcementId);
    if (!announcement) return { kind: 'missing' };
    if (announcement.status !== 'pending' || announcement.claimId !== input.claimId) {
      return { kind: 'claim_lost', announcement };
    }
    const file = announcement.files.find((candidate) => candidate.position === input.position);
    if (!file) return { kind: 'file_missing', announcement };
    if (file.deliveryStatus !== 'dispatching' || file.deliveryClaimId !== input.claimId) {
      return { kind: 'not_dispatching', announcement };
    }

    const retryCount = announcement.downloadRetryCount + 1;
    const exhausted = retryCount >= input.maxAttempts;
    const updatedFile = db.run(
      `UPDATE gallery_album_announcement_files
          SET delivery_status = 'pending', delivery_claim_id = NULL,
              delivery_started_at = NULL
        WHERE announcement_id = ? AND position = ? AND delivery_status = 'dispatching'
          AND delivery_claim_id = ?`,
      input.announcementId,
      input.position,
      input.claimId
    );
    const updatedAnnouncement = db.run(
      `UPDATE gallery_album_announcements
          SET status = ?, error = ?, claim_id = NULL, claim_expires_at = NULL,
              download_retry_count = ?, download_next_retry_at = ?,
              download_last_error = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending'
          AND claim_id = ? AND version = ?`,
      exhausted ? 'failed' : 'pending',
      exhausted ? input.error : null,
      retryCount,
      exhausted ? null : input.retryAt,
      input.error,
      input.announcementId,
      input.scopeId,
      input.claimId,
      announcement.version
    );
    if (updatedFile.changes !== 1 || updatedAnnouncement.changes !== 1) {
      throw new GalleryStorageConflictError(
        `Album announcement ${input.announcementId} changed while recording a download failure.`
      );
    }
    return {
      kind: exhausted ? 'exhausted' : 'retry_scheduled',
      announcement: requireAnnouncement(db, input.scopeId, input.announcementId)
    };
  });
}

export function completeAlbumAnnouncement(db: PluginDatabase, input: {
  scopeId: string;
  announcementId: string;
  claimId: string;
  status: 'announced' | 'skipped' | 'failed';
  completedAt: string;
  error?: string | undefined;
}): StoredPiwigoAlbumAnnouncement | undefined {
  return db.transaction(() => {
    const updated = db.run(
      `UPDATE gallery_album_announcements
          SET status = ?, error = ?, announced_at = ?, claim_id = NULL,
              claim_expires_at = NULL, download_next_retry_at = NULL,
              version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'pending' AND claim_id = ?`,
      input.status,
      input.error ?? null,
      input.status === 'announced' ? input.completedAt : null,
      input.announcementId,
      input.scopeId,
      input.claimId
    );
    return updated.changes === 1
      ? requireAnnouncement(db, input.scopeId, input.announcementId)
      : undefined;
  });
}

function insertBatch(db: PluginDatabase, batch: GalleryUploadBatch): void {
  const deadlineGeneration = batch.deadlineGeneration ?? 1;
  const version = batch.version ?? 1;
  const collectionChatId = normalizeCollectionChatId(batch.collectionChatId);
  db.run(
    `INSERT INTO gallery_upload_batches (
      id, status, scope_id, group_id, group_wid, chat_id, collection_chat_id, actor_wid,
      actor_identity_id, topomare_user_id, piwigo_user_id, actor_label, onde, quando, with_user_ids_json,
      source_kind, source_ref, source_snapshot_json,
      accepted_extensions_json, max_file_bytes, auto_finalize_minutes, created_at, updated_at,
      auto_finalize_at, last_accepted_at, deadline_generation, version,
      finalization_claim_id, finalization_claimed_at, finalization_claim_expires_at,
      album_label, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batch.id,
    batch.status,
    batch.scopeId,
    batch.groupId ?? null,
    normalizeWid(batch.groupWid),
    normalizeWid(batch.chatId),
    collectionChatId,
    normalizeWid(batch.actorWid),
    normalizeIdentityId(batch.actorIdentityId),
    requireTopomareUserId(batch.topomareUserId),
    requirePiwigoUserId(batch.piwigoUserId),
    batch.actorLabel,
    batch.onde,
    batch.quando,
    JSON.stringify(uniqueNumbers(batch.withUserIds)),
    batch.albumSource.kind,
    galleryAlbumSourceRef(batch.albumSource) ?? null,
    galleryAlbumSourceSnapshot(batch.albumSource) ?? null,
    JSON.stringify(uniqueStrings(batch.acceptedExtensions)),
    batch.maxFileBytes,
    batch.autoFinalizeMinutes,
    batch.createdAt,
    batch.updatedAt,
    batch.autoFinalizeAt,
    batch.lastAcceptedAt ?? null,
    deadlineGeneration,
    version,
    batch.finalizationClaimId ?? null,
    batch.finalizationClaimedAt ?? null,
    batch.finalizationClaimExpiresAt ?? null,
    batch.albumLabel ?? null,
    batch.error ?? null
  );
  for (const file of batch.files) {
    insertBatchFile(db, batch.id, file, file.acceptedAt ?? batch.lastAcceptedAt ?? batch.createdAt);
  }
}

function insertBatchFile(db: PluginDatabase, batchId: string, file: GalleryBatchFile, acceptedAt: string): void {
  db.run(
    `INSERT INTO gallery_upload_batch_files (
      batch_id, media_id, message_id, filename, mime_type, size_bytes, status,
      image_id, url, accepted_at, upload_attempt_id, upload_started_at, uploaded_at,
      upload_retry_count, upload_next_retry_at, upload_last_error,
      failure_code, failed_at, cleanup_pending, cleanup_completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchId,
    file.mediaId,
    file.messageId,
    file.filename,
    file.mimeType,
    file.sizeBytes,
    file.status,
    file.imageId ?? null,
    file.url ?? null,
    acceptedAt,
    file.uploadAttemptId ?? null,
    file.uploadStartedAt ?? null,
    file.uploadedAt ?? null,
    file.uploadRetryCount ?? 0,
    file.uploadNextRetryAt ?? null,
    file.uploadLastError ?? null,
    file.failureCode ?? null,
    file.failedAt ?? null,
    file.cleanupPending ? 1 : 0,
    file.cleanupCompletedAt ?? null
  );
}

function draftFromRow(row: DraftRow): StoredGalleryUploadDraft {
  return {
    flowSessionId: row.flow_session_id,
    flowType: row.flow_type,
    scopeId: row.scope_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    groupWid: row.group_wid,
    chatId: row.chat_id,
    collectionChatId: row.collection_chat_id,
    actorWid: row.actor_wid,
    actorIdentityId: normalizeIdentityId(row.actor_identity_id),
    topomareUserId: requireTopomareUserId(row.topomare_user_id),
    piwigoUserId: requirePiwigoUserId(row.piwigo_user_id),
    actorLabel: row.actor_label,
    acceptedExtensions: parseJsonArray(row.accepted_extensions_json, z.string()),
    maxFileBytes: row.max_file_bytes,
    autoFinalizeMinutes: row.auto_finalize_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  };
}

function batchFromRow(db: PluginDatabase, row: BatchRow): StoredGalleryUploadBatch {
  const topomareUserId = row.topomare_user_id === null
    ? null
    : requireTopomareUserId(row.topomare_user_id);
  const piwigoUserId = row.piwigo_user_id === null
    ? null
    : requirePiwigoUserId(row.piwigo_user_id);
  if ((topomareUserId === null || piwigoUserId === null) && !isTerminalBatchStatus(row.status)) {
    throw new GalleryStorageInvariantError(
      `Nonterminal gallery upload ${row.id} is missing its immutable Topomare/Piwigo subject binding.`
    );
  }
  const files = db.all<BatchFileRow>(
    `SELECT * FROM gallery_upload_batch_files
      WHERE batch_id = ? ORDER BY accepted_at ASC, message_id ASC`,
    row.id
  ).map(batchFileFromRow);
  return {
    id: row.id,
    status: row.status,
    scopeId: row.scope_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    groupWid: row.group_wid,
    chatId: row.chat_id,
    collectionChatId: row.collection_chat_id,
    actorWid: row.actor_wid,
    actorIdentityId: normalizeIdentityId(row.actor_identity_id),
    topomareUserId,
    piwigoUserId,
    actorLabel: row.actor_label,
    onde: row.onde,
    quando: row.quando,
    withUserIds: parseJsonArray(row.with_user_ids_json, z.number().int()),
    albumSource: parseGalleryAlbumSource({
      kind: row.source_kind,
      ref: row.source_ref,
      snapshotJson: row.source_snapshot_json
    }),
    acceptedExtensions: parseJsonArray(row.accepted_extensions_json, z.string()),
    maxFileBytes: row.max_file_bytes,
    autoFinalizeMinutes: row.auto_finalize_minutes,
    files,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    autoFinalizeAt: row.auto_finalize_at,
    ...(row.last_accepted_at ? { lastAcceptedAt: row.last_accepted_at } : {}),
    deadlineGeneration: row.deadline_generation,
    version: row.version,
    ...(row.finalization_claim_id ? { finalizationClaimId: row.finalization_claim_id } : {}),
    ...(row.finalization_claimed_at ? { finalizationClaimedAt: row.finalization_claimed_at } : {}),
    ...(row.finalization_claim_expires_at ? { finalizationClaimExpiresAt: row.finalization_claim_expires_at } : {}),
    ...(row.album_label ? { albumLabel: row.album_label } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.terminal_notification_text && row.terminal_notification_status && row.terminal_notification_delivery_key
      ? {
          terminalNotification: {
            text: row.terminal_notification_text,
            status: row.terminal_notification_status,
            deliveryKey: row.terminal_notification_delivery_key,
            ...(row.terminal_notification_attempt_id
              ? { attemptId: row.terminal_notification_attempt_id }
              : {}),
            ...(row.terminal_notification_started_at
              ? { startedAt: row.terminal_notification_started_at }
              : {}),
            ...(row.terminal_notification_delivered_at
              ? { deliveredAt: row.terminal_notification_delivered_at }
              : {})
          }
        }
      : {})
  };
}

function batchFileFromRow(row: BatchFileRow): GalleryBatchFile {
  return {
    mediaId: row.media_id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    acceptedAt: row.accepted_at,
    ...(row.upload_attempt_id ? { uploadAttemptId: row.upload_attempt_id } : {}),
    ...(row.upload_started_at ? { uploadStartedAt: row.upload_started_at } : {}),
    ...(row.upload_retry_count > 0 ? { uploadRetryCount: row.upload_retry_count } : {}),
    ...(row.upload_next_retry_at ? { uploadNextRetryAt: row.upload_next_retry_at } : {}),
    ...(row.upload_last_error ? { uploadLastError: row.upload_last_error } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.failed_at ? { failedAt: row.failed_at } : {}),
    ...(row.image_id !== null ? { imageId: row.image_id } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.uploaded_at ? { uploadedAt: row.uploaded_at } : {}),
    ...(row.cleanup_pending === 1 ? { cleanupPending: true } : {}),
    ...(row.cleanup_completed_at ? { cleanupCompletedAt: row.cleanup_completed_at } : {})
  };
}

function announcementFromRow(db: PluginDatabase, row: AnnouncementRow): StoredPiwigoAlbumAnnouncement {
  const files = db.all<AnnouncementFileRow>(
    `SELECT position, image_id, file_id, download_token, sha256, filename, mime_type,
            delivery_status, delivery_claim_id, delivery_started_at, delivered_at
       FROM gallery_album_announcement_files
      WHERE announcement_id = ? ORDER BY position`,
    row.id
  ).map((file) => ({
    position: file.position,
    ...(file.image_id !== null ? { imageId: file.image_id } : {}),
    ...(file.file_id ? { fileId: file.file_id } : {}),
    ...(file.download_token ? { downloadToken: file.download_token } : {}),
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    filename: file.filename,
    mimeType: file.mime_type,
    deliveryStatus: file.delivery_status,
    ...(file.delivery_claim_id ? { deliveryClaimId: file.delivery_claim_id } : {}),
    ...(file.delivery_started_at ? { deliveryStartedAt: file.delivery_started_at } : {}),
    ...(file.delivered_at ? { deliveredAt: file.delivered_at } : {})
  }));
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    scopeId: row.scope_id,
    ...(row.announcement_group_wid ? { announcementGroupWid: row.announcement_group_wid } : {}),
    ...(row.album_id ? { albumId: row.album_id } : {}),
    albumName: row.album_name,
    siteLabel: row.site_label,
    userDisplayName: row.user_display_name,
    files,
    observedAt: row.observed_at,
    announceAt: row.announce_at,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    ...(row.announced_at ? { announcedAt: row.announced_at } : {}),
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    downloadRetryCount: row.download_retry_count,
    ...(row.download_next_retry_at ? { downloadNextRetryAt: row.download_next_retry_at } : {}),
    ...(row.download_last_error ? { downloadLastError: row.download_last_error } : {}),
    version: row.version
  };
}

function insertAnnouncementFile(
  db: PluginDatabase,
  announcementId: string,
  file: PiwigoAlbumAnnouncementFile,
  position: number
): void {
  if (file.imageId === undefined || !Number.isInteger(file.imageId) || file.imageId <= 0) {
    throw new GalleryStorageInvariantError('Album announcement file requires a positive immutable Piwigo image ID.');
  }
  if (!file.sha256 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new GalleryStorageInvariantError('Album announcement file requires a lowercase SHA-256 digest.');
  }
  db.run(
    `INSERT INTO gallery_album_announcement_files (
      announcement_id, position, image_id, file_id, download_token, sha256, filename, mime_type,
      delivery_status, delivery_claim_id, delivery_started_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    announcementId,
    position,
    file.imageId,
    null,
    null,
    file.sha256,
    file.filename,
    file.mimeType,
    file.deliveryStatus ?? 'pending',
    file.deliveryClaimId ?? null,
    file.deliveryStartedAt ?? null,
    file.deliveredAt ?? null
  );
}

function requireDraft(db: PluginDatabase, scopeId: string, flowSessionId: string): StoredGalleryUploadDraft {
  const draft = getDraft(db, scopeId, flowSessionId);
  if (!draft) throw new GalleryStorageInvariantError(`Gallery upload draft ${flowSessionId} was not persisted.`);
  return draft;
}

function requireBatch(db: PluginDatabase, scopeId: string, batchId: string): StoredGalleryUploadBatch {
  const batch = getBatch(db, scopeId, batchId);
  if (!batch) throw new GalleryStorageInvariantError(`Gallery upload batch ${batchId} was not persisted.`);
  return batch;
}

function requireAnnouncement(
  db: PluginDatabase,
  scopeId: string,
  announcementId: string
): StoredPiwigoAlbumAnnouncement {
  const announcement = getAlbumAnnouncement(db, scopeId, announcementId);
  if (!announcement) {
    throw new GalleryStorageInvariantError(`Album announcement ${announcementId} was not persisted.`);
  }
  return announcement;
}

function assertExactTarget(groupWid: string, chatId: string): void {
  const group = normalizeWid(groupWid);
  const chat = normalizeWid(chatId);
  if (!group.endsWith('@g.us') || group !== chat) {
    throw new GalleryStorageInvariantError(
      `Gallery uploads require one exact physical group target; received group=${groupWid}, chat=${chatId}.`
    );
  }
}

function normalizeCollectionChatId(chatId: string): string {
  const normalized = normalizeWid(chatId);
  if (!normalized) {
    throw new GalleryStorageInvariantError('Gallery uploads require a collection inbox.');
  }
  return normalized;
}

function activeBatchIdentityClaim(
  db: PluginDatabase,
  scopeId: string,
  collectionChatId: string,
  actorIdentityId: string
): { scope_id: string; batch_id: string } | undefined {
  const normalizedChatId = normalizeCollectionChatId(collectionChatId);
  const normalizedIdentityId = normalizeIdentityId(actorIdentityId);
  if (normalizedChatId.endsWith('@g.us')) {
    return db.get<{ scope_id: string; batch_id: string }>(
      `SELECT scope_id, batch_id FROM gallery_active_batch_identities
        WHERE scope_id = ? AND collection_chat_id = ? AND actor_identity_id = ?`,
      scopeId,
      normalizedChatId,
      normalizedIdentityId
    );
  }
  return db.get<{ scope_id: string; batch_id: string }>(
    `SELECT scope_id, batch_id FROM gallery_active_batch_identities
      WHERE collection_chat_id = ? AND actor_identity_id = ?`,
    normalizedChatId,
    normalizedIdentityId
  );
}

function normalizeAnnouncementGroupWid(groupWid: string): string {
  const normalized = normalizeWid(groupWid);
  if (!normalized.endsWith('@g.us')) {
    throw new GalleryStorageInvariantError(
      `Album announcements require a physical WhatsApp group target; received ${groupWid}.`
    );
  }
  return normalized;
}

function assertSameTarget(
  existing: Pick<GalleryUploadDraft, 'scopeId' | 'groupId' | 'groupWid' | 'chatId' | 'collectionChatId' | 'actorIdentityId' | 'topomareUserId' | 'piwigoUserId'>,
  replacement: Pick<GalleryUploadDraft, 'scopeId' | 'groupId' | 'groupWid' | 'chatId' | 'collectionChatId' | 'actorIdentityId' | 'topomareUserId' | 'piwigoUserId'>,
  label: string
): void {
  if (
    existing.scopeId !== replacement.scopeId ||
    existing.groupId !== replacement.groupId ||
    normalizeWid(existing.groupWid) !== normalizeWid(replacement.groupWid) ||
    normalizeWid(existing.chatId) !== normalizeWid(replacement.chatId) ||
    normalizeCollectionChatId(existing.collectionChatId) !==
      normalizeCollectionChatId(replacement.collectionChatId) ||
    existing.actorIdentityId !== replacement.actorIdentityId ||
    requireTopomareUserId(existing.topomareUserId) !==
      requireTopomareUserId(replacement.topomareUserId) ||
    requirePiwigoUserId(existing.piwigoUserId) !== requirePiwigoUserId(replacement.piwigoUserId)
  ) {
    throw new GalleryStorageInvariantError(`${label} target cannot be changed after capture.`);
  }
}

function isTerminalBatchStatus(status: GalleryUploadBatchStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'expired' || status === 'failed';
}

function requireActorIdentityId(
  value: Pick<GalleryUploadDraft, 'actorIdentityId'>
): string {
  if (!value.actorIdentityId) {
    throw new GalleryStorageInvariantError(
      'Gallery upload ownership requires an authoritative actor identity ID.'
    );
  }
  return normalizeIdentityId(value.actorIdentityId);
}

function normalizeIdentityId(identityId: string | null | undefined): string {
  const normalized = identityId?.trim();
  if (!normalized) {
    throw new GalleryStorageInvariantError(
      'Gallery upload ownership requires an authoritative actor identity ID.'
    );
  }
  return normalized;
}

function requireTopomareUserId(topomareUserId: string | null | undefined): string {
  const parsed = z.string().uuid().safeParse(topomareUserId?.trim());
  if (!parsed.success || parsed.data !== parsed.data.toLowerCase()) {
    throw new GalleryStorageInvariantError(
      'Gallery upload ownership requires a canonical lowercase Topomare user UUID.'
    );
  }
  return parsed.data;
}

function requirePiwigoUserId(piwigoUserId: number | null | undefined): number {
  if (!Number.isSafeInteger(piwigoUserId) || (piwigoUserId ?? 0) <= 0) {
    throw new GalleryStorageInvariantError(
      'Gallery upload ownership requires a positive immutable Piwigo user ID.'
    );
  }
  return piwigoUserId as number;
}

function requireUploadAttemptId(attemptId: string): string {
  const normalized = attemptId.trim();
  if (
    normalized !== attemptId
    || !/^v4:[A-Za-z0-9][A-Za-z0-9._:-]{12,123}$/u.test(normalized)
  ) {
    throw new GalleryStorageInvariantError(
      'Gallery upload files require one canonical v4 Piwigo idempotency key.'
    );
  }
  return normalized;
}

function normalizeWid(wid: string): string {
  return wid.trim().toLowerCase();
}

function uniqueWids(wids: string[]): string[] {
  return [...new Set(wids.map(normalizeWid).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter(Number.isInteger))];
}

function parseJsonArray<T>(json: string, item: z.ZodType<T>): T[] {
  return z.array(item).parse(JSON.parse(json));
}
