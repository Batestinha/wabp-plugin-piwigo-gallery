import { createHash, randomInt, randomUUID } from 'node:crypto';
import { FlowSessionStatus } from '@prisma/client';
import { z } from 'zod';
import {
  ActivePrivateFlowConflictError,
  type FlowSessionSnapshot
} from '../../../adminBot/flows/flowEngine';
import type { TranslateFn } from '../../../platform/i18n';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginExternalActionRegistration } from '../../../platform/pluginRuntime/pluginExternalActions';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { PluginExternalActionRegistrationContext } from '../../../platform/pluginRuntime/types';
import type { TransportAdapter } from '../../../platform/transport/transportTypes';
import { parsePiwigoGalleryConfig } from './config';
import {
  linkChoiceCountForScopes,
  listConfiguredPiwigoGalleryEligibleScopes,
  type ConfiguredPiwigoGalleryScope
} from './eligibility';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_EXTERNAL_ACTIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import { piwigoGalleryMessages } from './messages';
import {
  createGalleryLinkFlowDefinition,
  galleryLinkDecisionPurpose,
  galleryLinkFlowDecision,
  galleryLinkFlowInitialData,
  galleryLinkFlowRequest,
  PIWIGO_GALLERY_LINK_FLOW_TYPE,
  type GalleryLinkFlowRequest
} from './flow';
import {
  PiwigoApiError,
  PiwigoGalleryClient,
  type PiwigoLinkCompletionResult
} from './piwigoClient';
import {
  bindAlbumAnnouncementTarget,
  consumeRegistrationOtp,
  GalleryStorageConflictError,
  getAlbumAnnouncementByDedupeKey,
  getRegistrationOtp,
  pruneExpiredRegistrationOtps,
  resolveGalleryConnection,
  saveAlbumAnnouncement,
  saveRegistrationOtp,
  type PiwigoAlbumAnnouncementFile,
  type StoredPiwigoAlbumAnnouncement
} from './store';
import { preparedGalleryDatabase } from './storageRuntime';

const WHATSAPP_REGISTRATION_OTP_EXPIRY_MS = 10 * 60 * 1000;
const WHATSAPP_REGISTRATION_OTP_MAX_ATTEMPTS = 5;
const WHATSAPP_REGISTRATION_OTP_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export interface PiwigoGalleryRateLimitPolicy {
  windowSeconds: number;
  perWid: number;
  perAccount: number;
  perIp: number;
}

const DEFAULT_REGISTRATION_OTP_RATE_LIMITS: PiwigoGalleryRateLimitPolicy = {
  windowSeconds: 10 * 60,
  perWid: 3,
  perAccount: 30,
  perIp: 10
};

const DEFAULT_AUTH_CODE_RATE_LIMITS: PiwigoGalleryRateLimitPolicy = {
  windowSeconds: 10 * 60,
  perWid: 5,
  perAccount: 60,
  perIp: 15
};

const registrationOtpPayloadSchema = z.object({
  version: z.literal(2),
  requestId: z.string(),
  identityId: z.string(),
  whatsappJid: z.string(),
  displayName: z.string().optional(),
  otp: z.string().regex(/^\d{6}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export const piwigoGalleryExternalActionSchemas = {
  whatsappLinkRequestStart: z.object({
    requestId: z.string().trim().min(1).max(160),
    requestToken: z.string().trim().min(1).max(512),
    phone: z.string().trim().min(1),
    username: z.string().trim().min(1).max(100),
    siteLabel: z.string().trim().min(1).max(120).default('Piwigo'),
    expiresInMinutes: z.number().int().min(1).max(60).default(10)
  }).strict(),
  whatsappRegistrationOtpStart: z.object({
    requestId: z.string().trim().regex(WHATSAPP_REGISTRATION_OTP_REQUEST_ID_PATTERN),
    phone: z.string().trim().min(1),
    displayName: z.string().trim().min(1).max(100).optional(),
    requestIp: z.string().trim().min(1).max(80).optional()
  }).strict(),
  whatsappRegistrationOtpVerify: z.object({
    requestId: z.string().trim().min(1),
    otp: z.string().trim().regex(/^\d{6}$/)
  }).strict(),
  authCodeSend: z.object({
    whatsappJid: z.string().trim().regex(/^[^\s@]+@(c\.us|lid)$/i),
    purpose: z.enum(['password_reset', 'login_otp', 'trusted_device']),
    code: z.string().trim().regex(/^\d{6}$/),
    username: z.string().trim().min(1).max(100).optional(),
    expiresInMinutes: z.number().int().min(1).max(60).default(10),
    scopeId: z.string().trim().min(1),
    ip: z.string().trim().max(80).optional(),
    location: z.string().trim().max(120).optional(),
    deviceName: z.string().trim().max(120).optional()
  }).strict(),
  eligibleScopesResolve: z.object({
    whatsappJid: z.string().trim().optional(),
    phone: z.string().trim().optional()
  }).strict().refine((value) => Boolean(value.whatsappJid || value.phone), 'whatsappJid or phone is required'),
  albumUploadObserved: z.object({
    eventId: z.string().trim().min(1).max(160),
    scopeId: z.string().trim().min(1),
    albumId: z.union([z.string().trim().min(1), z.number().int().positive()]),
    albumName: z.string().trim().min(1).max(200),
    siteLabel: z.string().trim().min(1).max(120),
    userDisplayName: z.string().trim().min(1).max(120),
    observedAt: z.string().trim().datetime().optional(),
    files: z.array(z.object({
      imageId: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      filename: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().min(1).max(120)
    }).strict()).min(1).max(50)
  }).strict()
};

const outputSchemas = {
  whatsappLinkRequestStart: z.object({
    requestId: z.string(),
    whatsappJid: z.string(),
    expiresInMinutes: z.number().int(),
    eligibleScopeCount: z.number().int().nonnegative()
  }).strict(),
  whatsappRegistrationOtpStart: z.object({
    requestId: z.string(),
    expiresInMinutes: z.number().int().positive()
  }).strict(),
  whatsappRegistrationOtpVerify: z.object({
    whatsappJid: z.string(),
    displayName: z.string().optional()
  }).strict(),
  authCodeSend: z.object({
    sent: z.literal(true),
    whatsappJid: z.string(),
    purpose: z.enum(['password_reset', 'login_otp', 'trusted_device'])
  }).strict(),
  eligibleScopesResolve: z.object({
    whatsappJid: z.string(),
    scopes: z.array(z.object({ scopeId: z.string(), label: z.string() }).strict())
  }).strict(),
  albumUploadObserved: z.object({
    accepted: z.boolean(),
    duplicate: z.boolean(),
    announcementId: z.string().optional(),
    announceAt: z.string().optional(),
    reason: z.string().optional()
  }).strict()
};

const PIWIGO_AUTH_CODE_PURPOSE_KEYS: Record<
  z.infer<typeof piwigoGalleryExternalActionSchemas.authCodeSend>['purpose'],
  string
> = {
  password_reset: 'official.piwigo-gallery.authCode.passwordReset',
  login_otp: 'official.piwigo-gallery.authCode.loginOtp',
  trusted_device: 'official.piwigo-gallery.authCode.trustedDevice'
};

type AnyExternalActionRegistration = PluginExternalActionRegistration<any, any>;

const registeredGalleryLinkFlowEngines = new WeakSet<PluginExternalActionRegistrationContext['flowEngine']>();

const galleryLinkCompletionPlanSchema = z.object({
  version: z.literal(1),
  decision: z.enum(['approve', 'deny']),
  requestId: z.string().trim().min(1).max(160),
  requestToken: z.string().trim().min(1).max(512),
  identityId: z.string().trim().min(1),
  whatsappJid: z.string().trim().min(1),
  scopeId: z.string().trim().min(1),
  linkChoiceCount: z.number().int().min(1),
  scopeOptions: z.array(z.object({
    scopeId: z.string().trim().min(1),
    label: z.string().trim().min(1)
  }).strict()).min(1),
  completionId: z.string().trim().min(1)
}).strict();

type GalleryLinkCompletionPlan = z.infer<typeof galleryLinkCompletionPlanSchema>;

function registerPiwigoGalleryLinkFlow(
  context: PluginExternalActionRegistrationContext,
  eligibleScopesForIdentity: (identityId: string) => Promise<ConfiguredPiwigoGalleryScope[]>
): void {
  if (registeredGalleryLinkFlowEngines.has(context.flowEngine)) {
    return;
  }
  context.flowEngine.register(createGalleryLinkFlowDefinition({
    t: defaultPiwigoGalleryTranslator
  }));
  context.flowEngine.registerPromptHandler(
    galleryLinkDecisionPurpose(),
    async (lock, activeTransport) => {
      if (!await context.flowEngine.getLockedPromptLock(lock.flowPromptId)) {
        return false;
      }
      if (!lock.flowSessionId) {
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
      if (!snapshot || snapshot.flowType !== PIWIGO_GALLERY_LINK_FLOW_TYPE) {
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      if (snapshot.status === FlowSessionStatus.ACTIVE) {
        return false;
      }
      if (snapshot.status !== FlowSessionStatus.COMPLETED) {
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      const request = galleryLinkFlowRequest(snapshot);
      const decision = galleryLinkFlowDecision(snapshot);
      if (
        !request
        && typeof snapshot.state.data.linkRequestFingerprint === 'string'
        && decision
      ) {
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      if (
        !request
        || !decision
        || snapshot.identityId !== request.identityId
        || lock.voterIdentityId !== request.identityId
      ) {
        await context.audit.record({
          actorIdentityId: snapshot.identityId,
          action: 'piwigo-gallery.account.link.flow.invalid',
          metadataJson: {
            flowSessionId: snapshot.id,
            flowPromptId: lock.flowPromptId
          }
        });
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      const requestedFirstScope = request.scopeOptions[0];
      if (!requestedFirstScope) {
        await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
          text: request.copy.failed,
          auditAction: 'piwigo-gallery.account.link.flow.failed',
          auditMetadata: { reason: 'missing-scope', decision },
          flowPromptId: lock.flowPromptId
        });
        return true;
      }
      const expectedCompletionId = `piwigo-gallery:link-flow:${snapshot.id}`;
      const persistedPlan = await context.flowEngine.getPromptLockDecision(lock.flowPromptId);
      let plan = galleryLinkCompletionPlanForRequest(
        persistedPlan,
        request,
        decision,
        expectedCompletionId
      );
      if (persistedPlan !== undefined && !plan) {
        await context.audit.record({
          actorIdentityId: request.identityId,
          action: 'piwigo-gallery.account.link.flow.invalid',
          metadataJson: {
            flowSessionId: snapshot.id,
            flowPromptId: lock.flowPromptId,
            reason: 'completion-plan-mismatch'
          }
        });
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }
      if (!plan) {
        if (new Date(request.expiresAt).getTime() <= Date.now()) {
          await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
            text: request.copy.expired,
            auditAction: 'piwigo-gallery.account.link.flow.expired',
            auditMetadata: { decision },
            flowPromptId: lock.flowPromptId,
            scopeId: requestedFirstScope.scopeId
          });
          return true;
        }
        const originallyAuthorizedScopeIds = new Set(
          request.scopeOptions.map((scope) => scope.scopeId)
        );
        const currentScopes = (await eligibleScopesForIdentity(request.identityId))
          .filter((scope) => originallyAuthorizedScopeIds.has(scope.scopeId));
        const currentFirstScope = currentScopes[0];
        if (!currentFirstScope) {
          await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
            text: request.copy.failed,
            auditAction: 'piwigo-gallery.account.link.flow.failed',
            auditMetadata: { reason: 'authorization-changed', decision },
            flowPromptId: lock.flowPromptId
          });
          return true;
        }
        const proposedPlan = galleryLinkCompletionPlanSchema.parse({
          version: 1,
          decision,
          requestId: request.requestId,
          requestToken: request.requestToken,
          identityId: request.identityId,
          whatsappJid: request.whatsappJid,
          scopeId: currentFirstScope.scopeId,
          linkChoiceCount: linkChoiceCountForScopes(currentScopes),
          scopeOptions: currentScopes.map((scope) => ({
            scopeId: scope.scopeId,
            label: scope.label
          })),
          completionId: expectedCompletionId
        });
        plan = galleryLinkCompletionPlanForRequest(
          await context.flowEngine.recordPromptLockDecision(lock.flowPromptId, proposedPlan),
          request,
          decision,
          expectedCompletionId
        );
        if (!plan) {
          throw new Error(`Piwigo link flow ${snapshot.id} persisted an invalid completion plan.`);
        }
      }
      let connection;
      try {
        const config = parsePiwigoGalleryConfig(
          await context.configFor(plan.scopeId, plan.identityId)
        );
        connection = await resolveGalleryConnection(
          context.dataStore,
          config,
          context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
          context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
        );
      } catch (error) {
        if (!isDeterministicGalleryLinkFailure(error)) {
          throw error;
        }
      }
      if (!connection) {
        await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
          text: request.copy.failed,
          auditAction: 'piwigo-gallery.account.link.flow.failed',
          auditMetadata: { reason: 'connection-not-configured', decision },
          flowPromptId: lock.flowPromptId,
          scopeId: plan.scopeId
        });
        return true;
      }
      let result: PiwigoLinkCompletionResult;
      try {
        result = await new PiwigoGalleryClient(connection).completeLinkRequest(
          plan.requestToken,
          plan.whatsappJid,
          plan.decision,
          {
            completionId: plan.completionId,
            ...(plan.decision === 'approve' && plan.linkChoiceCount === 1
              ? { scopeId: plan.scopeId }
              : {}),
            ...(plan.decision === 'approve' && plan.linkChoiceCount > 1
              ? {
                  eligibleScopes: plan.scopeOptions.map((scope) => ({
                    scope_id: scope.scopeId,
                    label: scope.label
                  }))
                }
              : {})
          }
        );
      } catch (error) {
        if (!isDeterministicGalleryLinkFailure(error)) {
          throw error;
        }
        await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
          text: request.copy.failed,
          auditAction: 'piwigo-gallery.account.link.flow.failed',
          auditMetadata: {
            reason: error instanceof Error ? error.message : String(error),
            decision
          },
          flowPromptId: lock.flowPromptId,
          scopeId: plan.scopeId
        });
        return true;
      }
      const text = galleryLinkResultText(request, plan.decision, result);
      if (!text) {
        await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
          text: request.copy.failed,
          auditAction: 'piwigo-gallery.account.link.flow.failed',
          auditMetadata: {
            reason: 'response-status-mismatch',
            decision: plan.decision,
            status: result.status
          },
          flowPromptId: lock.flowPromptId,
          scopeId: plan.scopeId
        });
        return true;
      }
      await sendGalleryLinkTerminalResult(context, activeTransport, snapshot, request, {
        text,
        auditAction: 'piwigo-gallery.account.link.flow.completed',
        auditMetadata: {
          decision: plan.decision,
          status: result.status,
          username: result.username ?? request.username
        },
        flowPromptId: lock.flowPromptId,
        scopeId: plan.scopeId
      });
      return true;
    },
    { recoverLocked: true }
  );
  registeredGalleryLinkFlowEngines.add(context.flowEngine);
}

async function sendGalleryLinkTerminalResult(
  context: PluginExternalActionRegistrationContext,
  transport: TransportAdapter,
  snapshot: FlowSessionSnapshot,
  request: GalleryLinkFlowRequest,
  input: {
    text: string;
    auditAction: string;
    auditMetadata: Record<string, unknown>;
    flowPromptId: string;
    scopeId?: string | undefined;
  }
): Promise<void> {
  await transport.sendText(
    snapshot.conversationChatId ?? snapshot.chatId,
    input.text,
    { idempotencyKey: `piwigo-gallery:link-flow:${snapshot.id}:result` }
  );
  await context.audit.record({
    actorIdentityId: request.identityId,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    action: input.auditAction,
    targetJson: {
      requestId: request.requestId,
      siteLabel: request.siteLabel
    },
    metadataJson: {
      flowSessionId: snapshot.id,
      flowPromptId: input.flowPromptId,
      ...input.auditMetadata
    }
  });
  if (!await context.flowEngine.redactPromptLockSessionData(
    input.flowPromptId,
    ['linkRequest']
  )) {
    throw new Error(`Piwigo link flow ${snapshot.id} could not redact its terminal request state.`);
  }
  await context.flowEngine.acknowledgePromptLock(input.flowPromptId);
}

function isDeterministicGalleryLinkFailure(error: unknown): boolean {
  return error instanceof PiwigoApiError
    && !error.ambiguousOutcome
    && !isTransientGalleryLinkFailureCode(error.httpStatus)
    && !isTransientGalleryLinkFailureCode(error.piwigoCode);
}

function isTransientGalleryLinkFailureCode(code: number | undefined): boolean {
  return code === 408
    || code === 423
    || code === 425
    || code === 429
    || (code !== undefined && code >= 500 && code < 600);
}

function galleryLinkCompletionPlanForRequest(
  value: unknown,
  request: GalleryLinkFlowRequest,
  decision: 'approve' | 'deny',
  expectedCompletionId: string
): GalleryLinkCompletionPlan | undefined {
  const parsed = galleryLinkCompletionPlanSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const plan = parsed.data;
  const originallyAuthorizedScopeIds = new Set(
    request.scopeOptions.map((scope) => scope.scopeId)
  );
  if (
    plan.decision !== decision
    || plan.requestId !== request.requestId
    || plan.requestToken !== request.requestToken
    || plan.identityId !== request.identityId
    || plan.whatsappJid !== request.whatsappJid
    || plan.completionId !== expectedCompletionId
    || !plan.scopeOptions.some((scope) => scope.scopeId === plan.scopeId)
    || plan.scopeOptions.some((scope) => !originallyAuthorizedScopeIds.has(scope.scopeId))
  ) {
    return undefined;
  }
  return plan;
}

function galleryLinkResultText(
  request: GalleryLinkFlowRequest,
  decision: 'approve' | 'deny',
  result: PiwigoLinkCompletionResult
): string | undefined {
  if (decision === 'deny') {
    return result.status === 'denied' ? request.copy.denied : undefined;
  }
  if (result.status === 'approved') {
    return request.copy.confirmed;
  }
  return result.status === 'scope_required' ? request.copy.scopeRequired : undefined;
}

function assertSameGalleryLinkRequest(
  snapshot: Pick<FlowSessionSnapshot, 'state'>,
  expected: GalleryLinkFlowRequest
): void {
  const existing = galleryLinkFlowRequest(snapshot);
  const persistedFingerprint = snapshot.state.data.linkRequestFingerprint;
  if (
    existing
      ? sameGalleryLinkRequest(existing, expected)
      : persistedFingerprint === galleryLinkRequestFingerprint(expected)
  ) {
    return;
  }
  throw httpError(409, 'requestId is already bound to a different Piwigo link request.');
}

function sameGalleryLinkRequest(
  left: GalleryLinkFlowRequest,
  right: GalleryLinkFlowRequest
): boolean {
  return left.requestId === right.requestId
    && left.requestToken === right.requestToken
    && left.identityId === right.identityId
    && left.whatsappJid === right.whatsappJid
    && left.username === right.username
    && left.siteLabel === right.siteLabel
    && left.linkChoiceCount === right.linkChoiceCount
    && left.scopeOptions.length === right.scopeOptions.length
    && left.scopeOptions.every((scope, index) => {
      const candidate = right.scopeOptions[index];
      return candidate?.scopeId === scope.scopeId && candidate.label === scope.label;
    });
}

function galleryLinkRequestFingerprint(request: GalleryLinkFlowRequest): string {
  return opaqueKey(
    'piwigo-gallery-link-request-v1',
    request.requestId,
    request.requestToken,
    request.identityId,
    request.whatsappJid,
    request.username,
    request.siteLabel,
    String(request.linkChoiceCount),
    JSON.stringify(request.scopeOptions)
  );
}

export interface PiwigoGalleryExternalActionDependencies {
  listEligibleScopes?: typeof listConfiguredPiwigoGalleryEligibleScopes | undefined;
  registrationOtpRateLimits?: Partial<PiwigoGalleryRateLimitPolicy> | undefined;
  authCodeRateLimits?: Partial<PiwigoGalleryRateLimitPolicy> | undefined;
}

export function createPiwigoGalleryExternalActions(
  context: PluginExternalActionRegistrationContext,
  dependencies: PiwigoGalleryExternalActionDependencies = {}
): AnyExternalActionRegistration[] {
  const runtime = new PiwigoGalleryExternalActionRuntime(context, dependencies);
  registerPiwigoGalleryLinkFlow(
    context,
    (identityId) => runtime.eligibleScopesForIdentity(identityId)
  );
  return [
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappLinkRequestStart,
      inputSchema: piwigoGalleryExternalActionSchemas.whatsappLinkRequestStart,
      outputSchema: outputSchemas.whatsappLinkRequestStart,
      handler: (input, call) => runtime.startWhatsappLinkRequest(input, call.signal)
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappRegistrationOtpStart,
      inputSchema: piwigoGalleryExternalActionSchemas.whatsappRegistrationOtpStart,
      outputSchema: outputSchemas.whatsappRegistrationOtpStart,
      handler: (input, call) => runtime.startRegistrationOtp(input, call.signal)
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappRegistrationOtpVerify,
      inputSchema: piwigoGalleryExternalActionSchemas.whatsappRegistrationOtpVerify,
      outputSchema: outputSchemas.whatsappRegistrationOtpVerify,
      handler: (input, call) => runtime.verifyRegistrationOtp(input, call.signal)
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.authCodeSend,
      inputSchema: piwigoGalleryExternalActionSchemas.authCodeSend,
      outputSchema: outputSchemas.authCodeSend,
      resolveScopeId: (input) => input.scopeId,
      handler: (input, call) => runtime.sendAuthCode(input, call.signal)
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.eligibleScopesResolve,
      inputSchema: piwigoGalleryExternalActionSchemas.eligibleScopesResolve,
      outputSchema: outputSchemas.eligibleScopesResolve,
      handler: (input, call) => runtime.resolveEligibleScopes(input, call.signal)
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.albumUploadObserved,
      inputSchema: piwigoGalleryExternalActionSchemas.albumUploadObserved,
      outputSchema: outputSchemas.albumUploadObserved,
      resolveScopeId: (input) => input.scopeId,
      handler: (input, call) => runtime.observeAlbumUpload(input, call.signal)
    }
  ];
}

class PiwigoGalleryExternalActionRuntime {
  constructor(
    private readonly context: PluginExternalActionRegistrationContext,
    private readonly dependencies: PiwigoGalleryExternalActionDependencies
  ) {}

  async startWhatsappLinkRequest(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.whatsappLinkRequestStart>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.whatsappLinkRequestStart>> {
    const identity = await resolvePiwigoExternalIdentity(
      input.phone,
      this.context.platform.contacts,
      signal
    );
    const scopes = await this.eligibleScopesForIdentity(identity.identityId);
    throwIfAborted(signal);
    if (scopes.length === 0) {
      throw httpError(403, 'WhatsApp identity is not a member of a Piwigo-enabled group.');
    }
    const linkChoiceCount = linkChoiceCountForScopes(scopes);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000);
    const firstScope = scopes[0]!;
    const t = await this.piwigoTranslator(identity.identityId, firstScope.scopeId);
    const requestData = galleryLinkFlowInitialData({
      t,
      requestId: input.requestId,
      requestToken: input.requestToken.toUpperCase(),
      identityId: identity.identityId,
      whatsappJid: identity.piwigoAccountWid,
      username: input.username,
      siteLabel: input.siteLabel,
      linkChoiceCount,
      scopeOptions: scopes.map((scope) => ({ scopeId: scope.scopeId, label: scope.label })),
      expiresAt
    });
    const initialData = {
      ...requestData,
      linkRequestFingerprint: galleryLinkRequestFingerprint(requestData.linkRequest)
    };
    const definition = createGalleryLinkFlowDefinition({
      t: defaultPiwigoGalleryTranslator,
      timeoutMinutes: input.expiresInMinutes
    });
    const externalIdempotencyKey = `piwigo-gallery:link-request:${opaqueKey(
      this.context.runtimeBindingId,
      identity.identityId,
      input.requestId
    )}`;
    const inspection = await this.context.flowEngine.inspectIdentityFlowStart({
      actorIdentityId: identity.identityId,
      externalIdempotencyKey
    });
    if (inspection.kind === 'conflict') {
      throw httpError(409, 'This WhatsApp identity is already answering another private flow.');
    }
    if (inspection.kind === 'duplicate') {
      assertSameGalleryLinkRequest(inspection.session, initialData.linkRequest);
    }
    try {
      const started = await this.context.flowEngine.startFlowForIdentity({
        definition,
        actorIdentityId: identity.identityId,
        externalIdempotencyKey,
        origin: { chatId: identity.deliveryChatId, context: 'private' },
        scopeId: firstScope.scopeId,
        initialData,
        initialPromptTranslator: t
      });
      if (started.deduplicated) {
        const snapshot = await this.context.flowEngine.getSessionSnapshot(started.flowSessionId);
        if (!snapshot) {
          throw new Error(`Piwigo link flow ${started.flowSessionId} could not be recovered.`);
        }
        assertSameGalleryLinkRequest(snapshot, initialData.linkRequest);
      }
    } catch (error) {
      const afterFailure = await this.context.flowEngine.inspectIdentityFlowStart({
        actorIdentityId: identity.identityId,
        externalIdempotencyKey
      }).catch(() => undefined);
      if (afterFailure?.kind === 'duplicate') {
        assertSameGalleryLinkRequest(afterFailure.session, initialData.linkRequest);
      } else if (
        error instanceof ActivePrivateFlowConflictError
        || afterFailure?.kind === 'conflict'
      ) {
        throw httpError(409, 'This WhatsApp identity is already answering another private flow.');
      } else {
        throw error;
      }
    }
    return {
      requestId: input.requestId,
      whatsappJid: identity.piwigoAccountWid,
      expiresInMinutes: input.expiresInMinutes,
      eligibleScopeCount: scopes.length
    };
  }

  async startRegistrationOtp(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.whatsappRegistrationOtpStart>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.whatsappRegistrationOtpStart>> {
    const identity = await resolvePiwigoExternalIdentity(
      input.phone,
      this.context.platform.contacts,
      signal
    );
    const database = await this.database();
    const now = new Date();
    pruneExpiredRegistrationOtps(database, now.toISOString());
    const existingRequest = getRegistrationOtp(database, input.requestId);
    if (existingRequest) {
      assertRegistrationOtpIdentity(existingRequest, identity.identityId, input.displayName);
      assertRegistrationOtpActive(existingRequest.status);
      const existingPayload = await this.registrationOtpPayload(input.requestId);
      if (!existingPayload) {
        throw httpError(409, 'This registration request cannot be retried because its original OTP is unavailable.');
      }
      assertRegistrationOtpPayload(existingPayload, input.requestId, identity.identityId, input.displayName);
      if (existingRequest.otpHash !== hashRegistrationOtp(input.requestId, existingPayload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
      if (existingRequest.expiresAt <= now.toISOString()) {
        throw httpError(410, 'WhatsApp registration code expired.');
      }
      await this.sendRegistrationOtp(existingPayload, identity, signal);
      return registrationOtpStartOutput(input.requestId);
    }

    const candidatePayload: RegistrationOtpPayload = {
      version: 2,
      requestId: input.requestId,
      identityId: identity.identityId,
      whatsappJid: identity.piwigoAccountWid,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      otp: String(randomInt(100000, 1000000)),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WHATSAPP_REGISTRATION_OTP_EXPIRY_MS).toISOString()
    };
    const payloadKey = registrationOtpPayloadKey(this.context.whatsAppAccountId, input.requestId);
    const created = await this.context.ephemeralStore.setIfAbsent(
      payloadKey,
      candidatePayload,
      WHATSAPP_REGISTRATION_OTP_EXPIRY_MS
    );
    const payload = created ? candidatePayload : await this.registrationOtpPayload(input.requestId);
    if (!payload) {
      throw httpError(409, 'Registration request state expired; use a new requestId.');
    }
    assertRegistrationOtpPayload(payload, input.requestId, identity.identityId, input.displayName);
    if (payload.expiresAt <= new Date().toISOString()) {
      throw httpError(410, 'WhatsApp registration code expired.');
    }

    const registrationRateLimits = rateLimitPolicy(
      DEFAULT_REGISTRATION_OTP_RATE_LIMITS,
      this.dependencies.registrationOtpRateLimits
    );
    await this.admitRateLimitedRequest({
      kind: 'registration-otp',
      idempotencyId: input.requestId,
      identityId: identity.identityId,
      requestIp: input.requestIp,
      ttlSeconds: Math.max(
        Math.ceil(WHATSAPP_REGISTRATION_OTP_EXPIRY_MS / 1_000),
        registrationRateLimits.windowSeconds
      ),
      policy: registrationRateLimits,
      signal
    });
    throwIfAborted(signal);

    const preparedRequest = getRegistrationOtp(database, input.requestId);
    if (preparedRequest) {
      assertRegistrationOtpIdentity(preparedRequest, identity.identityId, input.displayName);
      assertRegistrationOtpActive(preparedRequest.status);
      if (preparedRequest.otpHash !== hashRegistrationOtp(input.requestId, payload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
    } else {
      saveRegistrationOtp(database, {
        requestId: input.requestId,
        identityId: identity.identityId,
        whatsappJid: payload.whatsappJid,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        otpHash: hashRegistrationOtp(input.requestId, payload.otp),
        expiresAt: payload.expiresAt,
        attempts: 0,
        createdAt: payload.createdAt
      });
      const persistedRequest = getRegistrationOtp(database, input.requestId);
      if (!persistedRequest) {
        throw new Error('Registration OTP was not persisted.');
      }
      assertRegistrationOtpIdentity(persistedRequest, identity.identityId, input.displayName);
      assertRegistrationOtpActive(persistedRequest.status);
      if (persistedRequest.otpHash !== hashRegistrationOtp(input.requestId, payload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
    }
    await this.sendRegistrationOtp(payload, identity, signal);
    return registrationOtpStartOutput(input.requestId);
  }

  private async sendRegistrationOtp(
    payload: RegistrationOtpPayload,
    identity: PiwigoExternalIdentity,
    signal: AbortSignal
  ): Promise<void> {
    await this.context.platform.messaging.sendText(
      identity.deliveryChatId,
      formatRegistrationOtpMessage(await this.piwigoTranslator(identity.identityId), payload.otp),
      { idempotencyKey: `piwigo-gallery:registration-otp:${payload.requestId}` },
      signal
    );
  }

  async verifyRegistrationOtp(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.whatsappRegistrationOtpVerify>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.whatsappRegistrationOtpVerify>> {
    throwIfAborted(signal);
    const result = consumeRegistrationOtp(await this.database(), {
      requestId: input.requestId,
      candidateHash: hashRegistrationOtp(input.requestId, input.otp),
      now: new Date().toISOString(),
      maxAttempts: WHATSAPP_REGISTRATION_OTP_MAX_ATTEMPTS
    });
    if (result.kind === 'missing') {
      throw httpError(404, 'Invalid or expired WhatsApp registration code.');
    }
    if (result.kind === 'expired') {
      throw httpError(410, 'WhatsApp registration code expired.');
    }
    if (result.kind === 'consumed') {
      throw httpError(409, 'WhatsApp registration code was already consumed.');
    }
    if (result.kind === 'locked') {
      throw httpError(423, 'WhatsApp registration request is locked.');
    }
    if (result.kind === 'invalid') {
      throw httpError(401, 'Invalid WhatsApp registration code.');
    }
    return {
      whatsappJid: result.request.whatsappJid,
      ...(result.request.displayName ? { displayName: result.request.displayName } : {})
    };
  }

  async sendAuthCode(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.authCodeSend>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.authCodeSend>> {
    const identity = await resolvePiwigoExternalIdentity(
      input.whatsappJid,
      this.context.platform.contacts,
      signal
    );
    const whatsappJid = identity.piwigoAccountWid;
    const idempotencyDigest = createHash('sha256')
      .update(JSON.stringify([identity.identityId, input.scopeId, input.purpose, input.code]))
      .digest('hex');
    const authCodeRateLimits = rateLimitPolicy(DEFAULT_AUTH_CODE_RATE_LIMITS, this.dependencies.authCodeRateLimits);
    await this.admitRateLimitedRequest({
      kind: 'auth-code',
      idempotencyId: idempotencyDigest,
      identityId: identity.identityId,
      requestIp: input.ip,
      ttlSeconds: Math.max(input.expiresInMinutes * 60, authCodeRateLimits.windowSeconds),
      policy: authCodeRateLimits,
      signal
    });
    await this.context.platform.messaging.sendText(
      identity.deliveryChatId,
      formatPiwigoAuthCodeMessage(await this.piwigoTranslator(identity.identityId, input.scopeId), {
        ...input,
        whatsappJid
      }),
      {
        idempotencyKey: `piwigo-gallery:auth-code:${idempotencyDigest}`
      },
      signal
    );
    return { sent: true, whatsappJid, purpose: input.purpose };
  }

  async resolveEligibleScopes(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.eligibleScopesResolve>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.eligibleScopesResolve>> {
    const identity = await resolvePiwigoExternalIdentity(
      input.whatsappJid ?? input.phone!,
      this.context.platform.contacts,
      signal
    );
    const scopes = await this.eligibleScopesForIdentity(identity.identityId);
    throwIfAborted(signal);
    return {
      whatsappJid: identity.piwigoAccountWid,
      scopes: scopes.map((scope) => ({ scopeId: scope.scopeId, label: scope.label }))
    };
  }

  async observeAlbumUpload(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.albumUploadObserved>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.albumUploadObserved>> {
    const database = await this.database();
    const config = parsePiwigoGalleryConfig(await this.context.configFor(input.scopeId));
    const albumId = String(input.albumId);
    const dedupeKey = `album:${albumId}`;
    const observedAt = input.observedAt ?? new Date().toISOString();
    const observedDeadline = new Date(Math.max(
      Date.now(),
      new Date(observedAt).getTime() + config.newAlbumAnnouncementDelayMinutes * 60_000
    )).toISOString();
    const catchUpDeadline = new Date(
      Date.now() + config.newAlbumAnnouncementDelayMinutes * 60_000
    ).toISOString();
    let validatedGroupWid: string | undefined;
    const resolveAnnouncementGroup = async (
      capturedGroupWid?: string | undefined
    ): Promise<{ announcementGroupWid?: string | undefined; reason?: string | undefined }> => {
      const announcementGroupWid = capturedGroupWid ||
        config.announcementGroupWid ||
        await this.context.communityAnnouncementGroupWidForScope?.(input.scopeId);
      if (!announcementGroupWid) {
        return { reason: 'announcementGroupWid is not configured for this scope' };
      }
      if (validatedGroupWid !== announcementGroupWid) {
        if (!(await this.groupBelongsToScope(input.scopeId, announcementGroupWid))) {
          return { reason: 'announcementGroupWid does not belong to the callback scope' };
        }
        validatedGroupWid = announcementGroupWid;
      }
      throwIfAborted(signal);
      return { announcementGroupWid };
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let existing = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
      if (!existing) {
        if (!config.newAlbumAnnouncementsEnabled) {
          return { accepted: false, duplicate: false, reason: 'new album announcements are disabled for this scope' };
        }
        const target = await resolveAnnouncementGroup();
        if (!target.announcementGroupWid) {
          return { accepted: false, duplicate: false, reason: target.reason };
        }
        // The scope check above is asynchronous. Re-read before inserting so a
        // concurrent callback cannot create a second base announcement.
        existing = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
        if (existing) continue;
        const announcementId = randomUUID();
        try {
          const announcement = saveAlbumAnnouncement(database, {
            id: announcementId,
            dedupeKey,
            scopeId: input.scopeId,
            announcementGroupWid: target.announcementGroupWid,
            albumId,
            albumName: input.albumName,
            siteLabel: input.siteLabel,
            userDisplayName: input.userDisplayName,
            files: input.files.map(albumObservationFile),
            observedAt,
            announceAt: observedDeadline,
            status: 'pending'
          });
          throwIfAborted(signal);
          await enqueueAlbumAnnouncement(this.context, announcement, target.announcementGroupWid, false);
          return { accepted: true, duplicate: false, announcementId, announceAt: observedDeadline };
        } catch (error) {
          if (getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey)) continue;
          throw error;
        }
      }

      const catchUpDedupeKey = albumCatchUpDedupeKey(input.scopeId, existing.id);
      let catchUp = getAlbumAnnouncementByDedupeKey(database, input.scopeId, catchUpDedupeKey);
      assertAlbumAnnouncementDigestIntegrity(
        [...existing.files, ...(catchUp?.files ?? [])],
        input.files
      );
      const missingFiles = missingAlbumAnnouncementFiles(
        [...existing.files, ...(catchUp?.files ?? [])],
        input.files
      );

      if (missingFiles.length === 0) {
        const catchUpImageIds = new Set(catchUp?.files.map((file) => file.imageId) ?? []);
        const duplicate = catchUp && input.files.some((file) => catchUpImageIds.has(file.imageId))
          ? catchUp
          : existing;
        if (duplicate.status === 'pending' && config.newAlbumAnnouncementsEnabled) {
          if (!duplicate.announcementGroupWid) {
            const target = await resolveAnnouncementGroup(existing.announcementGroupWid);
            if (!target.announcementGroupWid) {
              return {
                accepted: true,
                duplicate: true,
                announcementId: duplicate.id,
                announceAt: duplicate.announceAt,
                reason: target.reason
              };
            }
            if (duplicate.id === existing.id) {
              bindAlbumAnnouncementTarget(database, {
                scopeId: input.scopeId,
                announcementId: existing.id,
                announcementGroupWid: target.announcementGroupWid
              });
              continue;
            }
            throw httpError(500, 'The stored album catch-up announcement target is missing.');
          }
          throwIfAborted(signal);
          await enqueueAlbumAnnouncement(
            this.context,
            duplicate,
            duplicate.announcementGroupWid,
            true
          );
        }
        return {
          accepted: true,
          duplicate: true,
          announcementId: duplicate.id,
          announceAt: duplicate.announceAt
        };
      }

      const terminalCatchUpEligible = existing.status === 'announced' &&
        existing.announcedAt !== undefined &&
        new Date(observedAt).getTime() <= new Date(existing.announcedAt).getTime();
      if (existing.status !== 'pending' && !terminalCatchUpEligible) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: existing.status === 'announced'
            ? 'the upload was observed after this album announcement completed'
            : `the album announcement is already ${existing.status}`
        };
      }
      if (catchUp && catchUp.status !== 'pending') {
        return {
          accepted: false,
          duplicate: true,
          announcementId: catchUp.id,
          announceAt: catchUp.announceAt,
          reason: `the album catch-up announcement is already ${catchUp.status}`
        };
      }
      if (!config.newAlbumAnnouncementsEnabled) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: 'new album announcements are disabled for this scope'
        };
      }

      const hasActiveClaim = hasActiveAlbumAnnouncementClaim(existing, Date.now());
      if (existing.status === 'pending' && hasActiveClaim) {
        throw httpError(425, 'The album announcement is currently being delivered; retry this observation.');
      }
      const useCatchUp = existing.status !== 'pending';
      if (!useCatchUp) {
        if (!existing.announcementGroupWid) {
          const target = await resolveAnnouncementGroup();
          if (!target.announcementGroupWid) {
            return {
              accepted: false,
              duplicate: true,
              announcementId: existing.id,
              announceAt: existing.announceAt,
              reason: 'the legacy announcement target could not be resolved inside the callback scope'
            };
          }
          bindAlbumAnnouncementTarget(database, {
            scopeId: input.scopeId,
            announcementId: existing.id,
            announcementGroupWid: target.announcementGroupWid
          });
          continue;
        }
        const announcementGroupWid = existing.announcementGroupWid;
        try {
          existing = saveAlbumAnnouncement(database, {
            ...existing,
            files: [...existing.files.map((file) => ({ ...file })), ...missingFiles],
            observedAt: existing.observedAt < observedAt ? existing.observedAt : observedAt,
            announceAt: existing.announceAt > observedDeadline ? existing.announceAt : observedDeadline,
            ...(existing.claimId ? { claimId: undefined, claimExpiresAt: undefined } : {})
          }, existing.version);
        } catch (error) {
          if (error instanceof GalleryStorageConflictError) continue;
          throw error;
        }
        throwIfAborted(signal);
        await enqueueAlbumAnnouncement(this.context, existing, announcementGroupWid, true);
        return {
          accepted: true,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt
        };
      }

      const target = await resolveAnnouncementGroup(existing.announcementGroupWid);
      if (!target.announcementGroupWid) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: target.reason
        };
      }
      // Re-read both rows after the asynchronous scope check. Any state change
      // is processed again from the top instead of mutating a stale snapshot.
      const latestBase = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
      const latestCatchUp = getAlbumAnnouncementByDedupeKey(database, input.scopeId, catchUpDedupeKey);
      if (
        !latestBase ||
        latestBase.version !== existing.version ||
        latestCatchUp?.version !== catchUp?.version
      ) {
        continue;
      }
      existing = latestBase;
      catchUp = latestCatchUp;
      if (!existing.announcementGroupWid) {
        bindAlbumAnnouncementTarget(database, {
          scopeId: input.scopeId,
          announcementId: existing.id,
          announcementGroupWid: target.announcementGroupWid
        });
        continue;
      }
      const upserted = upsertAlbumCatchUp(database, {
        base: existing,
        dedupeKey: catchUpDedupeKey,
        announcementGroupWid: target.announcementGroupWid,
        albumId,
        albumName: input.albumName,
        siteLabel: input.siteLabel,
        userDisplayName: input.userDisplayName,
        incomingFiles: input.files,
        observedAt,
        announceAt: catchUpDeadline,
        nowMs: Date.now()
      });
      throwIfAborted(signal);
      if (upserted.announcement.status === 'pending') {
        await enqueueAlbumAnnouncement(
          this.context,
          upserted.announcement,
          target.announcementGroupWid,
          !upserted.created
        );
      }
      return {
        accepted: upserted.rejectedReason === undefined,
        duplicate: !upserted.created,
        announcementId: upserted.announcement.id,
        announceAt: upserted.announcement.announceAt,
        ...(upserted.rejectedReason ? { reason: upserted.rejectedReason } : {})
      };
    }

    throw httpError(503, 'The album announcement changed concurrently; retry this observation.');
  }

  eligibleScopesForIdentity(identityId: string) {
    return (this.dependencies.listEligibleScopes ?? listConfiguredPiwigoGalleryEligibleScopes)(identityId, {
      whatsAppAccountId: this.context.whatsAppAccountId,
      runtimeBindingId: this.context.runtimeBindingId,
      defaultPiwigoBaseUrl: this.context.config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
      defaultPiwigoBotSecret: this.context.config.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
    });
  }

  private database() {
    return preparedGalleryDatabase(this.context.dataStore, this.context.databases);
  }

  private async registrationOtpPayload(requestId: string): Promise<RegistrationOtpPayload | undefined> {
    const value = await this.context.ephemeralStore.get(
      registrationOtpPayloadKey(this.context.whatsAppAccountId, requestId)
    );
    if (value === undefined) return undefined;
    const parsed = registrationOtpPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw httpError(409, 'Registration request state is invalid; use a new requestId.');
    }
    return parsed.data;
  }

  private async admitRateLimitedRequest(input: {
    kind: 'registration-otp' | 'auth-code';
    idempotencyId: string;
    identityId: string;
    requestIp?: string | undefined;
    ttlSeconds: number;
    policy: PiwigoGalleryRateLimitPolicy;
    signal: AbortSignal;
  }): Promise<void> {
    const accountId = this.context.whatsAppAccountId;
    const admissionKey = rateAdmissionKey(accountId, input.kind, input.idempotencyId);
    throwIfAborted(input.signal);
    const result = await this.context.ephemeralStore.admitRateLimit({
      idempotencyKey: admissionKey,
      idempotencyTtlMilliseconds: input.ttlSeconds * 1_000,
      windowSeconds: input.policy.windowSeconds,
      dimensions: rateLimitDimensions({
        accountId,
        kind: input.kind,
        identityId: input.identityId,
        requestIp: input.requestIp,
        policy: input.policy
      })
    });
    throwIfAborted(input.signal);
    if (result === 'rejected') throwRegistrationRateLimitError();
  }

  private async groupBelongsToScope(scopeId: string, groupWid: string): Promise<boolean> {
    const coveredGroups = await this.context.coveredGroupsForScope?.(scopeId);
    return coveredGroups?.some((group) => group.groupWid.toLowerCase() === groupWid.toLowerCase()) ?? false;
  }

  private async piwigoTranslator(identityId: string, scopeId?: string | undefined): Promise<TranslateFn> {
    return this.context.i18n.translatorForIdentity(identityId, scopeId).catch(() => defaultPiwigoGalleryTranslator);
  }
}

type RegistrationOtpPayload = z.infer<typeof registrationOtpPayloadSchema>;

function registrationOtpStartOutput(requestId: string): z.infer<typeof outputSchemas.whatsappRegistrationOtpStart> {
  return {
    requestId,
    expiresInMinutes: Math.ceil(WHATSAPP_REGISTRATION_OTP_EXPIRY_MS / 60_000)
  };
}

function registrationOtpPayloadKey(accountId: string, requestId: string): string {
  return `registration-otp:payload:${opaqueKey(accountId, requestId)}`;
}

function assertRegistrationOtpPayload(
  payload: RegistrationOtpPayload,
  requestId: string,
  identityId: string,
  displayName?: string | undefined
): void {
  if (
    payload.requestId !== requestId ||
    payload.identityId !== identityId ||
    (payload.displayName ?? undefined) !== (displayName ?? undefined)
  ) {
    throw httpError(409, 'requestId is already bound to a different WhatsApp identity or display name.');
  }
}

function assertRegistrationOtpIdentity(
  request: { identityId: string; displayName?: string | undefined },
  identityId: string,
  displayName?: string | undefined
): void {
  if (request.identityId !== identityId || (request.displayName ?? undefined) !== (displayName ?? undefined)) {
    throw httpError(409, 'requestId is already bound to a different WhatsApp identity or display name.');
  }
}

function assertRegistrationOtpActive(status?: 'active' | 'consumed' | 'locked' | 'expired' | undefined): void {
  if (status === 'consumed') throw httpError(409, 'WhatsApp registration request was already consumed.');
  if (status === 'locked') throw httpError(423, 'WhatsApp registration request is locked.');
  if (status === 'expired') throw httpError(410, 'WhatsApp registration request expired.');
}

function rateLimitPolicy(
  defaults: PiwigoGalleryRateLimitPolicy,
  override?: Partial<PiwigoGalleryRateLimitPolicy> | undefined
): PiwigoGalleryRateLimitPolicy {
  const policy = { ...defaults, ...override };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid Piwigo ${name} rate-limit policy.`);
    }
  }
  return policy;
}

function rateAdmissionKey(
  accountId: string,
  kind: 'registration-otp' | 'auth-code',
  idempotencyId: string
): string {
  return `${kind}:admission:${opaqueKey(accountId, idempotencyId)}`;
}

function rateLimitDimensions(input: {
  accountId: string;
  kind: 'registration-otp' | 'auth-code';
  identityId: string;
  requestIp?: string | undefined;
  policy: PiwigoGalleryRateLimitPolicy;
}): Array<{ key: string; limit: number }> {
  const prefix = `${input.kind}:rate`;
  const dimensions = [
    {
      key: `${prefix}:identity:${opaqueKey(input.accountId, input.identityId)}`,
      limit: input.policy.perWid
    },
    {
      key: `${prefix}:account:${opaqueKey(input.accountId)}`,
      limit: input.policy.perAccount
    }
  ];
  if (input.requestIp) {
    dimensions.push({
      // Only the digest enters Redis; neither the key nor value retains the caller IP.
      key: `${prefix}:ip:${opaqueKey(input.accountId, input.requestIp.trim().toLowerCase())}`,
      limit: input.policy.perIp
    });
  }
  return dimensions;
}

function opaqueKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function throwRegistrationRateLimitError(): never {
  throw httpError(429, 'Too many Piwigo authentication requests. Try again later.');
}

function enqueueAlbumAnnouncement(
  context: PluginExternalActionRegistrationContext,
  announcement: {
    id: string;
    scopeId: string;
    announceAt: string;
    downloadRetryCount?: number | undefined;
    downloadNextRetryAt?: string | undefined;
    version?: number | undefined;
  },
  groupWid: string,
  recovery: boolean
): Promise<void> {
  const dueAt = announcement.downloadNextRetryAt &&
    new Date(announcement.downloadNextRetryAt).getTime() > new Date(announcement.announceAt).getTime()
    ? announcement.downloadNextRetryAt
    : announcement.announceAt;
  const recoveryDedupeSuffix = recovery
    ? `:callback-recovery:v${announcement.version ?? 1}:r${announcement.downloadRetryCount ?? 0}:${dueAt}`
    : '';
  return enqueuePluginJob(context.queue, {
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    scopeId: announcement.scopeId,
    groupWid,
    runAt: new Date(dueAt),
    payload: { announcementId: announcement.id },
    dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcement.id}${recoveryDedupeSuffix}`
  });
}

type AlbumObservationFile = {
  imageId: number;
  sha256: string;
  filename: string;
  mimeType: string;
};

function albumObservationFile(file: AlbumObservationFile): PiwigoAlbumAnnouncementFile {
  return {
    imageId: file.imageId,
    sha256: file.sha256,
    filename: file.filename,
    mimeType: file.mimeType
  };
}

function assertAlbumAnnouncementDigestIntegrity(
  existing: readonly PiwigoAlbumAnnouncementFile[],
  incoming: readonly AlbumObservationFile[]
): void {
  const digests = new Map<number, string | undefined>();
  for (const file of existing) {
    if (file.imageId !== undefined) digests.set(file.imageId, file.sha256);
  }
  for (const file of incoming) {
    if (digests.has(file.imageId) && digests.get(file.imageId) !== file.sha256) {
      throw httpError(409, `Piwigo image ${file.imageId} was observed with a conflicting SHA-256 digest.`);
    }
    digests.set(file.imageId, file.sha256);
  }
}

function missingAlbumAnnouncementFiles(
  existing: readonly PiwigoAlbumAnnouncementFile[],
  incoming: readonly AlbumObservationFile[]
): PiwigoAlbumAnnouncementFile[] {
  const missing: PiwigoAlbumAnnouncementFile[] = [];
  const imageIds = new Set(
    existing
      .map((file) => file.imageId)
      .filter((imageId): imageId is number => imageId !== undefined)
  );
  for (const file of incoming) {
    if (imageIds.has(file.imageId)) continue;
    missing.push({
      imageId: file.imageId,
      sha256: file.sha256,
      filename: file.filename,
      mimeType: file.mimeType
    });
    imageIds.add(file.imageId);
  }
  return missing;
}

function hasActiveAlbumAnnouncementClaim(
  announcement: Pick<StoredPiwigoAlbumAnnouncement, 'claimId' | 'claimExpiresAt'>,
  nowMs: number
): boolean {
  return Boolean(
    announcement.claimId &&
    announcement.claimExpiresAt &&
    new Date(announcement.claimExpiresAt).getTime() > nowMs
  );
}

function albumCatchUpDedupeKey(scopeId: string, baseAnnouncementId: string): string {
  return `album-followup:${opaqueKey(scopeId, baseAnnouncementId)}`;
}

function upsertAlbumCatchUp(
  db: PluginDatabase,
  input: {
    base: StoredPiwigoAlbumAnnouncement;
    dedupeKey: string;
    announcementGroupWid: string;
    albumId: string;
    albumName: string;
    siteLabel: string;
    userDisplayName: string;
    incomingFiles: readonly AlbumObservationFile[];
    observedAt: string;
    announceAt: string;
    nowMs: number;
  }
): { announcement: StoredPiwigoAlbumAnnouncement; created: boolean; rejectedReason?: string | undefined } {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = getAlbumAnnouncementByDedupeKey(db, input.base.scopeId, input.dedupeKey);
    assertAlbumAnnouncementDigestIntegrity(
      [...input.base.files, ...(existing?.files ?? [])],
      input.incomingFiles
    );
    const missingFiles = missingAlbumAnnouncementFiles(
      [...input.base.files, ...(existing?.files ?? [])],
      input.incomingFiles
    );
    if (existing) {
      if (missingFiles.length === 0) {
        return { announcement: existing, created: false };
      }
      if (existing.status !== 'pending') {
        return {
          announcement: existing,
          created: false,
          rejectedReason: `the album catch-up announcement is already ${existing.status}`
        };
      }
      if (hasActiveAlbumAnnouncementClaim(existing, input.nowMs)) {
        throw httpError(425, 'The album catch-up announcement is currently being delivered; retry this observation.');
      }
      try {
        const announcement = saveAlbumAnnouncement(db, {
          ...existing,
          files: [...existing.files.map((file) => ({ ...file })), ...missingFiles],
          observedAt: existing.observedAt < input.observedAt ? existing.observedAt : input.observedAt,
          announceAt: existing.announceAt > input.announceAt ? existing.announceAt : input.announceAt,
          ...(existing.claimId ? { claimId: undefined, claimExpiresAt: undefined } : {})
        }, existing.version);
        return { announcement, created: false };
      } catch (error) {
        if (error instanceof GalleryStorageConflictError) continue;
        throw error;
      }
    }

    const announcementId = randomUUID();
    try {
      const announcement = saveAlbumAnnouncement(db, {
        id: announcementId,
        dedupeKey: input.dedupeKey,
        scopeId: input.base.scopeId,
        announcementGroupWid: input.announcementGroupWid,
        albumId: input.albumId,
        albumName: input.albumName,
        siteLabel: input.siteLabel,
        userDisplayName: input.userDisplayName,
        files: missingFiles,
        observedAt: input.observedAt,
        announceAt: input.announceAt,
        status: 'pending'
      });
      return { announcement, created: true };
    } catch (error) {
      if (getAlbumAnnouncementByDedupeKey(db, input.base.scopeId, input.dedupeKey)) continue;
      throw error;
    }
  }
  throw httpError(503, 'The album catch-up announcement changed concurrently; retry this observation.');
}

function formatRegistrationOtpMessage(t: TranslateFn, otp: string): string {
  return t('official.piwigo-gallery.registrationOtp', { otp });
}

function formatPiwigoAuthCodeMessage(
  t: TranslateFn,
  input: z.infer<typeof piwigoGalleryExternalActionSchemas.authCodeSend>
): string {
  const lines = [
    t('official.piwigo-gallery.authCode.header', { code: input.code }),
    '',
    t(PIWIGO_AUTH_CODE_PURPOSE_KEYS[input.purpose])
  ];
  if (input.username) lines.push(t('official.piwigo-gallery.authCode.account', { username: input.username }));
  if (input.deviceName) lines.push(t('official.piwigo-gallery.authCode.device', { deviceName: input.deviceName }));
  if (input.ip || input.location) {
    lines.push(t('official.piwigo-gallery.authCode.request', {
      ip: input.ip ?? t('official.piwigo-gallery.authCode.unknownIp'),
      location: input.location ?? t('official.piwigo-gallery.authCode.unknownLocation')
    }));
  }
  lines.push(
    '',
    t('official.piwigo-gallery.authCode.expires', { minutes: String(input.expiresInMinutes) }),
    t('official.piwigo-gallery.authCode.ignore')
  );
  return lines.join('\n');
}

interface PiwigoExternalIdentity {
  identityId: string;
  canonicalWid: string;
  piwigoAccountWid: string;
  deliveryChatId: string;
}

async function resolvePiwigoExternalIdentity(
  reference: string,
  contacts: PluginExternalActionRegistrationContext['platform']['contacts'],
  signal: AbortSignal
): Promise<PiwigoExternalIdentity> {
  throwIfAborted(signal);
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) {
    throw httpError(400, 'Invalid WhatsApp identity reference.');
  }
  const identity = await contacts.resolveIdentityReference(normalizedReference, signal).catch((error) => {
    if (error instanceof Error && error.message === 'A valid WhatsApp identity reference is required.') {
      throw httpError(400, 'Invalid WhatsApp phone number.');
    }
    throw error;
  });
  throwIfAborted(signal);
  const identityId = identity.identityId?.trim() ?? '';
  const canonicalWid = identity.canonicalWid.trim();
  const piwigoAccountWid = identity.addressBookWid.trim();
  const deliveryChatId = identity.deliveryChatId.trim();
  if (!identityId || !canonicalWid || !piwigoAccountWid || !deliveryChatId) {
    throw httpError(404, 'WhatsApp identity is not known to the bot.');
  }
  if (!await contacts.isKnownContact(piwigoAccountWid, signal)) {
    throw httpError(404, 'WhatsApp identity is not known to the bot.');
  }
  throwIfAborted(signal);
  return { identityId, canonicalWid, piwigoAccountWid, deliveryChatId };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Piwigo external action was aborted.');
  }
}

function hashRegistrationOtp(requestId: string, otp: string): string {
  return createHash('sha256').update(`${requestId}:${otp}`).digest('hex');
}

function defaultPiwigoGalleryTranslator(key: string, params: Record<string, unknown> = {}): string {
  const template = piwigoGalleryMessages[key] ?? key;
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? ''));
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
