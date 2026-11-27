import { z } from 'zod';
import type { PluginManifest } from '@wabs/plugin-sdk/manifest';

const metadata = require('../wa-plugin.json');
export const configSchema = z.object({
  uploadsEnabled: z.boolean().default(true),
  eventAlbumsEnabled: z.boolean().default(true),
  albumHintsEnabled: z.boolean().default(true),
  announcementsEnabled: z.boolean().default(true),
  maximumFileBytes: z.number().int().min(1).max(268435456).default(268435456),
  maximumFiles: z.number().int().min(1).max(1000).default(1000)
});
export const manifest: PluginManifest = {
  ...metadata, configSchema, defaultMessages: require('../locales/en/official.piwigo-gallery.json')
};
