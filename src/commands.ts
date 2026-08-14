import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { TranslateFn } from '../../../platform/i18n';
import { logger } from '../../../platform/logging/logger';
import type { PluginCancellationRegistration, PluginCancellationRequest, PluginCommandContext } from '../../../platform/pluginRuntime/types';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import type { MessageActor } from '../../../platform/identity/messageActor';
import {
  EVENT_ALBUM_SOURCE_LIST_METHOD,
  EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
  EVENT_ALBUM_SOURCE_SERVICE_ID,
  type EventAlbumSource,
  type EventAlbumSourceListOutput,
  type EventAlbumSourceResolveOutput
} from '../community-events/serviceApi';
import { EVENTS_PLUGIN_ID } from '../community-events/manifest';
import {
  commandText,
  parseBoolean,
  requireOfficialCommandRuntime,
  requireScopeId
} from '../shared';
import {
  parsePiwigoGalleryConfig,
  resolvePiwigoUploadMaxBytes,
  resolvePiwigoAccountProfileUrl,
  resolvePiwigoBaseUrl,
  type GalleryConnection,
  type PiwigoGalleryConfig
} from './config';
import {
  galleryConfirmPurpose,
  galleryFlowAnswers,
  galleryFlowConfirmed,
  galleryFlowTargetLabel,
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
  supportsPiwigoEventAlbumSource,
  type PiwigoPeopleResult
} from './piwigoClient';
import {
  cancelBatch,
  createBatch,
  deleteDraft,
  getActiveBatch,
  getActiveBatchAcrossScopes,
  getBatch,
  getDraft,
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

const PIWIGO_UPLOAD_SCOPE_MEMBER_ACCESS_PATH = 'access.allowScopeMemberUploads';

export interface GalleryUploadTarget {
  scopeId: string;
  groupId?: string | undefined;
  /** Physical managed group retained only as scope/authorization provenance. */
  groupWid: string;
  managementMode: 'OBSERVE' | 'ASSIST' | 'MANAGE';
  label: string;
  config: PiwigoGalleryConfig;
  connection: GalleryConnection;
  actor: {
    whatsappJid: string;
    peopleResult: PiwigoPeopleResult;
  };
}

type GalleryUploadTargetResolution =
  | { kind: 'resolved'; target: GalleryUploadTarget; t: TranslateFn }
  | { kind: 'reply'; text: string };

export type PrivateGalleryScopeSelection =
  | { kind: 'unauthorized' }
  | { kind: 'unlinked'; candidate: ConfiguredPiwigoGalleryScope }
  | { kind: 'multiple'; candidates: ConfiguredPiwigoGalleryScope[] }
  | {
      kind: 'resolved';
      candidate: ConfiguredPiwigoGalleryScope;
      actor: GalleryUploadTarget['actor'];
    };

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
    const actor = piwigoCommandActor(ctx);
    if (!actor) {
      throw new Error('Authoritative actor identity is unavailable.');
    }
    const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, actor.identityId));
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
    const actor = piwigoCommandActor(ctx);
    if (!actor) {
      throw new Error('Authoritative actor identity is unavailable.');
    }
    const args = ctx.remainingArgs ?? ctx.command.args;
    if (args.length === 0) {
      return { handled: true, text: t('official.piwigo-gallery.configUsage') };
    }
    const patch = parseConfigPatch(args);
    if (!patch) {
      return { handled: true, text: t('official.piwigo-gallery.configUsage') };
    }
    const current = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, actor.identityId));
    const next = parsePiwigoGalleryConfig({ ...current, ...patch });
    await runtime.setConfig(scopeId, next);
    return { handled: true, text: t('official.piwigo-gallery.configUpdated') };
  });

  router.register('gallery', 'upload', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.route',
    usage: '/gallery upload',
    descriptionKey: 'official.piwigo-gallery.help.upload',
    topicId: 'upload-gallery',
    exampleKey: 'official.piwigo-gallery.help.upload.example'
  }), async (ctx) => routeGalleryUpload(context, ctx, uploadFlowDefinition));

  router.register('gallery', 'signup', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.register',
    usage: '/gallery signup Your Name',
    descriptionKey: 'official.piwigo-gallery.help.register',
    topicId: 'link-gallery-account',
    exampleKey: 'official.piwigo-gallery.help.register.example'
  }), async (ctx) => {
    const fallbackT = await piwigoCommandTranslator(context, ctx);
    const actor = piwigoCommandActor(ctx);
    if (!actor) {
      const error = new Error('Authoritative actor identity is unavailable.');
      return {
        handled: true,
        text: localizedPiwigoFailure(fallbackT, error),
        pluginActions: [piwigoFailureAuditAction('piwigo-gallery.account.register.failed', error, {
          stage: 'actor-identity'
        })]
      };
    }
    const username = commandText(ctx) || ctx.message.senderDisplayName || '';
    if (!username.trim()) {
      return { handled: true, text: fallbackT('official.piwigo-gallery.registerUsage') };
    }
    const scopes = await configuredPiwigoScopesForCommand(actor, {
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
      const result = await new PiwigoGalleryClient(scope.connection).registerAccount(
        username,
        actor.piwigoAccountWid,
        scope.scopeId
      );
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
        const actor = piwigoCommandActor(input.actor);
        if (!actor) {
          return undefined;
        }
        const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
        const privateBatch = input.message.context === 'private'
          ? getActiveBatchAcrossScopes(db, input.message.chatId, actor.identityId)
          : undefined;
        const batches = privateBatch
          ? [privateBatch]
          : uniquePlainStrings(input.scopeIds).flatMap((scopeId) => {
              const batch = getActiveBatch(db, scopeId, input.message.chatId, actor.identityId);
              return batch ? [batch] : [];
            });
        for (const batch of batches) {
          if (!batch || batch.status !== 'collecting') {
            continue;
          }
          if (
            input.message.context === 'private'
            && !await galleryBatchPermissionAllowed(context, batch, actor.identityId)
          ) {
            continue;
          }
          if (!await cancelGalleryBatch(context, runtime, batch)) {
            continue;
          }
          const t = await piwigoMessageTranslator(context, input.message, input.actor, batch.scopeId);
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

async function piwigoCommandTranslator(
  context: PluginCommandContext,
  ctx: CommandContext,
  scopeId?: string | undefined
): Promise<TranslateFn> {
  const actor = piwigoCommandActor(ctx);
  if (!actor) {
    throw new Error('Authoritative actor identity is unavailable for gallery translation.');
  }
  const scoped = await context.i18n.translatorForIdentity(actor.identityId, scopeId);
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
  const identityId = actor.identityAddress?.identityId?.trim();
  if (!identityId) {
    throw new Error('Authoritative actor identity is unavailable for gallery translation.');
  }
  return context.i18n.translatorForIdentity(identityId, scopeId);
}

function piwigoPrivateFlowDeliveryFallback(
  ctx: CommandContext,
  actor: PiwigoCommandActor
): PrivateDeliveryFallback | undefined {
  if (ctx.message.context !== 'group') {
    return undefined;
  }
  const groupWid = ctx.groupWid?.trim() || ctx.message.chatId;
  if (!groupWid.endsWith('@g.us')) {
    return undefined;
  }
  return actor.mentionWid
    ? {
        chatId: groupWid,
        mentionedWids: [actor.mentionWid],
        ...(ctx.message.context === 'group' ? { quotedMessageId: ctx.message.id } : {})
      }
    : undefined;
}

interface PiwigoCommandActor {
  identityId: string;
  canonicalWid: string;
  deliveryChatId: string;
  mentionWid: string;
  piwigoAccountWid: string;
}

function piwigoCommandActor(actor: MessageActor): PiwigoCommandActor | undefined;
function piwigoCommandActor(ctx: CommandContext): PiwigoCommandActor | undefined;
function piwigoCommandActor(
  input: MessageActor | CommandContext
): PiwigoCommandActor | undefined {
  const actor = 'message' in input ? input.actor : input;
  if (!actor?.identityAddress) {
    return undefined;
  }
  const identityId = actor.identityAddress.identityId?.trim() ?? '';
  const canonicalWid = actor.identityAddress.canonicalWid.trim();
  const deliveryChatId = actor.identityAddress.deliveryChatId.trim();
  const piwigoAccountWid = actor.identityAddress.addressBookWid.trim();
  if (!identityId || !canonicalWid || !deliveryChatId || !piwigoAccountWid) {
    return undefined;
  }
  return {
    identityId,
    canonicalWid,
    deliveryChatId,
    mentionWid: actor.identityAddress.mentionWid.trim(),
    piwigoAccountWid
  };
}

async function galleryTargetLabel(context: PluginCommandContext, groupWid: string): Promise<string> {
  const metadata = await context.getGroupMetadataSnapshot?.(groupWid).catch(() => undefined);
  return metadata?.displayName?.trim() || groupWid;
}

async function peopleForPiwigoActor(
  client: PiwigoGalleryClient,
  piwigoAccountWid: string,
  scopeId: string
): Promise<{ whatsappJid: string; peopleResult: PiwigoPeopleResult } | undefined> {
  try {
    return {
      whatsappJid: piwigoAccountWid,
      peopleResult: await client.people(piwigoAccountWid, scopeId)
    };
  } catch (error) {
    if (!isMissingPiwigoLink(error)) {
      throw error;
    }
    return undefined;
  }
}

async function configuredPiwigoScopesForCommand(
  actor: PiwigoCommandActor,
  input: {
    defaultPiwigoBaseUrl?: string | undefined;
    defaultPiwigoBotSecret?: string | undefined;
  }
): Promise<ConfiguredPiwigoGalleryScope[]> {
  return listConfiguredPiwigoGalleryEligibleScopes(actor.identityId, input);
}

async function routeGalleryUpload(
  context: PluginCommandContext,
  ctx: CommandContext,
  definition: ReturnType<typeof createGalleryUploadFlowDefinition>
) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = piwigoCommandActor(ctx);
  if (!actor) {
    return galleryUploadStateFailure(
      context,
      ctx,
      new Error('Authoritative actor identity is unavailable.'),
      'actor-identity'
    );
  }
  let batch: GalleryUploadBatch | undefined;
  try {
    const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
    batch = getActiveBatchAcrossScopes(db, ctx.message.chatId, actor.identityId);
  } catch (error) {
    return galleryUploadStateFailure(context, ctx, error, 'active-batch-lookup');
  }
  if (!batch) {
    return startUploadFlow(context, ctx, definition, actor);
  }

  let scopeMatches: boolean;
  try {
    scopeMatches = await galleryUploadCommandMatchesBatch(context, ctx, batch, actor);
  } catch (error) {
    return galleryUploadStateFailure(context, ctx, error, 'scope-match', batch.scopeId);
  }
  if (!scopeMatches) {
    return galleryUploadScopeMismatch(context, ctx, batch);
  }
  return handleActiveGalleryUpload(context, ctx, batch, actor.identityId);
}

async function galleryUploadCommandMatchesBatch(
  context: PluginCommandContext,
  ctx: CommandContext,
  batch: GalleryUploadBatch,
  actor: PiwigoCommandActor
): Promise<boolean> {
  if (ctx.message.context === 'group') {
    const requestedScopeId = ctx.scopeId ?? ctx.targets?.scope?.id;
    const requestedGroupWid = ctx.groupWid ?? ctx.message.chatId;
    return requestedScopeId === batch.scopeId && requestedGroupWid === batch.groupWid;
  }

  const explicitScope = ctx.targets?.scope?.source === 'flag'
    ? ctx.targets.scope.raw?.trim()
    : undefined;
  if (!explicitScope || normalizeGalleryTarget(explicitScope) === normalizeGalleryTarget(batch.scopeId)) {
    return true;
  }
  const configured = await configuredPiwigoScopesForCommand(actor, {
    defaultPiwigoBaseUrl: context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    defaultPiwigoBotSecret: context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  });
  return configured.some((candidate) =>
    candidate.scopeId === batch.scopeId && galleryScopeMatches(candidate, explicitScope)
  );
}

async function galleryUploadScopeMismatch(
  context: PluginCommandContext,
  ctx: CommandContext,
  batch: GalleryUploadBatch
) {
  const t = await piwigoCommandTranslator(context, ctx, batch.scopeId);
  return {
    handled: true,
    text: t('official.piwigo-gallery.uploadScopeMismatch'),
    pluginActions: [{
      type: 'audit.record' as const,
      action: 'piwigo-gallery.upload.scope-mismatch',
      metadataJson: {
        activeScopeId: batch.scopeId,
        requestedScopeId: ctx.scopeId ?? ctx.targets?.scope?.id ?? '',
        collectionChatId: ctx.message.chatId,
        batchId: batch.id
      }
    }]
  };
}

async function galleryUploadStateFailure(
  context: PluginCommandContext,
  ctx: CommandContext,
  error: unknown,
  stage: string,
  scopeId?: string | undefined
) {
  const effectiveScopeId = scopeId ?? ctx.scopeId;
  const t = await piwigoCommandTranslator(context, ctx, effectiveScopeId);
  return {
    handled: true,
    text: t('official.piwigo-gallery.uploadStateUnavailable'),
    pluginActions: [{
      type: 'audit.record' as const,
      action: 'piwigo-gallery.upload.state-lookup-failed',
      metadataJson: {
        stage,
        reason: errorMessage(error),
        collectionChatId: ctx.message.chatId,
        ...(effectiveScopeId ? { scopeId: effectiveScopeId } : {})
      }
    }]
  };
}

async function startUploadFlow(
  context: PluginCommandContext,
  ctx: CommandContext,
  definition: ReturnType<typeof createGalleryUploadFlowDefinition>,
  actor: PiwigoCommandActor
) {
  const runtime = requireOfficialCommandRuntime(context);
  let resolution: GalleryUploadTargetResolution;
  try {
    const hasResolvedManagedTarget = Boolean(ctx.scopeId && ctx.groupWid?.endsWith('@g.us'));
    resolution = ctx.message.context === 'private' && !hasResolvedManagedTarget
      ? await resolvePrivateGalleryUploadTarget(context, ctx, actor)
      : await resolveGroupGalleryUploadTarget(context, ctx, actor);
  } catch (error) {
    const t = await piwigoCommandTranslator(context, ctx, ctx.scopeId);
    return {
      handled: true,
      text: t('official.piwigo-gallery.uploadStartFailed'),
      pluginActions: [{
        type: 'audit.record' as const,
        action: 'piwigo-gallery.upload.start.failed',
        metadataJson: {
          stage: 'target-resolution',
          reason: errorMessage(error),
          collectionChatId: ctx.message.chatId,
          ...(ctx.scopeId ? { scopeId: ctx.scopeId } : {})
        }
      }]
    };
  }
  if (resolution.kind === 'reply') {
    return { handled: true, text: resolution.text };
  }
  const { target, t } = resolution;
  const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
  const collectionChatId = ctx.message.context === 'private' ? ctx.message.chatId : target.groupWid;
  let active: GalleryUploadBatch | undefined;
  try {
    active = getActiveBatchAcrossScopes(db, collectionChatId, actor.identityId);
  } catch (error) {
    return galleryUploadStateFailure(context, ctx, error, 'pre-flow-active-batch-lookup', target.scopeId);
  }
  if (active) {
    if (active.scopeId !== target.scopeId || active.groupWid !== target.groupWid) {
      return galleryUploadScopeMismatch(context, ctx, active);
    }
    return handleActiveGalleryUpload(context, ctx, active, actor.identityId);
  }

  let stage = 'people';
  let createdFlowSessionId: string | undefined;
  try {
    const client = new PiwigoGalleryClient(target.connection);
    stage = 'accepted-types';
    const [acceptedTypes, eventCandidates] = await Promise.all([
      client.acceptedTypes(),
      galleryEventCandidates(context, client, target, ctx)
    ]);
    const privateActorWid = actor.deliveryChatId;
    const privateDeliveryFallback = piwigoPrivateFlowDeliveryFallback(ctx, actor);
    stage = 'private-flow';
    const flowStart = await context.flowEngine.startPrivateContinuation({
      definition,
      initialPromptTranslator: t,
      originMessage: ctx.message,
      recipientWid: privateActorWid,
      scopeId: target.scopeId,
      initialData: galleryUploadFlowInitialData({
        t,
        people: target.actor.peopleResult.people,
        eventCandidates,
        targetLabel: target.label
      }),
      startStepId: eventCandidates.length > 0 ? 'source' : 'onde',
      ...(privateDeliveryFallback ? { privateDeliveryFallback } : {}),
      onSessionCreated: (session) => {
        createdFlowSessionId = session.id;
        saveDraft(db, {
          flowSessionId: session.id,
          flowType: definition.flowType,
          scopeId: target.scopeId,
          ...(target.groupId ? { groupId: target.groupId } : {}),
          groupWid: target.groupWid,
          chatId: target.groupWid,
          collectionChatId,
          actorWid: actor.canonicalWid,
          actorIdentityId: actor.identityId,
          piwigoLinkedWid: target.actor.whatsappJid,
          actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
          acceptedExtensions: acceptedTypes.extensions,
          maxFileBytes: resolvePiwigoUploadMaxBytes(
            target.config.maxFileBytes,
            acceptedTypes.max_file_size
          ),
          autoFinalizeMinutes: target.config.autoFinalizeMinutes,
          createdAt: new Date().toISOString()
        });
      },
      onSessionStartFailed: (session) => {
        deleteDraft(db, target.scopeId, session.id);
      }
    });
    if (ctx.message.context === 'group') {
      return {
        handled: true,
        text: t(flowStart.privateDeliveryFallback
          ? 'official.piwigo-gallery.uploadStartedInGroupFallback'
          : 'official.piwigo-gallery.uploadStartedPrivate', { target: target.label })
      };
    }
    return { handled: true, response: { kind: 'none' as const } };
  } catch (error) {
    if (createdFlowSessionId) {
      deleteDraft(db, target.scopeId, createdFlowSessionId);
    }
    return {
      handled: true,
      text: t('official.piwigo-gallery.uploadStartFailed'),
      pluginActions: [{
        type: 'audit.record' as const,
        action: 'piwigo-gallery.upload.start.failed',
        metadataJson: {
          stage,
          reason: errorMessage(error),
          collectionChatId,
          groupWid: target.groupWid,
          scopeId: target.scopeId
        }
      }]
    };
  }
}

async function resolveGroupGalleryUploadTarget(
  context: PluginCommandContext,
  ctx: CommandContext,
  commandActor: PiwigoCommandActor
): Promise<GalleryUploadTargetResolution> {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const t = await piwigoCommandTranslator(context, ctx, scopeId);
  const groupWid = ctx.groupWid ?? ctx.message.chatId;
  if (!groupWid.endsWith('@g.us')) {
    return { kind: 'reply', text: t('official.piwigo-gallery.notConfigured') };
  }
  const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, commandActor.identityId));
  if (!config.enabled) {
    return { kind: 'reply', text: t('official.piwigo-gallery.disabled') };
  }
  if (ctx.managementMode === 'OBSERVE') {
    return { kind: 'reply', text: t('official.piwigo-gallery.observeOnly') };
  }
  const connection = await resolveGalleryConnection(
    runtime.dataStore,
    config,
    context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    return { kind: 'reply', text: t('official.piwigo-gallery.notConfigured') };
  }
  const actor = await peopleForPiwigoActor(
    new PiwigoGalleryClient(connection),
    commandActor.piwigoAccountWid,
    scopeId
  );
  if (!actor || actor.peopleResult.people.length === 0) {
    return {
      kind: 'reply',
      text: uploadAccountRequiredMessage(t, config, context.config.PIWIGO_GALLERY_ACCOUNT_PROFILE_URL)
    };
  }
  return {
    kind: 'resolved',
    t,
    target: {
      scopeId,
      ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
      groupWid,
      managementMode: ctx.managementMode ?? 'MANAGE',
      label: await galleryTargetLabel(context, groupWid),
      config,
      connection,
      actor
    }
  };
}

async function resolvePrivateGalleryUploadTarget(
  context: PluginCommandContext,
  ctx: CommandContext,
  actor: PiwigoCommandActor
): Promise<GalleryUploadTargetResolution> {
  const fallbackT = await piwigoCommandTranslator(context, ctx);
  const configured = await configuredPiwigoScopesForCommand(actor, {
    defaultPiwigoBaseUrl: context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    defaultPiwigoBotSecret: context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  });
  if (configured.length === 0) {
    return { kind: 'reply', text: fallbackT('official.piwigo-gallery.notConfigured') };
  }

  const explicitScope = ctx.targets?.scope?.source === 'flag'
    ? ctx.targets.scope.raw?.trim()
    : undefined;
  const eligible = explicitScope
    ? configured.filter((candidate) => galleryScopeMatches(candidate, explicitScope))
    : configured;
  if (eligible.length === 0) {
    return { kind: 'reply', text: fallbackT('official.piwigo-gallery.notConfigured') };
  }

  const selection = await selectLinkedPrivateGalleryScope(eligible, {
    authorize: (candidate) => galleryUploadScopeAuthorized(context, actor, candidate),
    people: (candidate) => peopleForPiwigoActor(
      new PiwigoGalleryClient(candidate.connection),
      actor.piwigoAccountWid,
      candidate.scopeId
    )
  });
  if (selection.kind === 'unauthorized') {
    return { kind: 'reply', text: ctx.t('core.router.notAuthorized') };
  }
  if (selection.kind === 'unlinked') {
    const t = await piwigoCommandTranslator(context, ctx, selection.candidate.scopeId);
    return {
      kind: 'reply',
      text: uploadAccountRequiredMessage(
        t,
        selection.candidate.config,
        context.config.PIWIGO_GALLERY_ACCOUNT_PROFILE_URL
      )
    };
  }
  if (selection.kind === 'multiple') {
    const t = await piwigoCommandTranslator(context, ctx, selection.candidates[0]?.scopeId);
    return {
      kind: 'reply',
      text: t('official.piwigo-gallery.multipleLinkedGalleries', {
        choices: formatGalleryScopeChoices(selection.candidates)
      })
    };
  }
  const candidate = selection.candidate;
  const target: GalleryUploadTarget = {
    scopeId: candidate.scopeId,
    groupId: candidate.groupId,
    groupWid: candidate.groupWid,
    managementMode: candidate.managementMode ?? 'MANAGE',
    label: candidate.scopeLabel?.trim() || candidate.label,
    config: candidate.config,
    connection: candidate.connection,
    actor: selection.actor
  };
  return {
    kind: 'resolved',
    target,
    t: await piwigoCommandTranslator(context, ctx, target.scopeId)
  };
}

export async function selectLinkedPrivateGalleryScope(
  candidates: ConfiguredPiwigoGalleryScope[],
  input: {
    authorize(candidate: ConfiguredPiwigoGalleryScope): Promise<boolean>;
    people(candidate: ConfiguredPiwigoGalleryScope): Promise<GalleryUploadTarget['actor'] | undefined>;
  }
): Promise<PrivateGalleryScopeSelection> {
  const linked: Array<{
    candidate: ConfiguredPiwigoGalleryScope;
    actor: GalleryUploadTarget['actor'];
  }> = [];
  let firstAuthorized: ConfiguredPiwigoGalleryScope | undefined;
  for (const scopeCandidates of configuredScopesByScopeId(candidates)) {
    let candidate: ConfiguredPiwigoGalleryScope | undefined;
    for (const value of scopeCandidates) {
      if (value.managementMode === 'OBSERVE' || !await input.authorize(value)) {
        continue;
      }
      candidate = value;
      break;
    }
    if (!candidate) {
      continue;
    }
    firstAuthorized ??= candidate;
    const actor = await input.people(candidate);
    if (!actor || actor.peopleResult.people.length === 0) {
      continue;
    }
    linked.push({ candidate, actor });
  }
  if (linked.length === 1) {
    return { kind: 'resolved', ...linked[0]! };
  }
  if (linked.length > 1) {
    return { kind: 'multiple', candidates: linked.map((value) => value.candidate) };
  }
  return firstAuthorized
    ? { kind: 'unlinked', candidate: firstAuthorized }
    : { kind: 'unauthorized' };
}

function configuredScopesByScopeId(
  candidates: ConfiguredPiwigoGalleryScope[]
): ConfiguredPiwigoGalleryScope[][] {
  const byScope = new Map<string, ConfiguredPiwigoGalleryScope[]>();
  for (const candidate of candidates) {
    const values = byScope.get(candidate.scopeId) ?? [];
    values.push(candidate);
    byScope.set(candidate.scopeId, values);
  }
  return [...byScope.values()].map((values) => values.sort((left, right) =>
    managementModeRank(right.managementMode) - managementModeRank(left.managementMode)
    || left.label.localeCompare(right.label)
    || left.groupWid.localeCompare(right.groupWid)
  ));
}

async function galleryUploadScopeAuthorized(
  context: PluginCommandContext,
  actor: PiwigoCommandActor,
  candidate: ConfiguredPiwigoGalleryScope
): Promise<boolean> {
  if (!context.explainPermission) {
    return false;
  }
  const decision = await context.explainPermission({
    actorIdentityId: actor.identityId,
    action: PIWIGO_GALLERY_PERMISSIONS.upload,
    scopeId: candidate.scopeId,
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    groupId: candidate.groupId,
    groupWid: candidate.groupWid,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    allowCurrentManagedGroupMember: candidate.config.access.allowScopeMemberUploads
  });
  return decision.allowed;
}

function galleryScopeMatches(candidate: ConfiguredPiwigoGalleryScope, input: string): boolean {
  const normalized = normalizeGalleryTarget(input);
  return [candidate.scopeId, candidate.scopeLabel, candidate.label]
    .some((value) => value && normalizeGalleryTarget(value) === normalized);
}

function normalizeGalleryTarget(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function formatGalleryScopeChoices(candidates: ConfiguredPiwigoGalleryScope[]): string {
  return [...candidates]
    .sort((left, right) =>
      (left.scopeLabel ?? left.label).localeCompare(right.scopeLabel ?? right.label)
      || left.scopeId.localeCompare(right.scopeId)
    )
    .map((candidate) => `• ${candidate.scopeLabel?.trim() || candidate.label} — ${candidate.scopeId}`)
    .join('\n');
}

function managementModeRank(mode: ConfiguredPiwigoGalleryScope['managementMode']): number {
  return mode === 'MANAGE' ? 3 : mode === 'ASSIST' ? 2 : 1;
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
      if (galleryFlowConfirmed(snapshot) && galleryFlowAnswers(snapshot)) {
        await activeTransport.sendText(
          snapshot.conversationChatId ?? snapshot.chatId,
          t('official.piwigo-gallery.flowInvalid'), {
            idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:missing-identity-state`
          }
        );
      }
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    if (!galleryFlowConfirmed(snapshot)) {
      if (draft) {
        await activeTransport.sendText(
          draft.collectionChatId,
          t('official.piwigo-gallery.flowCancelled'), {
          idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:cancelled`
          }
        );
        deleteDraft(db, draft.scopeId, draft.flowSessionId);
      }
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    const answers = galleryFlowAnswers(snapshot);
    if (!answers) {
      if (draft) {
        await activeTransport.sendText(
          draft.collectionChatId,
          t('official.piwigo-gallery.flowInvalid'), {
          idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:invalid`
          }
        );
        deleteDraft(db, draft.scopeId, draft.flowSessionId);
      }
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    if (!existingBatch && answers.albumSource.kind === 'community-event') {
      if (!draft) {
        return false;
      }
      const validation = await validateGalleryEventSource(context, {
        scopeId: snapshot.scopeId,
        actorIdentityId: draft.actorIdentityId,
        actorWid: draft.actorWid,
        groupId: draft.groupId,
        groupWid: draft.groupWid,
        source: answers.albumSource
      });
      if (validation !== 'valid') {
        if (draft) {
          await activeTransport.sendText(
            draft.collectionChatId,
            t(validation === 'changed'
              ? 'official.piwigo-gallery.flow.eventChanged'
              : 'official.piwigo-gallery.flow.eventUnavailable'),
            { idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:event-${validation}` }
          );
          deleteDraft(db, draft.scopeId, draft.flowSessionId);
        }
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
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
        collectionChatId: draft.collectionChatId,
        actorWid: draft.actorWid,
        actorIdentityId: draft.actorIdentityId,
        ...(draft.piwigoLinkedWid ? { piwigoLinkedWid: draft.piwigoLinkedWid } : {}),
        actorLabel: draft.actorLabel,
        onde: answers.onde,
        quando: answers.quando,
        withUserIds: answers.withUserIds,
        albumSource: answers.albumSource,
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
    const target = galleryFlowTargetLabel(snapshot) ?? await galleryTargetLabel(context, stored.groupWid);
    const collectionChatId = stored.collectionChatId;
    if (snapshot.conversationChatId && snapshot.conversationChatId !== collectionChatId) {
      await activeTransport.sendText(
        snapshot.conversationChatId,
        t('official.piwigo-gallery.collectingReadyElsewhere', {
          minutes: String(stored.autoFinalizeMinutes),
          target
        }),
        { idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:collection-handoff` }
      );
    }
    await activeTransport.sendText(collectionChatId, t('official.piwigo-gallery.collectingReady', {
      minutes: String(stored.autoFinalizeMinutes),
      target
    }), {
      idempotencyKey: `piwigo-gallery:flow:${lock.flowSessionId}:collecting-ready`
    });
    await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }, { recoverLocked: true });
}

async function galleryEventCandidates(
  context: PluginCommandContext,
  client: PiwigoGalleryClient,
  target: GalleryUploadTarget,
  ctx: CommandContext
): Promise<EventAlbumSource[]> {
  if (!context.services || !context.catalog) {
    return [];
  }
  const actorIdentityId = piwigoCommandActor(ctx)?.identityId;
  if (!actorIdentityId) {
    return [];
  }
  try {
    if (!await context.catalog.enabledFor(EVENTS_PLUGIN_ID, target.scopeId)) {
      return [];
    }
    const status = await client.status();
    if (!supportsPiwigoEventAlbumSource(status)) {
      return [];
    }
    const output = await context.services.call<EventAlbumSourceListOutput>({
      serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
      method: EVENT_ALBUM_SOURCE_LIST_METHOD,
      scopeId: target.scopeId,
      actorIdentityId,
      ...(target.groupId ? { groupId: target.groupId } : {}),
      groupWid: target.groupWid,
      managementMode: target.managementMode,
      input: { referenceTime: new Date().toISOString() }
    });
    return output.candidates;
  } catch (error) {
    logger.warn({
      error,
      scopeId: target.scopeId,
      actorWid: ctx.message.senderWid
    }, 'Piwigo event album sources are unavailable; continuing with manual album setup');
    return [];
  }
}

async function validateGalleryEventSource(
  context: PluginCommandContext,
  input: {
    scopeId: string;
    actorIdentityId: string;
    actorWid?: string | undefined;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    source: Extract<GalleryUploadBatch['albumSource'], { kind: 'community-event' }>;
  }
): Promise<'valid' | 'changed' | 'unavailable'> {
  if (!context.services) {
    return 'unavailable';
  }
  try {
    const output = await context.services.call<EventAlbumSourceResolveOutput>({
      serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
      method: EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
      scopeId: input.scopeId,
      actorIdentityId: input.actorIdentityId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.groupWid ? { groupWid: input.groupWid } : {}),
      input: { eventId: input.source.eventId }
    });
    if (output.kind !== 'found') {
      return 'unavailable';
    }
    return output.event.revision === input.source.revision ? 'valid' : 'changed';
  } catch (error) {
    logger.warn({
      error,
      scopeId: input.scopeId,
      eventId: input.source.eventId
    }, 'Could not revalidate the selected Piwigo event album source');
    return 'unavailable';
  }
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

async function handleActiveGalleryUpload(
  context: PluginCommandContext,
  ctx: CommandContext,
  batch: GalleryUploadBatch,
  actorIdentityId: string
) {
  const t = await piwigoCommandTranslator(context, ctx, batch.scopeId);
  if (ctx.message.context === 'private') {
    let allowed: boolean;
    try {
      allowed = await galleryBatchPermissionAllowed(context, batch, actorIdentityId);
    } catch (error) {
      return galleryUploadStateFailure(context, ctx, error, 'active-batch-permission', batch.scopeId);
    }
    if (!allowed) {
      return { handled: true, text: t('official.piwigo-gallery.noActiveUpload') };
    }
  }
  if (batch.status === 'finalizing') {
    return { handled: true, text: t('official.piwigo-gallery.finalizeInProgress') };
  }
  if (batch.status !== 'collecting') {
    return galleryUploadStateFailure(
      context,
      ctx,
      new Error(`Unexpected active gallery upload status: ${batch.status}`),
      'active-batch-status',
      batch.scopeId
    );
  }
  if (
    batch.files.some((file) => file.status === 'staged')
    && batch.autoFinalizeAt === batch.updatedAt
  ) {
    return { handled: true, text: t('official.piwigo-gallery.finalizeAlreadyQueued') };
  }
  return finalizeActiveGalleryUpload(context, ctx, batch, t);
}

async function finalizeActiveGalleryUpload(
  context: PluginCommandContext,
  ctx: CommandContext,
  batch: GalleryUploadBatch,
  t: TranslateFn
) {
  const runtime = requireOfficialCommandRuntime(context);
  const db = await preparedGalleryDatabase(runtime.dataStore, runtime.databases);
  const requestedAt = new Date().toISOString();
  const requested = requestBatchFinalization(db, {
    scopeId: batch.scopeId,
    batchId: batch.id,
    requestedAt,
    expectedVersion: batch.version
  });
  if (requested.kind === 'no_files') {
    return { handled: true, text: t('official.piwigo-gallery.noFiles') };
  }
  if (
    (requested.kind === 'not_collecting' || requested.kind === 'version_conflict')
    && requested.batch.status === 'finalizing'
  ) {
    return { handled: true, text: t('official.piwigo-gallery.finalizeInProgress') };
  }
  if (requested.kind === 'version_conflict' && requested.batch.autoFinalizeAt === requested.batch.updatedAt) {
    return { handled: true, text: t('official.piwigo-gallery.finalizeAlreadyQueued') };
  }
  if (requested.kind !== 'queued') {
    return galleryUploadStateFailure(
      context,
      ctx,
      new Error(`Gallery finalization request returned ${requested.kind}`),
      'finalization-request',
      batch.scopeId
    );
  }
  return {
    handled: true,
    pluginActions: [
      {
        type: 'message.sendText' as const,
        chatId: ctx.message.chatId,
        text: t('official.piwigo-gallery.finalizeQueued'),
        idempotencyKey: `piwigo-gallery:upload-request:${ctx.message.id}`,
        quotedMessageId: ctx.message.id
      },
      {
        type: 'plugin.enqueueJob' as const,
        pluginId: PIWIGO_GALLERY_PLUGIN_ID,
        jobName: PIWIGO_GALLERY_FINALIZE_JOB,
        scopeId: batch.scopeId,
        runAt: new Date(requestedAt),
        payload: {
          batchId: requested.batch.id,
          deadlineGeneration: requested.batch.deadlineGeneration,
          forced: true
        },
        dedupeKey: `${PIWIGO_GALLERY_FINALIZE_JOB}:${requested.batch.id}:${requested.batch.deadlineGeneration}:manual`,
        abortBatchOnFailure: true
      }
    ]
  };
}

async function galleryBatchPermissionAllowed(
  context: PluginCommandContext,
  batch: Pick<GalleryUploadBatch, 'scopeId' | 'groupId' | 'groupWid'>,
  actorIdentityId: string
): Promise<boolean> {
  if (!context.explainPermission || !context.configFor || !context.enabledFor) {
    return false;
  }
  if (!await context.enabledFor(batch.scopeId)) {
    return false;
  }
  const config = parsePiwigoGalleryConfig(await context.configFor(batch.scopeId, actorIdentityId));
  if (!config.enabled) {
    return false;
  }
  const decision = await context.explainPermission({
    actorIdentityId,
    action: PIWIGO_GALLERY_PERMISSIONS.upload,
    scopeId: batch.scopeId,
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    ...(batch.groupId ? { groupId: batch.groupId } : {}),
    groupWid: batch.groupWid,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    allowCurrentManagedGroupMember: config.access.allowScopeMemberUploads
  });
  return decision.allowed;
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
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'either_same_chat',
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    permission: PIWIGO_GALLERY_PERMISSIONS.upload,
    privateScopeAuthorization: 'handler',
    currentManagedGroupMembershipMode: 'effective_scope',
    allowCurrentManagedGroupMemberConfigPath: PIWIGO_UPLOAD_SCOPE_MEMBER_ACCESS_PATH,
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

type GalleryHelpTopic = 'manage-gallery' | 'upload-gallery' | 'link-gallery-account';

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
        if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
        patch.maxFileBytes = bytes;
        break;
      }
      default:
        return undefined;
    }
  }
  return patch;
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
