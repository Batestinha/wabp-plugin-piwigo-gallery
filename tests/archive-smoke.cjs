const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'wa-plugin.json')));
const plugin = require(path.join(root, metadata.entrypoint)).default;
assert.equal(plugin.manifest.pluginId, 'official.piwigo-gallery');
assert.equal(plugin.manifest.version, metadata.version);
assert.equal(plugin.manifest.coreApiRange, '^0.3.6');
for (const method of ['registerCommands', 'registerCancellations', 'registerHooks', 'registerExternalActions']) assert.equal(typeof plugin[method], 'function');
assert.equal(plugin.lifecycle, undefined);
const pt = JSON.parse(fs.readFileSync(path.join(root, 'locales/pt-PT/official.piwigo-gallery.json')));
for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
for (const file of ['node_modules/@wabs/plugin-sdk/dist/identity-access.js', 'node_modules/@wabs/plugin-sdk/LICENSE', 'node_modules/zod/LICENSE', 'contracts/provenance.json', 'contracts/LICENSE.events', 'upload-only-boundary.v1.json', 'dist/upload-only-boundary.v1.json']) assert.ok(fs.statSync(path.join(root, file)).isFile());
assert.equal(fs.existsSync(path.join(root, 'node_modules/@prisma')), false);
assert.equal(plugin.manifest.configSchema.parse({ newAlbumAnnouncementTemplate: 'Saved: {album}' }).newAlbumAnnouncementTemplate, 'Saved: {album}');
assert.equal(metadata.dataVersion, '12');
assert.equal(fs.readdirSync(path.join(root, 'migrations/gallery')).length, 11);
assert.deepEqual(metadata.databases[0].operatorMigrations, ['011_topomare_subject_cutover.sql']);
console.log(JSON.stringify({ pluginId: metadata.pluginId, version: metadata.version, standaloneLoad: true, translations: Object.keys(pt).length, controls: metadata.operatorConsole.controls.length }));

const compiledConsoleOperations = metadata.consoleOperations ?? [];
assert.deepEqual(plugin.manifest.consoleOperations ?? [], compiledConsoleOperations);
assert.deepEqual(plugin.manifest.configuration ?? null, metadata.configuration ?? null);
if (compiledConsoleOperations.length) {
  const handlers = plugin.registerConsoleOperations({
    pluginId: metadata.pluginId, runtimeBindingId: 'fixture-runtime', whatsAppAccountId: 'fixture-account', archive: {}
  });
  assert.deepEqual(handlers.map(operation => operation.operationId).sort(), compiledConsoleOperations.map(operation => operation.operationId).sort());
  for (const operation of handlers) assert.equal(typeof operation.handler, 'function');
}
if ((metadata.externalActions ?? []).length) assert.equal(typeof plugin.registerExternalActions, 'function');
