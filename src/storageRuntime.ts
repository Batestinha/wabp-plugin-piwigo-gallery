import { createHash } from 'node:crypto';
import type { FlowEngine } from '../../../adminBot/flows/flowEngine';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';
import type {
  PluginDatabase,
  PluginDatabaseRow,
  PluginDatabaseRegistry
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import {
  galleryDatabase,
  importLegacyPiwigoGalleryRecords,
  deleteDraft,
  listDrafts,
  type LegacyGalleryImportResult
} from './store';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_FINALIZE_JOB
} from './manifest';

const preparations = new Map<string, Promise<LegacyGalleryImportResult>>();
const runtimePreparations = new Map<string, Promise<PluginDatabase>>();
const LEGACY_GALLERY_KEY_PREFIXES = [
  'upload-draft:',
  'upload-batch:',
  'active-upload:',
  'link-request:',
  'link-request-wid:',
  'link-request-phone:',
  'album-announcement:',
  'album-announcement-dedupe:',
  'registration-otp:'
] as const;

export interface GalleryFinalizationRecoveryJob {
  jobName: typeof PIWIGO_GALLERY_FINALIZE_JOB;
  scopeId: string;
  groupId?: string | undefined;
  groupWid: string;
  payload: {
    batchId: string;
    deadlineGeneration: number;
    phase?: 'cleanup' | undefined;
  };
  runAt: Date;
  dedupeKey: string;
}

export interface GalleryAnnouncementRecoveryJob {
  jobName: typeof PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB;
  scopeId: string;
  groupWid?: string | undefined;
  payload: {
    announcementId: string;
  };
  runAt: Date;
  dedupeKey: string;
}

export type GalleryRuntimeRecoveryJob =
  | GalleryFinalizationRecoveryJob
  | GalleryAnnouncementRecoveryJob;

export interface GalleryRuntimePreparationOptions {
  enqueueJob(job: GalleryRuntimeRecoveryJob): Promise<void>;
  now?: Date | undefined;
}

export interface GalleryDraftReconciliationResult {
  inspected: number;
  pruned: string[];
  retained: string[];
  lookupFailures: string[];
}

interface RecoverableBatchRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string;
  status: 'collecting' | 'finalizing' | 'completed' | 'cancelled' | 'expired' | 'failed';
  auto_finalize_at: string;
  deadline_generation: number;
  finalization_claim_expires_at: string | null;
  upload_retry_at: string | null;
  cleanup_count: number;
  terminal_notification_status: 'pending' | 'dispatching' | 'delivered' | null;
}

interface RecoverableAnnouncementRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  announcement_group_wid: string | null;
  announce_at: string;
  download_next_retry_at: string | null;
  claim_id: string | null;
  claim_expires_at: string | null;
  version: number;
}

export async function preparedGalleryDatabase(
  dataStore: PluginDataStore,
  databases: PluginDatabaseRegistry | undefined
): Promise<PluginDatabase> {
  const database = galleryDatabase(databases);
  let preparation = preparations.get(database.filePath);
  if (!preparation) {
    preparation = legacyGalleryRecordsForAccount(dataStore).then((records) =>
      importLegacyPiwigoGalleryRecords(database, records)
    );
    preparations.set(database.filePath, preparation);
  }
  try {
    await preparation;
  } catch (error) {
    preparations.delete(database.filePath);
    throw error;
  }
  return database;
}

/**
 * Performs the one-time account-aware legacy import and recreates durable
 * finalization and album-announcement jobs that may have been lost while the
 * runtime was stopped.
 * Hook registration should keep and await the returned promise before handling
 * its first event.
 */
export async function prepareAndReconcileGalleryDatabase(
  dataStore: PluginDataStore,
  databases: PluginDatabaseRegistry | undefined,
  options: GalleryRuntimePreparationOptions
): Promise<PluginDatabase> {
  const database = galleryDatabase(databases);
  let preparation = runtimePreparations.get(database.filePath);
  if (!preparation) {
    preparation = (async () => {
      const prepared = await preparedGalleryDatabase(dataStore, databases);
      await reconcileGalleryFinalizationJobs(prepared, options);
      await reconcileGalleryAnnouncementJobs(prepared, options);
      return prepared;
    })();
    runtimePreparations.set(database.filePath, preparation);
  }
  try {
    return await preparation;
  } catch (error) {
    runtimePreparations.delete(database.filePath);
    throw error;
  }
}

export async function reconcileGalleryFinalizationJobs(
  database: PluginDatabase,
  options: GalleryRuntimePreparationOptions
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = database.all<RecoverableBatchRow>(
    `SELECT batches.id, batches.scope_id, batches.group_id, batches.group_wid,
            batches.status, batches.auto_finalize_at, batches.deadline_generation,
            batches.finalization_claim_expires_at, batches.terminal_notification_status,
            (SELECT MIN(files.upload_next_retry_at) FROM gallery_upload_batch_files files
              WHERE files.batch_id = batches.id AND files.status = 'uploading'
                AND files.upload_next_retry_at IS NOT NULL) AS upload_retry_at,
            (SELECT COUNT(*) FROM gallery_upload_batch_files files
              WHERE files.batch_id = batches.id AND files.cleanup_pending = 1) AS cleanup_count
       FROM gallery_upload_batches batches
      WHERE batches.status IN ('collecting', 'finalizing')
         OR EXISTS (
           SELECT 1 FROM gallery_upload_batch_files files
            WHERE files.batch_id = batches.id AND files.cleanup_pending = 1
         )
         OR batches.terminal_notification_status IN ('pending', 'dispatching')
      ORDER BY auto_finalize_at ASC, id ASC`
  );
  for (const row of rows) {
    const runAt = recoveryRunAt(row, now);
    await options.enqueueJob({
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: row.scope_id,
      ...(row.group_id ? { groupId: row.group_id } : {}),
      groupWid: row.group_wid,
      payload: {
        batchId: row.id,
        deadlineGeneration: row.deadline_generation,
        ...(row.status !== 'collecting' && row.status !== 'finalizing' && row.cleanup_count > 0
          ? { phase: 'cleanup' as const }
          : {})
      },
      runAt,
      // Recovery must not be suppressed by a retained completed copy of the
      // original generation job. The startup timestamp keeps it idempotent
      // within this preparation while allowing a later process to recover it.
      dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${row.id}:${row.deadline_generation}:recovery:${now.getTime()}`
    });
  }
  return rows.length;
}

export async function reconcileGalleryAnnouncementJobs(
  database: PluginDatabase,
  options: GalleryRuntimePreparationOptions
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = database.all<RecoverableAnnouncementRow>(
    `SELECT id, scope_id, announcement_group_wid, announce_at, download_next_retry_at,
            claim_id, claim_expires_at, version
       FROM gallery_album_announcements
      WHERE status = 'pending'
      ORDER BY announce_at ASC, id ASC`
  );
  for (const row of rows) {
    await options.enqueueJob({
      jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
      scopeId: row.scope_id,
      ...(row.announcement_group_wid ? { groupWid: row.announcement_group_wid } : {}),
      payload: { announcementId: row.id },
      runAt: announcementRecoveryRunAt(row, now),
      // A retained failed/completed BullMQ job from an earlier runtime must
      // not suppress recovery on this startup. The timestamp stays stable for
      // this reconciliation while giving a later process a fresh generation.
      dedupeKey: announcementRecoveryDedupeKey(row, now)
    });
  }
  return rows.length;
}

/** Removes SQLite upload drafts whose owning durable flow no longer exists or is terminal. */
export async function reconcileGalleryUploadDrafts(
  database: PluginDatabase,
  flowEngine: Pick<FlowEngine, 'getSessionSnapshot'>
): Promise<GalleryDraftReconciliationResult> {
  const result: GalleryDraftReconciliationResult = {
    inspected: 0,
    pruned: [],
    retained: [],
    lookupFailures: []
  };
  for (const draft of listDrafts(database)) {
    result.inspected += 1;
    try {
      const session = await flowEngine.getSessionSnapshot(draft.flowSessionId);
      if (
        !session ||
        session.status !== 'ACTIVE' ||
        session.flowType !== draft.flowType ||
        session.scopeId !== draft.scopeId
      ) {
        deleteDraft(database, draft.scopeId, draft.flowSessionId);
        result.pruned.push(draft.flowSessionId);
      } else {
        result.retained.push(draft.flowSessionId);
      }
    } catch {
      // A transient Prisma failure must not destroy a potentially active draft.
      result.lookupFailures.push(draft.flowSessionId);
    }
  }
  return result;
}

async function legacyGalleryRecordsForAccount(dataStore: PluginDataStore) {
  const [records, accountScopeIds] = await Promise.all([
    dataStore.list(),
    dataStore.accountScopeIds?.() ?? Promise.resolve(undefined)
  ]);
  const legacyRecords = records.filter((record) =>
    LEGACY_GALLERY_KEY_PREFIXES.some((prefix) => record.key.startsWith(prefix))
  );
  if (accountScopeIds === undefined) {
    return legacyRecords;
  }
  const ownedScopeIds = new Set(accountScopeIds);
  return legacyRecords.flatMap((record) => {
    if (record.scopeId) {
      return ownedScopeIds.has(record.scopeId) ? [record] : [];
    }
    if (record.key.startsWith('registration-otp:')) {
      return [];
    }
    if (isPrimaryLinkRequestKey(record.key)) {
      const value = objectValue(record.valueJson);
      const scopeOptions = Array.isArray(value?.scopeOptions)
        ? value.scopeOptions.filter((option) => {
            const candidate = objectValue(option);
            return typeof candidate?.scopeId === 'string' && ownedScopeIds.has(candidate.scopeId);
          })
        : [];
      if (!value || scopeOptions.length === 0) {
        return [];
      }
      return [{
        ...record,
        valueJson: {
          ...value,
          scopeOptions,
          linkChoiceCount: new Set(scopeOptions.flatMap((option) => {
            const candidate = objectValue(option);
            return typeof candidate?.scopeId === 'string' ? [candidate.scopeId] : [];
          })).size
        }
      }];
    }
    if (record.key.startsWith('link-request-wid:') || record.key.startsWith('link-request-phone:')) {
      return [record];
    }
    const valueScopeId = objectValue(record.valueJson)?.scopeId;
    return typeof valueScopeId === 'string' && ownedScopeIds.has(valueScopeId) ? [record] : [];
  });
}

function recoveryRunAt(row: RecoverableBatchRow, now: Date): Date {
  if (row.status !== 'collecting' && row.status !== 'finalizing') {
    return now;
  }
  const timestamps = [now.getTime()];
  if (row.status === 'collecting') {
    timestamps.push(validTimestamp(row.auto_finalize_at));
  } else {
    if (row.finalization_claim_expires_at) {
      timestamps.push(validTimestamp(row.finalization_claim_expires_at));
    }
    if (row.upload_retry_at) {
      timestamps.push(validTimestamp(row.upload_retry_at));
    }
  }
  return new Date(Math.max(...timestamps));
}

function announcementRecoveryRunAt(row: RecoverableAnnouncementRow, now: Date): Date {
  const timestamps = [now.getTime(), validTimestamp(row.announce_at)];
  if (row.download_next_retry_at) {
    timestamps.push(validTimestamp(row.download_next_retry_at));
  }
  if (row.claim_id && row.claim_expires_at) {
    timestamps.push(validTimestamp(row.claim_expires_at));
  }
  return new Date(Math.max(...timestamps));
}

function announcementRecoveryDedupeKey(row: RecoverableAnnouncementRow, startupAt: Date): string {
  const currentState = JSON.stringify([
    row.scope_id,
    row.id,
    row.version,
    row.announce_at,
    row.announcement_group_wid,
    row.download_next_retry_at,
    row.claim_id,
    row.claim_expires_at
  ]);
  const stateDigest = createHash('sha256').update(currentState).digest('hex');
  return `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:recovery:${stateDigest}:${startupAt.getTime()}`;
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isPrimaryLinkRequestKey(key: string): boolean {
  return key.startsWith('link-request:') &&
    !key.startsWith('link-request-wid:') &&
    !key.startsWith('link-request-phone:');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
