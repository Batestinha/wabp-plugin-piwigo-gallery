import { z } from 'zod';

export const PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV = 'PIWIGO_GALLERY_DEFAULT_BASE_URL';
export const PIWIGO_GALLERY_DEFAULT_BOT_SECRET_ENV = 'PIWIGO_GALLERY_DEFAULT_BOT_SECRET';
export const PIWIGO_GALLERY_ACCOUNT_PROFILE_URL_ENV = 'PIWIGO_GALLERY_ACCOUNT_PROFILE_URL';
export const PIWIGO_GALLERY_UNLIMITED_FILE_BYTES = Number.MAX_SAFE_INTEGER;
export const PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS = ['album', 'site', 'user'] as const;

const piwigoAlbumAnnouncementTemplateSchema = z.string().trim().max(500).superRefine((template, ctx) => {
  const allowed = new Set<string>(PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS);
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)) {
    const token = match[1]!;
    if (!allowed.has(token)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown announcement template variable {${token}}`
      });
    }
  }
});

export const piwigoGalleryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoFinalizeMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxFileBytes: z.number().int().min(0).max(25 * 1024 * 1024 * 1024).default(0),
  access: z.object({
    allowScopeMemberUploads: z.boolean().default(false)
  }).default({}),
  mediaDumpDocumentsHint: z.string().trim().max(500).default(''),
  accountCreationLabel: z.string().trim().min(1).max(120).default('Piwigo'),
  accountProfileUrl: z.string().trim().url().or(z.literal('')).default(''),
  newAlbumAnnouncementsEnabled: z.boolean().default(false),
  announcementGroupWid: z.string().trim().regex(/^[^\s@]+@g\.us$/i).or(z.literal('')).default(''),
  newAlbumAnnouncementTemplate: piwigoAlbumAnnouncementTemplateSchema.default(''),
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

export function renderPiwigoAlbumAnnouncementTemplate(
  template: string,
  values: Record<(typeof PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS)[number], string>
): string {
  return template.replace(/\{(album|site|user)\}/g, (_, token: keyof typeof values) => values[token]);
}

/**
 * Zero is the explicit no-configured-limit value in both the plugin and the
 * Piwigo deployment contract. Persist a positive sentinel in upload batches
 * because their immutable storage schema predates that configuration choice.
 */
export function resolvePiwigoUploadMaxBytes(
  configuredMaxFileBytes: number,
  advertisedMaxFileBytes?: number | null | undefined
): number {
  const limits = [configuredMaxFileBytes, advertisedMaxFileBytes]
    .filter((value): value is number => value !== null && value !== undefined && value > 0);
  return limits.length > 0 ? Math.min(...limits) : PIWIGO_GALLERY_UNLIMITED_FILE_BYTES;
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

export function resolvePiwigoAccountProfileUrl(
  config: PiwigoGalleryConfig,
  defaultAccountProfileUrl?: string | undefined
): string {
  return normalizeOptionalUrl(defaultAccountProfileUrl?.trim() || config.accountProfileUrl);
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
