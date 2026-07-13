import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerPiwigoGalleryCancellations, registerPiwigoGalleryCommands } from './commands';
import { createPiwigoGalleryHooks } from './hooks';
import { piwigoGalleryManifest } from './manifest';

export const piwigoGalleryPlugin: BotPlugin = {
  manifest: piwigoGalleryManifest,
  registerCommands(context) {
    registerPiwigoGalleryCommands(context);
  },
  registerCancellations(context) {
    return registerPiwigoGalleryCancellations(context);
  },
  registerHooks(context) {
    return createPiwigoGalleryHooks(context);
  }
};

export default piwigoGalleryPlugin;
