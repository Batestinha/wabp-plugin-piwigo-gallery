import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PluginManifest } from '../../../../packages/plugin-sdk/src/manifest';
import boundaryJson from './upload-only-boundary.v1.json';

const commandsSchema = z.tuple([
  z.literal('/gallery status'),
  z.literal('/gallery configure'),
  z.literal('/gallery upload')
]);

const permissionsSchema = z.tuple([
  z.literal('piwigo-gallery.configure'),
  z.literal('piwigo-gallery.upload')
]);

const outboundMethodsSchema = z.tuple([
  z.literal('topomare.gallery.integrationStatus'),
  z.literal('topomare.gallery.acceptedMediaTypes'),
  z.literal('topomare.gallery.peopleForSubject'),
  z.literal('topomare.gallery.resolveUploadForSubject'),
  z.literal('topomare.gallery.uploadForSubject'),
  z.literal('topomare.gallery.downloadAnnouncementMedia')
]);

const uploadOnlyBoundarySchema = z.object({
  allowedCapabilities: z.tuple([
    z.literal('integration-status'),
    z.literal('media-type-discovery'),
    z.literal('subject-bound-gallery-authorization'),
    z.literal('upload-context-resolution'),
    z.literal('media-upload'),
    z.literal('upload-derived-announcement-media-download'),
    z.literal('upload-observation')
  ]),
  boundaryPurpose: z.literal('authorized-gallery-upload-workflow-only'),
  commands: commandsSchema,
  contractId: z.literal('topomare.wabp-piwigo-gallery-upload-only.v1'),
  credentialAuthority: z.literal('topomare-central-identity'),
  forbiddenEndUserCapabilities: z.tuple([
    z.literal('account-linking'),
    z.literal('authentication'),
    z.literal('credential-migration'),
    z.literal('credential-validation'),
    z.literal('login'),
    z.literal('one-time-password'),
    z.literal('password'),
    z.literal('password-reset'),
    z.literal('registration')
  ]),
  inboundPiwigoCallback: z.object({
    action: z.literal('piwigo.albumUploadObserved'),
    authorization: z.literal('topomare-oidc-service-bearer'),
    httpMethod: z.literal('POST'),
    path: z.literal('/integrations/piwigo/album-upload-observed')
  }).strict(),
  legacyRuntime: z.object({
    accountLinking: z.literal('forbidden'),
    credentialVerification: z.literal('forbidden'),
    oneTimePasswords: z.literal('forbidden'),
    registration: z.literal('forbidden'),
    requiredRemovalMigration: z.literal('011_topomare_subject_cutover.sql'),
    state: z.literal('subject-bound-only')
  }).strict(),
  outboundPiwigoApi: z.object({
    authorization: z.object({
      endUserCredentialDelegation: z.literal(false),
      kind: z.literal('topomare-oidc-client-credentials-bearer')
    }).strict(),
    format: z.literal('json'),
    httpMethod: z.literal('POST'),
    methods: outboundMethodsSchema,
    path: z.literal('/ws.php')
  }).strict(),
  permissions: permissionsSchema,
  pluginId: z.literal('official.piwigo-gallery'),
  schemaVersion: z.literal(1)
}).strict();

export const piwigoGalleryUploadOnlyBoundary = deepFreeze(
  uploadOnlyBoundarySchema.parse(boundaryJson)
);

export type PiwigoGalleryOutboundMethod =
  (typeof piwigoGalleryUploadOnlyBoundary.outboundPiwigoApi.methods)[number];

const outboundMethods = new Set<string>(
  piwigoGalleryUploadOnlyBoundary.outboundPiwigoApi.methods
);

export const PIWIGO_GALLERY_UPLOAD_ONLY_BOUNDARY_SHA256 = createHash('sha256')
  .update(JSON.stringify(sortValue(piwigoGalleryUploadOnlyBoundary)), 'utf8')
  .digest('hex');

export class PiwigoGalleryBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiwigoGalleryBoundaryError';
  }
}

/**
 * Enforces the entire WABP-to-Piwigo remote method surface before a service
 * token is acquired or a request is sent. Unknown methods fail closed.
 */
export function assertPiwigoGalleryOutboundMethod(
  method: string
): asserts method is PiwigoGalleryOutboundMethod {
  if (!outboundMethods.has(method)) {
    throw new PiwigoGalleryBoundaryError(
      `Piwigo Gallery method is outside the upload-only integration boundary: ${method}`
    );
  }
}

export function assertPiwigoGalleryCommandRoute(
  namespace: string,
  subcommand: string
): void {
  const route = `/${namespace.trim().toLowerCase()} ${subcommand.trim().toLowerCase()}`;
  if (!(piwigoGalleryUploadOnlyBoundary.commands as readonly string[]).includes(route)) {
    throw new PiwigoGalleryBoundaryError(
      `Piwigo Gallery command is outside the upload-only integration boundary: ${route}`
    );
  }
}

export function assertPiwigoGalleryExternalAction(actionId: string): void {
  if (actionId !== piwigoGalleryUploadOnlyBoundary.inboundPiwigoCallback.action) {
    throw new PiwigoGalleryBoundaryError(
      `Piwigo Gallery action is outside the upload-only integration boundary: ${actionId}`
    );
  }
}

/** Validate the public plugin metadata before any handler is registered. */
export function assertPiwigoGalleryPluginManifestBoundary(
  manifest: Pick<
    PluginManifest,
    | 'pluginId'
    | 'commands'
    | 'requiredPermissions'
    | 'requiredBotCapabilities'
    | 'dangerousActions'
    | 'externalActions'
  >
): void {
  const expectedExternalActions = [{
    actionId: piwigoGalleryUploadOnlyBoundary.inboundPiwigoCallback.action,
    access: 'mutation',
    scope: 'scope',
    timeoutMs: 30_000,
    description: 'Observe a scoped Piwigo album upload and schedule its WhatsApp announcement.'
  }];
  if (
    manifest.pluginId !== piwigoGalleryUploadOnlyBoundary.pluginId
    || !sameJson(manifest.commands, piwigoGalleryUploadOnlyBoundary.commands)
    || !sameJson(manifest.requiredPermissions, piwigoGalleryUploadOnlyBoundary.permissions)
    || !sameJson(manifest.requiredBotCapabilities, [])
    || !sameJson(manifest.dangerousActions, [])
    || !sameJson(manifest.externalActions ?? [], expectedExternalActions)
  ) {
    throw new PiwigoGalleryBoundaryError(
      'Piwigo Gallery plugin manifest exceeds the upload-only integration boundary.'
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
