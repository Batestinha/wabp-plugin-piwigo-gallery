import { z } from 'zod';

const optionalUrlString = z.string().trim().default('').refine(
  (value) => value === '' || z.string().url().safeParse(value).success,
  'Invalid Piwigo URL'
);

export const piwigoGalleryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  piwigoBaseUrl: optionalUrlString,
  botSecret: z.string().default(''),
  autoFinalizeMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxFileBytes: z.number().int().positive().max(25 * 1024 * 1024 * 1024).default(512 * 1024 * 1024)
}).strict();

export type PiwigoGalleryConfig = z.infer<typeof piwigoGalleryConfigSchema>;

export interface GalleryConnection {
  piwigoBaseUrl: string;
  botSecret: string;
}

export function parsePiwigoGalleryConfig(input: unknown): PiwigoGalleryConfig {
  return piwigoGalleryConfigSchema.parse(input);
}

export function configConnection(config: PiwigoGalleryConfig): GalleryConnection | undefined {
  if (!config.piwigoBaseUrl.trim() || !config.botSecret.trim()) {
    return undefined;
  }
  return {
    piwigoBaseUrl: normalizePiwigoBaseUrl(config.piwigoBaseUrl),
    botSecret: config.botSecret
  };
}

export function normalizePiwigoBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}
