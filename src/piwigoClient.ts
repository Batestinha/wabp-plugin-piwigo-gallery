import type { GalleryConnection } from './config';
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import type { GalleryAlbumSource } from './albumMetadata';

export interface PiwigoAcceptedTypes {
  extensions: string[];
  media_only?: boolean | undefined;
  max_file_size?: number | null | undefined;
}

export interface PiwigoPerson {
  id: number;
  label: string;
}

export interface PiwigoPeopleResult {
  people: PiwigoPerson[];
}

export interface PiwigoStatusResult {
  ok: boolean;
  plugin: string;
  version?: string | undefined;
  upload_idempotency?: boolean | undefined;
  capabilities?: {
    upload_idempotency?: boolean | undefined;
    event_album_source_v1?: boolean | undefined;
  } | undefined;
}

export interface PiwigoEligibleScope {
  scope_id: string;
  label: string;
}

export interface PiwigoUploadResult {
  image_id: number;
  url?: string | undefined;
  category_id: number;
  category_label: string;
  created_category?: boolean | undefined;
  user_id?: number | undefined;
  username?: string | undefined;
}

export interface PiwigoDownloadForBotResult {
  filename: string;
  mime_type: string;
  content_base64: string;
}

export interface PiwigoCalendarPublishResult {
  scope_id: string;
  calendar_id: string;
  label: string;
  subscription_url?: string | undefined;
  webcal_url?: string | undefined;
  calendar_url?: string | undefined;
  updated_on: string;
}

const piwigoFailureSchema = z.object({
  stat: z.literal('fail'),
  err: z.number().int().optional(),
  message: z.string().optional()
}).passthrough();

const acceptedTypesSchema = z.object({
  extensions: z.array(z.string().trim().min(1)).min(1),
  media_only: z.boolean().optional(),
  max_file_size: z.number().int().nonnegative().nullable().optional()
}).passthrough();

const statusSchema = z.object({
  ok: z.boolean(),
  plugin: z.string().trim().min(1),
  version: z.string().trim().min(1).optional(),
  upload_idempotency: z.boolean().optional(),
  capabilities: z.object({
    upload_idempotency: z.boolean().optional(),
    event_album_source_v1: z.boolean().optional()
  }).passthrough().optional()
}).passthrough();

const uploadIdempotencyKeySchema = z.string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);

const peopleSchema = z.object({
  people: z.array(z.object({
    id: z.number().int().positive(),
    label: z.string().trim().min(1)
  }).passthrough())
}).passthrough();

const linkResultSchema = z.object({
  status: z.string().trim().min(1),
  username: z.string().optional()
}).passthrough();

const registrationResultSchema = z.object({
  username: z.string().trim().min(1),
  pending: z.boolean().optional()
}).passthrough();

const calendarPublishResultSchema = z.object({
  scope_id: z.string().trim().min(1),
  calendar_id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  subscription_url: z.string().optional(),
  webcal_url: z.string().optional(),
  calendar_url: z.string().optional(),
  updated_on: z.string().trim().min(1)
}).passthrough();

const uploadResultSchema = z.object({
  image_id: z.number().int().positive(),
  url: z.string().optional(),
  category_id: z.number().int().positive(),
  category_label: z.string().trim().min(1),
  created_category: z.boolean().optional(),
  user_id: z.number().int().positive().optional(),
  username: z.string().optional()
}).passthrough();

const downloadResultSchema = z.object({
  filename: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  content_base64: z.string().min(1)
}).passthrough();

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
  return status.ok === true && (
    status.upload_idempotency === true || status.capabilities?.upload_idempotency === true
  );
}

export function supportsPiwigoEventAlbumSource(status: PiwigoStatusResult): boolean {
  return status.ok === true && status.capabilities?.event_album_source_v1 === true;
}

export class PiwigoGalleryClient {
  constructor(
    private readonly connection: GalleryConnection,
    private readonly timeoutMs = 15_000,
    private readonly uploadTimeoutMs = 30 * 60_000
  ) {}

  acceptedTypes(): Promise<PiwigoAcceptedTypes> {
    return this.post('wabp.piwigo.media.acceptedTypes', {}, acceptedTypesSchema);
  }

  status(): Promise<PiwigoStatusResult> {
    return this.post('wabp.piwigo.status', {}, statusSchema);
  }

  people(whatsappJid: string, scopeId: string): Promise<PiwigoPeopleResult> {
    return this.post('wabp.piwigo.media.people', { whatsapp_jid: whatsappJid, scope_id: scopeId }, peopleSchema);
  }

  completeLinkRequest(
    requestToken: string,
    whatsappJid: string,
    decision: 'approve' | 'deny',
    input: {
      scopeId?: string | undefined;
      eligibleScopes?: PiwigoEligibleScope[] | undefined;
    } = {}
  ): Promise<{ status: string; username?: string | undefined }> {
    return this.post('wabp.piwigo.link.completeRequest', {
      request_token: requestToken,
      whatsapp_jid: whatsappJid,
      decision,
      ...(input.scopeId ? { scope_id: input.scopeId } : {}),
      ...(input.eligibleScopes ? { eligible_scopes_json: JSON.stringify(input.eligibleScopes) } : {})
    }, linkResultSchema);
  }

  registerAccount(username: string, whatsappJid: string, scopeId: string): Promise<{ username: string; pending?: boolean | undefined }> {
    return this.post(
      'wabp.piwigo.account.register',
      { username, whatsapp_jid: whatsappJid, scope_id: scopeId },
      registrationResultSchema
    );
  }

  publishCalendar(input: {
    scopeId: string;
    calendarId: string;
    label: string;
    icsBody: string;
  }): Promise<PiwigoCalendarPublishResult> {
    return this.post('wabp.piwigo.calendar.publish', {
      scope_id: input.scopeId,
      calendar_id: input.calendarId,
      label: input.label,
      ics_body: input.icsBody
    }, calendarPublishResultSchema);
  }

  uploadForJid(input: {
    idempotencyKey: string;
    whatsappJid: string;
    scopeId: string;
    onde: string;
    quando: string;
    withUserIds: number[];
    albumSource: GalleryAlbumSource;
    filename: string;
    mimeType: string;
    buffer?: Buffer | undefined;
    path?: string | undefined;
  }): Promise<PiwigoUploadResult> {
    const idempotencyKey = uploadIdempotencyKeySchema.parse(input.idempotencyKey);
    const form = new FormData();
    form.set('bot_secret', this.connection.botSecret);
    form.set('idempotency_key', idempotencyKey);
    form.set('whatsapp_jid', input.whatsappJid);
    form.set('scope_id', input.scopeId);
    form.set('onde', input.onde);
    form.set('quando', input.quando);
    form.set('with_user_ids', input.withUserIds.join(','));
    if (input.albumSource.kind === 'community-event') {
      form.set('source_kind', input.albumSource.kind);
      form.set('source_ref', input.albumSource.eventId);
      form.set('source_revision', input.albumSource.revision);
      form.set('source_label', input.albumSource.title);
    }
    return this.uploadFile(form, input);
  }

  private async uploadFile(
    form: FormData,
    input: { filename: string; mimeType: string; buffer?: Buffer | undefined; path?: string | undefined }
  ): Promise<PiwigoUploadResult> {
    if (Boolean(input.buffer) === Boolean(input.path)) {
      throw new Error('Piwigo upload requires exactly one media buffer or file path.');
    }
    const blob = input.path
      ? await openAsBlob(input.path, { type: input.mimeType })
      : new Blob([new Uint8Array(input.buffer!)], { type: input.mimeType });
    form.set('image', blob, input.filename);
    return this.request(
      'wabp.piwigo.media.uploadForJid',
      form,
      uploadResultSchema,
      this.uploadTimeoutMs
    );
  }

  async downloadForBot(input: {
    imageId?: number | undefined;
    fileId?: string | undefined;
    downloadToken?: string | undefined;
    whatsappJid?: string | undefined;
    scopeId?: string | undefined;
  }): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
    const result = await this.post('wabp.piwigo.media.downloadForBot', {
      ...(input.imageId !== undefined ? { image_id: input.imageId } : {}),
      ...(input.fileId ? { file_id: input.fileId } : {}),
      ...(input.downloadToken ? { download_token: input.downloadToken } : {}),
      ...(input.whatsappJid ? { whatsapp_jid: input.whatsappJid } : {}),
      ...(input.scopeId ? { scope_id: input.scopeId } : {})
    }, downloadResultSchema);
    return {
      filename: result.filename,
      mimeType: result.mime_type,
      buffer: Buffer.from(result.content_base64, 'base64')
    };
  }

  private post<T>(
    method: string,
    fields: Record<string, string | number | boolean>,
    resultSchema: z.ZodType<T>
  ): Promise<T> {
    const body = new URLSearchParams();
    body.set('bot_secret', this.connection.botSecret);
    for (const [key, value] of Object.entries(fields)) {
      body.set(key, String(value));
    }
    return this.request(method, body, resultSchema);
  }

  private async request<T>(
    method: string,
    body: BodyInit,
    resultSchema: z.ZodType<T>,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${this.connection.piwigoBaseUrl}/ws.php?format=json&method=${encodeURIComponent(method)}`, {
      method: 'POST',
      body,
      signal: controller.signal
    }).finally(() => {
      clearTimeout(timeout);
    });
    const text = await response.text();
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
        failure.data.err
      );
    }
    const envelope = z.object({ stat: z.literal('ok'), result: z.unknown() }).passthrough().safeParse(payload);
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
  }
}

function isAmbiguousHttpOutcome(status: number): boolean {
  return status >= 500 || status === 408 || status === 423 || status === 425 || status === 429 ||
    (status >= 200 && status < 300);
}
