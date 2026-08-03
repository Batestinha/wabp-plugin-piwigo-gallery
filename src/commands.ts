import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { TranslateFn } from '../../../platform/i18n';
import type { PluginCancellationRegistration, PluginCancellationRequest, PluginCommandContext } from '../../../platform/pluginRuntime/types';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import {
  commandText,
  parseBoolean,
  requireOfficialCommandRuntime,
  requireScopeId
} from '../shared';
import { parsePiwigoGalleryConfig, resolvePiwigoAccountProfileUrl, resolvePiwigoBaseUrl } from './config';
import {
  galleryConfirmPurpose,
  galleryFlowAnswers,
  galleryFlowConfirmed,
  galleryUploadBatchId,
  createGalleryUploadFlowDefinition,
  galleryUploadFlowInitialData,
  PIWIGO_GALLERY_UPLOAD_FLOW_TYPE
} from './flow';
import {
  PIWIGO_GALLERY_FINALIZE_JOB,
  PIWIGO_GALLERY_PERMISSIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import {
  PiwigoApiError,
  PiwigoGalleryClient,
  type PiwigoPeopleResult
} from './piwigoClient';
import {
  cancelBatch,
  createBatch,
  deleteLinkRequest,
  deleteDraft,
  digitsFromPhoneLike,
  getActiveBatchForActorWids,
  getBatch,
  getDraft,
  getLinkRequestForPhoneDigits,
  getLinkRequestForWids,
  requestBatchFinalization,
  resolveGalleryConnection,
  saveDraft,
  type GalleryUploadBatch
} from './store';
import { preparedGalleryDatabase } from './storageRuntime';
import {
  listConfiguredPiwigoGalleryEligibleScopes,
  type ConfiguredPiwigoGalleryScope
} from './eligibility';

const SCOPE_TARGET: CommandTargetSpec = {
  kind: 'scope',
  flag: ['scope', 'scope-id'],
  fallback: 'current_scope'
};

const CHAT_TARGET: CommandTargetSpec = {
  kind: 'group',
  name: 'chat',
  flag: 'chat',
  position: 0
};

const PIWIGO_UPLOAD_SCOPE_MEMBER_ACCESS_PATH = 'access.allowScopeMemberUploads';
const PIWIGO_DOWNLOAD_SCOPE_MEMBER_ACCESS_PATH = 'access.allowScopeMemberDownloads';

export function registerPiwigoGalleryCommands(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const router = context.router;
  const uploadFlowDefinition = createGalleryUploadFlowDefinition({
    t: context.i18n.translator(context.i18n.getDefaultLocale())
  });
  context.flowEngine.register(uploadFlowDefinition);
  registerUploadFlowCompletionHandler(context);

  router.register('gallery', 'status', galleryAdminCommand({
    mutation: 'none',
    auditAction: 'piwigo-gallery.status',
    usage: '/gallery status',
    descriptionKey: 'official.piwigo-gallery.help.gallery',
    topicId: 'manage-gallery',
    exampleKey: 'official.piwigo-gallery.help.status.example'
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
    descriptionKey: 'official.piwigo-gallery.help.gallery',
    topicId: 'manage-gallery',
    exampleKey: 'official.piwigo-gallery.help.configure.example'
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
    descriptionKey: 'official.piwigo-gallery.help.download',
    topicId: 'download-gallery',
    exampleKey: 'official.piwigo-gallery.help.download.example'
  }), async (ctx) => downloadGalleryFile(context, ctx));

  router.register('send', 'gallery', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.start',
    usage: '/send gallery',
    descriptionKey: 'official.piwigo-gallery.help.send',
    topicId: 'upload-gallery',
    exampleKey: 'official.piwigo-gallery.help.send.example',
    privateContinuation: true
  }), async (ctx) => startUploadFlow(context, ctx, uploadFlowDefinition));

  router.register('upload', '*', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.finalize',
    usage: '/upload',
    descriptionKey: 'official.piwigo-gallery.help.upload',
    topicId: 'upload-gallery',
    exampleKey: 'official.piwigo-gallery.help.upload.example'
  }), async (ctx) => finalizeActiveUpload(context, ctx));

  router.register('accept', '*', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.link.accept',
    usage: '/accept',
    descriptionKey: 'official.piwigo-gallery.help.accept',
    topicId: 'link-gallery-account',
    exampleKey: 'official.piwigo-gallery.help.accept.example'
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
    descriptionKey: 'official.piwigo-gallery.help.refuse',
    topicId: 'link-gallery-account',
    exampleKey: 'official.piwigo-gallery.help.refuse.example'
  }), async (ctx) => completeLinkRequest(
    context,
    runtime,
    ctx,
    'deny',
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  ));

  router.register('register', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.register',
    usage: '/register gallery Your Name',
    descriptionKey: 'official.piwigo-gallery.help.register',
    topicId: 'link-gallery-account',
    exampleKey: 'official.piwigo-gallery.help.register.example'
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
      return {
        handled: true,
        text: localizedPiwigoFailure(t, error),
        pluginActions: [piwigoFailureAuditAction('piwigo-gallery.account.register.failed', error, {
          scopeId: scope.scopeId
        })]
      };
    }
  });
}

export function registerPiwigoGalleryCancellations(context: PluginCommandContext): PluginCancellationRegistration[] {
  const runtime = requireOfficialCommandRuntime(context);
  return [
    {
      workflowId: 'gallery-upload-setup',
      cancel: async (input) => {
        const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
        let cancelled = false;
        for (const flow of input.cancelledFlows) {
          if (!flow.scopeId || !flow.flowType.startsWith('official.piwigo-gallery.upload.')) {
            continue;
          }
          const draft = getDraft(db, flow.scopeId, flow.id);
          if (!draft) {
            continue;
          }
          deleteDraft(db, draft.scopeId, draft.flowSessionId);
          cancelled = true;
        }
        return cancelled ? { workflowId: 'gallery-upload-setup', cancelled: true } : undefined;
      }
    },
    {
      workflowId: 'gallery-upload-batch',
      cancel: async (input) => {
        const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
        for (const scopeId of uniquePlainStrings(input.scopeIds)) {
          const batch = getActiveBatchForActorWids(db, scopeId, input.message.chatId, input.actorWids);
          if (!batch || batch.status !== 'collecting') {
            continue;
          }
          if (!await cancelGalleryBatch(context, runtime, batch)) {
            continue;
          }
          const t = await piwigoMessageTranslator(context, input.message, input.actor, scopeId);
          return {
            workflowId: 'gallery-upload-batch',
            cancelled: true,
            text: t('official.piwigo-gallery.cancelled')
          };
        }
        return undefined;
      }
    }
  ];
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
    const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
    const senderWids = linkRequestLookupWids(ctx);
    const request = getLinkRequestForWids(db, senderWids)
      ?? getLinkRequestForPhoneDigits(db, phoneDigitsForWids(senderWids));
    responseT = request?.scopeOptions[0]?.scopeId
      ? await piwigoCommandTranslator(context, ctx, request.scopeOptions[0].scopeId)
      : fallbackT;
    if (!request || new Date(request.expiresAt).getTime() < Date.now()) {
      if (request) {
        deleteLinkRequest(db, request.requestToken);
      }
      return { handled: true, text: responseT('official.piwigo-gallery.requestFailed', { reason: responseT('official.piwigo-gallery.error.invalidOrExpiredLinkRequest') }) };
    }
    if (!linkRequestMatchesSender(request, senderWids)) {
      return { handled: true, text: responseT('official.piwigo-gallery.requestFailed', { reason: responseT('official.piwigo-gallery.error.identityMismatch') }) };
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
    deleteLinkRequest(db, request.requestToken);
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
    return {
      handled: true,
      text: localizedPiwigoFailure(responseT, error),
      pluginActions: [piwigoFailureAuditAction('piwigo-gallery.account.link.complete.failed', error, {
        decision
      })]
    };
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

function piwigoMessageTranslator(
  context: PluginCommandContext,
  _message: PluginCancellationRequest['message'],
  actor: PluginCancellationRequest['actor'],
  scopeId?: string | undefined
): Promise<TranslateFn> {
  return context.i18n.translatorForIdentity(actor.wid, scopeId);
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

function piwigoPrivateFlowDeliveryFallback(ctx: CommandContext, actorWids: string[]): PrivateDeliveryFallback | undefined {
  const groupWid = ctx.groupWid?.trim() || (ctx.message.context === 'group' ? ctx.message.chatId : '');
  if (!groupWid.endsWith('@g.us')) {
    return undefined;
  }
  const mentionWid = piwigoMentionWid(actorWids);
  return mentionWid
    ? {
        chatId: groupWid,
        mentionedWids: [mentionWid],
        ...(ctx.message.context === 'group' ? { quotedMessageId: ctx.message.id } : {})
      }
    : undefined;
}

function piwigoPrivateChatWid(actorWids: string[], preferredWid?: string | undefined): string | undefined {
  const preferred = preferredWid?.trim();
  if (preferred && !preferred.endsWith('@g.us')) {
    return preferred;
  }
  return actorWids.find((wid) => wid.endsWith('@c.us')) ?? actorWids.find((wid) => !wid.endsWith('@g.us'));
}

function piwigoMentionWid(actorWids: string[]): string | undefined {
  return actorWids.find((wid) => wid.endsWith('@c.us')) ?? actorWids.find((wid) => wid.endsWith('@lid')) ?? actorWids[0];
}

async function galleryTargetLabel(context: PluginCommandContext, groupWid: string): Promise<string> {
  const metadata = await context.getGroupMetadataSnapshot?.(groupWid).catch(() => undefined);
  return metadata?.displayName?.trim() || groupWid;
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
): Promise<{ whatsappJid: string; peopleResult: PiwigoPeopleResult } | undefined> {
  for (const whatsappJid of candidateWids) {
    try {
      return {
        whatsappJid,
        peopleResult: await client.people(whatsappJid, scopeId)
      };
    } catch (error) {
      if (!isMissingPiwigoLink(error)) {
        throw error;
      }
    }
  }
  return undefined;
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
    if (!actor) {
      return {
        handled: true,
        text: uploadAccountRequiredMessage(t, config, context.config.PIWIGO_GALLERY_ACCOUNT_PROFILE_URL)
      };
    }
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
    return {
      handled: true,
      text: localizedPiwigoFailure(t, error),
      pluginActions: [piwigoFailureAuditAction('piwigo-gallery.download.failed', error, { scopeId })]
    };
  }
}

async function startUploadFlow(
  context: PluginCommandContext,
  ctx: CommandContext,
  definition: ReturnType<typeof createGalleryUploadFlowDefinition>
) {
  const runtime = requireOfficialCommandRuntime(context);
  const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const targetChatId = ctx.groupWid ?? (ctx.message.context === 'group' ? ctx.message.chatId : '');
  if (!targetChatId.endsWith('@g.us')) {
    return { handled: true, text: t('official.piwigo-gallery.notConfigured') };
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
  const actorWids = commandActorWids(ctx);
  const active = getActiveBatchForActorWids(db, scopeId, targetChatId, actorWids);
  if (active && (active.status === 'collecting' || active.status === 'finalizing')) {
    return { handled: true, text: t('official.piwigo-gallery.uploadAlreadyActive') };
  }

  let stage = 'people';
  let createdFlowSessionId: string | undefined;
  try {
    const client = new PiwigoGalleryClient(connection);
    const people = await peopleForPiwigoActor(client, piwigoCandidateWids(ctx), scopeId);
    if (!people) {
      return { handled: true, text: uploadAccountRequiredMessage(t, config, context.config.PIWIGO_GALLERY_ACCOUNT_PROFILE_URL) };
    }
    const peopleResult = people.peopleResult;
    if (peopleResult.people.length === 0) {
      return { handled: true, text: uploadAccountRequiredMessage(t, config, context.config.PIWIGO_GALLERY_ACCOUNT_PROFILE_URL) };
    }
    stage = 'accepted-types';
    const acceptedTypes = await client.acceptedTypes();
    const privateActorWid = piwigoPrivateChatWid(actorWids, ctx.actor?.wid ?? ctx.message.senderWid) ?? ctx.message.senderWid;
    const privateDeliveryFallback = piwigoPrivateFlowDeliveryFallback(ctx, actorWids);
    stage = 'private-flow';
    const flowStart = await context.flowEngine.startPrivateContinuation({
      definition,
      originMessage: ctx.message,
      recipientWid: privateActorWid,
      scopeId,
      initialData: galleryUploadFlowInitialData({ t, people: peopleResult.people }),
      ...(privateDeliveryFallback ? { privateDeliveryFallback } : {}),
      onSessionCreated: (session) => {
        createdFlowSessionId = session.id;
        saveDraft(db, {
          flowSessionId: session.id,
          flowType: definition.flowType,
          scopeId,
          ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
          groupWid: targetChatId,
          chatId: targetChatId,
          actorWid: ctx.message.senderWid,
          actorAliases: actorWids,
          actorIdentityId: privateActorWid,
          piwigoLinkedWid: people.whatsappJid,
          actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
          acceptedExtensions: acceptedTypes.extensions,
          maxFileBytes: Math.min(config.maxFileBytes, acceptedTypes.max_file_size ?? config.maxFileBytes),
          autoFinalizeMinutes: config.autoFinalizeMinutes,
          createdAt: new Date().toISOString()
        });
      },
      onSessionStartFailed: (session) => {
        deleteDraft(db, scopeId, session.id);
      }
    });
    if (ctx.message.context === 'group') {
      const target = await galleryTargetLabel(context, targetChatId);
      return {
        handled: true,
        text: t(flowStart.privateDeliveryFallback
          ? 'official.piwigo-gallery.uploadStartedInGroupFallback'
          : 'official.piwigo-gallery.uploadStartedPrivate', { target })
      };
    }
    return { handled: true, response: { kind: 'none' as const } };
  } catch (error) {
    if (createdFlowSessionId) {
      deleteDraft(db, scopeId, createdFlowSessionId);
    }
    return {
      handled: true,
      text: t('official.piwigo-gallery.uploadStartFailed'),
      pluginActions: [{
        type: 'audit.record' as const,
        action: 'piwigo-gallery.upload.start.failed',
        metadataJson: { stage, reason: errorMessage(error), targetChatId, scopeId }
      }]
    };
  }
}

function uploadAccountRequiredMessage(
  t: TranslateFn,
  config: ReturnType<typeof parsePiwigoGalleryConfig>,
  defaultAccountProfileUrl?: string | undefined
): string {
  const profileUrl = resolvePiwigoAccountProfileUrl(config, defaultAccountProfileUrl);
  const key = profileUrl
    ? 'official.piwigo-gallery.accountRequiredWithProfileUrl'
    : 'official.piwigo-gallery.accountRequired';
  return t(key, {
    accountLabel: config.accountCreationLabel,
    profileUrl
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

function registerUploadFlowCompletionHandler(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const purpose = galleryConfirmPurpose();
  context.flowEngine.registerPromptHandler(purpose, async (lock, activeTransport) => {
    if (!await context.flowEngine.getLockedPromptLock(lock.flowPromptId)) {
      return false;
    }
    const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
    if (!lock.flowSessionId) {
      return false;
    }
    const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
    if (!snapshot || snapshot.flowType !== PIWIGO_GALLERY_UPLOAD_FLOW_TYPE || !snapshot.scopeId) {
      return false;
    }
    const t = await context.i18n.translatorForIdentity(snapshot.identityId, snapshot.scopeId);
    const batchId = galleryUploadBatchId(lock.flowSessionId);
    const existingBatch = getBatch(db, snapshot.scopeId, batchId);
    const draft = getDraft(db, snapshot.scopeId, lock.flowSessionId);
    if (!draft && !existingBatch) {
      if (!galleryFlowConfirmed(snapshot) || !galleryFlowAnswers(snapshot)) {
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      return false;
    }
    if (!galleryFlowConfirmed(snapshot)) {
      if (draft) {
        await activeTransport.sendText(draft.chatId, t('official.piwigo-gallery.flowCancelled'), {
          idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:cancelled`
        });
        deleteDraft(db, draft.scopeId, draft.flowSessionId);
      }
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    const answers = galleryFlowAnswers(snapshot);
    if (!answers) {
      if (draft) {
        await activeTransport.sendText(draft.chatId, t('official.piwigo-gallery.flowInvalid'), {
          idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:invalid`
        });
        deleteDraft(db, draft.scopeId, draft.flowSessionId);
      }
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    let stored = existingBatch;
    if (!stored) {
      if (!draft) {
        return false;
      }
      const now = new Date();
      const autoFinalizeAt = new Date(now.getTime() + draft.autoFinalizeMinutes * 60_000);
      const batch: GalleryUploadBatch = {
        id: batchId,
        status: 'collecting',
        scopeId: draft.scopeId,
        ...(draft.groupId ? { groupId: draft.groupId } : {}),
        groupWid: draft.groupWid,
        chatId: draft.chatId,
        actorWid: draft.actorWid,
        ...(draft.actorAliases ? { actorAliases: draft.actorAliases } : {}),
        ...(draft.actorIdentityId ? { actorIdentityId: draft.actorIdentityId } : {}),
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
      stored = createBatch(db, batch, { draftFlowSessionId: draft.flowSessionId });
    }
    if (stored.status !== 'collecting') {
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    await enqueueGalleryBatchFinalization(runtime, stored);
    const target = await galleryTargetLabel(context, stored.groupWid);
    if (snapshot.conversationChatId && snapshot.conversationChatId !== stored.chatId) {
      await activeTransport.sendText(
        snapshot.conversationChatId,
        t('official.piwigo-gallery.flow.complete', { target }),
        { idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:private-complete` }
      );
    }
    await activeTransport.sendText(stored.chatId, t('official.piwigo-gallery.collectingReady', {
      minutes: String(stored.autoFinalizeMinutes),
      target,
      expiresAt: stored.autoFinalizeAt
    }), {
      idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:collecting-ready`
    });
    await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }, { recoverLocked: true });
}

function enqueueGalleryBatchFinalization(
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  batch: GalleryUploadBatch
): Promise<void> {
  return runtime.enqueuePluginJob({
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId: batch.scopeId,
    ...(batch.groupId ? { groupId: batch.groupId } : {}),
    groupWid: batch.groupWid,
    runAt: new Date(batch.autoFinalizeAt),
    payload: { batchId: batch.id, deadlineGeneration: batch.deadlineGeneration ?? 1 },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${batch.id}:${batch.deadlineGeneration ?? 1}`
  });
}

async function finalizeActiveUpload(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const batch = getActiveBatchForActorWids(db, scopeId, ctx.message.chatId, commandActorWids(ctx));
  if (!batch || batch.status !== 'collecting') {
    return { handled: true, text: t('official.piwigo-gallery.noActiveUpload') };
  }
  const requestedAt = new Date().toISOString();
  const requested = requestBatchFinalization(db, {
    scopeId,
    batchId: batch.id,
    requestedAt,
    expectedVersion: batch.version
  });
  if (requested.kind === 'no_files') {
    return { handled: true, text: t('official.piwigo-gallery.noFiles') };
  }
  if (requested.kind !== 'queued') {
    return { handled: true, text: t('official.piwigo-gallery.noActiveUpload') };
  }
  await runtime.enqueuePluginJob({
    jobName: PIWIGO_GALLERY_FINALIZE_JOB,
    scopeId,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    ...(ctx.groupWid ? { groupWid: ctx.groupWid } : {}),
    payload: {
      batchId: requested.batch.id,
      deadlineGeneration: requested.batch.deadlineGeneration,
      forced: true
    },
    dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${requested.batch.id}:${requested.batch.deadlineGeneration}:manual`
  });
  return { handled: true, text: t('official.piwigo-gallery.finalizeQueued') };
}

async function cancelGalleryBatch(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  batch: GalleryUploadBatch
): Promise<boolean> {
  if (batch.status !== 'collecting') {
    return false;
  }
  const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
  const result = cancelBatch(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    cancelledAt: new Date().toISOString(),
    expectedVersion: batch.version
  });
  if (result.kind !== 'cancelled') {
    return false;
  }
  for (const file of result.batch.files) {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
  }
  return true;
}

function uniquePlainStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function galleryAdminCommand(input: {
  mutation?: CommandMetadata['mutation'] | undefined;
  auditAction: string;
  usage: string;
  descriptionKey: string;
  topicId: GalleryHelpTopic;
  exampleKey: string;
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
      featureId: 'gallery',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      exampleKeys: [input.exampleKey],
      keywords: ['gallery', 'piwigo', input.topicId]
    }
  };
}

function galleryUploadCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
  topicId: GalleryHelpTopic;
  exampleKey: string;
  privateContinuation?: boolean | undefined;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: input.privateContinuation ? 'either_same_chat' : 'group_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.upload,
    allowCurrentManagedGroupMemberConfigPath: PIWIGO_UPLOAD_SCOPE_MEMBER_ACCESS_PATH,
    requiresManagedGroup: true,
    ...(input.privateContinuation
      ? {
          privateManagedTarget: {
            mode: 'infer_group_or_community',
            explicitTargetName: 'chat',
            explicitArgPosition: 0,
            collapseCommunities: false,
            qualifyWithCommunity: true
          },
          targets: [CHAT_TARGET, SCOPE_TARGET]
        }
      : { targets: [SCOPE_TARGET] }),
    mutation: 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      featureId: 'gallery',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      exampleKeys: [input.exampleKey],
      keywords: ['gallery', 'piwigo', input.topicId]
    }
  };
}

function galleryDownloadCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
  topicId: GalleryHelpTopic;
  exampleKey: string;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'group_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.download,
    allowCurrentManagedGroupMemberConfigPath: PIWIGO_DOWNLOAD_SCOPE_MEMBER_ACCESS_PATH,
    requiresManagedGroup: true,
    targets: [SCOPE_TARGET],
    mutation: 'durable',
    auditAction: input.auditAction,
    assistant: galleryAssistantMetadata(input.usage, 'durable'),
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      featureId: 'gallery',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      exampleKeys: [input.exampleKey],
      keywords: ['gallery', 'piwigo', input.topicId]
    }
  };
}

function galleryAuthCommand(input: {
  auditAction: string;
  usage: string;
  descriptionKey: string;
  topicId: GalleryHelpTopic;
  exampleKey: string;
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
      featureId: 'gallery',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      exampleKeys: [input.exampleKey],
      keywords: ['gallery', 'piwigo', input.topicId]
    }
  };
}

type GalleryHelpTopic = 'manage-gallery' | 'upload-gallery' | 'download-gallery' | 'link-gallery-account';

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

function isMissingPiwigoLink(error: unknown): boolean {
  return error instanceof PiwigoApiError &&
    error.method === 'wabp.piwigo.media.people' &&
    error.piwigoCode === 404;
}

function localizedPiwigoFailure(t: TranslateFn, error: unknown): string {
  const reasonKey = error instanceof PiwigoApiError &&
    error.piwigoCode !== undefined &&
    error.piwigoCode >= 400 &&
    error.piwigoCode < 500
    ? 'official.piwigo-gallery.error.requestRejected'
    : 'official.piwigo-gallery.error.serviceUnavailable';
  return t('official.piwigo-gallery.requestFailed', { reason: t(reasonKey) });
}

function piwigoFailureAuditAction(
  action: string,
  error: unknown,
  metadataJson: Record<string, unknown> = {}
) {
  return {
    type: 'audit.record' as const,
    action,
    metadataJson: {
      ...metadataJson,
      reason: errorMessage(error),
      ...(error instanceof PiwigoApiError
        ? {
            method: error.method,
            httpStatus: error.httpStatus,
            piwigoCode: error.piwigoCode
          }
        : {})
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
