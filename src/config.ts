import { z } from 'zod';

export const PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV = 'PIWIGO_GALLERY_DEFAULT_BASE_URL';
export const PIWIGO_GALLERY_DEFAULT_BOT_SECRET_ENV = 'PIWIGO_GALLERY_DEFAULT_BOT_SECRET';

export const piwigoGalleryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoFinalizeMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxFileBytes: z.number().int().positive().max(25 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
  mediaDumpDocumentsHint: z.string().trim().max(500).default(''),
  accountCreationLabel: z.string().trim().min(1).max(120).default('Piwigo'),
  accountProfileUrl: z.string().trim().url().or(z.literal('')).default(''),
  newAlbumAnnouncementsEnabled: z.boolean().default(false),
  announcementGroupWid: z.string().trim().regex(/^[^\s@]+@g\.us$/i).or(z.literal('')).default(''),
  newAlbumAnnouncementDelayMinutes: z.number().int().min(1).max(24 * 60).default(120)
}).strip();

export type PiwigoGalleryConfig = z.infer<typeof piwigoGalleryConfigSchema>;

export interface GalleryConnection {
  piwigoBaseUrl: string;
  botSecret: string;
}

export function parsePiwigoGalleryConfig(input: unknown): PiwigoGalleryConfig {
  return piwigoGalleryConfigSchema.parse(input);
}

export function configConnection(
  _config: PiwigoGalleryConfig,
  defaultBaseUrl?: string | undefined,
  defaultBotSecret?: string | undefined
): GalleryConnection | undefined {
  const piwigoBaseUrl = resolvePiwigoBaseUrl(defaultBaseUrl);
  const botSecret = resolvePiwigoBotSecret(defaultBotSecret);
  if (!piwigoBaseUrl || !botSecret) {
    return undefined;
  }
  return {
    piwigoBaseUrl,
    botSecret
  };
}

export function resolvePiwigoBaseUrl(defaultBaseUrl?: string | undefined): string {
  return normalizeOptionalUrl(defaultBaseUrl?.trim() ? defaultBaseUrl : defaultPiwigoBaseUrl());
}

export function defaultPiwigoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOptionalUrl(env[PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV]?.trim() ?? '');
}

export function resolvePiwigoBotSecret(defaultBotSecret?: string | undefined): string {
  return defaultBotSecret?.trim() || defaultPiwigoBotSecret();
}

export function defaultPiwigoBotSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env[PIWIGO_GALLERY_DEFAULT_BOT_SECRET_ENV]?.trim() ?? '';
}

function normalizeOptionalUrl(input: string): string {
  const value = input.trim();
  if (!value || !z.string().url().safeParse(value).success) {
    return '';
  }
  return normalizePiwigoBaseUrl(value);
}

export function normalizePiwigoBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
