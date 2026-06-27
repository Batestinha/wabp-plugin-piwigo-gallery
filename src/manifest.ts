import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { piwigoGalleryConfigSchema } from './config';
import { piwigoGalleryMessages } from './messages';

export const PIWIGO_GALLERY_PLUGIN_ID = 'official.piwigo-gallery';
export const PIWIGO_GALLERY_FINALIZE_JOB = 'piwigo-gallery.finalize';

export const PIWIGO_GALLERY_PERMISSIONS = {
  configure: 'piwigo-gallery.configure',
  upload: 'piwigo-gallery.upload'
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
    '/send gallery',
    '/upload',
    '/cancel',
    '/confirm gallery',
    '/deny gallery',
    '/login gallery',
    '/register gallery'
  ],
  eventSubscriptions: ['message', 'plugin.job'],
  requiredPermissions: [
    PIWIGO_GALLERY_PERMISSIONS.configure,
    PIWIGO_GALLERY_PERMISSIONS.upload
  ],
  requiredBotCapabilities: [],
  configSchema: piwigoGalleryConfigSchema,
  dangerousActions: [],
  backgroundJobs: [PIWIGO_GALLERY_FINALIZE_JOB],
  assistant: {
    summary: 'Piwigo gallery upload workflow for collecting WhatsApp documents, linking users, and finalizing gallery batches.',
    useCases: [
      'Explain whether gallery uploads are configured for the current scope.',
      'Start and manage a guided gallery upload flow.',
      'Help users link or register a Piwigo account.'
    ],
    prerequisites: [
      'enabled=true in the target scope.',
      'The Piwigo base URL and bot secret must be configured before uploads can start.',
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
        description: 'Configure the Piwigo endpoint and upload limits for the scope.',
        commands: ['/gallery configure']
      },
      {
        intent: 'gallery_upload',
        description: 'Start, finalize, or cancel a guided gallery upload batch.',
        commands: ['/send gallery', '/upload', '/cancel']
      },
      {
        intent: 'gallery_account',
        description: 'Confirm, deny, log in, or register a linked gallery account.',
        commands: ['/confirm gallery', '/deny gallery', '/login gallery', '/register gallery']
      }
    ]
  }
};
