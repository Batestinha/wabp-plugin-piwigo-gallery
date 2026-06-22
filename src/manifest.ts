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
    '/connect gallery',
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
  backgroundJobs: [PIWIGO_GALLERY_FINALIZE_JOB]
};
