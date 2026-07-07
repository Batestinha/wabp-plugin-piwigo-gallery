import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';
import type { GalleryConnection, PiwigoGalleryConfig } from './config';
import { configConnection } from './config';

export interface GalleryUploadDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  chatId: string;
  actorWid: string;
  actorAliases?: string[] | undefined;
  piwigoLinkedWid?: string | undefined;
  actorLabel: string;
  acceptedExtensions: string[];
  maxFileBytes: number;
  autoFinalizeMinutes: number;
  createdAt: string;
}

export interface GalleryBatchFile {
  mediaId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: 'staged' | 'uploaded';
  imageId?: number | undefined;
  url?: string | undefined;
  uploadedAt?: string | undefined;
}

export interface GalleryUploadBatch {
  id: string;
  status: 'collecting' | 'uploading' | 'completed' | 'cancelled' | 'expired' | 'failed';
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  chatId: string;
  actorWid: string;
  actorAliases?: string[] | undefined;
  piwigoLinkedWid?: string | undefined;
  actorLabel: string;
  onde: string;
  quando: string;
  withUserIds: number[];
  acceptedExtensions: string[];
  maxFileBytes: number;
  autoFinalizeMinutes: number;
  files: GalleryBatchFile[];
  createdAt: string;
  updatedAt: string;
  autoFinalizeAt: string;
  albumLabel?: string | undefined;
  error?: string | undefined;
}

export interface GalleryScopeOption {
  scopeId: string;
  label: string;
}

export interface GalleryLinkRequest {
  requestId: string;
  requestToken: string;
  phone?: string | undefined;
  whatsappJid: string;
  whatsappAliases?: string[] | undefined;
  siteLabel: string;
  linkChoiceCount: number;
  scopeOptions: GalleryScopeOption[];
  createdAt: string;
  expiresAt: string;
}

export interface PiwigoAlbumAnnouncementFile {
  imageId?: number | undefined;
  fileId?: string | undefined;
  downloadToken?: string | undefined;
  filename: string;
  mimeType: string;
}

export interface PiwigoAlbumAnnouncement {
  id: string;
  dedupeKey: string;
  scopeId: string;
  albumId?: string | undefined;
  albumName: string;
  siteLabel: string;
  userDisplayName: string;
  files: PiwigoAlbumAnnouncementFile[];
  observedAt: string;
  announceAt: string;
  status: 'pending' | 'announced' | 'skipped' | 'failed';
  error?: string | undefined;
  announcedAt?: string | undefined;
}

export async function resolveGalleryConnection(
  _store: PluginDataStore,
  config?: PiwigoGalleryConfig | undefined,
  defaultPiwigoBaseUrl?: string | undefined,
  defaultPiwigoBotSecret?: string | undefined
): Promise<GalleryConnection | undefined> {
  return config ? configConnection(config, defaultPiwigoBaseUrl, defaultPiwigoBotSecret) : undefined;
}

export async function saveLinkRequest(store: PluginDataStore, request: GalleryLinkRequest): Promise<void> {
  await store.set(linkRequestKey(request.requestToken), request);
  for (const wid of uniqueWids([request.whatsappJid, ...(request.whatsappAliases ?? [])])) {
    await store.set(linkRequestWidKey(wid), { requestToken: request.requestToken.toUpperCase() });
  }
  const phoneDigits = digitsFromPhoneLike(request.phone ?? request.whatsappJid);
  if (phoneDigits) {
    await store.set(linkRequestPhoneKey(phoneDigits), { requestToken: request.requestToken.toUpperCase() });
  }
}

export function getLinkRequest(store: PluginDataStore, requestToken: string): Promise<GalleryLinkRequest | undefined> {
  return store.get<GalleryLinkRequest>(linkRequestKey(requestToken));
}

export async function getLinkRequestForWid(store: PluginDataStore, wid: string): Promise<GalleryLinkRequest | undefined> {
  const index = await store.get<{ requestToken: string }>(linkRequestWidKey(wid));
  return index?.requestToken ? getLinkRequest(store, index.requestToken) : undefined;
}

export async function getLinkRequestForWids(store: PluginDataStore, wids: string[]): Promise<GalleryLinkRequest | undefined> {
  for (const wid of uniqueWids(wids)) {
    const request = await getLinkRequestForWid(store, wid);
    if (request) {
      return request;
    }
  }
  return undefined;
}

export async function getLinkRequestForPhoneDigits(store: PluginDataStore, phoneDigits: string): Promise<GalleryLinkRequest | undefined> {
  const normalized = digitsFromPhoneLike(phoneDigits);
  if (!normalized) {
    return undefined;
  }
  const index = await store.get<{ requestToken: string }>(linkRequestPhoneKey(normalized));
  return index?.requestToken ? getLinkRequest(store, index.requestToken) : undefined;
}

export async function deleteLinkRequest(store: PluginDataStore, requestToken: string): Promise<void> {
  const request = await getLinkRequest(store, requestToken);
  await store.delete(linkRequestKey(requestToken));
  if (request) {
    for (const wid of uniqueWids([request.whatsappJid, ...(request.whatsappAliases ?? [])])) {
      await store.delete(linkRequestWidKey(wid));
    }
    const phoneDigits = digitsFromPhoneLike(request.phone ?? request.whatsappJid);
    if (phoneDigits) {
      await store.delete(linkRequestPhoneKey(phoneDigits));
    }
  }
}

export async function saveDraft(store: PluginDataStore, draft: GalleryUploadDraft): Promise<void> {
  await store.set(draftKey(draft.flowSessionId), draft, draft.scopeId);
}

export function getDraft(store: PluginDataStore, scopeId: string, flowSessionId: string): Promise<GalleryUploadDraft | undefined> {
  return store.get<GalleryUploadDraft>(draftKey(flowSessionId), scopeId);
}

export async function deleteDraft(store: PluginDataStore, scopeId: string, flowSessionId: string): Promise<void> {
  await store.delete(draftKey(flowSessionId), scopeId);
}

export async function saveBatch(store: PluginDataStore, batch: GalleryUploadBatch): Promise<void> {
  await store.set(batchKey(batch.id), batch, batch.scopeId);
}

export function getBatch(store: PluginDataStore, scopeId: string, batchId: string): Promise<GalleryUploadBatch | undefined> {
  return store.get<GalleryUploadBatch>(batchKey(batchId), scopeId);
}

export async function setActiveBatch(store: PluginDataStore, batch: GalleryUploadBatch): Promise<void> {
  for (const actorWid of batchActorWids(batch)) {
    await store.set(activeKey(batch.chatId, actorWid), { batchId: batch.id }, batch.scopeId);
  }
}

export async function getActiveBatch(
  store: PluginDataStore,
  scopeId: string,
  chatId: string,
  actorWid: string
): Promise<GalleryUploadBatch | undefined> {
  const active = await store.get<{ batchId: string }>(activeKey(chatId, actorWid), scopeId);
  if (!active?.batchId) {
    return undefined;
  }
  return getBatch(store, scopeId, active.batchId);
}

export async function getActiveBatchForActorWids(
  store: PluginDataStore,
  scopeId: string,
  chatId: string,
  actorWids: string[]
): Promise<GalleryUploadBatch | undefined> {
  for (const actorWid of uniqueWids(actorWids)) {
    const batch = await getActiveBatch(store, scopeId, chatId, actorWid);
    if (batch) {
      return batch;
    }
  }
  return undefined;
}

export async function clearActiveBatch(store: PluginDataStore, batch: GalleryUploadBatch): Promise<void> {
  for (const actorWid of batchActorWids(batch)) {
    await store.delete(activeKey(batch.chatId, actorWid), batch.scopeId);
  }
}

export async function saveAlbumAnnouncement(store: PluginDataStore, announcement: PiwigoAlbumAnnouncement): Promise<void> {
  await store.set(albumAnnouncementKey(announcement.id), announcement, announcement.scopeId);
  await store.set(albumAnnouncementDedupeKey(announcement.dedupeKey), { announcementId: announcement.id }, announcement.scopeId);
}

export function getAlbumAnnouncement(
  store: PluginDataStore,
  scopeId: string,
  announcementId: string
): Promise<PiwigoAlbumAnnouncement | undefined> {
  return store.get<PiwigoAlbumAnnouncement>(albumAnnouncementKey(announcementId), scopeId);
}

export async function getAlbumAnnouncementByDedupeKey(
  store: PluginDataStore,
  scopeId: string,
  dedupeKey: string
): Promise<PiwigoAlbumAnnouncement | undefined> {
  const index = await store.get<{ announcementId: string }>(albumAnnouncementDedupeKey(dedupeKey), scopeId);
  return index?.announcementId ? getAlbumAnnouncement(store, scopeId, index.announcementId) : undefined;
}

function batchActorWids(batch: Pick<GalleryUploadBatch, 'actorWid' | 'actorAliases'>): string[] {
  return uniqueWids([batch.actorWid, ...(batch.actorAliases ?? [])]);
}

function draftKey(flowSessionId: string): string {
  return `upload-draft:${flowSessionId}`;
}

function batchKey(batchId: string): string {
  return `upload-batch:${batchId}`;
}

function activeKey(chatId: string, actorWid: string): string {
  return `active-upload:${chatId}:${actorWid}`;
}

function albumAnnouncementKey(announcementId: string): string {
  return `album-announcement:${announcementId}`;
}

function albumAnnouncementDedupeKey(dedupeKey: string): string {
  return `album-announcement-dedupe:${dedupeKey}`;
}

function linkRequestKey(requestToken: string): string {
  return `link-request:${requestToken.toUpperCase()}`;
}

function linkRequestWidKey(wid: string): string {
  return `link-request-wid:${wid.toLowerCase()}`;
}

function linkRequestPhoneKey(phoneDigits: string): string {
  return `link-request-phone:${phoneDigits}`;
}

function uniqueWids(wids: string[]): string[] {
  return [...new Set(wids.map((wid) => wid.trim().toLowerCase()).filter(Boolean))];
}

export function digitsFromPhoneLike(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cUsMatch = trimmed.match(/^(\d+)@c\.us$/);
  if (cUsMatch?.[1]) {
    return cUsMatch[1];
  }
  if (trimmed.includes('@')) {
    return '';
  }
  return trimmed.replace(/\D/g, '');
}
