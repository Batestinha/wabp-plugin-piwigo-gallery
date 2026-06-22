import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { PluginCommandContext } from '../../../platform/pluginRuntime/types';
import {
  commandText,
  makeId,
  parseBoolean,
  requireOfficialCommandRuntime,
  requireScopeId
} from '../shared';
import { configConnection, parsePiwigoGalleryConfig } from './config';
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
import { PiwigoGalleryClient } from './piwigoClient';
import {
  clearActiveBatch,
  deleteDraft,
  getActiveBatch,
  getDraft,
  resolveGalleryConnection,
  saveBatch,
  saveDraft,
  saveGalleryConnection,
  setActiveBatch,
  type GalleryUploadBatch
} from './store';

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
    const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
    const connection = await resolveGalleryConnection(runtime.dataStore, config);
    return {
      handled: true,
      text: ctx.t('official.piwigo-gallery.status', {
        enabled: String(config.enabled),
        url: connection?.piwigoBaseUrl ?? '',
        auto: String(config.autoFinalizeMinutes),
        max: String(config.maxFileBytes)
      })
    };
  });

  router.register('gallery', 'configure', galleryAdminCommand({
    auditAction: 'piwigo-gallery.configure',
    usage: '/gallery configure enabled=yes url=https://gallery.example secret=SECRET auto=30 max=536870912',
    descriptionKey: 'official.piwigo-gallery.help.gallery'
  }), async (ctx) => {
    const scopeId = requireScopeId(ctx);
    const args = ctx.remainingArgs ?? ctx.command.args;
    if (args.length === 0) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.configUsage') };
    }
    const patch = parseConfigPatch(args);
    if (!patch) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.configUsage') };
    }
    const current = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
    const next = parsePiwigoGalleryConfig({ ...current, ...patch });
    await runtime.setConfig(scopeId, next);
    const connection = configConnection(next);
    if (connection) {
      await saveGalleryConnection(runtime.dataStore, connection);
    }
    return { handled: true, text: ctx.t('official.piwigo-gallery.configUpdated') };
  });

  router.register('send', 'gallery', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.start',
    usage: '/send gallery',
    descriptionKey: 'official.piwigo-gallery.help.send'
  }), async (ctx) => startUploadFlow(context, ctx));

  router.register('upload', '*', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.finalize',
    usage: '/upload',
    descriptionKey: 'official.piwigo-gallery.help.upload'
  }), async (ctx) => finalizeActiveUpload(runtime, ctx));

  router.register('cancel', '*', galleryUploadCommand({
    auditAction: 'piwigo-gallery.upload.cancel',
    usage: '/cancel',
    descriptionKey: 'official.piwigo-gallery.help.cancel'
  }), async (ctx) => cancelActiveUpload(context, ctx));

  router.register('connect', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.link',
    usage: '/connect gallery CODE',
    descriptionKey: 'official.piwigo-gallery.help.connect'
  }), async (ctx) => {
    const code = commandText(ctx).toUpperCase();
    if (!code) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.linkUsage') };
    }
    const connection = await resolveGalleryConnection(runtime.dataStore);
    if (!connection) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.notConfigured') };
    }
    try {
      const result = await new PiwigoGalleryClient(connection).consumeLinkCode(code, ctx.message.senderWid);
      return { handled: true, text: ctx.t('official.piwigo-gallery.linked', { username: result.username }) };
    } catch (error) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
    }
  });

  router.register('login', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.login',
    usage: '/login gallery CODE',
    descriptionKey: 'official.piwigo-gallery.help.login'
  }), async (ctx) => {
    const code = commandText(ctx).toUpperCase();
    if (!code) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.loginUsage') };
    }
    const connection = await resolveGalleryConnection(runtime.dataStore);
    if (!connection) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.notConfigured') };
    }
    try {
      const result = await new PiwigoGalleryClient(connection).consumeLoginCode(code, ctx.message.senderWid);
      return { handled: true, text: ctx.t('official.piwigo-gallery.loginApproved', { username: result.username }) };
    } catch (error) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
    }
  });

  router.register('register', 'gallery', galleryAuthCommand({
    auditAction: 'piwigo-gallery.account.register',
    usage: '/register gallery Your Name',
    descriptionKey: 'official.piwigo-gallery.help.register'
  }), async (ctx) => {
    const username = commandText(ctx) || ctx.message.senderDisplayName || '';
    if (!username.trim()) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.registerUsage') };
    }
    const connection = await resolveGalleryConnection(runtime.dataStore);
    if (!connection) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.notConfigured') };
    }
    try {
      const result = await new PiwigoGalleryClient(connection).registerAccount(username, ctx.message.senderWid);
      return {
        handled: true,
        text: ctx.t(result.pending ? 'official.piwigo-gallery.registeredPending' : 'official.piwigo-gallery.registered', {
          username: result.username
        })
      };
    } catch (error) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
    }
  });
}

async function startUploadFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const config = parsePiwigoGalleryConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.disabled') };
  }
  if (ctx.managementMode === 'OBSERVE') {
    return { handled: true, text: ctx.t('official.piwigo-gallery.observeOnly') };
  }
  const connection = await resolveGalleryConnection(runtime.dataStore, config);
  if (!connection) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.notConfigured') };
  }
  const active = await getActiveBatch(runtime.dataStore, scopeId, ctx.message.chatId, ctx.message.senderWid);
  if (active && (active.status === 'collecting' || active.status === 'uploading')) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.uploadAlreadyActive') };
  }

  try {
    const client = new PiwigoGalleryClient(connection);
    const [peopleResult, acceptedTypes] = await Promise.all([
      client.people(ctx.message.senderWid),
      client.acceptedTypes()
    ]);
    if (peopleResult.people.length === 0) {
      return { handled: true, text: ctx.t('official.piwigo-gallery.noPeople') };
    }
    const definition = createGalleryUploadFlowDefinition({ t: ctx.t, people: peopleResult.people });
    registerUploadFlowCompletionHandler(context, definition.flowType, ctx.t);
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
      actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
      acceptedExtensions: acceptedTypes.extensions,
      maxFileBytes: Math.min(config.maxFileBytes, acceptedTypes.max_file_size ?? config.maxFileBytes),
      autoFinalizeMinutes: config.autoFinalizeMinutes,
      createdAt: new Date().toISOString()
    });
    return { handled: true, text: ctx.t('official.piwigo-gallery.uploadStartedGroup') };
  } catch (error) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.failed', { reason: errorMessage(error) }) };
  }
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

async function finalizeActiveUpload(runtime: ReturnType<typeof requireOfficialCommandRuntime>, ctx: CommandContext) {
  const scopeId = requireScopeId(ctx);
  const batch = await getActiveBatch(runtime.dataStore, scopeId, ctx.message.chatId, ctx.message.senderWid);
  if (!batch || batch.status !== 'collecting') {
    return { handled: true, text: ctx.t('official.piwigo-gallery.noActiveUpload') };
  }
  if (batch.files.filter((file) => file.status === 'staged').length === 0) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.noFiles') };
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
  return { handled: true, text: ctx.t('official.piwigo-gallery.finalizeQueued') };
}

async function cancelActiveUpload(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const batch = await getActiveBatch(runtime.dataStore, scopeId, ctx.message.chatId, ctx.message.senderWid);
  if (!batch || (batch.status !== 'collecting' && batch.status !== 'uploading')) {
    return { handled: true, text: ctx.t('official.piwigo-gallery.noActiveUpload') };
  }
  for (const file of batch.files) {
    await context.mediaStore?.delete(file.mediaId).catch(() => undefined);
  }
  batch.status = 'cancelled';
  batch.updatedAt = new Date().toISOString();
  await saveBatch(runtime.dataStore, batch);
  await clearActiveBatch(runtime.dataStore, batch);
  return { handled: true, text: ctx.t('official.piwigo-gallery.cancelled') };
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
    help: {
      familyKey: 'official.piwigo-gallery.help.family',
      descriptionKey: input.descriptionKey,
      usage: input.usage
    }
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
      case 'url':
        patch.piwigoBaseUrl = value;
        break;
      case 'secret':
        patch.botSecret = value;
        break;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
