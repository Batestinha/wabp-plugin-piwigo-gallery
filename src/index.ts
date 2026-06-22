import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerPiwigoGalleryCommands } from './commands';
import { createPiwigoGalleryHooks } from './hooks';
import { piwigoGalleryManifest } from './manifest';

export const piwigoGalleryPlugin: BotPlugin = {
  manifest: piwigoGalleryManifest,
  registerCommands(context) {
    registerPiwigoGalleryCommands(context);
  },
  registerHooks(context) {
    return createPiwigoGalleryHooks(context);
  }
};

export default piwigoGalleryPlugin;
