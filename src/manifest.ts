import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { piwigoGalleryConfigSchema } from './config';
import { piwigoGalleryMessages } from './messages';

export const PIWIGO_GALLERY_PLUGIN_ID = 'official.piwigo-gallery';
export const PIWIGO_GALLERY_FINALIZE_JOB = 'piwigo-gallery.finalize';
export const PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB = 'piwigo-gallery.announce-new-album';
export const PIWIGO_GALLERY_MEDIA_DUMP_HINT_JOB = 'piwigo-gallery.media-dump-hint';

export const PIWIGO_GALLERY_PERMISSIONS = {
  configure: 'piwigo-gallery.configure',
  upload: 'piwigo-gallery.upload',
  download: 'piwigo-gallery.download'
} as const;

export const piwigoGalleryManifest: PluginManifest = {
  pluginId: PIWIGO_GALLERY_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.1.0',
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
  eventSubscriptions: ['message', 'plugin.job'],
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
        cancellableStates: ['collecting', 'uploading'],
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
