const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PluginServiceNotInvokedError } = require('@wabs/plugin-sdk/services');
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

test('Gallery reads and revalidates event albums inside the upload scope', async () => {
  const event = { eventId: 'event:42', title: 'Weekend outing', place: 'Cabo da Roca',
    revision: 'a'.repeat(64), localDate: '2026-11-28', timezone: 'Europe/Lisbon',
    startsAt: '2026-11-28T10:00:00.000Z', eventStatus: 'active' };
  const calls = [];
  let current = event;
  const [registration] = plugin.registerServices({ services: { async call(request) {
    calls.push(request);
    if (request.method === 'listCandidates') return { generatedAt: event.startsAt, candidates: [event] };
    return { kind: 'found', event: current };
  } } });
  const method = registration.methods[0];
  const binding = { callerPluginId: 'official.integration-manager', scopeId: 'community-A',
    actorIdentityId: 'member', groupWid: 'outing@g.us' };
  const prepare = input => method.handler({ capabilityId: 'gallery.media.upload.v1', ...input }, binding);
  const listed = method.outputSchema.parse(await prepare({ operation: 'invoke', args: ['upload'] }));
  assert.deepEqual(listed.payload.candidates, [{ eventId: event.eventId, revision: event.revision,
    title: event.title, place: event.place, localDate: event.localDate }]);
  const choiceId = `event-source:${event.revision}:${event.eventId}`;
  assert.deepEqual((await prepare({ operation: 'choice', choiceId })).payload.selected, listed.payload.candidates[0]);
  current = { ...event, revision: 'b'.repeat(64) };
  assert.equal((await prepare({ operation: 'choice', choiceId: `confirm:${choiceId}` })).payload.selected, null);
  assert.deepEqual(calls.map(request => [request.serviceId, request.method, request.scopeId, request.actorIdentityId,
    request.groupWid, request.input]), [
    ['official.community-events.album-source.v1', 'listCandidates', 'community-A', 'member', 'outing@g.us', {}],
    ['official.community-events.album-source.v1', 'resolve', 'community-A', 'member', 'outing@g.us', { eventId: event.eventId }],
    ['official.community-events.album-source.v1', 'resolve', 'community-A', 'member', 'outing@g.us', { eventId: event.eventId }]
  ]);
});

test('Gallery can start a manual upload when the event provider is absent', async () => {
  const [registration] = plugin.registerServices({ services: { async call() {
    throw new PluginServiceNotInvokedError('unavailable');
  } } });
  const input = { capabilityId: 'gallery.media.upload.v1', operation: 'invoke', args: [] };
  const binding = { callerPluginId: 'official.integration-manager', scopeId: 'community-A', actorIdentityId: 'member' };
  assert.deepEqual(await registration.methods[0].handler(input, binding),
    { kind: 'gallery.event-albums.v1', payload: { candidates: [] } });
  assert.equal(await registration.methods[0].handler(input, { ...binding, callerPluginId: 'another-plugin' }), null);
});
