import type { GalleryConnection } from './config';

export interface PiwigoAcceptedTypes {
  extensions: string[];
  media_only?: boolean;
  max_file_size?: number | null;
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
}

export interface PiwigoEligibleScope {
  scope_id: string;
  label: string;
}

export interface PiwigoUploadResult {
  image_id: number;
  url?: string;
  category_id: number;
  category_label: string;
  created_category?: boolean;
  user_id?: number;
  username?: string;
}

type PiwigoResponse<T> =
  | { stat: 'ok'; result: T }
  | { stat: 'fail'; err?: number; message?: string };

export class PiwigoGalleryClient {
  constructor(
    private readonly connection: GalleryConnection,
    private readonly timeoutMs = 15_000
  ) {}

  acceptedTypes(): Promise<PiwigoAcceptedTypes> {
    return this.post<PiwigoAcceptedTypes>('wabp.piwigo.media.acceptedTypes', {});
  }

  status(): Promise<PiwigoStatusResult> {
    return this.post<PiwigoStatusResult>('wabp.piwigo.status', {});
  }

  people(whatsappJid: string, scopeId: string): Promise<PiwigoPeopleResult> {
    return this.post<PiwigoPeopleResult>('wabp.piwigo.media.people', { whatsapp_jid: whatsappJid, scope_id: scopeId });
  }

  completeLinkRequest(
    requestToken: string,
    whatsappJid: string,
    decision: 'approve' | 'deny',
    input: {
      scopeId?: string | undefined;
      eligibleScopes?: PiwigoEligibleScope[] | undefined;
    } = {}
  ): Promise<{ status: string; username?: string }> {
    return this.post('wabp.piwigo.link.completeRequest', {
      request_token: requestToken,
      whatsapp_jid: whatsappJid,
      decision,
      ...(input.scopeId ? { scope_id: input.scopeId } : {}),
      ...(input.eligibleScopes ? { eligible_scopes_json: JSON.stringify(input.eligibleScopes) } : {})
    });
  }

  consumeLoginCode(code: string, whatsappJid: string): Promise<{ username: string }> {
    return this.post('wabp.piwigo.auth.consumeLoginCode', { code, whatsapp_jid: whatsappJid });
  }

  registerAccount(username: string, whatsappJid: string, scopeId: string): Promise<{ username: string; pending?: boolean }> {
    return this.post('wabp.piwigo.account.register', { username, whatsapp_jid: whatsappJid, scope_id: scopeId });
  }

  uploadForJid(input: {
    whatsappJid: string;
    scopeId: string;
    onde: string;
    quando: string;
    withUserIds: number[];
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<PiwigoUploadResult> {
    const form = new FormData();
    form.set('bot_secret', this.connection.botSecret);
    form.set('whatsapp_jid', input.whatsappJid);
    form.set('scope_id', input.scopeId);
    form.set('onde', input.onde);
    form.set('quando', input.quando);
    form.set('with_user_ids', input.withUserIds.join(','));
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType });
    form.set('image', blob, input.filename);
    return this.request<PiwigoUploadResult>('wabp.piwigo.media.uploadForJid', form);
  }

  private post<T>(method: string, fields: Record<string, string | number | boolean>): Promise<T> {
    const body = new URLSearchParams();
    body.set('bot_secret', this.connection.botSecret);
    for (const [key, value] of Object.entries(fields)) {
      body.set(key, String(value));
    }
    return this.request<T>(method, body);
  }

  private async request<T>(method: string, body: BodyInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const response = await fetch(`${this.connection.piwigoBaseUrl}/ws.php?format=json&method=${encodeURIComponent(method)}`, {
      method: 'POST',
      body,
      signal: controller.signal
    }).finally(() => {
      clearTimeout(timeout);
    });
    const text = await response.text();
    let payload: PiwigoResponse<T>;
    try {
      payload = JSON.parse(text) as PiwigoResponse<T>;
    } catch {
      throw new Error(`Piwigo returned non-JSON response for ${method}: HTTP ${response.status}`);
    }
    if (payload.stat === 'ok') {
      return payload.result;
    }
    throw new Error(payload.message ?? `Piwigo error ${payload.err ?? response.status}`);
  }
}
