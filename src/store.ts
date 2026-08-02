import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';
import type {
  PluginDatabase,
  PluginDatabaseRegistry,
  PluginDatabaseRow
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { GalleryConnection, PiwigoGalleryConfig } from './config';
import { configConnection } from './config';
import { PIWIGO_GALLERY_DATABASE } from './manifest';

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
  /** Collection chat. It must be the same exact physical group as groupWid. */
  chatId: string;
  actorWid: string;
  actorAliases?: string[] | undefined;
  actorIdentityId?: string | undefined;
  piwigoLinkedWid?: string | undefined;
  actorLabel: string;
  acceptedExtensions: string[];
  maxFileBytes: number;
  autoFinalizeMinutes: number;
  createdAt: string;
  updatedAt?: string | undefined;
  version?: number | undefined;
}

export interface StoredGalleryUploadDraft extends GalleryUploadDraft {
  updatedAt: string;
  version: number;
}

export interface GalleryBatchFile {
  mediaId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'staged' | 'uploaded';
  acceptedAt?: string | undefined;
  imageId?: number | undefined;
  url?: string | undefined;
  uploadedAt?: string | undefined;
}

export interface GalleryUploadBatch {
  id: string;
  status: GalleryUploadBatchStatus;
  scopeId: string;
  groupId?: string | undefined;
  /** Exact physical managed-group target. It is immutable after insertion. */
  groupWid: string;
  /** Collection chat. It must be the same exact physical group as groupWid. */
  chatId: string;
  actorWid: string;
  actorAliases?: string[] | undefined;
  actorIdentityId?: string | undefined;
  piwigoLinkedWid?: string | undefined;
  actorLabel: string;
  onde: string;
  quando: string;
  withUserIds: number[];
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
}

export interface StoredGalleryUploadBatch extends GalleryUploadBatch {
  deadlineGeneration: number;
  version: number;
}

export interface GalleryScopeOption {
  scopeId: string;
  label: string;
}

export interface GalleryLinkRequest {
  requestId: string;
  requestToken: string;
  phone?: string | undefined;
  whatsappJid: string;
  whatsappAliases?: string[] | undefined;
  siteLabel: string;
  linkChoiceCount: number;
  scopeOptions: GalleryScopeOption[];
  createdAt: string;
  expiresAt: string;
}

export interface PiwigoAlbumAnnouncementFile {
  imageId?: number | undefined;
  fileId?: string | undefined;
  downloadToken?: string | undefined;
  filename: string;
  mimeType: string;
}

export interface PiwigoAlbumAnnouncement {
  id: string;
  dedupeKey: string;
  scopeId: string;
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
  version?: number | undefined;
}

export interface StoredPiwigoAlbumAnnouncement extends PiwigoAlbumAnnouncement {
  version: number;
}

export interface GalleryRegistrationOtpRequest {
  requestId: string;
  wid: string;
  displayName?: string | undefined;
  otpHash: string;
  expiresAt: string;
  attempts: number;
  createdAt: string;
}

interface DraftRow extends PluginDatabaseRow {
  flow_session_id: string;
  flow_type: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string;
  chat_id: string;
  actor_wid: string;
  actor_aliases_json: string;
  actor_identity_id: string | null;
  piwigo_linked_wid: string | null;
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
  actor_wid: string;
  actor_aliases_json: string;
  actor_identity_id: string | null;
  piwigo_linked_wid: string | null;
  actor_label: string;
  onde: string;
  quando: string;
  with_user_ids_json: string;
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
  uploaded_at: string | null;
}

interface LinkRequestRow extends PluginDatabaseRow {
  token_key: string;
  request_token: string;
  request_id: string;
  phone: string | null;
  whatsapp_jid: string;
  site_label: string;
  link_choice_count: number;
  created_at: string;
  expires_at: string;
}

interface LinkRequestScopeRow extends PluginDatabaseRow {
  scope_id: string;
  label: string;
}

interface LinkRequestAliasRow extends PluginDatabaseRow {
  wid: string;
}

interface AnnouncementRow extends PluginDatabaseRow {
  id: string;
  dedupe_key: string;
  scope_id: string;
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
  version: number;
}

interface AnnouncementFileRow extends PluginDatabaseRow {
  image_id: number | null;
  file_id: string | null;
  download_token: string | null;
  filename: string;
  mime_type: string;
}

interface RegistrationOtpRow extends PluginDatabaseRow {
  request_id: string;
  wid: string;
  display_name: string | null;
  otp_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
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
  _store: PluginDataStore | PluginDatabase | undefined,
  config?: PiwigoGalleryConfig | undefined,
  defaultPiwigoBaseUrl?: string | undefined,
  defaultPiwigoBotSecret?: string | undefined
): Promise<GalleryConnection | undefined> {
  return config ? configConnection(config, defaultPiwigoBaseUrl, defaultPiwigoBotSecret) : undefined;
}

export function saveDraft(db: PluginDatabase, draft: GalleryUploadDraft): StoredGalleryUploadDraft {
  assertExactTarget(draft.groupWid, draft.chatId);
  const updatedAt = draft.updatedAt ?? draft.createdAt;
  return db.transaction(() => {
    const existing = getDraft(db, draft.scopeId, draft.flowSessionId);
    if (existing) {
      assertSameTarget(existing, draft, 'gallery upload draft');
      const result = db.run(
        `UPDATE gallery_upload_drafts
            SET flow_type = ?, actor_aliases_json = ?, piwigo_linked_wid = ?, actor_label = ?,
                accepted_extensions_json = ?, max_file_bytes = ?, auto_finalize_minutes = ?,
                updated_at = ?, version = version + 1
          WHERE flow_session_id = ? AND scope_id = ? AND version = ?`,
        draft.flowType,
        JSON.stringify(uniqueWids([draft.actorWid, ...(draft.actorAliases ?? [])])),
        draft.piwigoLinkedWid ?? null,
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
          flow_session_id, flow_type, scope_id, group_id, group_wid, chat_id, actor_wid,
          actor_aliases_json, actor_identity_id, piwigo_linked_wid, actor_label,
          accepted_extensions_json, max_file_bytes, auto_finalize_minutes,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        draft.flowSessionId,
        draft.flowType,
        draft.scopeId,
        draft.groupId ?? null,
        normalizeWid(draft.groupWid),
        normalizeWid(draft.chatId),
        normalizeWid(draft.actorWid),
        JSON.stringify(uniqueWids([draft.actorWid, ...(draft.actorAliases ?? [])])),
        draft.actorIdentityId ?? null,
        draft.piwigoLinkedWid ? normalizeWid(draft.piwigoLinkedWid) : null,
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

export function deleteDraft(db: PluginDatabase, scopeId: string, flowSessionId: string): number {
  return db.run(
    'DELETE FROM gallery_upload_drafts WHERE flow_session_id = ? AND scope_id = ?',
    flowSessionId,
    scopeId
  ).changes;
}

export function createBatch(
  db: PluginDatabase,
  batch: GalleryUploadBatch,
  options: { draftFlowSessionId?: string | undefined } = {}
): StoredGalleryUploadBatch {
  if (batch.status !== 'collecting') {
    throw new GalleryStorageInvariantError('New gallery upload batches must start in collecting state.');
  }
  assertExactTarget(batch.groupWid, batch.chatId);
  return db.transaction(() => {
    insertBatch(db, batch);
    for (const actorWid of batchActorWids(batch)) {
      const active = db.get<{ batch_id: string }>(
        `SELECT batch_id FROM gallery_active_batch_actors
          WHERE scope_id = ? AND chat_id = ? AND actor_wid = ?`,
        batch.scopeId,
        normalizeWid(batch.chatId),
        actorWid
      );
      if (active && active.batch_id !== batch.id) {
        throw new GalleryStorageConflictError(
          `Actor ${actorWid} already has active gallery upload ${active.batch_id} in ${batch.chatId}.`
        );
      }
      db.run(
        `INSERT INTO gallery_active_batch_actors (scope_id, chat_id, actor_wid, batch_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, chat_id, actor_wid) DO UPDATE SET batch_id = excluded.batch_id`,
        batch.scopeId,
        normalizeWid(batch.chatId),
        actorWid,
        batch.id,
        batch.createdAt
      );
    }
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
  actorWid: string
): StoredGalleryUploadBatch | undefined {
  const active = db.get<{ batch_id: string }>(
    `SELECT batch_id FROM gallery_active_batch_actors
      WHERE scope_id = ? AND chat_id = ? AND actor_wid = ?`,
    scopeId,
    normalizeWid(chatId),
    normalizeWid(actorWid)
  );
  return active?.batch_id ? getBatch(db, scopeId, active.batch_id) : undefined;
}

export function getActiveBatchForActorWids(
  db: PluginDatabase,
  scopeId: string,
  chatId: string,
  actorWids: string[]
): StoredGalleryUploadBatch | undefined {
  for (const actorWid of uniqueWids(actorWids)) {
    const batch = getActiveBatch(db, scopeId, chatId, actorWid);
    if (batch) {
      return batch;
    }
  }
  return undefined;
}

export function clearActiveBatch(db: PluginDatabase, batch: Pick<GalleryUploadBatch, 'id'>): number {
  return db.run('DELETE FROM gallery_active_batch_actors WHERE batch_id = ?', batch.id).changes;
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
        image_id, url, accepted_at, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'staged', NULL, NULL, ?, NULL)`,
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

export function markBatchFileUploaded(db: PluginDatabase, input: {
  scopeId: string;
  batchId: string;
  messageId: string;
  claimId: string;
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
    db.run(
      `UPDATE gallery_upload_batch_files
          SET status = 'uploaded', image_id = ?, url = ?, uploaded_at = ?
        WHERE batch_id = ? AND message_id = ? AND status = 'staged'`,
      input.imageId,
      input.url ?? null,
      input.uploadedAt,
      input.batchId,
      input.messageId
    );
    db.run(
      `UPDATE gallery_upload_batches
          SET album_label = COALESCE(?, album_label), updated_at = ?, version = version + 1
        WHERE id = ? AND scope_id = ? AND status = 'finalizing' AND finalization_claim_id = ?`,
      input.albumLabel ?? null,
      input.uploadedAt,
      input.batchId,
      input.scopeId,
      input.claimId
    );
    const stored = requireBatch(db, input.scopeId, input.batchId);
    return {
      kind: 'uploaded',
      batch: stored,
      file: stored.files.find((candidate) => candidate.messageId === input.messageId)!
    };
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
}): CompleteBatchResult {
  return db.transaction(() => {
    const batch = getBatch(db, input.scopeId, input.batchId);
    if (!batch) return { kind: 'missing' };
    if (isTerminalBatchStatus(batch.status)) return { kind: 'already_terminal', batch };
    if (batch.status !== 'finalizing' || batch.finalizationClaimId !== input.claimId) {
      return { kind: 'claim_lost', batch };
    }
    if (input.status === 'completed' && batch.files.some((file) => file.status === 'staged')) {
      return { kind: 'staged_files_remain', batch };
    }
    if (input.status === 'expired' && batch.files.length > 0) {
      throw new GalleryStorageInvariantError('Only an empty gallery upload batch may expire.');
    }
    db.run(
      `UPDATE gallery_upload_batches
          SET status = ?, updated_at = ?, deadline_generation = deadline_generation + 1,
              version = version + 1, finalization_claim_id = NULL,
              finalization_claimed_at = NULL, finalization_claim_expires_at = NULL,
              album_label = COALESCE(?, album_label), error = ?
        WHERE id = ? AND scope_id = ? AND status = 'finalizing' AND finalization_claim_id = ?`,
      input.status,
      input.completedAt,
      input.albumLabel ?? null,
      input.error ?? null,
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

export function saveLinkRequest(db: PluginDatabase, request: GalleryLinkRequest): void {
  const tokenKey = normalizedToken(request.requestToken);
  const aliases = uniqueWids([request.whatsappJid, ...(request.whatsappAliases ?? [])]);
  const phoneDigits = digitsFromPhoneLike(request.phone ?? request.whatsappJid);
  db.transaction(() => {
    db.run(
      `INSERT INTO gallery_link_requests (
        token_key, request_token, request_id, phone, phone_digits, whatsapp_jid, site_label,
        link_choice_count, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_key) DO UPDATE SET
        request_token = excluded.request_token,
        request_id = excluded.request_id,
        phone = excluded.phone,
        phone_digits = excluded.phone_digits,
        whatsapp_jid = excluded.whatsapp_jid,
        site_label = excluded.site_label,
        link_choice_count = excluded.link_choice_count,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
      tokenKey,
      request.requestToken,
      request.requestId,
      request.phone ?? null,
      phoneDigits || null,
      normalizeWid(request.whatsappJid),
      request.siteLabel,
      request.linkChoiceCount,
      request.createdAt,
      request.expiresAt
    );
    db.run('DELETE FROM gallery_link_request_aliases WHERE token_key = ?', tokenKey);
    db.run('DELETE FROM gallery_link_request_scopes WHERE token_key = ?', tokenKey);
    for (const wid of aliases) {
      db.run(
        `INSERT INTO gallery_link_request_aliases (wid, token_key) VALUES (?, ?)
         ON CONFLICT(wid) DO UPDATE SET token_key = excluded.token_key`,
        wid,
        tokenKey
      );
    }
    request.scopeOptions.forEach((scope, position) => {
      db.run(
        `INSERT INTO gallery_link_request_scopes (token_key, position, scope_id, label)
         VALUES (?, ?, ?, ?)`,
        tokenKey,
        position,
        scope.scopeId,
        scope.label
      );
    });
  });
}

export function getLinkRequest(db: PluginDatabase, requestToken: string): GalleryLinkRequest | undefined {
  const row = db.get<LinkRequestRow>(
    'SELECT * FROM gallery_link_requests WHERE token_key = ?',
    normalizedToken(requestToken)
  );
  return row ? linkRequestFromRow(db, row) : undefined;
}

export function getLinkRequestForWid(db: PluginDatabase, wid: string): GalleryLinkRequest | undefined {
  const row = db.get<{ token_key: string }>(
    'SELECT token_key FROM gallery_link_request_aliases WHERE wid = ?',
    normalizeWid(wid)
  );
  return row?.token_key ? getLinkRequest(db, row.token_key) : undefined;
}

export function getLinkRequestForWids(db: PluginDatabase, wids: string[]): GalleryLinkRequest | undefined {
  for (const wid of uniqueWids(wids)) {
    const request = getLinkRequestForWid(db, wid);
    if (request) return request;
  }
  return undefined;
}

export function getLinkRequestForPhoneDigits(db: PluginDatabase, phoneDigits: string): GalleryLinkRequest | undefined {
  const normalized = digitsFromPhoneLike(phoneDigits);
  if (!normalized) return undefined;
  const row = db.get<{ token_key: string }>(
    `SELECT token_key FROM gallery_link_requests
      WHERE phone_digits = ? ORDER BY created_at DESC LIMIT 1`,
    normalized
  );
  return row?.token_key ? getLinkRequest(db, row.token_key) : undefined;
}

export function deleteLinkRequest(db: PluginDatabase, requestToken: string): number {
  return db.run(
    'DELETE FROM gallery_link_requests WHERE token_key = ?',
    normalizedToken(requestToken)
  ).changes;
}

export function pruneExpiredLinkRequests(db: PluginDatabase, now: string): number {
  return db.run('DELETE FROM gallery_link_requests WHERE expires_at <= ?', now).changes;
}

export function saveAlbumAnnouncement(
  db: PluginDatabase,
  announcement: PiwigoAlbumAnnouncement,
  expectedVersion?: number | undefined
): StoredPiwigoAlbumAnnouncement {
  return db.transaction(() => {
    const existing = getAlbumAnnouncement(db, announcement.scopeId, announcement.id);
    if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new GalleryStorageConflictError(`Album announcement ${announcement.id} changed concurrently.`);
    }
    if (existing) {
      const updated = db.run(
        `UPDATE gallery_album_announcements
            SET album_id = ?, album_name = ?, site_label = ?, user_display_name = ?,
                observed_at = ?, announce_at = ?, status = ?, error = ?, announced_at = ?,
                claim_id = ?, claim_expires_at = ?, version = version + 1
          WHERE id = ? AND scope_id = ? AND version = ?`,
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
          id, dedupe_key, scope_id, album_id, album_name, site_label, user_display_name,
          observed_at, announce_at, status, error, announced_at, claim_id, claim_expires_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        announcement.id,
        announcement.dedupeKey,
        announcement.scopeId,
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
        announcement.claimExpiresAt ?? null
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
              claim_expires_at = NULL, version = version + 1
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

export function saveRegistrationOtp(db: PluginDatabase, request: GalleryRegistrationOtpRequest): void {
  db.run(
    `INSERT INTO gallery_registration_otps (
      request_id, wid, display_name, otp_hash, expires_at, attempts, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      wid = excluded.wid,
      display_name = excluded.display_name,
      otp_hash = excluded.otp_hash,
      expires_at = excluded.expires_at,
      attempts = excluded.attempts,
      created_at = excluded.created_at`,
    request.requestId,
    normalizeWid(request.wid),
    request.displayName ?? null,
    request.otpHash,
    request.expiresAt,
    request.attempts,
    request.createdAt
  );
}

export function getRegistrationOtp(
  db: PluginDatabase,
  requestId: string
): GalleryRegistrationOtpRequest | undefined {
  const row = db.get<RegistrationOtpRow>(
    'SELECT * FROM gallery_registration_otps WHERE request_id = ?',
    requestId
  );
  return row ? registrationOtpFromRow(row) : undefined;
}

export type ConsumeRegistrationOtpResult =
  | { kind: 'verified'; request: GalleryRegistrationOtpRequest }
  | { kind: 'invalid'; attempts: number; locked: boolean }
  | { kind: 'expired' }
  | { kind: 'missing' };

export function consumeRegistrationOtp(db: PluginDatabase, input: {
  requestId: string;
  candidateHash: string;
  now: string;
  maxAttempts: number;
}): ConsumeRegistrationOtpResult {
  return db.transaction(() => {
    const request = getRegistrationOtp(db, input.requestId);
    if (!request) return { kind: 'missing' };
    if (request.expiresAt <= input.now) {
      db.run('DELETE FROM gallery_registration_otps WHERE request_id = ?', input.requestId);
      return { kind: 'expired' };
    }
    if (safeHashEqual(request.otpHash, input.candidateHash)) {
      db.run('DELETE FROM gallery_registration_otps WHERE request_id = ?', input.requestId);
      return { kind: 'verified', request };
    }
    const attempts = request.attempts + 1;
    const locked = attempts >= input.maxAttempts;
    if (locked) {
      db.run('DELETE FROM gallery_registration_otps WHERE request_id = ?', input.requestId);
    } else {
      db.run(
        'UPDATE gallery_registration_otps SET attempts = ? WHERE request_id = ?',
        attempts,
        input.requestId
      );
    }
    return { kind: 'invalid', attempts, locked };
  });
}

export function pruneExpiredRegistrationOtps(db: PluginDatabase, now: string): number {
  return db.run('DELETE FROM gallery_registration_otps WHERE expires_at <= ?', now).changes;
}

export interface LegacyPluginDataRecord {
  id?: string | undefined;
  scopeId?: string | null | undefined;
  key: string;
  valueJson: unknown;
}

export interface LegacyGalleryImportResult {
  importedRecordIds: string[];
  alreadyImportedRecordIds: string[];
  skipped: Array<{ recordId: string; key: string; reason: string }>;
}

/**
 * Idempotently copies explicit legacy PluginDataRecord rows into SQLite.
 *
 * The caller owns account filtering and intentionally supplies rows because the legacy
 * PluginDataStore API cannot enumerate prefixes. Imported rows are not deleted here;
 * callers may delete only importedRecordIds after every account that owns them is migrated.
 */
export function importLegacyPiwigoGalleryRecords(
  db: PluginDatabase,
  records: readonly LegacyPluginDataRecord[],
  importedAt = new Date().toISOString()
): LegacyGalleryImportResult {
  const result: LegacyGalleryImportResult = {
    importedRecordIds: [],
    alreadyImportedRecordIds: [],
    skipped: []
  };
  const ordered = [...records].sort((left, right) => legacyImportPriority(left.key) - legacyImportPriority(right.key));
  for (const row of ordered) {
    const recordId = row.id?.trim() || `${row.scopeId ?? '__global__'}:${row.key}`;
    if (db.get('SELECT record_id FROM gallery_legacy_imports WHERE record_id = ?', recordId)) {
      result.alreadyImportedRecordIds.push(recordId);
      continue;
    }
    try {
      const imported = importLegacyRecord(db, row, importedAt);
      if (!imported) {
        result.skipped.push({ recordId, key: row.key, reason: 'unsupported legacy key or invalid value' });
        continue;
      }
      db.run(
        `INSERT OR IGNORE INTO gallery_legacy_imports (record_id, record_key, scope_id, imported_at)
         VALUES (?, ?, ?, ?)`,
        recordId,
        row.key,
        row.scopeId ?? null,
        importedAt
      );
      result.importedRecordIds.push(recordId);
    } catch (error) {
      result.skipped.push({
        recordId,
        key: row.key,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  reconstructImportedActiveBatches(db, importedAt);
  return result;
}

export function digitsFromPhoneLike(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cUsMatch = trimmed.match(/^(\d+)@c\.us$/);
  if (cUsMatch?.[1]) return cUsMatch[1];
  if (trimmed.includes('@')) return '';
  return trimmed.replace(/\D/g, '');
}

function insertBatch(db: PluginDatabase, batch: GalleryUploadBatch): void {
  const deadlineGeneration = batch.deadlineGeneration ?? 1;
  const version = batch.version ?? 1;
  db.run(
    `INSERT INTO gallery_upload_batches (
      id, status, scope_id, group_id, group_wid, chat_id, actor_wid, actor_aliases_json,
      actor_identity_id, piwigo_linked_wid, actor_label, onde, quando, with_user_ids_json,
      accepted_extensions_json, max_file_bytes, auto_finalize_minutes, created_at, updated_at,
      auto_finalize_at, last_accepted_at, deadline_generation, version,
      finalization_claim_id, finalization_claimed_at, finalization_claim_expires_at,
      album_label, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batch.id,
    batch.status,
    batch.scopeId,
    batch.groupId ?? null,
    normalizeWid(batch.groupWid),
    normalizeWid(batch.chatId),
    normalizeWid(batch.actorWid),
    JSON.stringify(uniqueWids([batch.actorWid, ...(batch.actorAliases ?? [])])),
    batch.actorIdentityId ?? null,
    batch.piwigoLinkedWid ? normalizeWid(batch.piwigoLinkedWid) : null,
    batch.actorLabel,
    batch.onde,
    batch.quando,
    JSON.stringify(uniqueNumbers(batch.withUserIds)),
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
      image_id, url, accepted_at, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    file.uploadedAt ?? null
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
    actorWid: row.actor_wid,
    actorAliases: parseJsonArray(row.actor_aliases_json, z.string()),
    ...(row.actor_identity_id ? { actorIdentityId: row.actor_identity_id } : {}),
    ...(row.piwigo_linked_wid ? { piwigoLinkedWid: row.piwigo_linked_wid } : {}),
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
    actorWid: row.actor_wid,
    actorAliases: parseJsonArray(row.actor_aliases_json, z.string()),
    ...(row.actor_identity_id ? { actorIdentityId: row.actor_identity_id } : {}),
    ...(row.piwigo_linked_wid ? { piwigoLinkedWid: row.piwigo_linked_wid } : {}),
    actorLabel: row.actor_label,
    onde: row.onde,
    quando: row.quando,
    withUserIds: parseJsonArray(row.with_user_ids_json, z.number().int()),
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
    ...(row.error ? { error: row.error } : {})
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
    ...(row.image_id !== null ? { imageId: row.image_id } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.uploaded_at ? { uploadedAt: row.uploaded_at } : {})
  };
}

function linkRequestFromRow(db: PluginDatabase, row: LinkRequestRow): GalleryLinkRequest {
  const scopeOptions = db.all<LinkRequestScopeRow>(
    `SELECT scope_id, label FROM gallery_link_request_scopes
      WHERE token_key = ? ORDER BY position`,
    row.token_key
  ).map((scope) => ({ scopeId: scope.scope_id, label: scope.label }));
  const aliases = db.all<LinkRequestAliasRow>(
    'SELECT wid FROM gallery_link_request_aliases WHERE token_key = ? ORDER BY wid',
    row.token_key
  ).map((alias) => alias.wid).filter((wid) => wid !== row.whatsapp_jid);
  return {
    requestId: row.request_id,
    requestToken: row.request_token,
    ...(row.phone ? { phone: row.phone } : {}),
    whatsappJid: row.whatsapp_jid,
    whatsappAliases: aliases,
    siteLabel: row.site_label,
    linkChoiceCount: row.link_choice_count,
    scopeOptions,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function announcementFromRow(db: PluginDatabase, row: AnnouncementRow): StoredPiwigoAlbumAnnouncement {
  const files = db.all<AnnouncementFileRow>(
    `SELECT image_id, file_id, download_token, filename, mime_type
       FROM gallery_album_announcement_files
      WHERE announcement_id = ? ORDER BY position`,
    row.id
  ).map((file) => ({
    ...(file.image_id !== null ? { imageId: file.image_id } : {}),
    ...(file.file_id ? { fileId: file.file_id } : {}),
    ...(file.download_token ? { downloadToken: file.download_token } : {}),
    filename: file.filename,
    mimeType: file.mime_type
  }));
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    scopeId: row.scope_id,
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
    version: row.version
  };
}

function registrationOtpFromRow(row: RegistrationOtpRow): GalleryRegistrationOtpRequest {
  return {
    requestId: row.request_id,
    wid: row.wid,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    otpHash: row.otp_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    createdAt: row.created_at
  };
}

function insertAnnouncementFile(
  db: PluginDatabase,
  announcementId: string,
  file: PiwigoAlbumAnnouncementFile,
  position: number
): void {
  if (file.imageId === undefined && !file.fileId && !file.downloadToken) {
    throw new GalleryStorageInvariantError('Album announcement file requires a download reference.');
  }
  db.run(
    `INSERT INTO gallery_album_announcement_files (
      announcement_id, position, image_id, file_id, download_token, filename, mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    announcementId,
    position,
    file.imageId ?? null,
    file.fileId ?? null,
    file.downloadToken ?? null,
    file.filename,
    file.mimeType
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

function assertSameTarget(
  existing: Pick<GalleryUploadDraft, 'scopeId' | 'groupId' | 'groupWid' | 'chatId' | 'actorWid' | 'actorIdentityId'>,
  replacement: Pick<GalleryUploadDraft, 'scopeId' | 'groupId' | 'groupWid' | 'chatId' | 'actorWid' | 'actorIdentityId'>,
  label: string
): void {
  if (
    existing.scopeId !== replacement.scopeId ||
    existing.groupId !== replacement.groupId ||
    normalizeWid(existing.groupWid) !== normalizeWid(replacement.groupWid) ||
    normalizeWid(existing.chatId) !== normalizeWid(replacement.chatId) ||
    normalizeWid(existing.actorWid) !== normalizeWid(replacement.actorWid) ||
    existing.actorIdentityId !== replacement.actorIdentityId
  ) {
    throw new GalleryStorageInvariantError(`${label} target cannot be changed after capture.`);
  }
}

function isTerminalBatchStatus(status: GalleryUploadBatchStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'expired' || status === 'failed';
}

function batchActorWids(batch: Pick<GalleryUploadBatch, 'actorWid' | 'actorAliases'>): string[] {
  return uniqueWids([batch.actorWid, ...(batch.actorAliases ?? [])]);
}

function normalizeWid(wid: string): string {
  return wid.trim().toLowerCase();
}

function normalizedToken(token: string): string {
  return token.trim().toUpperCase();
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

function safeHashEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

const legacyDraftSchema = z.object({
  flowSessionId: z.string().min(1),
  flowType: z.string().min(1),
  scopeId: z.string().min(1),
  groupId: z.string().min(1).optional(),
  groupWid: z.string().min(1).optional(),
  chatId: z.string().min(1),
  actorWid: z.string().min(1),
  actorAliases: z.array(z.string()).optional(),
  actorIdentityId: z.string().min(1).optional(),
  piwigoLinkedWid: z.string().min(1).optional(),
  actorLabel: z.string(),
  acceptedExtensions: z.array(z.string()),
  maxFileBytes: z.number().int().positive(),
  autoFinalizeMinutes: z.number().int().positive(),
  createdAt: z.string().min(1)
}).passthrough();

const legacyBatchFileSchema = z.object({
  mediaId: z.string().min(1),
  messageId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(['staged', 'uploaded']),
  acceptedAt: z.string().min(1).optional(),
  imageId: z.number().int().optional(),
  url: z.string().optional(),
  uploadedAt: z.string().min(1).optional()
}).passthrough();

const legacyBatchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['collecting', 'uploading', 'finalizing', 'completed', 'cancelled', 'expired', 'failed']),
  scopeId: z.string().min(1),
  groupId: z.string().min(1).optional(),
  groupWid: z.string().min(1).optional(),
  chatId: z.string().min(1),
  actorWid: z.string().min(1),
  actorAliases: z.array(z.string()).optional(),
  actorIdentityId: z.string().min(1).optional(),
  piwigoLinkedWid: z.string().min(1).optional(),
  actorLabel: z.string(),
  onde: z.string(),
  quando: z.string(),
  withUserIds: z.array(z.number().int()),
  acceptedExtensions: z.array(z.string()),
  maxFileBytes: z.number().int().positive(),
  autoFinalizeMinutes: z.number().int().positive(),
  files: z.array(legacyBatchFileSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  autoFinalizeAt: z.string().min(1),
  lastAcceptedAt: z.string().min(1).optional(),
  deadlineGeneration: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
  albumLabel: z.string().optional(),
  error: z.string().optional()
}).passthrough();

const legacyLinkRequestSchema = z.object({
  requestId: z.string().min(1),
  requestToken: z.string().min(1),
  phone: z.string().optional(),
  whatsappJid: z.string().min(1),
  whatsappAliases: z.array(z.string()).optional(),
  siteLabel: z.string(),
  linkChoiceCount: z.number().int().nonnegative(),
  scopeOptions: z.array(z.object({ scopeId: z.string().min(1), label: z.string() })),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1)
}).passthrough();

const legacyAnnouncementSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1),
  scopeId: z.string().min(1),
  albumId: z.string().optional(),
  albumName: z.string(),
  siteLabel: z.string(),
  userDisplayName: z.string(),
  files: z.array(z.object({
    imageId: z.number().int().optional(),
    fileId: z.string().optional(),
    downloadToken: z.string().optional(),
    filename: z.string().min(1),
    mimeType: z.string().min(1)
  })),
  observedAt: z.string().min(1),
  announceAt: z.string().min(1),
  status: z.enum(['pending', 'announced', 'skipped', 'failed']),
  error: z.string().optional(),
  announcedAt: z.string().optional()
}).passthrough();

const legacyOtpSchema = z.object({
  requestId: z.string().min(1),
  wid: z.string().min(1),
  displayName: z.string().optional(),
  otpHash: z.string().min(1),
  expiresAt: z.string().min(1),
  attempts: z.number().int().nonnegative()
}).passthrough();

function importLegacyRecord(db: PluginDatabase, row: LegacyPluginDataRecord, importedAt: string): boolean {
  if (row.key.startsWith('upload-draft:')) {
    const parsed = legacyDraftSchema.safeParse(row.valueJson);
    if (!parsed.success || !legacyScopeMatches(row, parsed.data.scopeId)) return false;
    if (!getDraft(db, parsed.data.scopeId, parsed.data.flowSessionId)) {
      const groupWid = parsed.data.groupWid ?? parsed.data.chatId;
      saveDraft(db, { ...parsed.data, groupWid, chatId: groupWid });
    }
    return true;
  }
  if (row.key.startsWith('upload-batch:')) {
    const parsed = legacyBatchSchema.safeParse(row.valueJson);
    if (!parsed.success || !legacyScopeMatches(row, parsed.data.scopeId)) return false;
    if (!getBatch(db, parsed.data.scopeId, parsed.data.id)) {
      const groupWid = parsed.data.groupWid ?? parsed.data.chatId;
      assertExactTarget(groupWid, groupWid);
      const status = parsed.data.status === 'uploading' ? 'finalizing' : parsed.data.status;
      db.transaction(() => insertBatch(db, {
        ...parsed.data,
        status,
        groupWid,
        chatId: groupWid,
        deadlineGeneration: parsed.data.deadlineGeneration ?? 1,
        version: parsed.data.version ?? 1
      }));
    }
    return true;
  }
  if (row.key.startsWith('active-upload:')) {
    const scopeId = row.scopeId ?? undefined;
    const value = z.object({ batchId: z.string().min(1) }).safeParse(row.valueJson);
    if (!scopeId || !value.success) return false;
    const batch = getBatch(db, scopeId, value.data.batchId);
    if (!batch || isTerminalBatchStatus(batch.status)) return false;
    const suffix = row.key.slice('active-upload:'.length);
    const separator = suffix.lastIndexOf(':');
    if (separator < 1) return false;
    const chatId = suffix.slice(0, separator);
    const actorWid = suffix.slice(separator + 1);
    if (normalizeWid(chatId) !== normalizeWid(batch.chatId)) return false;
    db.run(
      `INSERT OR IGNORE INTO gallery_active_batch_actors
        (scope_id, chat_id, actor_wid, batch_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      scopeId,
      normalizeWid(chatId),
      normalizeWid(actorWid),
      batch.id,
      batch.createdAt
    );
    return true;
  }
  if (row.key.startsWith('link-request:')) {
    const parsed = legacyLinkRequestSchema.safeParse(row.valueJson);
    if (!parsed.success) return false;
    if (!getLinkRequest(db, parsed.data.requestToken)) saveLinkRequest(db, parsed.data);
    return true;
  }
  if (row.key.startsWith('album-announcement:') && !row.key.startsWith('album-announcement-dedupe:')) {
    const parsed = legacyAnnouncementSchema.safeParse(row.valueJson);
    if (!parsed.success || !legacyScopeMatches(row, parsed.data.scopeId)) return false;
    if (!getAlbumAnnouncement(db, parsed.data.scopeId, parsed.data.id)) saveAlbumAnnouncement(db, parsed.data);
    return true;
  }
  if (row.key.startsWith('registration-otp:')) {
    const parsed = legacyOtpSchema.safeParse(row.valueJson);
    if (!parsed.success) return false;
    if (!getRegistrationOtp(db, parsed.data.requestId)) {
      saveRegistrationOtp(db, { ...parsed.data, createdAt: importedAt });
    }
    return true;
  }
  if (row.key.startsWith('link-request-wid:') || row.key.startsWith('link-request-phone:')) {
    const index = z.object({ requestToken: z.string().min(1) }).safeParse(row.valueJson);
    return index.success && Boolean(getLinkRequest(db, index.data.requestToken));
  }
  if (row.key.startsWith('album-announcement-dedupe:')) {
    const scopeId = row.scopeId ?? undefined;
    const index = z.object({ announcementId: z.string().min(1) }).safeParse(row.valueJson);
    return Boolean(scopeId && index.success && getAlbumAnnouncement(db, scopeId, index.data.announcementId));
  }
  return false;
}

function legacyImportPriority(key: string): number {
  if (key.startsWith('upload-batch:')) return 10;
  if (key.startsWith('upload-draft:')) return 20;
  if (key.startsWith('link-request:') && !key.startsWith('link-request-wid:') && !key.startsWith('link-request-phone:')) return 30;
  if (key.startsWith('album-announcement:') && !key.startsWith('album-announcement-dedupe:')) return 40;
  if (key.startsWith('registration-otp:')) return 50;
  if (key.startsWith('active-upload:')) return 90;
  return 100;
}

function legacyScopeMatches(row: LegacyPluginDataRecord, valueScopeId: string): boolean {
  return row.scopeId === undefined || row.scopeId === null || row.scopeId === valueScopeId;
}

function reconstructImportedActiveBatches(db: PluginDatabase, createdAt: string): void {
  const rows = db.all<BatchRow>(
    `SELECT * FROM gallery_upload_batches WHERE status IN ('collecting', 'finalizing')`
  );
  for (const row of rows) {
    const batch = batchFromRow(db, row);
    for (const actorWid of batchActorWids(batch)) {
      db.run(
        `INSERT OR IGNORE INTO gallery_active_batch_actors
          (scope_id, chat_id, actor_wid, batch_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        batch.scopeId,
        batch.chatId,
        actorWid,
        batch.id,
        createdAt
      );
    }
  }
}
