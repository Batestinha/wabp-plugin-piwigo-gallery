import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { TranslateFn } from '../../../platform/i18n';
import type { PluginCommandContext } from '../../../platform/pluginRuntime/types';
import {
  commandText,
  makeId,
  parseBoolean,
  requireOfficialCommandRuntime,
  requireScopeId
} from '../shared';
import { parsePiwigoGalleryConfig, resolvePiwigoBaseUrl } from './config';
import {
  galleryConfirmPurpose,
  galleryFlowAnswers,
  galleryFlowConfirmed,
  createGalleryUploadFlowDefinition
} from './flow';
import {
  PIWIGO_GALLERY_FINALIZE_JOB,
  PIWIGO_GALLERY_PERMISSIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import { PiwigoGalleryClient, type PiwigoPeopleResult } from './piwigoClient';
import {
  clearActiveBatch,
  deleteLinkRequest,
  deleteDraft,
  digitsFromPhoneLike,
  getActiveBatchForActorWids,
  getDraft,
  getLinkRequestForPhoneDigits,
  getLinkRequestForWids,
  resolveGalleryConnection,
  saveBatch,
  saveDraft,
  setActiveBatch,
  type GalleryUploadBatch
} from './store';
import {
  listConfiguredPiwigoGalleryEligibleScopes,
  type ConfiguredPiwigoGalleryScope
} from './eligibility';

const SCOPE_TARGET: CommandTargetSpec = {
  kind: 'scope',
  flag: ['scope', 'scope-id'],
  fallback: 'current_scope'
};

export function registerPiwigoGalleryCommands(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const router = context.router;

  router.register('gallery', 'status', galleryAdminCommand({
    mutation: 'none',
    auditAction: 'piwigo-gallery.status',
    usage: '/gallery status',
    descriptionKey: 'official.piwigo-gallery.help.gallery'
  }), async (ctx) => {
    const scopeId = requireScopeId(ctx);
    const t = await piwigoCommandTranslator(context, ctx, scopeId);
    const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
    const connection = await resolveGalleryConnection(
      runtime.dataStore,
      config,
      context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
      context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
    );
    return {
      handled: true,
      text: t('official.piwigo-gallery.status', {
        enabled: String(config.enabled),
        url: connection?.piwigoBaseUrl ?? resolvePiwigoBaseUrl(context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL),
        auto: String(config.autoFinalizeMinutes),
        max: String(config.maxFileBytes),
        announceEnabled: String(config.newAlbumAnnouncementsEnabled),
        announcementGroup: config.announcementGroupWid || '',
        announcementDelay: String(config.newAlbumAnnouncementDelayMinutes)
      })
    };
  });

  router.register('gallery', 'configure', galleryAdminCommand({
    auditAction: 'piwigo-gallery.configure',
    usage: '/gallery configure enabled=yes auto=30 max=536870912',
    descriptionKey: 'official.piwigo-gallery.help.gallery'
  }), async (ctx) => {
    const scopeId = requireScopeId(ctx);
    const t = await piwigoCommandTranslator(context, ctx, scopeId);
    const args = ctx.remainingArgs ?? ctx.command.args;
    if (args.length === 0) {
      return { handled: true, text: t('official.piwigo-gallery.configUsage') };
    }
    const patch = parseConfigPatch(args);
    if (!patch) {
      return { handled: true, text: t('official.piwigo-gallery.configUsage') };
    }
    const current = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
    const next = parsePiwigoGalleryConfig({ ...current, ...patch });
    await runtime.setConfig(scopeId, next);
    return { handled: true, text: t('official.piwigo-gallery.configUpdated') };
  });

  router.register('gallery', 'download', galleryDownloadCommand({
    auditAction: 'piwigo-gallery.download',
    usage: '/gallery download image 123',
    descriptionKey: 'official.piwigo-gallery.help.download'
  }), async (ctx) => downloadGalleryFile(context, ctx));

  router.register('send', 'gallery', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.start',
    usage: '/send gallery',
    descriptionKey: 'official.piwigo-gallery.help.send'
  }), async (ctx) => startUploadFlow(context, ctx));

  router.register('upload', '*', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.finalize',
    usage: '/upload',
    descriptionKey: 'official.piwigo-gallery.help.upload'
  }), async (ctx) => finalizeActiveUpload(context, ctx));

  router.register('cancel', '*', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.cancel',
    usage: '/cancel',
    descriptionKey: 'official.piwigo-gallery.help.cancel'
  }), async (ctx) => cancelActiveUpload(context, ctx));

  router.register('accept', '*', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.link.accept',
    usage: '/accept',
    descriptionKey: 'official.piwigo-gallery.help.accept'
  }), async (ctx) => completeLinkRequest(
    context,
    runtime,
    ctx,
    'approve',
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  ));

  router.register('refuse', '*', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.link.refuse',
    usage: '/refuse',
    descriptionKey: 'official.piwigo-gallery.help.refuse'
  }), async (ctx) => completeLinkRequest(
    context,
    runtime,
    ctx,
    'deny',
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  ));

  router.register('login', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.login',
    usage: '/login gallery CODE',
    descriptionKey: 'official.piwigo-gallery.help.login'
  }), async (ctx) => {
    const fallbackT = await piwigoCommandTranslator(context, ctx);
    const code = commandText(ctx).toUpperCase();
    if (!code) {
      return { handled: true, text: fallbackT('official.piwigo-gallery.loginUsage') };
    }
    const scopes = await configuredPiwigoScopesForCommand(ctx, {
      defaultPiwigoBaseUrl: context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
      defaultPiwigoBotSecret: context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
    });
    if (scopes.length === 0) {
      return { handled: true, text: fallbackT('official.piwigo-gallery.notConfigured') };
    }
    const t = await piwigoCommandTranslator(context, ctx, scopes[0]?.scopeId);
    let lastError: unknown;
    const tried = new Set<string>();
    const candidateWids = piwigoCandidateWids(ctx);
    for (const scope of scopes) {
      const key = `${scope.connection.piwigoBaseUrl}\n${scope.connection.botSecret}`;
      if (tried.has(key)) {
        continue;
      }
      tried.add(key);
      const client = new PiwigoGalleryClient(scope.connection);
      for (const whatsappJid of candidateWids) {
        try {
          const result = await client.consumeLoginCode(code, whatsappJid);
          return { handled: true, text: t('official.piwigo-gallery.loginApproved', { username: result.username }) };
        } catch (error) {
          lastError = error;
        }
      }
    }
    return { handled: true, text: t('official.piwigo-gallery.failed', { reason: errorMessage(lastError) }) };
  });

  router.register('register', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.register',
    usage: '/register gallery Your Name',
    descriptionKey: 'official.piwigo-gallery.help.register'
  }), async (ctx) => {
    const fallbackT = await piwigoCommandTranslator(context, ctx);
    const username = commandText(ctx) || ctx.message.senderDisplayName || '';
    if (!username.trim()) {
      return { handled: true, text: fallbackT('official.piwigo-gallery.registerUsage') };
    }
    const scopes = await configuredPiwigoScopesForCommand(ctx, {
      defaultPiwigoBaseUrl: context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
      defaultPiwigoBotSecret: context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
    });
    if (scopes.length === 0) {
      return { handled: true, text: fallbackT('official.piwigo-gallery.notConfigured') };
    }
    const t = await piwigoCommandTranslator(context, ctx, scopes[0]?.scopeId);
    if (scopes.length > 1) {
      return { handled: true, text: t('official.piwigo-gallery.multipleEligibleScopes') };
    }
    const scope = scopes[0]!;
    try {
      const result = await new PiwigoGalleryClient(scope.connection).registerAccount(username, piwigoCandidateWids(ctx)[0] ?? ctx.message.senderWid, scope.scopeId);
      return {
        handled: true,
        text: t(result.pending ? 'official.piwigo-gallery.registeredPending' : 'official.piwigo-gallery.registered', {
          username: result.username
        })
      };
    } catch (error) {
      return { handled: true, text: t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
    }
  });
}

async function completeLinkRequest(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  ctx: CommandContext,
  decision: 'approve' | 'deny',
  defaultPiwigoBaseUrl: string,
  defaultPiwigoBotSecret: string
) {
  const fallbackT = await piwigoCommandTranslator(context, ctx);
  if (ctx.command.args.length > 0 || (ctx.remainingArgs?.length ?? 0) > 0) {
    return { handled: true, text: fallbackT(decision === 'approve' ? 'official.piwigo-gallery.acceptUsage' : 'official.piwigo-gallery.refuseUsage') };
  }
  let responseT = fallbackT;
  try {
    const senderWids = linkRequestLookupWids(ctx);
    const request = await getLinkRequestForWids(runtime.dataStore, senderWids)
      ?? await getLinkRequestForPhoneDigits(runtime.dataStore, phoneDigitsForWids(senderWids));
    responseT = request?.scopeOptions[0]?.scopeId
      ? await piwigoCommandTranslator(context, ctx, request.scopeOptions[0].scopeId)
      : fallbackT;
    if (!request || new Date(request.expiresAt).getTime() < Date.now()) {
      if (request) {
        await deleteLinkRequest(runtime.dataStore, request.requestToken);
      }
      return { handled: true, text: responseT('official.piwigo-gallery.failed', { reason: responseT('official.piwigo-gallery.error.invalidOrExpiredLinkRequest') }) };
    }
    if (!linkRequestMatchesSender(request, senderWids)) {
      return { handled: true, text: responseT('official.piwigo-gallery.failed', { reason: responseT('official.piwigo-gallery.error.identityMismatch') }) };
    }
    const firstScope = request.scopeOptions[0];
    if (!firstScope) {
      return { handled: true, text: responseT('official.piwigo-gallery.notConfigured') };
    }
    const connection = await connectionForScope(
      runtime,
      firstScope.scopeId,
      defaultPiwigoBaseUrl,
      defaultPiwigoBotSecret,
      ctx.message.senderWid
    );
    if (!connection) {
      return { handled: true, text: responseT('official.piwigo-gallery.notConfigured') };
    }
    const linkChoiceCount = request.linkChoiceCount ?? new Set(request.scopeOptions.map((scope) => scope.scopeId)).size;
    const selectedScopeId = decision === 'approve' && linkChoiceCount === 1
      ? firstScope.scopeId
      : undefined;
    const result = await new PiwigoGalleryClient(connection).completeLinkRequest(request.requestToken, request.whatsappJid, decision, {
      ...(selectedScopeId ? { scopeId: selectedScopeId } : {}),
      ...(decision === 'approve' && linkChoiceCount > 1
        ? {
            eligibleScopes: request.scopeOptions.map((scope) => ({
              scope_id: scope.scopeId,
              label: scope.label
            }))
          }
        : {})
    });
    await deleteLinkRequest(runtime.dataStore, request.requestToken);
    if (decision === 'approve' && result.status === 'scope_required') {
      return { handled: true, text: responseT('official.piwigo-gallery.linkScopeRequired', { siteLabel: request.siteLabel }) };
    }
    return {
      handled: true,
      text: responseT(decision === 'approve' ? 'official.piwigo-gallery.linkConfirmed' : 'official.piwigo-gallery.linkDenied', {
        username: result.username ?? ''
      })
    };
  } catch (error) {
    return { handled: true, text: responseT('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
  }
}

async function piwigoCommandTranslator(
  context: PluginCommandContext,
  ctx: CommandContext,
  scopeId?: string | undefined
): Promise<TranslateFn> {
  const scoped = await context.i18n.translatorForIdentity(ctx.message.senderWid, scopeId);
  return (key, params) => {
    const translated = scoped(key, params);
    return translated === key ? ctx.t(key, params) : translated;
  };
}

function linkRequestLookupWids(ctx: CommandContext): string[] {
  return [...new Set([
    ctx.message.senderWid,
    ctx.message.authorWid,
    ctx.message.chatId,
    ...(ctx.actor?.aliases ?? [])
  ].map((wid) => wid.trim().toLowerCase()).filter(Boolean))];
}

function linkRequestMatchesSender(
  request: { whatsappJid: string; whatsappAliases?: string[] | undefined; phone?: string | undefined },
  senderWids: string[]
): boolean {
  const requestWids = new Set([request.whatsappJid, ...(request.whatsappAliases ?? [])].map((wid) => wid.toLowerCase()));
  if (senderWids.some((wid) => requestWids.has(wid.toLowerCase()))) {
    return true;
  }
  const requestPhoneDigits = digitsFromPhoneLike(request.phone ?? request.whatsappJid);
  return Boolean(requestPhoneDigits && phoneDigitsForWids(senderWids) === requestPhoneDigits);
}

function phoneDigitsForWids(wids: string[]): string {
  for (const wid of wids) {
    const digits = digitsFromPhoneLike(wid);
    if (digits) {
      return digits;
    }
  }
  return '';
}

function commandActorWids(ctx: CommandContext): string[] {
  return uniqueWids([
    ctx.message.senderWid,
    ctx.message.authorWid,
    ctx.actor?.wid,
    ...(ctx.actor?.aliases ?? [])
  ]);
}

function piwigoCandidateWids(ctx: CommandContext): string[] {
  const wids = commandActorWids(ctx);
  return [
    ...wids.filter(isPhoneWid),
    ...wids.filter((wid) => !isPhoneWid(wid))
  ];
}

function isPhoneWid(wid: string): boolean {
  return /^\d+@c\.us$/i.test(wid.trim());
}

function uniqueWids(wids: Array<string | null | undefined>): string[] {
  return [...new Set(wids.map((wid) => wid?.trim().toLowerCase() ?? '').filter(Boolean))];
}

async function peopleForPiwigoActor(
  client: PiwigoGalleryClient,
  candidateWids: string[],
  scopeId: string
): Promise<{ whatsappJid: string; peopleResult: PiwigoPeopleResult }> {
  let lastError: unknown;
  for (const whatsappJid of candidateWids) {
    try {
      return {
        whatsappJid,
        peopleResult: await client.people(whatsappJid, scopeId)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('WhatsApp account is not linked for this Piwigo scope');
}

async function configuredPiwigoScopesForCommand(
  ctx: CommandContext,
  input: {
    defaultPiwigoBaseUrl?: string | undefined;
    defaultPiwigoBotSecret?: string | undefined;
  }
): Promise<ConfiguredPiwigoGalleryScope[]> {
  const scopes = new Map<string, ConfiguredPiwigoGalleryScope>();
  for (const wid of commandActorWids(ctx)) {
    for (const scope of await listConfiguredPiwigoGalleryEligibleScopes(wid, input)) {
      scopes.set(`${scope.scopeId}:${scope.groupId}`, scope);
    }
  }
  return [...scopes.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.scopeId.localeCompare(right.scopeId)
  );
}

async function downloadGalleryFile(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const reference = parseDownloadReference(ctx.remainingArgs ?? ctx.command.args);
  if (!reference) {
    return { handled: true, text: t('official.piwigo-gallery.downloadUsage') };
  }
  const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
  if (!config.enabled) {
    return { handled: true, text: t('official.piwigo-gallery.disabled') };
  }
  if (ctx.managementMode === 'OBSERVE') {
    return { handled: true, text: t('official.piwigo-gallery.observeOnly') };
  }
  const connection = await resolveGalleryConnection(
    runtime.dataStore,
    config,
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    return { handled: true, text: t('official.piwigo-gallery.notConfigured') };
  }

  try {
    const client = new PiwigoGalleryClient(connection);
    const actor = await peopleForPiwigoActor(client, piwigoCandidateWids(ctx), scopeId);
    const file = await client.downloadForBot({
      ...reference,
      whatsappJid: actor.whatsappJid,
      scopeId
    });
    return {
      handled: true,
      pluginActions: [{
        type: 'message.sendDocument' as const,
        chatId: ctx.message.chatId,
        file: {
          filename: file.filename,
          mimeType: file.mimeType,
          buffer: file.buffer
        },
        quotedMessageId: ctx.message.id
      }]
    };
  } catch (error) {
    return { handled: true, text: t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
  }
}

async function startUploadFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
  if (!config.enabled) {
    return { handled: true, text: t('official.piwigo-gallery.disabled') };
  }
  if (ctx.managementMode === 'OBSERVE') {
    return { handled: true, text: t('official.piwigo-gallery.observeOnly') };
  }
  const connection = await resolveGalleryConnection(
    runtime.dataStore,
    config,
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    return { handled: true, text: t('official.piwigo-gallery.notConfigured') };
  }
  const actorWids = commandActorWids(ctx);
  const active = await getActiveBatchForActorWids(runtime.dataStore, scopeId, ctx.message.chatId, actorWids);
  if (active && (active.status === 'collecting' || active.status === 'uploading')) {
    return { handled: true, text: t('official.piwigo-gallery.uploadAlreadyActive') };
  }

  try {
    const client = new PiwigoGalleryClient(connection);
    const people = await peopleForPiwigoActor(client, piwigoCandidateWids(ctx), scopeId)
      .catch(() => undefined);
    if (!people) {
      return { handled: true, text: uploadAccountRequiredMessage(t, config) };
    }
    const peopleResult = people.peopleResult;
    if (peopleResult.people.length === 0) {
      return { handled: true, text: uploadAccountRequiredMessage(t, config) };
    }
    const acceptedTypes = await client.acceptedTypes();
    const definition = createGalleryUploadFlowDefinition({ t, people: peopleResult.people });
    registerUploadFlowCompletionHandler(context, definition.flowType, t);
    const flowSessionId = await context.flowEngine.startFlow({
      definition,
      message: ctx.message,
      scopeId
    });
    await saveDraft(runtime.dataStore, {
      flowSessionId,
      flowType: definition.flowType,
      scopeId,
      ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
      ...(ctx.groupWid ? { groupWid: ctx.groupWid } : {}),
      chatId: ctx.message.chatId,
      actorWid: ctx.message.senderWid,
      actorAliases: actorWids,
      piwigoLinkedWid: people.whatsappJid,
      actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
      acceptedExtensions: acceptedTypes.extensions,
      maxFileBytes: Math.min(config.maxFileBytes, acceptedTypes.max_file_size ?? config.maxFileBytes),
      autoFinalizeMinutes: config.autoFinalizeMinutes,
      createdAt: new Date().toISOString()
    });
    return { handled: true, text: t('official.piwigo-gallery.uploadStartedGroup') };
  } catch (error) {
    return { handled: true, text: t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
  }
}

function uploadAccountRequiredMessage(
  t: TranslateFn,
  config: ReturnType<typeof parsePiwigoGalleryConfig>
): string {
  const key = config.accountProfileUrl
    ? 'official.piwigo-gallery.accountRequiredWithProfileUrl'
    : 'official.piwigo-gallery.accountRequired';
  return t(key, {
    accountLabel: config.accountCreationLabel,
    profileUrl: config.accountProfileUrl
  });
}

async function connectionForScope(
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  scopeId: string,
  defaultPiwigoBaseUrl: string,
  defaultPiwigoBotSecret: string,
  actorWid?: string | undefined
) {
  const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, actorWid));
  return resolveGalleryConnection(runtime.dataStore, config, defaultPiwigoBaseUrl, defaultPiwigoBotSecret);
}

function registerUploadFlowCompletionHandler(context: PluginCommandContext, flowType: string, t: CommandContext['t']): void {
  const runtime = requireOfficialCommandRuntime(context);
  const purpose = galleryConfirmPurpose(flowType);
  context.flowEngine.registerPromptHandler(purpose, async (lock, activeTransport) => {
    if (!lock.flowSessionId) {
      return false;
    }
    const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
    if (!snapshot || snapshot.flowType !== flowType || !snapshot.scopeId) {
      return false;
    }
    const draft = await getDraft(runtime.dataStore, snapshot.scopeId, lock.flowSessionId);
    if (!draft) {
      return false;
    }
    if (!galleryFlowConfirmed(snapshot)) {
      await deleteDraft(runtime.dataStore, draft.scopeId, draft.flowSessionId);
      await activeTransport.sendText(draft.chatId, t('official.piwigo-gallery.flowCancelled'));
      return true;
    }
    const answers = galleryFlowAnswers(snapshot);
    if (!answers) {
      await deleteDraft(runtime.dataStore, draft.scopeId, draft.flowSessionId);
      await activeTransport.sendText(draft.chatId, t('official.piwigo-gallery.flowInvalid'));
      return true;
    }
    const now = new Date();
    const autoFinalizeAt = new Date(now.getTime() + draft.autoFinalizeMinutes * 60_000);
    const batch: GalleryUploadBatch = {
      id: makeId('gallery'),
      status: 'collecting',
      scopeId: draft.scopeId,
      ...(draft.groupId ? { groupId: draft.groupId } : {}),
      ...(draft.groupWid ? { groupWid: draft.groupWid } : {}),
      chatId: draft.chatId,
      actorWid: draft.actorWid,
      ...(draft.actorAliases ? { actorAliases: draft.actorAliases } : {}),
      ...(draft.piwigoLinkedWid ? { piwigoLinkedWid: draft.piwigoLinkedWid } : {}),
      actorLabel: draft.actorLabel,
      onde: answers.onde,
      quando: answers.quando,
      withUserIds: answers.withUserIds,
      acceptedExtensions: draft.acceptedExtensions,
      maxFileBytes: draft.maxFileBytes,
      autoFinalizeMinutes: draft.autoFinalizeMinutes,
      files: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      autoFinalizeAt: autoFinalizeAt.toISOString()
    };
    await saveBatch(runtime.dataStore, batch);
    await setActiveBatch(runtime.dataStore, batch);
    await deleteDraft(runtime.dataStore, draft.scopeId, draft.flowSessionId);
    await runtime.enqueuePluginJob({
      jobName: PIWIGO_GALLERY_FINALIZE_JOB,
      scopeId: draft.scopeId,
      ...(draft.groupId ? { groupId: draft.groupId } : {}),
      ...(draft.groupWid ? { groupWid: draft.groupWid } : {}),
      runAt: autoFinalizeAt,
      payload: { batchId: batch.id },
      dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:initial`
    });
    await activeTransport.sendText(draft.chatId, t('official.piwigo-gallery.collectingReady', {
      minutes: String(draft.autoFinalizeMinutes)
    }));
    return true;
  });
}

async function finalizeActiveUpload(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const batch = await getActiveBatchForActorWids(runtime.dataStore, scopeId, ctx.message.chatId, commandActorWids(ctx));
  if (!batch || batch.status !== 'collecting') {
    return { handled: true, text: t('official.piwigo-gallery.noActiveUpload') };
  }
  if (batch.files.filter((file) => file.status === 'staged').length === 0) {
    return { handled: true, text: t('official.piwigo-gallery.noFiles') };
  }
  batch.autoFinalizeAt = new Date().toISOString();
  batch.updatedAt = new Date().toISOString();
  await saveBatch(runtime.dataStore, batch);
  await runtime.enqueuePluginJob({
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    ...(ctx.groupWid ? { groupWid: ctx.groupWid } : {}),
    payload: { batchId: batch.id, forced: true },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:manual:${Date.now()}`
  });
  return { handled: true, text: t('official.piwigo-gallery.finalizeQueued') };
}

async function cancelActiveUpload(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const batch = await getActiveBatchForActorWids(runtime.dataStore, scopeId, ctx.message.chatId, commandActorWids(ctx));
  if (!batch || (batch.status !== 'collecting' && batch.status !== 'uploading')) {
    return { handled: true, text: t('official.piwigo-gallery.noActiveUpload') };
  }
  for (const file of batch.files) {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
  }
  batch.status = 'cancelled';
  batch.updatedAt = new Date().toISOString();
  await saveBatch(runtime.dataStore, batch);
  await clearActiveBatch(runtime.dataStore, batch);
  return { handled: true, text: t('official.piwigo-gallery.cancelled') };
}

function galleryAdminCommand(input: {
  mutation?: CommandMetadata['mutation'] | undefined;
  auditAction: string;
  usage: string;
  descriptionKey: string;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'group_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.configure,
    requiresManagedGroup: true,
    targets: [SCOPE_TARGET],
    mutation: input.mutation ?? 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, input.mutation ?? 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      descriptionKey: input.descriptionKey,
      usage: input.usage
    }
  };
}

function galleryUploadCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'group_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.upload,
    requiresManagedGroup: true,
    targets: [SCOPE_TARGET],
    mutation: 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      descriptionKey: input.descriptionKey,
      usage: input.usage
    }
  };
}

function galleryDownloadCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'group_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.download,
    requiresManagedGroup: true,
    targets: [SCOPE_TARGET],
    mutation: 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      descriptionKey: input.descriptionKey,
      usage: input.usage
    }
  };
}

function galleryAuthCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
}): CommandMetadata {
  return {
    plane: 'system',
    interaction: 'either_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    mutation: 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      descriptionKey: input.descriptionKey,
      usage: input.usage
    }
  };
}

function galleryAssistantMetadata(
  usage: string,
  mutation: CommandMetadata['mutation']
): CommandMetadata['assistant'] {
  return {
    intentTags: usage.replace(/^\//, '').split(/\s+/).filter(Boolean).slice(0, 3),
    executable: true,
    requiresConfirmation: mutation !== 'none'
  };
}

function parseConfigPatch(args: string[]): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator <= 0) {
      return undefined;
    }
    const key = arg.slice(0, separator).trim().toLowerCase();
    const value = arg.slice(separator + 1).trim();
    switch (key) {
      case 'enabled':
      case 'active': {
        const parsed = parseBoolean(value);
        if (parsed === undefined) return undefined;
        patch.enabled = parsed;
        break;
      }
      case 'auto':
      case 'autominutos': {
        const minutes = Number(value);
        if (!Number.isSafeInteger(minutes) || minutes < 1) return undefined;
        patch.autoFinalizeMinutes = minutes;
        break;
      }
      case 'max':
      case 'maxbytes': {
        const bytes = Number(value);
        if (!Number.isSafeInteger(bytes) || bytes < 1) return undefined;
        patch.maxFileBytes = bytes;
        break;
      }
      default:
        return undefined;
    }
  }
  return patch;
}

function parseDownloadReference(args: string[]): {
  imageId?: number | undefined;
  fileId?: string | undefined;
  downloadToken?: string | undefined;
} | undefined {
  const tokens = args.map((arg) => arg.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }
  const joined = tokens.join(' ');
  if (/^https?:\/\//i.test(joined)) {
    const fromUrl = parseDownloadReferenceUrl(joined);
    if (fromUrl) {
      return fromUrl;
    }
  }
  const first = tokens[0] ?? '';
  const [inlineKey, inlineValue] = first.includes('=') ? first.split('=', 2) : ['', ''];
  const kind = (inlineKey || first).toLowerCase().replace(/[-_]/g, '');
  const value = inlineValue || tokens[1] || first;
  switch (kind) {
    case 'image':
    case 'imageid':
    case 'id':
      return imageDownloadReference(value);
    case 'file':
    case 'fileid':
      return value ? { fileId: value } : undefined;
    case 'token':
    case 'downloadtoken':
      return value ? { downloadToken: value } : undefined;
    default:
      return tokens.length === 1 ? imageDownloadReference(first) : undefined;
  }
}

function parseDownloadReferenceUrl(input: string): {
  imageId?: number | undefined;
  fileId?: string | undefined;
  downloadToken?: string | undefined;
} | undefined {
  try {
    const url = new URL(input);
    return imageDownloadReference(url.searchParams.get('image_id') ?? url.searchParams.get('imageId') ?? url.searchParams.get('id') ?? '')
      ?? stringDownloadReference('fileId', url.searchParams.get('file_id') ?? url.searchParams.get('fileId') ?? '')
      ?? stringDownloadReference('downloadToken', url.searchParams.get('download_token') ?? url.searchParams.get('downloadToken') ?? url.searchParams.get('token') ?? '');
  } catch {
    return undefined;
  }
}

function imageDownloadReference(input: string): { imageId: number } | undefined {
  const imageId = Number(input);
  return Number.isSafeInteger(imageId) && imageId > 0 ? { imageId } : undefined;
}

function stringDownloadReference(
  key: 'fileId' | 'downloadToken',
  value: string
): { fileId: string } | { downloadToken: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return key === 'fileId' ? { fileId: trimmed } : { downloadToken: trimmed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
