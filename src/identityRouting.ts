import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';

export interface GalleryIdentityAddressResolver {
  resolveStableIdentityById?(identityId: string): Promise<StableIdentityAddressResolution>;
  resolveIdentityAddress?(wid: string): Promise<StableIdentityAddressResolution>;
}

export async function resolveGalleryUploadWhatsappJid(
  identities: GalleryIdentityAddressResolver,
  batch: {
    actorIdentityId: string;
    piwigoLinkedWid?: string | undefined;
  }
): Promise<string> {
  if (!identities.resolveStableIdentityById || !identities.resolveIdentityAddress) {
    throw new Error('Authoritative identity address resolution is unavailable.');
  }
  const actorIdentityId = batch.actorIdentityId.trim();
  const actor = await identities.resolveStableIdentityById(actorIdentityId);
  if (!actorIdentityId || actor.identityId !== actorIdentityId) {
    throw new Error(`Resolved gallery actor identity ${actor.identityId} does not match ${actorIdentityId}.`);
  }
  if (!batch.piwigoLinkedWid) {
    return requiredAddressBookWid(actor, actorIdentityId);
  }
  const linked = await identities.resolveIdentityAddress(batch.piwigoLinkedWid);
  if (linked.identityId !== actor.identityId) {
    throw new Error(
      `Piwigo-linked WhatsApp address belongs to ${linked.identityId}, not gallery actor ${actor.identityId}.`
    );
  }
  return requiredAddressBookWid(linked, actorIdentityId);
}

function requiredAddressBookWid(address: StableIdentityAddressResolution, identityId: string): string {
  const wid = address.addressBookWid.trim();
  if (!wid) {
    throw new Error(`Authoritative Piwigo address is unavailable for gallery actor ${identityId}.`);
  }
  return wid;
}
