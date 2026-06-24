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
  constructor(private readonly connection: GalleryConnection) {}

  acceptedTypes(): Promise<PiwigoAcceptedTypes> {
    return this.post<PiwigoAcceptedTypes>('local.whatsappMedia.acceptedTypes', {});
  }

  people(whatsappJid: string): Promise<PiwigoPeopleResult> {
    return this.post<PiwigoPeopleResult>('local.whatsappMedia.people', { whatsapp_jid: whatsappJid });
  }

  completeLinkRequest(
    requestToken: string,
    whatsappJid: string,
    decision: 'approve' | 'deny'
  ): Promise<{ status: string; username?: string }> {
    return this.post('local.whatsappLink.completeRequest', {
      request_token: requestToken,
      whatsapp_jid: whatsappJid,
      decision
    });
  }

  consumeLoginCode(code: string, whatsappJid: string): Promise<{ username: string }> {
    return this.post('local.whatsappAuth.consumeLoginCode', { code, whatsapp_jid: whatsappJid });
  }

  registerAccount(username: string, whatsappJid: string): Promise<{ username: string; pending?: boolean }> {
    return this.post('local.whatsappAccount.register', { username, whatsapp_jid: whatsappJid });
  }

  uploadForJid(input: {
    whatsappJid: string;
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
    form.set('onde', input.onde);
    form.set('quando', input.quando);
    form.set('with_user_ids', input.withUserIds.join(','));
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType });
    form.set('image', blob, input.filename);
    return this.request<PiwigoUploadResult>('local.whatsappMedia.uploadForJid', form);
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
    const response = await fetch(`${this.connection.piwigoBaseUrl}/ws.php?format=json&method=${encodeURIComponent(method)}`, {
      method: 'POST',
      body
    });
    const payload = await response.json() as PiwigoResponse<T>;
    if (!response.ok || payload.stat !== 'ok') {
      throw new Error(payload.stat === 'fail' ? (payload.message ?? `Piwigo error ${payload.err ?? response.status}`) : `Piwigo HTTP ${response.status}`);
    }
    return payload.result;
  }
}
