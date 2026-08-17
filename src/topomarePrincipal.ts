import { z } from 'zod';
import {
  FederatedSubjectLinkService,
  type ActiveFederatedSubjectLink
} from '../../../platform/identity/federatedSubjectLinkService';
import {
  stableWaIdentityIdSchema,
  topomareUserIdSchema
} from '../../../platform/identity/federatedSubjectLink';
import { parseCanonicalHttpsIssuer } from '../../../platform/identity/clientCredentialsTokenProvider';

const providerNamespaceSchema = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);

export interface TopomareGalleryPrincipal {
  topomareUserId: string;
  wabpProviderNamespace: string;
  wabpIdentityId: string;
}

export interface TopomareGalleryPrincipalResolver {
  resolveForIdentity(identityId: string): Promise<TopomareGalleryPrincipal>;
}

/**
 * Resolves only from the permanent, verified WaIdentity projection. WhatsApp
 * addresses, phone numbers, display names and email addresses are deliberately
 * not accepted at this boundary.
 */
export class FederatedTopomareGalleryPrincipalResolver implements TopomareGalleryPrincipalResolver {
  readonly #issuer: string;
  readonly #providerNamespace: string;

  constructor(
    issuer: string,
    providerNamespace: string,
    private readonly links: Pick<FederatedSubjectLinkService, 'resolveSubjectForIdentity'> =
      new FederatedSubjectLinkService()
  ) {
    this.#issuer = parseCanonicalHttpsIssuer(issuer);
    this.#providerNamespace = providerNamespaceSchema.parse(providerNamespace);
  }

  async resolveForIdentity(identityId: string): Promise<TopomareGalleryPrincipal> {
    const wabpIdentityId = stableWaIdentityIdSchema.parse(identityId);
    if (/@(?:c\.us|s\.whatsapp\.net|lid)$/iu.test(wabpIdentityId)) {
      throw new Error('Gallery identity resolution requires a stable WaIdentity id, not a WhatsApp address.');
    }
    const link = await this.links.resolveSubjectForIdentity({
      issuer: this.#issuer,
      identityId: wabpIdentityId
    });
    return principalFromLink(link, this.#providerNamespace, wabpIdentityId);
  }
}

function principalFromLink(
  link: ActiveFederatedSubjectLink,
  wabpProviderNamespace: string,
  expectedIdentityId: string
): TopomareGalleryPrincipal {
  if (link.identityId !== expectedIdentityId || link.revokedAt !== null) {
    throw new Error('Federated Topomare identity projection did not match the gallery actor.');
  }
  return {
    topomareUserId: topomareUserIdSchema.parse(link.topomareUserId),
    wabpProviderNamespace,
    wabpIdentityId: expectedIdentityId
  };
}
