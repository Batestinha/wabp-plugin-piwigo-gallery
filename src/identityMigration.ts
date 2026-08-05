import type {
  PluginDatabase,
  PluginDatabaseRow
} from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { PluginLifecycleContext } from '../../../platform/pluginRuntime/types';
import { galleryDatabase } from './store';

interface GalleryActorRow extends PluginDatabaseRow {
  key: string;
  actor_wid: string;
  identity_id: string | null;
}

interface ActiveGalleryActorRow extends PluginDatabaseRow {
  key: string;
  scope_id: string;
  collection_chat_id: string;
  batch_id: string;
  actor_wid: string;
  identity_id: string;
}

interface GalleryIdentitySnapshot {
  batches: GalleryActorRow[];
  drafts: GalleryActorRow[];
  activeBatches: ActiveGalleryActorRow[];
  linkRequests: GalleryActorRow[];
  registrationOtps: GalleryActorRow[];
}

export interface GalleryIdentityMigrationResult {
  batchesBackfilled: number;
  draftsBackfilled: number;
  activeBatchesBackfilled: number;
  linkRequestsBackfilled: number;
  registrationOtpsBackfilled: number;
}

type ResolvePersistedIdentityId = (wid: string) => Promise<string>;

/** Finalize durable gallery ownership through the authoritative platform identity service. */
export async function migrateGalleryIdentityData(
  context: PluginLifecycleContext
): Promise<void> {
  if (!context.resolvePersistedIdentityId) {
    throw new Error('official.piwigo-gallery identity migration requires platform identity access.');
  }
  const result = await finalizeGalleryIdentityMigration(
    galleryDatabase(context.databases),
    context.resolvePersistedIdentityId
  );
  context.logger.info(result, 'Finalized official.piwigo-gallery authoritative identity data');
}

/** Exported for deterministic, transport-free migration verification. */
export async function finalizeGalleryIdentityMigration(
  db: PluginDatabase,
  resolvePersistedIdentityId: ResolvePersistedIdentityId
): Promise<GalleryIdentityMigrationResult> {
  const before = readIdentitySnapshot(db);
  const identityIdsByWid = new Map<string, string>();
  const resolve = async (wid: string): Promise<string> => {
    const normalizedWid = wid.trim();
    if (!normalizedWid) {
      throw new Error('Cannot migrate official.piwigo-gallery identity data with an empty WhatsApp address.');
    }
    const cached = identityIdsByWid.get(normalizedWid);
    if (cached) return cached;
    const identityId = (await resolvePersistedIdentityId(normalizedWid)).trim();
    if (!identityId) {
      throw new Error(`Cannot migrate official.piwigo-gallery identity data: ${normalizedWid} resolved without an identity id.`);
    }
    identityIdsByWid.set(normalizedWid, identityId);
    return identityId;
  };

  const expected = await resolveSnapshot(before, resolve);
  const result = migrationResult(before, expected);

  db.transaction(() => {
    if (!sameSnapshot(before, readIdentitySnapshot(db))) {
      throw new Error(
        'Cannot migrate official.piwigo-gallery identity data: gallery identity rows changed while authoritative identities were resolving; retry the migration.'
      );
    }

    db.exec(`
      DROP TRIGGER gallery_upload_drafts_immutable_target;
      DROP TRIGGER gallery_upload_batches_immutable_target;
    `);
    updateActorRows(db, 'gallery_upload_batches', 'id', before.batches, expected.batches);
    updateActorRows(db, 'gallery_upload_drafts', 'flow_session_id', before.drafts, expected.drafts);
    restoreImmutableTargetTriggers(db);

    updateActiveBatchRows(db, before.activeBatches, expected.activeBatches);
    updateActorRows(
      db,
      'gallery_link_requests',
      'token_key',
      before.linkRequests,
      expected.linkRequests,
      'identity_id',
      'whatsapp_jid'
    );
    updateActorRows(
      db,
      'gallery_registration_otps',
      'request_id',
      before.registrationOtps,
      expected.registrationOtps,
      'identity_id',
      'whatsapp_jid'
    );

    if (!sameSnapshot(expected, readIdentitySnapshot(db))) {
      throw new Error(
        'Cannot finalize official.piwigo-gallery identity data: authoritative ownership postconditions were not satisfied.'
      );
    }
  });

  return result;
}

async function resolveSnapshot(
  snapshot: GalleryIdentitySnapshot,
  resolve: ResolvePersistedIdentityId
): Promise<GalleryIdentitySnapshot> {
  return {
    batches: await resolveRows(snapshot.batches, resolve),
    drafts: await resolveRows(snapshot.drafts, resolve),
    activeBatches: await Promise.all(snapshot.activeBatches.map(async (row) => ({
      ...row,
      identity_id: await authoritativeIdentityId(row.identity_id, row.actor_wid, resolve, `active batch ${row.batch_id}`)
    }))),
    linkRequests: await resolveRows(snapshot.linkRequests, resolve),
    registrationOtps: await resolveRows(snapshot.registrationOtps, resolve)
  };
}

async function resolveRows(
  rows: GalleryActorRow[],
  resolve: ResolvePersistedIdentityId
): Promise<GalleryActorRow[]> {
  return await Promise.all(rows.map(async (row) => ({
    ...row,
    identity_id: await authoritativeIdentityId(row.identity_id, row.actor_wid, resolve, row.key)
  })));
}

async function authoritativeIdentityId(
  storedIdentityId: string | null,
  wid: string,
  resolve: ResolvePersistedIdentityId,
  key: string
): Promise<string> {
  const expectedIdentityId = (await resolve(wid)).trim();
  const stored = storedIdentityId?.trim() ?? '';
  if (!stored) return expectedIdentityId;
  if (stored === expectedIdentityId) return expectedIdentityId;

  // This is a one-time migration boundary, not a runtime compatibility path.
  // Historical rows sometimes persisted a WhatsApp address in the identity-id column.
  if (stored.includes('@')) {
    const storedPrincipal = await resolve(stored);
    if (storedPrincipal === expectedIdentityId) return expectedIdentityId;
  }
  throw new Error(
    `Cannot migrate official.piwigo-gallery identity data for ${key}: stored identity ${stored} conflicts with authoritative identity ${expectedIdentityId}.`
  );
}

function readIdentitySnapshot(db: PluginDatabase): GalleryIdentitySnapshot {
  return {
    batches: db.all<GalleryActorRow>(
      `SELECT id AS key, actor_wid, actor_identity_id AS identity_id
         FROM gallery_upload_batches
        ORDER BY id ASC`
    ),
    drafts: db.all<GalleryActorRow>(
      `SELECT flow_session_id AS key, actor_wid, actor_identity_id AS identity_id
         FROM gallery_upload_drafts
        ORDER BY flow_session_id ASC`
    ),
    activeBatches: db.all<ActiveGalleryActorRow>(
      `SELECT active.batch_id AS key,
              active.scope_id, active.collection_chat_id, active.batch_id,
              batch.actor_wid, active.actor_identity_id AS identity_id
         FROM gallery_active_batch_identities active
         JOIN gallery_upload_batches batch ON batch.id = active.batch_id
        ORDER BY active.scope_id, active.collection_chat_id, active.actor_identity_id`
    ),
    linkRequests: db.all<GalleryActorRow>(
      `SELECT token_key AS key, whatsapp_jid AS actor_wid, identity_id
         FROM gallery_link_requests
        ORDER BY token_key ASC`
    ),
    registrationOtps: db.all<GalleryActorRow>(
      `SELECT request_id AS key, whatsapp_jid AS actor_wid, identity_id
         FROM gallery_registration_otps
        ORDER BY request_id ASC`
    )
  };
}

function updateActorRows(
  db: PluginDatabase,
  table: string,
  keyColumn: string,
  before: GalleryActorRow[],
  expected: GalleryActorRow[],
  identityColumn = 'actor_identity_id',
  widColumn = 'actor_wid'
): void {
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = expected[index];
    if (!previous || !next || previous.identity_id === next.identity_id) continue;
    const result = db.run(
      `UPDATE ${table}
          SET ${identityColumn} = ?
        WHERE ${keyColumn} = ?
          AND ${widColumn} = ?
          AND ${identityColumn} IS ?`,
      next.identity_id,
      previous.key,
      previous.actor_wid,
      previous.identity_id
    );
    if (result.changes !== 1) {
      throw new Error(`Could not atomically backfill gallery identity for ${previous.key}.`);
    }
  }
}

function updateActiveBatchRows(
  db: PluginDatabase,
  before: ActiveGalleryActorRow[],
  expected: ActiveGalleryActorRow[]
): void {
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = expected[index];
    if (!previous || !next || previous.identity_id === next.identity_id) continue;
    const result = db.run(
      `UPDATE gallery_active_batch_identities
          SET actor_identity_id = ?
        WHERE scope_id = ?
          AND collection_chat_id = ?
          AND actor_identity_id = ?
          AND batch_id = ?`,
      next.identity_id,
      previous.scope_id,
      previous.collection_chat_id,
      previous.identity_id,
      previous.batch_id
    );
    if (result.changes !== 1) {
      throw new Error(`Could not atomically backfill active gallery identity for batch ${previous.batch_id}.`);
    }
  }
}

function restoreImmutableTargetTriggers(db: PluginDatabase): void {
  db.exec(`
    CREATE TRIGGER gallery_upload_drafts_immutable_target
    BEFORE UPDATE OF scope_id, group_id, group_wid, chat_id, actor_wid, actor_identity_id
    ON gallery_upload_drafts
    WHEN OLD.scope_id IS NOT NEW.scope_id
      OR OLD.group_id IS NOT NEW.group_id
      OR OLD.group_wid IS NOT NEW.group_wid
      OR OLD.chat_id IS NOT NEW.chat_id
      OR OLD.actor_wid IS NOT NEW.actor_wid
      OR OLD.actor_identity_id IS NOT NEW.actor_identity_id
    BEGIN
      SELECT RAISE(ABORT, 'gallery upload draft target is immutable');
    END;

    CREATE TRIGGER gallery_upload_batches_immutable_target
    BEFORE UPDATE OF scope_id, group_id, group_wid, chat_id, actor_wid, actor_identity_id
    ON gallery_upload_batches
    WHEN OLD.scope_id IS NOT NEW.scope_id
      OR OLD.group_id IS NOT NEW.group_id
      OR OLD.group_wid IS NOT NEW.group_wid
      OR OLD.chat_id IS NOT NEW.chat_id
      OR OLD.actor_wid IS NOT NEW.actor_wid
      OR OLD.actor_identity_id IS NOT NEW.actor_identity_id
    BEGIN
      SELECT RAISE(ABORT, 'gallery upload batch target is immutable');
    END;
  `);
}

function migrationResult(
  before: GalleryIdentitySnapshot,
  expected: GalleryIdentitySnapshot
): GalleryIdentityMigrationResult {
  return {
    batchesBackfilled: changedRows(before.batches, expected.batches),
    draftsBackfilled: changedRows(before.drafts, expected.drafts),
    activeBatchesBackfilled: changedRows(before.activeBatches, expected.activeBatches),
    linkRequestsBackfilled: changedRows(before.linkRequests, expected.linkRequests),
    registrationOtpsBackfilled: changedRows(before.registrationOtps, expected.registrationOtps)
  };
}

function changedRows<T extends { identity_id: string | null }>(before: T[], expected: T[]): number {
  return before.reduce((count, row, index) => count + (row.identity_id === expected[index]?.identity_id ? 0 : 1), 0);
}

function sameSnapshot(left: GalleryIdentitySnapshot, right: GalleryIdentitySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
