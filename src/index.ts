import type { BotPlugin } from './runtime';
import { registerPiwigoGalleryCancellations, registerPiwigoGalleryCommands } from './commands';
import { createPiwigoGalleryHooks } from './hooks';
import { createPiwigoGalleryExternalActions } from './externalActions';
import { piwigoGalleryManifest } from './manifest';
import { assertPiwigoGalleryPluginManifestBoundary } from './uploadOnlyBoundary';

assertPiwigoGalleryPluginManifestBoundary(piwigoGalleryManifest);

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
  },
  registerExternalActions(context) {
    return createPiwigoGalleryExternalActions(context);
  }
};

export default piwigoGalleryPlugin;
