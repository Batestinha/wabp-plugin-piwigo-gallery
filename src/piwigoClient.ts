import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import {
  OidcClientCredentialsTokenProvider,
  type ClientCredentialsTokenProvider
} from '../../../platform/identity/clientCredentialsTokenProvider';
import type { GalleryAlbumSource } from './albumMetadata';
import type { GalleryConnection } from './config';
import type { TopomareGalleryPrincipal } from './topomarePrincipal';
import { assertPiwigoGalleryOutboundMethod } from './uploadOnlyBoundary';

export interface PiwigoAcceptedTypes {
  extensions: string[];
  mediaOnly: true;
  maxFileSize: number;
}

export interface PiwigoPerson {
  id: number;
  label: string;
}

export interface PiwigoPeopleResult {
  people: PiwigoPerson[];
  /** Immutable Piwigo shadow-user ID affirmed for this Topomare subject. */
  piwigoUserId: number;
}

export interface PiwigoStatusResult {
  plugin: 'topomare_wabp_gallery';
  version: string;
  releaseReady: boolean;
  blockingGaps: string[];
  announcementDownloadMaxBytes: number;
  capabilities: {
    activePeopleContractVersion: 1;
    uploadResolutionContractVersion: 1;
    subjectUploadContractVersion: 1;
    subjectUploadIdempotencyVersion: 4;
    eventCommunityAlbumSourceVersion: 1;
    acceptedMediaTypesVersion: 1;
    announcementMediaDownloadVersion: 1;
    albumUploadObservedCallbackVersion: 3;
  };
}

export const PIWIGO_GALLERY_MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
export const PIWIGO_GALLERY_MAX_ANNOUNCEMENT_BYTES = 32 * 1024 * 1024;
const PIWIGO_GALLERY_MAX_ANNOUNCEMENT_RESPONSE_BYTES =
  Math.ceil(PIWIGO_GALLERY_MAX_ANNOUNCEMENT_BYTES * 4 / 3) + PIWIGO_GALLERY_MAX_JSON_RESPONSE_BYTES;

export interface PiwigoResolvedUploadContext {
  categoryId: number;
  categoryLabel: string;
  categoryUrl: string;
  createdCategory: boolean;
  onde: string;
  quando: string;
  withUserIds: number[];
  albumSource: GalleryAlbumSource | null;
}

export interface PiwigoUploadResult extends PiwigoResolvedUploadContext {
  imageId: number;
  url: string;
  idempotencyKey: string;
  piwigoUserId: number;
}

const piwigoFailureSchema = z.object({
  stat: z.literal('fail'),
  err: z.number().int().optional(),
  message: z.string().optional()
}).passthrough();

const acceptedTypesSchema = z.object({
  schema_version: z.literal(1),
  extensions: z.array(z.string().trim().min(1)).min(1),
  media_only: z.literal(true),
  upload_form_all_types: z.boolean(),
  max_file_size: z.number().int().positive().safe()
}).strict();

const statusSchema = z.object({
  schema_version: z.literal(1),
  plugin: z.literal('topomare_wabp_gallery'),
  version: z.string().trim().min(1),
  release_ready: z.boolean(),
  blocking_gaps: z.array(z.string().trim().min(1)),
  capabilities: z.object({
    active_people_contract: z.object({
      version: z.literal(1),
      subject_bound: z.literal(true),
      lifecycle_authority: z.literal('topomare')
    }).strict(),
    upload_resolution_contract: z.object({
      version: z.literal(1),
      subject_bound: z.literal(true),
      scope_authority: z.literal('wabp'),
      category_url: z.literal('absolute_same_origin_https')
    }).strict(),
    subject_upload_contract: z.object({
      version: z.literal(1),
      subject_authorization_version: z.literal(1),
      image_url: z.literal('absolute_same_origin_https'),
      category_url: z.literal('absolute_same_origin_https'),
      identity_binding: z.object({
        topomare_user_id: z.literal(true),
        wabp_provider_namespace: z.literal(true),
        wabp_identity_id: z.literal(true),
        piwigo_provider_namespace: z.literal(true),
        piwigo_user_id: z.literal(true)
      }).strict(),
      idempotency: z.object({
        version: z.literal(4),
        required: z.literal(true),
        key_pattern: z.literal('^v4:[A-Za-z0-9][A-Za-z0-9._:-]{12,123}$'),
        stable_image_id: z.literal(true),
        stable_wabp_identity_binding: z.literal(true),
        album_source_binding: z.literal(true)
      }).strict()
    }).strict(),
    event_community_album_source: z.object({
      version: z.literal(1),
      source_kind: z.literal('community-event'),
      scope_authority: z.literal('wabp'),
      stable_source_mapping: z.literal(true),
      revision_required: z.literal(true)
    }).strict(),
    accepted_media_types: z.object({
      version: z.literal(1),
      media_only: z.literal(true)
    }).strict(),
    announcement_media_download: z.object({
      version: z.literal(1),
      expected_sha256_required: z.literal(true),
      encoding: z.literal('base64'),
      max_bytes: z.number().int().positive().safe()
    }).strict(),
    album_upload_observed_callback: z.object({
      version: z.literal(3),
      action: z.literal('piwigo.albumUploadObserved'),
      stable_event_id: z.literal(true),
      delivery_mode: z.literal('durable_per_file_outbox'),
      file_sha256_required: z.literal(true),
      payload_fields: z.tuple([
        z.literal('eventId'),
        z.literal('scopeId'),
        z.literal('albumId'),
        z.literal('albumName'),
        z.literal('siteLabel'),
        z.literal('userDisplayName'),
        z.literal('observedAt'),
        z.literal('files')
      ])
    }).strict(),
    consumer_preflight: z.object({
      version: z.literal(1),
      release_ready_required: z.literal(true),
      required_capability_versions: z.object({
        active_people_contract: z.literal(1),
        upload_resolution_contract: z.literal(1),
        subject_upload_contract: z.literal(1),
        subject_upload_idempotency: z.literal(4),
        event_community_album_source: z.literal(1),
        accepted_media_types: z.literal(1),
        announcement_media_download: z.literal(1),
        album_upload_observed_callback: z.literal(3)
      }).strict()
    }).strict()
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.release_ready !== (value.blocking_gaps.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['release_ready'],
      message: 'release_ready must agree with blocking_gaps'
    });
  }
});

const uploadIdempotencyKeySchema = z.string()
  .min(16)
  .max(127)
  .regex(/^v4:[A-Za-z0-9][A-Za-z0-9._:-]{12,123}$/u);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const absoluteHttpsUrlSchema = z.string().url().refine(
  (value) => new URL(value).protocol === 'https:',
  'URL must use HTTPS'
);

const stableIdentifierSchema = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const canonicalUuidSchema = z.string().uuid().refine(
  (value) => value === value.toLowerCase(),
  'UUID must be canonical lowercase text'
);

const identityEchoSchema = z.object({
  schema_version: z.literal(1),
  topomare_user_id: canonicalUuidSchema,
  wabp_provider_namespace: stableIdentifierSchema,
  wabp_identity_id: stableIdentifierSchema,
  piwigo_provider_namespace: stableIdentifierSchema,
  piwigo_user_id: z.number().int().positive().safe(),
  scope_id: stableIdentifierSchema
}).strict();

const peopleSchema = identityEchoSchema.extend({
  people: z.array(z.object({
    id: z.number().int().positive().safe(),
    label: z.string().trim().min(1)
  }).strict()).max(500)
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.people.length; index += 1) {
    if (value.people[index - 1]!.id >= value.people[index]!.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['people', index, 'id'],
        message: 'people must be strictly ordered by unique Piwigo user ID'
      });
    }
  }
});

const albumSourceSchema = z.object({
  kind: z.literal('community-event'),
  ref: z.string().trim().min(1),
  revision: sha256Schema,
  label: z.string().trim().min(1)
}).strict();

const resolvedUploadSchema = identityEchoSchema.extend({
  category_id: z.number().int().positive().safe(),
  category_label: z.string().trim().min(1),
  category_url: absoluteHttpsUrlSchema,
  created_category: z.boolean(),
  onde: z.string(),
  quando: z.string(),
  with_user_ids: z.array(z.number().int().positive().safe()),
  album_source: albumSourceSchema.nullable()
}).strict();

const uploadResultSchema = resolvedUploadSchema.extend({
  image_id: z.number().int().positive().safe(),
  url: absoluteHttpsUrlSchema,
  idempotency_key: uploadIdempotencyKeySchema
}).strict();

const announcementDownloadResultSchema = z.object({
  schema_version: z.literal(1),
  image_id: z.number().int().positive().safe(),
  filename: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().positive().safe(),
  sha256: sha256Schema,
  content_base64: z.string().min(1)
}).strict();

export class PiwigoApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly httpStatus?: number | undefined,
    readonly piwigoCode?: number | undefined,
    options?: (ErrorOptions & { ambiguousOutcome?: boolean | undefined }) | undefined
  ) {
    super(message, options);
    this.name = 'PiwigoApiError';
    this.ambiguousOutcome = options?.ambiguousOutcome === true;
  }

  readonly ambiguousOutcome: boolean;
}

export function supportsPiwigoUploadIdempotency(status: PiwigoStatusResult): boolean {
  return status.releaseReady && status.capabilities.subjectUploadIdempotencyVersion === 4;
}

export function supportsPiwigoEventAlbumSource(status: PiwigoStatusResult): boolean {
  return status.releaseReady && status.capabilities.eventCommunityAlbumSourceVersion === 1;
}

export class PiwigoGalleryClient {
  readonly #tokens: ClientCredentialsTokenProvider;

  constructor(
    private readonly connection: GalleryConnection,
    tokenProvider?: ClientCredentialsTokenProvider | undefined,
    private readonly timeoutMs = 15_000,
    private readonly uploadTimeoutMs = 30 * 60_000
  ) {
    this.#tokens = tokenProvider ?? new OidcClientCredentialsTokenProvider({
      issuer: connection.topomareOidcIssuer,
      clientId: connection.serviceOidcClientId,
      clientSecret: connection.serviceOidcClientSecret
    });
  }

  async acceptedTypes(): Promise<PiwigoAcceptedTypes> {
    const result = await this.post('topomare.gallery.acceptedMediaTypes', {}, acceptedTypesSchema);
    return {
      extensions: result.extensions,
      mediaOnly: result.media_only,
      maxFileSize: result.max_file_size
    };
  }

  async status(): Promise<PiwigoStatusResult> {
    const result = await this.post('topomare.gallery.integrationStatus', {}, statusSchema);
    return {
      plugin: result.plugin,
      version: result.version,
      releaseReady: result.release_ready,
      blockingGaps: result.blocking_gaps,
      announcementDownloadMaxBytes: result.capabilities.announcement_media_download.max_bytes,
      capabilities: {
        activePeopleContractVersion: result.capabilities.active_people_contract.version,
        uploadResolutionContractVersion: result.capabilities.upload_resolution_contract.version,
        subjectUploadContractVersion: result.capabilities.subject_upload_contract.version,
        subjectUploadIdempotencyVersion: result.capabilities.subject_upload_contract.idempotency.version,
        eventCommunityAlbumSourceVersion: result.capabilities.event_community_album_source.version,
        acceptedMediaTypesVersion: result.capabilities.accepted_media_types.version,
        announcementMediaDownloadVersion: result.capabilities.announcement_media_download.version,
        albumUploadObservedCallbackVersion: result.capabilities.album_upload_observed_callback.version
      }
    };
  }

  async preflight(): Promise<PiwigoStatusResult> {
    const status = await this.status();
    if (
      !status.releaseReady ||
      status.announcementDownloadMaxBytes > PIWIGO_GALLERY_MAX_ANNOUNCEMENT_BYTES
    ) {
      throw new PiwigoApiError(
        'Piwigo Topomare Gallery transport is not release-ready.',
        'topomare.gallery.integrationStatus',
        undefined,
        503
      );
    }
    return status;
  }

  async people(
    principal: TopomareGalleryPrincipal,
    scopeId: string
  ): Promise<PiwigoPeopleResult> {
    const result = await this.post(
      'topomare.gallery.peopleForSubject',
      subjectFields(principal, scopeId),
      peopleSchema
    );
    assertIdentityEcho(
      result,
      principal,
      scopeId,
      this.connection.topomareWabpProviderNamespace,
      this.connection.topomarePiwigoProviderNamespace
    );
    return { people: result.people, piwigoUserId: result.piwigo_user_id };
  }

  async resolveUploadForSubject(input: {
    principal: TopomareGalleryPrincipal;
    scopeId: string;
    onde: string;
    quando: string;
    withUserIds: number[];
    albumSource: GalleryAlbumSource;
    piwigoUserId: number;
  }): Promise<PiwigoResolvedUploadContext> {
    const result = await this.post(
      'topomare.gallery.resolveUploadForSubject',
      uploadContextFields(input),
      resolvedUploadSchema
    );
    assertIdentityEcho(
      result,
      input.principal,
      input.scopeId,
      this.connection.topomareWabpProviderNamespace,
      this.connection.topomarePiwigoProviderNamespace,
      input.piwigoUserId
    );
    assertUploadContextEcho(result, input);
    assertExpectedPublicOrigin(
      this.connection.piwigoBaseUrl,
      [result.category_url],
      'topomare.gallery.resolveUploadForSubject'
    );
    return resolvedUploadResult(result, input.albumSource);
  }

  async uploadForSubject(input: {
    idempotencyKey: string;
    principal: TopomareGalleryPrincipal;
    scopeId: string;
    onde: string;
    quando: string;
    withUserIds: number[];
    albumSource: GalleryAlbumSource;
    piwigoUserId: number;
    filename: string;
    mimeType: string;
    buffer?: Buffer | undefined;
    path?: string | undefined;
  }): Promise<PiwigoUploadResult> {
    const idempotencyKey = uploadIdempotencyKeySchema.parse(input.idempotencyKey);
    const form = new FormData();
    for (const [key, value] of Object.entries(uploadContextFields(input))) {
      form.set(key, String(value));
    }
    form.set('idempotency_key', idempotencyKey);
    const result = await this.uploadFile(form, input);
    try {
      assertIdentityEcho(
        result,
        input.principal,
        input.scopeId,
        this.connection.topomareWabpProviderNamespace,
        this.connection.topomarePiwigoProviderNamespace,
        input.piwigoUserId
      );
      assertUploadContextEcho(result, input);
      assertExpectedPublicOrigin(
        this.connection.piwigoBaseUrl,
        [result.category_url, result.url],
        'topomare.gallery.uploadForSubject'
      );
      if (result.idempotency_key !== idempotencyKey) {
        throw new PiwigoApiError(
          'Piwigo upload response did not echo the durable v4 idempotency key.',
          'topomare.gallery.uploadForSubject'
        );
      }
      return {
        ...resolvedUploadResult(result, input.albumSource),
        imageId: result.image_id,
        url: result.url,
        idempotencyKey: result.idempotency_key,
        piwigoUserId: result.piwigo_user_id
      };
    } catch (error) {
      throw new PiwigoApiError(
        'Piwigo upload result failed immutable post-upload validation.',
        'topomare.gallery.uploadForSubject',
        undefined,
        undefined,
        { cause: sanitizedRequestCause(error), ambiguousOutcome: true }
      );
    }
  }

  async downloadForAnnouncement(input: {
    imageId: number;
    expectedSha256: string;
  }): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
    const method = 'topomare.gallery.downloadAnnouncementMedia';
    const imageId = z.number().int().positive().safe().parse(input.imageId);
    const expectedSha256 = sha256Schema.parse(input.expectedSha256);
    const result = await this.post(
      method,
      { image_id: imageId, expected_sha256: expectedSha256 },
      announcementDownloadResultSchema,
      PIWIGO_GALLERY_MAX_ANNOUNCEMENT_RESPONSE_BYTES
    );
    if (result.image_id !== imageId || result.sha256 !== expectedSha256) {
      throw new PiwigoApiError('Piwigo announcement media identity did not match the request.', method);
    }
    if (result.size_bytes > PIWIGO_GALLERY_MAX_ANNOUNCEMENT_BYTES) {
      throw new PiwigoApiError('Piwigo announcement media exceeds the local byte limit.', method);
    }
    const buffer = Buffer.from(result.content_base64, 'base64');
    const actualSha256 = createHash('sha256').update(buffer).digest('hex');
    if (
      buffer.length !== result.size_bytes ||
      actualSha256 !== expectedSha256 ||
      buffer.toString('base64') !== result.content_base64
    ) {
      throw new PiwigoApiError('Piwigo announcement media failed local SHA-256 verification.', method);
    }
    return { filename: result.filename, mimeType: result.mime_type, buffer };
  }

  private async uploadFile(
    form: FormData,
    input: { filename: string; mimeType: string; buffer?: Buffer | undefined; path?: string | undefined }
  ): Promise<z.infer<typeof uploadResultSchema>> {
    if (Boolean(input.buffer) === Boolean(input.path)) {
      throw new Error('Piwigo upload requires exactly one media buffer or file path.');
    }
    const blob = input.path
      ? await openAsBlob(input.path, { type: input.mimeType })
      : new Blob([new Uint8Array(input.buffer!)], { type: input.mimeType });
    form.set('image', blob, input.filename);
    return await this.request(
      'topomare.gallery.uploadForSubject',
      form,
      uploadResultSchema,
      this.uploadTimeoutMs
    );
  }

  private async post<T>(
    method: string,
    fields: Record<string, string | number | boolean>,
    resultSchema: z.ZodType<T>,
    maxResponseBytes = PIWIGO_GALLERY_MAX_JSON_RESPONSE_BYTES
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    return await this.request(method, body, resultSchema, this.timeoutMs, maxResponseBytes);
  }

  private async request<T>(
    method: string,
    body: BodyInit,
    resultSchema: z.ZodType<T>,
    timeoutMs = this.timeoutMs,
    maxResponseBytes = PIWIGO_GALLERY_MAX_JSON_RESPONSE_BYTES
  ): Promise<T> {
    assertPiwigoGalleryOutboundMethod(method);
    const bearer = await this.#tokens.accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(
        `${this.connection.piwigoBaseUrl}/ws.php?format=json&method=${encodeURIComponent(method)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}` },
          body,
          redirect: 'error',
          signal: controller.signal
        }
      );
    } catch (error) {
      clearTimeout(timeout);
      throw new PiwigoApiError(
        `Piwigo request failed for ${method}.`,
        method,
        undefined,
        undefined,
        { cause: sanitizedRequestCause(error), ambiguousOutcome: true }
      );
    }
    try {
      if (response.status === 401) this.#tokens.invalidate();
      const text = await readBoundedResponseText(response, maxResponseBytes, method);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new PiwigoApiError(
          `Piwigo returned non-JSON response for ${method}: HTTP ${response.status}`,
          method,
          response.status,
          undefined,
          { cause: error, ambiguousOutcome: isAmbiguousHttpOutcome(response.status) }
        );
      }
      const failure = piwigoFailureSchema.safeParse(payload);
      if (failure.success) {
        throw new PiwigoApiError(
          failure.data.message ?? `Piwigo error ${failure.data.err ?? response.status}`,
          method,
          response.status,
          failure.data.err,
          // A strict Piwigo failure envelope is an authoritative application
          // rejection. Callers may still classify its numeric code as
          // retryable, but it is not an unknown transport outcome.
          { ambiguousOutcome: false }
        );
      }
      if (!response.ok) {
        throw new PiwigoApiError(
          `Piwigo rejected ${method}: HTTP ${response.status}`,
          method,
          response.status,
          undefined,
          { ambiguousOutcome: isAmbiguousHttpOutcome(response.status) }
        );
      }
      const envelope = z.object({ stat: z.literal('ok'), result: z.unknown() }).strict().safeParse(payload);
      if (!envelope.success) {
        throw new PiwigoApiError(
          `Piwigo returned an invalid response envelope for ${method}.`,
          method,
          response.status,
          undefined,
          { cause: envelope.error, ambiguousOutcome: true }
        );
      }
      const result = resultSchema.safeParse(envelope.data.result);
      if (!result.success) {
        throw new PiwigoApiError(
          `Piwigo returned an invalid result for ${method}.`,
          method,
          response.status,
          undefined,
          { cause: result.error, ambiguousOutcome: true }
        );
      }
      return result.data;
    } catch (error) {
      if (error instanceof PiwigoApiError) throw error;
      throw new PiwigoApiError(
        `Piwigo response failed for ${method}.`,
        method,
        response.status,
        undefined,
        { cause: sanitizedRequestCause(error), ambiguousOutcome: true }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function subjectFields(
  principal: TopomareGalleryPrincipal,
  scopeId: string
): Record<string, string> {
  return {
    topomare_user_id: principal.topomareUserId,
    wabp_identity_id: principal.wabpIdentityId,
    scope_id: scopeId
  };
}

function uploadContextFields(input: {
  principal: TopomareGalleryPrincipal;
  scopeId: string;
  onde: string;
  quando: string;
  withUserIds: number[];
  albumSource: GalleryAlbumSource;
}): Record<string, string> {
  const fields: Record<string, string> = {
    ...subjectFields(input.principal, input.scopeId),
    onde: input.onde,
    quando: input.quando,
    with_user_ids: canonicalUserIds(input.withUserIds).join(',')
  };
  if (input.albumSource.kind === 'community-event') {
    fields.source_kind = input.albumSource.kind;
    fields.source_ref = input.albumSource.eventId;
    fields.source_revision = input.albumSource.revision;
    fields.source_label = input.albumSource.title;
  }
  return fields;
}

function assertIdentityEcho(
  result: z.infer<typeof identityEchoSchema>,
  principal: TopomareGalleryPrincipal,
  scopeId: string,
  configuredWabpProviderNamespace: string,
  configuredPiwigoProviderNamespace: string,
  expectedPiwigoUserId?: number | undefined
): void {
  if (
    result.topomare_user_id !== principal.topomareUserId ||
    result.wabp_provider_namespace !== principal.wabpProviderNamespace ||
    result.wabp_provider_namespace !== configuredWabpProviderNamespace ||
    result.wabp_identity_id !== principal.wabpIdentityId ||
    result.piwigo_provider_namespace !== configuredPiwigoProviderNamespace ||
    (expectedPiwigoUserId !== undefined && result.piwigo_user_id !== expectedPiwigoUserId) ||
    result.scope_id !== scopeId
  ) {
    throw new PiwigoApiError(
      'Piwigo subject response did not match the requested identity and scope.',
      'topomare.gallery.subject-contract'
    );
  }
}

function assertExpectedPublicOrigin(
  configuredBaseUrl: string,
  responseUrls: readonly string[],
  method: string
): void {
  const expectedOrigin = new URL(configuredBaseUrl).origin;
  for (const responseUrl of responseUrls) {
    const parsed = new URL(responseUrl);
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin) {
      throw new PiwigoApiError(
        'Piwigo returned a URL outside the configured public HTTPS origin.',
        method
      );
    }
  }
}

function assertUploadContextEcho(
  result: z.infer<typeof resolvedUploadSchema>,
  input: {
    onde: string;
    quando: string;
    withUserIds: number[];
    albumSource: GalleryAlbumSource;
  }
): void {
  const expectedUserIds = canonicalUserIds(input.withUserIds);
  const actualSource = result.album_source;
  const sourceMatches = input.albumSource.kind === 'manual'
    ? actualSource === null
    : actualSource !== null &&
      actualSource.kind === 'community-event' &&
      actualSource.ref === input.albumSource.eventId &&
      actualSource.revision === input.albumSource.revision &&
      actualSource.label === input.albumSource.title;
  if (
    result.onde !== input.onde ||
    result.quando !== input.quando ||
    !sameNumberArray(result.with_user_ids, expectedUserIds) ||
    !sourceMatches
  ) {
    throw new PiwigoApiError(
      'Piwigo upload context response did not match the requested immutable context.',
      'topomare.gallery.upload-context-contract'
    );
  }
}

function resolvedUploadResult(
  result: z.infer<typeof resolvedUploadSchema>,
  expectedAlbumSource: GalleryAlbumSource
): PiwigoResolvedUploadContext {
  return {
    categoryId: result.category_id,
    categoryLabel: result.category_label,
    categoryUrl: result.category_url,
    createdCategory: result.created_category,
    onde: result.onde,
    quando: result.quando,
    withUserIds: result.with_user_ids,
    albumSource: expectedAlbumSource.kind === 'community-event' ? expectedAlbumSource : null
  };
}

function canonicalUserIds(values: number[]): number[] {
  return [...new Set(values.map((value) => z.number().int().positive().safe().parse(value)))]
    .sort((left, right) => left - right);
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizedRequestCause(error: unknown): Error {
  return new Error(error instanceof Error && error.name === 'AbortError'
    ? 'request timed out'
    : 'network request failed');
}

function isAmbiguousHttpOutcome(status: number): boolean {
  return status >= 500 || status === 408 || status === 423 || status === 425 || status === 429 ||
    (status >= 200 && status < 300);
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  method: string
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new PiwigoApiError(
        `Piwigo response exceeded the local byte limit for ${method}.`,
        method,
        response.status,
        undefined,
        { ambiguousOutcome: isAmbiguousHttpOutcome(response.status) }
      );
    }
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PiwigoApiError(
          `Piwigo response exceeded the local byte limit for ${method}.`,
          method,
          response.status,
          undefined,
          { ambiguousOutcome: isAmbiguousHttpOutcome(response.status) }
        );
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PiwigoApiError(
        `Piwigo returned invalid UTF-8 for ${method}.`,
        method,
        response.status,
        undefined,
        { ambiguousOutcome: isAmbiguousHttpOutcome(response.status) }
      );
    }
  } finally {
    reader.releaseLock();
  }
}
