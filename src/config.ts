import { z } from 'zod';
import type { AppConfig } from './deploymentConfig';
import { parseCanonicalHttpsIssuer } from '@wabs/plugin-sdk/client-credentials';
import {
  conditionalTemplateHasCondition,
  renderConditionalTemplateIfActive,
  validateConditionalTemplate,
  validateConditionalTemplateIfActive
} from '@wabs/plugin-sdk/templates';

export const PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV = 'PIWIGO_GALLERY_DEFAULT_BASE_URL';
export const TOPOMARE_OIDC_ISSUER_ENV = 'TOPOMARE_OIDC_ISSUER';
export const TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID_ENV =
  'TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID';
export const TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_SECRET_FILE_ENV =
  'TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_SECRET_FILE';
export const TOPOMARE_WABP_PROVIDER_NAMESPACE_ENV = 'TOPOMARE_WABP_PROVIDER_NAMESPACE';
export const TOPOMARE_PIWIGO_PROVIDER_NAMESPACE_ENV = 'TOPOMARE_PIWIGO_PROVIDER_NAMESPACE';
export const PIWIGO_GALLERY_UNLIMITED_FILE_BYTES = Number.MAX_SAFE_INTEGER;
export const PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS = ['album', 'site', 'user'] as const;
export const PIWIGO_MEDIA_DUMP_HINT_TEMPLATE_TOKENS = ['actorDisplayName', 'isGroup', 'isPrivate'] as const;

const piwigoAlbumAnnouncementTemplateSchema = z.string().trim().max(500).superRefine((template, ctx) => {
  const allowed = new Set<string>(PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS);
  if (!conditionalTemplateHasCondition(template)) {
    for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)) {
      const token = match[1] ?? '';
      if (!allowed.has(token)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown announcement template variable {${token}}` });
      }
    }
  }
  for (const issue of conditionalTemplateHasCondition(template)
    ? validateConditionalTemplate(template, PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS)
    : []) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message
    });
  }
});

const piwigoMediaDumpHintSchema = z.string().trim().max(500).superRefine((template, ctx) => {
  for (const issue of validateConditionalTemplateIfActive(template, PIWIGO_MEDIA_DUMP_HINT_TEMPLATE_TOKENS)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message
    });
  }
});

export const piwigoGalleryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoFinalizeMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxFileBytes: z.number().int().min(0).max(25 * 1024 * 1024 * 1024).default(0),
  access: z.object({
    allowScopeMemberUploads: z.boolean().default(false)
  }).default({}),
  mediaDumpDocumentsHint: piwigoMediaDumpHintSchema.default(''),
  newAlbumAnnouncementsEnabled: z.boolean().default(false),
  announcementGroupWid: z.string().trim().regex(/^[^\s@]+@g\.us$/i).or(z.literal('')).default(''),
  newAlbumAnnouncementTemplate: piwigoAlbumAnnouncementTemplateSchema.default(''),
  newAlbumAnnouncementDelayMinutes: z.number().int().min(1).max(24 * 60).default(120)
}).strip();

export type PiwigoGalleryConfig = z.infer<typeof piwigoGalleryConfigSchema>;

export interface GalleryConnection {
  piwigoBaseUrl: string;
  topomareOidcIssuer: string;
  topomareWabpProviderNamespace: string;
  topomarePiwigoProviderNamespace: string;
  serviceOidcClientId: string;
  serviceOidcClientSecret: string;
}

export interface GalleryConnectionDefaults {
  piwigoBaseUrl: string;
  topomareOidcIssuer: string;
  topomareWabpProviderNamespace: string;
  topomarePiwigoProviderNamespace: string;
  serviceOidcClientId: string;
  serviceOidcClientSecret: string;
}

export function parsePiwigoGalleryConfig(input: unknown): PiwigoGalleryConfig {
  return piwigoGalleryConfigSchema.parse(input);
}

export function renderPiwigoAlbumAnnouncementTemplate(
  template: string,
  values: Record<(typeof PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS)[number], string>
): string {
  if (conditionalTemplateHasCondition(template)) {
    return renderConditionalTemplateIfActive(template, PIWIGO_ALBUM_ANNOUNCEMENT_TEMPLATE_TOKENS, values);
  }
  return template.replace(/\{(album|site|user)\}/g, (_, token: keyof typeof values) => values[token]);
}

export function renderPiwigoMediaDumpDocumentsHint(
  template: string,
  values: Readonly<Record<(typeof PIWIGO_MEDIA_DUMP_HINT_TEMPLATE_TOKENS)[number], string | undefined>>
): string {
  return renderConditionalTemplateIfActive(template, PIWIGO_MEDIA_DUMP_HINT_TEMPLATE_TOKENS, values);
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
  defaults: GalleryConnectionDefaults
): GalleryConnection | undefined {
  const configured = {
    piwigoBaseUrl: defaults.piwigoBaseUrl,
    topomareOidcIssuer: defaults.topomareOidcIssuer,
    topomareWabpProviderNamespace: defaults.topomareWabpProviderNamespace,
    topomarePiwigoProviderNamespace: defaults.topomarePiwigoProviderNamespace,
    serviceOidcClientId: defaults.serviceOidcClientId,
    serviceOidcClientSecret: defaults.serviceOidcClientSecret
  };
  const values = Object.values(configured);
  if (values.every((value) => value === '')) {
    return undefined;
  }
  if (values.some((value) => value === '')) {
    throw new Error('Topomare Gallery service integration configuration is incomplete.');
  }
  return {
    piwigoBaseUrl: requiredPiwigoBaseUrl(configured.piwigoBaseUrl),
    topomareOidcIssuer: requiredTopomareOidcIssuer(configured.topomareOidcIssuer),
    topomareWabpProviderNamespace: stableDeploymentIdentifier(
      configured.topomareWabpProviderNamespace,
      TOPOMARE_WABP_PROVIDER_NAMESPACE_ENV
    ),
    topomarePiwigoProviderNamespace: stableDeploymentIdentifier(
      configured.topomarePiwigoProviderNamespace,
      TOPOMARE_PIWIGO_PROVIDER_NAMESPACE_ENV
    ),
    serviceOidcClientId: stableDeploymentIdentifier(
      configured.serviceOidcClientId,
      TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID_ENV
    ),
    serviceOidcClientSecret: requiredServiceOidcClientSecret(configured.serviceOidcClientSecret)
  };
}

export function galleryConnectionDefaultsFromAppConfig(
  config: Pick<
    AppConfig,
    | 'PIWIGO_GALLERY_DEFAULT_BASE_URL'
    | 'TOPOMARE_OIDC_ISSUER'
    | 'TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID'
    | 'TOPOMARE_WABP_PROVIDER_NAMESPACE'
    | 'TOPOMARE_PIWIGO_PROVIDER_NAMESPACE'
    | 'topomareWabpGalleryServiceOidcClientSecret'
  >
): GalleryConnectionDefaults {
  return {
    piwigoBaseUrl: config.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    topomareOidcIssuer: config.TOPOMARE_OIDC_ISSUER,
    topomareWabpProviderNamespace: config.TOPOMARE_WABP_PROVIDER_NAMESPACE,
    topomarePiwigoProviderNamespace: config.TOPOMARE_PIWIGO_PROVIDER_NAMESPACE,
    serviceOidcClientId: config.TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID,
    serviceOidcClientSecret: config.topomareWabpGalleryServiceOidcClientSecret
  };
}

export function resolvePiwigoBaseUrl(defaultBaseUrl?: string | undefined): string {
  const value = defaultBaseUrl?.trim() ?? '';
  if (!value) {
    return '';
  }
  return requiredPiwigoBaseUrl(value);
}

export function normalizePiwigoBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function requiredPiwigoBaseUrl(input: string): string {
  if (input.trim() !== input) {
    throw new Error(`${PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV} must be an exact HTTPS URL.`);
  }
  const value = normalizePiwigoBaseUrl(input);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV} must be an HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error(`${PIWIGO_GALLERY_DEFAULT_BASE_URL_ENV} must be an HTTPS URL without credentials, query, or fragment.`);
  }
  return value;
}

function requiredTopomareOidcIssuer(input: string): string {
  if (input.trim() !== input) {
    throw new Error(`${TOPOMARE_OIDC_ISSUER_ENV} must be an exact canonical HTTPS realm URL.`);
  }
  return parseCanonicalHttpsIssuer(input);
}

function stableDeploymentIdentifier(input: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(input)) {
    throw new Error(`${name} is invalid.`);
  }
  return input;
}

function requiredServiceOidcClientSecret(input: string): string {
  if (
    input.trim() !== input
    || input.length < 16
    || input.length > 8_192
    || /[\r\n\0]/u.test(input)
  ) {
    throw new Error('Topomare WABP Gallery OIDC client secret is invalid.');
  }
  return input;
}
