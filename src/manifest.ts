import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { piwigoGalleryConfigSchema } from './config';
import { piwigoGalleryMessages } from './messages';

export const PIWIGO_GALLERY_PLUGIN_ID = 'official.piwigo-gallery';
export const PIWIGO_GALLERY_DATABASE = 'gallery';
export const PIWIGO_GALLERY_FINALIZE_JOB = 'piwigo-gallery.finalize';
export const PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB = 'piwigo-gallery.announce-new-album';
export const PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB = 'piwigo-gallery.media-dump-hint';

export const PIWIGO_GALLERY_EXTERNAL_ACTIONS = {
  whatsappLinkRequestStart: 'piwigo.whatsappLinkRequest.start',
  whatsappRegistrationOtpStart: 'piwigo.whatsappRegistrationOtp.start',
  whatsappRegistrationOtpVerify: 'piwigo.whatsappRegistrationOtp.verify',
  authCodeSend: 'piwigo.authCode.send',
  eligibleScopesResolve: 'piwigo.eligibleScopes.resolve',
  albumUploadObserved: 'piwigo.albumUploadObserved'
} as const;

export const PIWIGO_GALLERY_PERMISSIONS = {
  configure: 'piwigo-gallery.configure',
  upload: 'piwigo-gallery.upload',
  download: 'piwigo-gallery.download'
} as const;

export const piwigoGalleryDatabases = [{
  name: PIWIGO_GALLERY_DATABASE,
  engine: 'sqlite' as const,
  scope: 'account' as const,
  migrations: 'migrations/gallery'
}];

export const piwigoGalleryManifest: PluginManifest = {
  pluginId: PIWIGO_GALLERY_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.6.0',
  coreApiRange: '>=0.2.0',
  messageNamespace: 'official.piwigo-gallery',
  descriptionKey: 'official.piwigo-gallery.description',
  defaultMessages: piwigoGalleryMessages,
  commands: [
    '/gallery status',
    '/gallery configure',
    '/gallery download',
    '/send gallery',
    '/upload',
    '/accept',
    '/refuse',
    '/register gallery'
  ],
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
        commands: ['/send gallery', '/upload'],
        instructionKeys: ['official.piwigo-gallery.help.upload.instruction'],
        exampleKeys: ['official.piwigo-gallery.help.send.example', 'official.piwigo-gallery.help.upload.example'],
        keywords: ['upload', 'send', 'documents', 'photos'],
        availability: {
          invocation: 'either',
          permission: PIWIGO_GALLERY_PERMISSIONS.upload,
          requiresCurrentManagedGroupMembership: true,
          allowCurrentManagedGroupMemberConfigPath: 'access.allowScopeMemberUploads'
        }
      },
      {
        topicId: 'download-gallery',
        titleKey: 'official.piwigo-gallery.help.download.title',
        summaryKey: 'official.piwigo-gallery.help.download.summary',
        order: 30,
        commands: ['/gallery download'],
        instructionKeys: ['official.piwigo-gallery.help.download.instruction'],
        exampleKeys: ['official.piwigo-gallery.help.download.example'],
        keywords: ['download', 'image', 'file', 'token'],
        availability: {
          invocation: 'group_only',
          permission: PIWIGO_GALLERY_PERMISSIONS.download,
          requiresCurrentManagedGroupMembership: true,
          allowCurrentManagedGroupMemberConfigPath: 'access.allowScopeMemberDownloads'
        }
      },
      {
        topicId: 'link-gallery-account',
        titleKey: 'official.piwigo-gallery.help.account.title',
        summaryKey: 'official.piwigo-gallery.help.account.summary',
        order: 40,
        commands: ['/accept', '/refuse', '/register gallery'],
        instructionKeys: ['official.piwigo-gallery.help.account.instruction'],
        exampleKeys: ['official.piwigo-gallery.help.register.example'],
        keywords: ['account', 'link', 'register', 'accept', 'refuse'],
        availability: { invocation: 'either' }
      }
    ]
  },
  eventSubscriptions: ['message', 'private.message', 'plugin.job'],
  requiredPermissions: [
    PIWIGO_GALLERY_PERMISSIONS.configure,
    PIWIGO_GALLERY_PERMISSIONS.upload,
    PIWIGO_GALLERY_PERMISSIONS.download
  ],
  requiredBotCapabilities: [],
  configSchema: piwigoGalleryConfigSchema,
  dangerousActions: [],
  backgroundJobs: [
    PIWIGO_GALLERY_FINALIZE_JOB,
    PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB
  ],
  externalActions: [
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappLinkRequestStart,
      access: 'mutation',
      scope: 'account',
      timeoutMs: 30_000,
      description: 'Start a Piwigo account-link request through a known WhatsApp contact.'
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappRegistrationOtpStart,
      access: 'mutation',
      scope: 'account',
      timeoutMs: 30_000,
      description: 'Send and persist a WhatsApp registration OTP.'
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.whatsappRegistrationOtpVerify,
      access: 'mutation',
      scope: 'account',
      timeoutMs: 30_000,
      description: 'Verify and consume a WhatsApp registration OTP.'
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.authCodeSend,
      access: 'mutation',
      scope: 'scope',
      timeoutMs: 30_000,
      description: 'Deliver a scoped Piwigo authentication code through WhatsApp.'
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.eligibleScopesResolve,
      access: 'read',
      scope: 'account',
      timeoutMs: 30_000,
      description: 'Resolve Piwigo-enabled scopes available to a WhatsApp identity.'
    },
    {
      actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.albumUploadObserved,
      access: 'mutation',
      scope: 'scope',
      timeoutMs: 30_000,
      description: 'Observe a scoped Piwigo album upload and schedule its WhatsApp announcement.'
    }
  ],
  databases: piwigoGalleryDatabases,
  dataVersion: '7',
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
        commands: ['/send gallery'],
        cancellableStates: ['active'],
        terminalStates: ['completed', 'cancelled', 'expired'],
        effects: ['discard-gallery-upload-draft']
      },
      {
        id: 'gallery-upload-batch',
        description: 'Active gallery document collection or upload batch.',
        mode: 'plugin-handler',
        scope: 'actor-chat',
        commands: ['/send gallery', '/upload'],
        cancellableStates: ['collecting'],
        terminalStates: ['completed', 'cancelled', 'expired', 'failed'],
        effects: ['delete-staged-media', 'clear-active-batch'],
        auditAction: 'piwigo-gallery.upload.cancel'
      }
    ]
  },
  assistant: {
    summary: 'Piwigo gallery upload workflow for collecting WhatsApp documents, linking users, and finalizing gallery batches.',
    useCases: [
      'Explain whether gallery uploads are configured for the current scope.',
      'Start and manage a guided gallery upload flow.',
      'Download a Piwigo media file into WhatsApp.',
      'Help users link or register a Piwigo account.'
    ],
    prerequisites: [
      'enabled=true in the target scope.',
      'The deployment must provide the internal Piwigo base URL and shared bot secret before uploads can start.',
      'Upload users need the scoped piwigo-gallery.upload permission.',
      'Download users need the scoped piwigo-gallery.download permission.'
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
        commands: ['/send gallery', '/upload']
      },
      {
        intent: 'gallery_download',
        description: 'Download a gallery file into WhatsApp.',
        commands: ['/gallery download']
      },
      {
        intent: 'gallery_account',
        description: 'Accept, refuse, or register a linked gallery account.',
        commands: ['/accept', '/refuse', '/register gallery']
      }
    ]
  }
};
