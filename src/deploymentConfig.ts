export interface GalleryDeploymentConfig {
  PIWIGO_GALLERY_DEFAULT_BASE_URL: string;
  TOPOMARE_OIDC_ISSUER: string;
  TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID: string;
  TOPOMARE_WABP_PROVIDER_NAMESPACE: string;
  TOPOMARE_PIWIGO_PROVIDER_NAMESPACE: string;
  topomareWabpGalleryServiceOidcClientSecret: string;
}
export type AppConfig = GalleryDeploymentConfig;
