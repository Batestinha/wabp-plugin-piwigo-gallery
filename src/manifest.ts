import type { PluginManifest } from '@wabs/plugin-sdk/manifest';
import { piwigoGalleryConfigSchema } from './config';
import { piwigoGalleryMessages } from './messages';
import { piwigoGalleryUploadOnlyBoundary } from './uploadOnlyBoundary';

export const PIWIGO_GALLERY_PLUGIN_ID = piwigoGalleryUploadOnlyBoundary.pluginId;
export const PIWIGO_GALLERY_DATABASE = 'gallery';
export const PIWIGO_GALLERY_FINALIZE_JOB = 'piwigo-gallery.finalize';
export const PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB = 'piwigo-gallery.announce-new-album';
export const PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB = 'piwigo-gallery.media-dump-hint';
export const PIWIGO_GALLERY_SUBJECT_CUTOVER_MIGRATION = '011_topomare_subject_cutover.sql';
export const PIWIGO_GALLERY_SUBJECT_CUTOVER_APPROVAL =
  `${PIWIGO_GALLERY_DATABASE}:${PIWIGO_GALLERY_SUBJECT_CUTOVER_MIGRATION}`;

export const PIWIGO_GALLERY_EXTERNAL_ACTIONS = {
  albumUploadObserved: piwigoGalleryUploadOnlyBoundary.inboundPiwigoCallback.action
} as const;

export const PIWIGO_GALLERY_PERMISSIONS = {
  configure: piwigoGalleryUploadOnlyBoundary.permissions[0],
  upload: piwigoGalleryUploadOnlyBoundary.permissions[1]
} as const;

export const piwigoGalleryDatabases = [{
  name: PIWIGO_GALLERY_DATABASE,
  engine: 'sqlite' as const,
  scope: 'account' as const,
  migrations: 'migrations/gallery',
  operatorMigrations: [PIWIGO_GALLERY_SUBJECT_CUTOVER_MIGRATION]
}];

export const piwigoGalleryManifest: PluginManifest = {
  pluginId: PIWIGO_GALLERY_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.17.3',
  coreApiRange: '^0.3.3',
  messageNamespace: 'official.piwigo-gallery',
  descriptionKey: 'official.piwigo-gallery.description',
  defaultMessages: piwigoGalleryMessages,
  commands: [...piwigoGalleryUploadOnlyBoundary.commands],
  help: {
    featureId: 'gallery',
    titleKey: 'official.piwigo-gallery.help.feature.title',
    summaryKey: 'official.piwigo-gallery.help.feature.summary',
    order: 40,
    aliases: ['piwigo', 'photos', 'albums'],
    topics: [
      {
        topicId: 'manage-gallery',
        titleKey: 'official.piwigo-gallery.help.manage.title',
        summaryKey: 'official.piwigo-gallery.help.manage.summary',
        order: 10,
        commands: ['/gallery status', '/gallery configure'],
        instructionKeys: ['official.piwigo-gallery.help.manage.instruction'],
        exampleKeys: ['official.piwigo-gallery.help.status.example', 'official.piwigo-gallery.help.configure.example'],
        keywords: ['status', 'configure', 'settings'],
        availability: { invocation: 'group_only', permission: PIWIGO_GALLERY_PERMISSIONS.configure }
      },
      {
        topicId: 'upload-gallery',
        titleKey: 'official.piwigo-gallery.help.upload.title',
        summaryKey: 'official.piwigo-gallery.help.upload.summary',
        order: 20,
        commands: ['/gallery upload'],
        instructionKeys: ['official.piwigo-gallery.help.upload.instruction'],
        exampleKeys: ['official.piwigo-gallery.help.upload.example'],
        keywords: ['upload', 'send', 'documents', 'photos'],
        availability: {
          invocation: 'either',
          permission: PIWIGO_GALLERY_PERMISSIONS.upload,
          requiresCurrentManagedGroupMembership: true,
          currentManagedGroupMembershipMode: 'effective_scope',
          allowCurrentManagedGroupMemberConfigPath: 'access.allowScopeMemberUploads'
        }
      }
    ]
  },
  eventSubscriptions: ['message', 'private.message', 'plugin.job'],
  requiredPermissions: [
    PIWIGO_GALLERY_PERMISSIONS.configure,
    PIWIGO_GALLERY_PERMISSIONS.upload
  ],
  requiredBotCapabilities: [],
  configSchema: piwigoGalleryConfigSchema,
  dangerousActions: [],
  backgroundJobs: [
    PIWIGO_GALLERY_FINALIZE_JOB,
    PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB
  ],
  externalActions: [{
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.albumUploadObserved,
      access: 'mutation',
      scope: 'scope',
      timeoutMs: 30_000,
      description: 'Observe a scoped Piwigo album upload and schedule its WhatsApp announcement.'
  }],
  databases: piwigoGalleryDatabases,
  dataVersion: '11',
  dependencies: [
    { pluginId: 'official.community-events', versionRange: '>=0.5.0', optional: true }
  ],
  cancellation: {
    workflows: [
      {
        id: 'gallery-upload-setup',
        description: 'Guided gallery upload setup before document collection starts.',
        mode: 'core-flow',
        scope: 'actor-chat',
        commands: ['/gallery upload'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-gallery-upload-draft']
      },
      {
        id: 'gallery-upload-batch',
        description: 'Active gallery document collection or upload batch.',
        mode: 'plugin-handler',
        scope: 'actor-chat',
        commands: ['/gallery upload'],
        cancellableStates: ['collecting'],
        terminalStates: ['completed', 'cancelled', 'expired', 'failed'],
        effects: ['delete-staged-media', 'clear-active-batch'],
        auditAction: 'piwigo-gallery.upload.cancel'
      }
    ]
  },
  assistant: {
    summary: 'Piwigo gallery upload workflow for collecting WhatsApp documents and finalizing gallery batches.',
    useCases: [
      'Explain whether gallery uploads are configured for the current scope.',
      'Start and manage a guided gallery upload flow.'
    ],
    prerequisites: [
      'enabled=true in the target scope.',
      'The deployment must provide the public HTTPS Piwigo URL and the file-backed Topomare OIDC service identity before uploads can start.',
      'Upload users need the scoped piwigo-gallery.upload permission.'
    ],
    workflows: [
      {
        intent: 'gallery_status',
        description: 'Inspect gallery configuration and connection state.',
        commands: ['/gallery status']
      },
      {
        intent: 'gallery_configure',
        description: 'Configure upload enablement and upload limits for the scope.',
        commands: ['/gallery configure']
      },
      {
        intent: 'gallery_upload',
        description: 'Start, finalize, or cancel a guided gallery upload batch.',
        commands: ['/gallery upload']
      }
    ]
  }
};
