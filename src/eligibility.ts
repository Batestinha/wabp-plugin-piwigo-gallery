import type { PluginIdentityAccess, PluginIdentityScopeMembership } from '@wabs/plugin-sdk/identity-access';
import { configConnection, parsePiwigoGalleryConfig, type GalleryConnection, type GalleryConnectionDefaults, type PiwigoGalleryConfig } from './config';

export async function assertPiwigoGalleryEligibleIdentity(identityId: string, identityAccess: PluginIdentityAccess): Promise<void> {
  if (!(await isPiwigoGalleryEligibleIdentity(identityId, identityAccess))) throw new Error('WhatsApp identity is not a member of a Piwigo-enabled group.');
}
export async function isPiwigoGalleryEligibleIdentity(identityId: string, identityAccess: PluginIdentityAccess): Promise<boolean> {
  if (!identityId.trim()) return false;
  return (await identityAccess.listEnabledScopeMemberships(identityId)).length > 0;
}
export interface ConfiguredPiwigoGalleryScope extends Omit<PluginIdentityScopeMembership, 'enabledConfigLayers'> {
  config: PiwigoGalleryConfig;
  connection: GalleryConnection;
}
export async function listConfiguredPiwigoGalleryEligibleScopes(identityId: string,
  input: GalleryConnectionDefaults & { identityAccess?: PluginIdentityAccess | undefined }
): Promise<ConfiguredPiwigoGalleryScope[]> {
  if (!identityId.trim()) return [];
  if (!input.identityAccess) throw new Error('Host identity membership capability is unavailable');
  const memberships = await input.identityAccess.listEnabledScopeMemberships(identityId);
  return memberships.flatMap(({ enabledConfigLayers, ...membership }) => {
    // Preserve the existing enabled-layer, shallow merge contract when packaging this plugin.
    const config = parsePiwigoGalleryConfig(Object.assign({}, ...enabledConfigLayers));
    const connection = configConnection(config, input);
    return config.enabled && connection ? [{ ...membership, config, connection }] : [];
  });
}
