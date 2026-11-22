const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../dist').default;
test('Piwigo owns gallery and preserves the host actor, scope, original message and result', async () => {
  let registered, request;
  const reply = { handled: true, text: 'Choose an album' };
  plugin.registerCommands({ router: { register: (...args) => { registered = args; } },
    services: { call: async value => { request = value; return reply; } } });
  assert.deepEqual(registered.slice(0, 2), ['gallery', '*']);
  assert.equal(registered[2].pluginId, 'official.piwigo-gallery');
  const ctx = { actor: { identityAddress: { identityId: 'member' } }, scopeId: 'scope',
    groupWid: 'group@g.us', message: { id: 'original', chatId: 'group@g.us', context: 'group' }, command: { args: [] },
    t: key => key };
  assert.deepEqual(await registered[3](ctx), reply);
  assert.equal(request.serviceId, 'official.integration-manager.capability.v1');
  assert.equal(request.scopeId, 'scope');
  assert.equal(request.actorIdentityId, 'member');
  assert.equal(request.input.messageId, 'original');
  assert.equal(request.input.capabilityId, 'gallery.media.upload.v1');
  assert.equal((await registered[3]({ ...ctx, actor: undefined })).text, 'official.piwigo-gallery.unavailable');
  assert.throws(() => plugin.manifest.configSchema.parse({ maximumFiles: 0 }));
  assert.equal(plugin.manifest.configSchema.parse({ announcementsEnabled: false }).announcementsEnabled, false);
});
