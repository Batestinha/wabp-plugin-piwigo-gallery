import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerPiwigoGalleryCancellations, registerPiwigoGalleryCommands } from './commands';
import { createPiwigoGalleryHooks } from './hooks';
import { createPiwigoGalleryExternalActions } from './externalActions';
import { migrateGalleryIdentityData } from './identityMigration';
import { piwigoGalleryManifest } from './manifest';

export const piwigoGalleryPlugin: BotPlugin = {
  manifest: piwigoGalleryManifest,
  lifecycle: {
    migrateData: migrateGalleryIdentityData
  },
  registerCommands(context) {
    registerPiwigoGalleryCommands(context);
  },
  registerCancellations(context) {
    return registerPiwigoGalleryCancellations(context);
  },
  registerHooks(context) {
    return createPiwigoGalleryHooks(context);
  },
  registerExternalActions(context) {
    return createPiwigoGalleryExternalActions(context);
  }
};

export default piwigoGalleryPlugin;
