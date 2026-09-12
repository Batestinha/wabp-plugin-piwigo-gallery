const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../dist').default;
const { createBatch, getBatch, getActiveBatch, appendBatchFile } = require('../dist/store');
const { assertGallerySubjectCutoverSchema } = require('../dist/storageRuntime');
const { listConfiguredPiwigoGalleryEligibleScopes } = require('../dist/eligibility');
const { FederatedTopomareGalleryPrincipalResolver } = require('../dist/topomarePrincipal');
const { assertPiwigoGalleryOutboundMethod, assertPiwigoGalleryCommandRoute, assertPiwigoGalleryPluginManifestBoundary } = require('../dist/uploadOnlyBoundary');
const metadata = require('../wa-plugin.json');
const migrations = fs.readdirSync('migrations/gallery').filter(name => name.endsWith('.sql')).sort();
const timestamp = '2026-09-12T10:00:00.000Z';
const issuer = 'https://id.example/realms/fixture';

function open(filePath) {
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return { name: 'gallery', filePath, exec: sql => sqlite.exec(sql), prepare: sql => sqlite.prepare(sql),
    get: (sql, ...args) => sqlite.prepare(sql).get(...args), all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args), close: () => sqlite.close(),
    transaction(operation) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const value = operation(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
function migrate(db, names = migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS _plugin_database_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  for (const name of names) db.transaction(() => {
    db.exec(fs.readFileSync(path.join('migrations/gallery', name), 'utf8'));
    db.run('INSERT INTO _plugin_database_migrations VALUES (?, ?)', name, timestamp);
  });
}
function cleanup(directory) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('wabs-gallery-')) throw new Error('Unexpected fixture cleanup path');
  fs.rmSync(directory, { recursive: true, force: true });
}
function batch() {
  return { id: 'fixture-batch', status: 'collecting', scopeId: 'fixture-scope', groupId: 'fixture-group', groupWid: 'target@g.us', chatId: 'target@g.us',
    collectionChatId: 'collector@lid', actorWid: 'actor@lid', actorIdentityId: 'fixture-actor',
    topomareUserId: '22222222-2222-4222-8222-222222222222', piwigoUserId: 17, actorLabel: 'Actor',
    albumSource: { kind: 'manual' }, onde: 'Sintra', quando: '2026-09-12', withUserIds: [10], acceptedExtensions: ['jpg'],
    maxFileBytes: 10_000_000, autoFinalizeMinutes: 30, files: [], createdAt: timestamp, updatedAt: timestamp, autoFinalizeAt: '2026-09-12T10:30:00.000Z' };
}

test('reopening the packaged gallery preserves identity bindings, media receipts, queue deadlines and deduplication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-gallery-data-'));
  let db;
  try {
    const file = path.join(directory, 'gallery.sqlite');
    db = open(file); migrate(db);
    assertGallerySubjectCutoverSchema(db);
    const stored = createBatch(db, batch());
    const input = { scopeId: stored.scopeId, batchId: stored.id,
      file: { mediaId: 'fixture-media', messageId: 'fixture-message', filename: 'image.jpg', mimeType: 'image/jpeg', sizeBytes: 50, status: 'staged' },
      acceptedAt: timestamp, autoFinalizeAt: '2026-09-12T10:45:00.000Z' };
    assert.equal(appendBatchFile(db, input).kind, 'appended');
    const before = getBatch(db, stored.scopeId, stored.id);
    db.close(); db = open(file);
    assertGallerySubjectCutoverSchema(db);
    assert.deepEqual(getBatch(db, stored.scopeId, stored.id), before);
    assert.equal(appendBatchFile(db, input).kind, 'duplicate');
    assert.equal(getActiveBatch(db, stored.scopeId, stored.collectionChatId, stored.actorIdentityId).id, stored.id);
    assert.equal(getActiveBatch(db, stored.scopeId, stored.collectionChatId, stored.actorWid), undefined);
    assert.equal(getBatch(db, 'other-scope', stored.id), undefined);
    assert.equal(getBatch(db, stored.scopeId, stored.id).files.length, 1);
    assert.throws(() => createBatch(db, { ...batch(), id: 'duplicate-actor' }), /already has active/);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db?.close(); cleanup(directory); }
});

test('an older gallery schema is rejected without silently running the historical destructive cutover', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-gallery-legacy-'));
  const db = open(path.join(directory, 'legacy.sqlite'));
  try {
    migrate(db, migrations.slice(0, 10));
    assert.throws(() => assertGallerySubjectCutoverSchema(db), /refuses startup/);
    assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name = 'gallery_link_requests'").name, 'gallery_link_requests');
    assert.equal(db.all('SELECT name FROM _plugin_database_migrations').length, 10);
    assert.deepEqual(metadata.databases[0].operatorMigrations, ['011_topomare_subject_cutover.sql']);
  } finally { db.close(); cleanup(directory); }
});

test('membership layers retain stored gallery settings and never mutate the host response', async () => {
  const layer = { scopeId: 'fixture-scope', groupId: 'fixture-group', groupWid: 'target@g.us', label: 'Physical group', scopeLabel: 'My gallery',
    enabledConfigLayers: [{ enabled: true, autoFinalizeMinutes: 5, maxFileBytes: 4096 }, { autoFinalizeMinutes: 17 }] };
  const original = JSON.stringify(layer);
  const identities = [];
  const result = await listConfiguredPiwigoGalleryEligibleScopes('fixture-actor', {
    piwigoBaseUrl: 'https://gallery.example', topomareOidcIssuer: issuer, topomareWabpProviderNamespace: 'wabp-fixture',
    topomarePiwigoProviderNamespace: 'piwigo-fixture', serviceOidcClientId: 'fixture-client', serviceOidcClientSecret: 'fixture-secret-only',
    identityAccess: { listEnabledScopeMemberships: async id => { identities.push(id); return [layer]; } }
  });
  assert.deepEqual(identities, ['fixture-actor']);
  assert.equal(result[0].scopeLabel, 'My gallery');
  assert.equal(result[0].config.autoFinalizeMinutes, 17);
  assert.equal(result[0].config.maxFileBytes, 4096);
  assert.equal(JSON.stringify(layer), original);
  await assert.rejects(listConfiguredPiwigoGalleryEligibleScopes('fixture-actor', {}), /Host identity membership/);
});

test('federated identity requires host verification and rejects addresses, revoked records and mismatched identities', async () => {
  const binding = { issuer, identityId: 'fixture-actor', subject: 'fixture-subject', topomareUserId: batch().topomareUserId, verifiedAt: new Date(timestamp), revokedAt: null };
  const calls = [];
  const resolver = new FederatedTopomareGalleryPrincipalResolver(issuer, 'wabp-fixture', { resolveSubjectForIdentity: async input => { calls.push(input); return binding; } });
  assert.deepEqual(await resolver.resolveForIdentity('fixture-actor'), { topomareUserId: binding.topomareUserId, wabpIdentityId: 'fixture-actor', wabpProviderNamespace: 'wabp-fixture' });
  await assert.rejects(resolver.resolveForIdentity('actor@lid'), /not a WhatsApp address/);
  assert.equal(calls.length, 1);
  binding.revokedAt = new Date(timestamp);
  await assert.rejects(resolver.resolveForIdentity('fixture-actor'), /did not match/);
  binding.revokedAt = null; binding.identityId = 'different-actor';
  await assert.rejects(resolver.resolveForIdentity('fixture-actor'), /did not match/);
  await assert.rejects(new FederatedTopomareGalleryPrincipalResolver(issuer, 'wabp-fixture').resolveForIdentity('fixture-actor'), /Host federated identity/);
});

test('callbacks reuse captured targets and durable jobs when a queue retry follows configuration changes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-gallery-callback-'));
  const db = open(path.join(directory, 'gallery.sqlite'));
  try {
    migrate(db);
    let config = { enabled: true, newAlbumAnnouncementsEnabled: true, announcementGroupWid: 'target@g.us', newAlbumAnnouncementDelayMinutes: 30 };
    const queued = [];
    let queueUnavailable = true;
    const context = { pluginId: plugin.manifest.pluginId, databases: { open: () => db }, configFor: async () => config,
      coveredGroupsForScope: async () => [{ scopeId: 'fixture-scope', groupId: 'fixture-group', groupWid: 'target@g.us' }],
      enqueuePluginJob: async input => { queued.push(input); if (queueUnavailable) throw new Error('Fixture queue unavailable'); } };
    const registration = plugin.registerExternalActions(context)[0];
    const input = registration.inputSchema.parse({ eventId: 'fixture-observation', scopeId: 'fixture-scope', albumId: 12,
      albumName: 'Fixture album', siteLabel: 'Fixture gallery', userDisplayName: 'Fixture user', observedAt: timestamp,
      files: [{ imageId: 17, sha256: 'a'.repeat(64), filename: 'photo.jpg', mimeType: 'image/jpeg' }] });
    const call = { signal: new AbortController().signal };
    await assert.rejects(registration.handler(input, call), /queue unavailable/);
    const captured = db.get('SELECT * FROM gallery_album_announcements');
    const priorRetry = queued.at(-1);
    config = { ...config, announcementGroupWid: 'new-target@g.us' };
    queueUnavailable = false;
    const result = await registration.handler(input, call);
    assert.equal(result.accepted, true);
    assert.equal(result.duplicate, true);
    assert.equal(db.all('SELECT * FROM gallery_album_announcements').length, 1);
    assert.equal(db.get('SELECT announcement_group_wid FROM gallery_album_announcements').announcement_group_wid, captured.announcement_group_wid);
    assert.deepEqual(queued.at(-1), priorRetry);
    assert.equal(queued.at(-1).pluginId, undefined);
  } finally { db.close(); cleanup(directory); }
});

test('the upload-only boundary, migration bytes, translations and custom templates remain intact', () => {
  assertPiwigoGalleryPluginManifestBoundary(plugin.manifest);
  assert.throws(() => assertPiwigoGalleryCommandRoute('gallery', 'signup'), /boundary/);
  assert.throws(() => assertPiwigoGalleryOutboundMethod('pwg.session.login'), /boundary/);
  const config = plugin.manifest.configSchema.parse({ newAlbumAnnouncementTemplate: 'Saved: {album}', autoFinalizeMinutes: 17 });
  assert.equal(config.newAlbumAnnouncementTemplate, 'Saved: {album}');
  assert.equal(config.autoFinalizeMinutes, 17);
  assert.equal(metadata.dataVersion, '11');
  assert.equal(migrations.length, 11);
  for (const name of migrations) assert.equal(fs.readFileSync(path.join('migrations/gallery', name), 'utf8'), fs.readFileSync(path.join('src/migrations/gallery', name), 'utf8'));
  const pt = require('../locales/pt-PT/official.piwigo-gallery.json');
  for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
  assert.equal(plugin.lifecycle, undefined);
});
