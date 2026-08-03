import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TranslateFn } from '../../../platform/i18n';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginExternalActionRegistration } from '../../../platform/pluginRuntime/pluginExternalActions';
import type { PluginExternalActionRegistrationContext } from '../../../platform/pluginRuntime/types';
import { parsePiwigoGalleryConfig } from './config';
import {
  linkChoiceCountForScopes,
  listConfiguredPiwigoGalleryEligibleScopes
} from './eligibility';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_EXTERNAL_ACTIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import { piwigoGalleryMessages } from './messages';
import {
  bindAlbumAnnouncementTarget,
  consumeRegistrationOtp,
  getAlbumAnnouncementByDedupeKey,
  getRegistrationOtp,
  pruneExpiredRegistrationOtps,
  saveAlbumAnnouncement,
  saveLinkRequest,
  saveRegistrationOtp
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
  version: z.literal(1),
  requestId: z.string(),
  wid: z.string(),
  displayName: z.string().optional(),
  otp: z.string().regex(/^\d{6}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export const piwigoGalleryExternalActionSchemas = {
  whatsappLinkRequestStart: z.object({
    requestId: z.string().trim().min(1),
    requestToken: z.string().trim().min(1),
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
    albumId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    albumName: z.string().trim().min(1).max(200),
    siteLabel: z.string().trim().min(1).max(120),
    userDisplayName: z.string().trim().min(1).max(120),
    observedAt: z.string().trim().datetime().optional(),
    files: z.array(z.object({
      imageId: z.number().int().positive(),
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
    const wid = await resolveKnownWhatsAppRegistrationWid(input.phone, this.context.platform.contacts, signal);
    const scopes = await this.eligibleScopesForWid(wid);
    throwIfAborted(signal);
    if (scopes.length === 0) {
      throw httpError(403, 'WhatsApp identity is not a member of a Piwigo-enabled group.');
    }
    const linkChoiceCount = linkChoiceCountForScopes(scopes);
    const whatsappAliases = await this.context.platform.contacts.getContactAliases(wid, signal).catch(() => [wid]);
    throwIfAborted(signal);
    const now = new Date();
    const database = await this.database();
    saveLinkRequest(database, {
      requestId: input.requestId,
      requestToken: input.requestToken.toUpperCase(),
      phone: input.phone,
      whatsappJid: wid,
      whatsappAliases,
      siteLabel: input.siteLabel,
      linkChoiceCount,
      scopeOptions: scopes.map((scope) => ({ scopeId: scope.scopeId, label: scope.label })),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.expiresInMinutes * 60_000).toISOString()
    });
    await this.context.platform.messaging.sendText(
      wid,
      formatWhatsappLinkRequestMessage(
        await this.piwigoTranslator(wid, scopes[0]?.scopeId),
        input.username,
        input.siteLabel,
        linkChoiceCount
      ),
      { idempotencyKey: `piwigo-gallery:link-request:${input.requestId}` },
      signal
    );
    return {
      requestId: input.requestId,
      whatsappJid: wid,
      expiresInMinutes: input.expiresInMinutes,
      eligibleScopeCount: scopes.length
    };
  }

  async startRegistrationOtp(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.whatsappRegistrationOtpStart>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.whatsappRegistrationOtpStart>> {
    const database = await this.database();
    const wid = await resolveKnownWhatsAppRegistrationWid(input.phone, this.context.platform.contacts, signal);
    const now = new Date();
    pruneExpiredRegistrationOtps(database, now.toISOString());
    const existingRequest = getRegistrationOtp(database, input.requestId);
    if (existingRequest) {
      assertRegistrationOtpIdentity(existingRequest, wid, input.displayName);
      assertRegistrationOtpActive(existingRequest.status);
      const existingPayload = await this.registrationOtpPayload(input.requestId);
      if (!existingPayload) {
        throw httpError(409, 'This registration request cannot be retried because its original OTP is unavailable.');
      }
      assertRegistrationOtpPayload(existingPayload, input.requestId, wid, input.displayName);
      if (existingRequest.otpHash !== hashRegistrationOtp(input.requestId, existingPayload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
      if (existingRequest.expiresAt <= now.toISOString()) {
        throw httpError(410, 'WhatsApp registration code expired.');
      }
      await this.sendRegistrationOtp(existingPayload, signal);
      return registrationOtpStartOutput(input.requestId);
    }

    const candidatePayload: RegistrationOtpPayload = {
      version: 1,
      requestId: input.requestId,
      wid,
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
    assertRegistrationOtpPayload(payload, input.requestId, wid, input.displayName);
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
      wid,
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
      assertRegistrationOtpIdentity(preparedRequest, wid, input.displayName);
      assertRegistrationOtpActive(preparedRequest.status);
      if (preparedRequest.otpHash !== hashRegistrationOtp(input.requestId, payload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
    } else {
      saveRegistrationOtp(database, {
        requestId: input.requestId,
        wid,
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
      assertRegistrationOtpIdentity(persistedRequest, wid, input.displayName);
      assertRegistrationOtpActive(persistedRequest.status);
      if (persistedRequest.otpHash !== hashRegistrationOtp(input.requestId, payload.otp)) {
        throw httpError(409, 'Registration request state conflicts with the original OTP.');
      }
    }
    await this.sendRegistrationOtp(payload, signal);
    return registrationOtpStartOutput(input.requestId);
  }

  private async sendRegistrationOtp(payload: RegistrationOtpPayload, signal: AbortSignal): Promise<void> {
    await this.context.platform.messaging.sendText(
      payload.wid,
      formatRegistrationOtpMessage(await this.piwigoTranslator(payload.wid), payload.otp),
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
      whatsappJid: result.request.wid,
      ...(result.request.displayName ? { displayName: result.request.displayName } : {})
    };
  }

  async sendAuthCode(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.authCodeSend>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.authCodeSend>> {
    const whatsappJid = input.whatsappJid.toLowerCase();
    const idempotencyDigest = createHash('sha256')
      .update(JSON.stringify([whatsappJid, input.scopeId, input.purpose, input.code]))
      .digest('hex');
    const authCodeRateLimits = rateLimitPolicy(DEFAULT_AUTH_CODE_RATE_LIMITS, this.dependencies.authCodeRateLimits);
    await this.admitRateLimitedRequest({
      kind: 'auth-code',
      idempotencyId: idempotencyDigest,
      wid: whatsappJid,
      requestIp: input.ip,
      ttlSeconds: Math.max(input.expiresInMinutes * 60, authCodeRateLimits.windowSeconds),
      policy: authCodeRateLimits,
      signal
    });
    await this.context.platform.messaging.sendText(
      whatsappJid,
      formatPiwigoAuthCodeMessage(await this.piwigoTranslator(whatsappJid, input.scopeId), {
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
    const wid = input.whatsappJid ?? await resolveKnownWhatsAppRegistrationWid(
      input.phone!,
      this.context.platform.contacts,
      signal
    );
    const scopes = await this.eligibleScopesForWid(wid);
    throwIfAborted(signal);
    return {
      whatsappJid: wid,
      scopes: scopes.map((scope) => ({ scopeId: scope.scopeId, label: scope.label }))
    };
  }

  async observeAlbumUpload(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.albumUploadObserved>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.albumUploadObserved>> {
    const database = await this.database();
    const config = parsePiwigoGalleryConfig(await this.context.configFor(input.scopeId));
    if (!config.newAlbumAnnouncementsEnabled) {
      return { accepted: false, duplicate: false, reason: 'new album announcements are disabled for this scope' };
    }
    const albumId = input.albumId !== undefined ? String(input.albumId) : undefined;
    const dedupeKey = `${input.eventId}:${albumId ?? 'album'}`;
    let existing = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
    if (existing) {
      if (existing.status === 'pending') {
        let announcementGroupWid = existing.announcementGroupWid;
        if (!announcementGroupWid) {
          announcementGroupWid = config.announcementGroupWid ||
            await this.context.communityAnnouncementGroupWidForScope?.(input.scopeId);
          if (!announcementGroupWid || !(await this.groupBelongsToScope(input.scopeId, announcementGroupWid))) {
            return {
              accepted: false,
              duplicate: true,
              announcementId: existing.id,
              announceAt: existing.announceAt,
              reason: 'the legacy announcement target could not be resolved inside the callback scope'
            };
          }
          existing = bindAlbumAnnouncementTarget(database, {
            scopeId: input.scopeId,
            announcementId: existing.id,
            announcementGroupWid
          }) ?? existing;
        }
        throwIfAborted(signal);
        await enqueueAlbumAnnouncement(this.context, existing, announcementGroupWid, true);
      }
      return {
        accepted: existing.status === 'pending',
        duplicate: true,
        announcementId: existing.id,
        announceAt: existing.announceAt
      };
    }

    const announcementGroupWid = config.announcementGroupWid ||
      await this.context.communityAnnouncementGroupWidForScope?.(input.scopeId);
    if (!announcementGroupWid) {
      return { accepted: false, duplicate: false, reason: 'announcementGroupWid is not configured for this scope' };
    }
    if (!(await this.groupBelongsToScope(input.scopeId, announcementGroupWid))) {
      return { accepted: false, duplicate: false, reason: 'announcementGroupWid does not belong to the callback scope' };
    }
    throwIfAborted(signal);

    const observedAt = input.observedAt ?? new Date().toISOString();
    const announceAt = new Date(Math.max(
      Date.now(),
      new Date(observedAt).getTime() + config.newAlbumAnnouncementDelayMinutes * 60_000
    )).toISOString();
    const announcementId = randomUUID();
    throwIfAborted(signal);
    const announcement = saveAlbumAnnouncement(database, {
      id: announcementId,
      dedupeKey,
      scopeId: input.scopeId,
      announcementGroupWid,
      ...(albumId ? { albumId } : {}),
      albumName: input.albumName,
      siteLabel: input.siteLabel,
      userDisplayName: input.userDisplayName,
      files: input.files.map((file) => ({
        imageId: file.imageId,
        filename: file.filename,
        mimeType: file.mimeType
      })),
      observedAt,
      announceAt,
      status: 'pending'
    });
    throwIfAborted(signal);
    await enqueueAlbumAnnouncement(this.context, announcement, announcementGroupWid, false);
    return { accepted: true, duplicate: false, announcementId, announceAt };
  }

  private eligibleScopesForWid(wid: string) {
    return (this.dependencies.listEligibleScopes ?? listConfiguredPiwigoGalleryEligibleScopes)(wid, {
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
    wid: string;
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
        wid: input.wid,
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

  private async piwigoTranslator(wid: string, scopeId?: string | undefined): Promise<TranslateFn> {
    return this.context.i18n.translatorForIdentity(wid, scopeId).catch(() => defaultPiwigoGalleryTranslator);
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
  wid: string,
  displayName?: string | undefined
): void {
  if (
    payload.requestId !== requestId ||
    payload.wid !== wid ||
    (payload.displayName ?? undefined) !== (displayName ?? undefined)
  ) {
    throw httpError(409, 'requestId is already bound to a different WhatsApp identity or display name.');
  }
}

function assertRegistrationOtpIdentity(
  request: { wid: string; displayName?: string | undefined },
  wid: string,
  displayName?: string | undefined
): void {
  if (request.wid !== wid || (request.displayName ?? undefined) !== (displayName ?? undefined)) {
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
  wid: string;
  requestIp?: string | undefined;
  policy: PiwigoGalleryRateLimitPolicy;
}): Array<{ key: string; limit: number }> {
  const prefix = `${input.kind}:rate`;
  const dimensions = [
    {
      key: `${prefix}:wid:${opaqueKey(input.accountId, input.wid.toLowerCase())}`,
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
  const dueAt = announcement.downloadNextRetryAt ?? announcement.announceAt;
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

export function formatWhatsappLinkRequestMessage(
  t: TranslateFn,
  username: string,
  siteLabel: string,
  scopeCount: number
): string {
  return [
    t('official.piwigo-gallery.linkRequest', { username, siteLabel }),
    scopeCount > 1 ? t('official.piwigo-gallery.linkRequestScopeChoice', { siteLabel }) : undefined
  ].filter((line): line is string => Boolean(line)).join(' ');
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

async function resolveKnownWhatsAppRegistrationWid(
  phone: string,
  contacts: PluginExternalActionRegistrationContext['platform']['contacts'],
  signal: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const candidateWid = normalizeRegistrationPhoneWid(phone);
  if (await contacts.isKnownContact(candidateWid, signal)) return candidateWid;
  const aliases = await contacts.getContactAliases(candidateWid, signal);
  for (const alias of aliases) {
    if (alias && await contacts.isKnownContact(alias, signal)) return alias;
  }
  const candidateDigits = phoneDigitsFromWid(candidateWid);
  const knownContacts = await contacts.getKnownContacts(signal);
  const contact = knownContacts.find((row) =>
    row.wid === candidateWid || aliases.includes(row.wid) || phoneDigitsFromWid(row.wid) === candidateDigits
  );
  if (contact) return contact.wid;
  throw httpError(404, 'WhatsApp identity is not a known bot contact.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Piwigo external action was aborted.');
  }
}

function normalizeRegistrationPhoneWid(phone: string): string {
  const trimmed = phone.trim().toLowerCase();
  if (/^\d{7,15}@c\.us$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(digits)) throw httpError(400, 'Invalid WhatsApp phone number.');
  return `${digits}@c.us`;
}

function phoneDigitsFromWid(wid: string): string {
  return wid.toLowerCase().match(/^(\d+)@c\.us$/)?.[1] ?? '';
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
