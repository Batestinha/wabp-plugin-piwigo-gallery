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
  whatsappJid: string;
  piwigoBaseUrl?: string | undefined;
  scopeOptions: GalleryScopeOption[];
  createdAt: string;
  expiresAt: string;
}

export async function resolveGalleryConnection(
  _store: PluginDataStore,
  config?: PiwigoGalleryConfig | undefined
): Promise<GalleryConnection | undefined> {
  return config ? configConnection(config) : undefined;
}

export async function saveLinkRequest(store: PluginDataStore, request: GalleryLinkRequest): Promise<void> {
  await store.set(linkRequestKey(request.requestToken), request);
}

export function getLinkRequest(store: PluginDataStore, requestToken: string): Promise<GalleryLinkRequest | undefined> {
  return store.get<GalleryLinkRequest>(linkRequestKey(requestToken));
}

export async function deleteLinkRequest(store: PluginDataStore, requestToken: string): Promise<void> {
  await store.delete(linkRequestKey(requestToken));
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
  await store.set(activeKey(batch.chatId, batch.actorWid), { batchId: batch.id }, batch.scopeId);
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

export async function clearActiveBatch(store: PluginDataStore, batch: GalleryUploadBatch): Promise<void> {
  await store.delete(activeKey(batch.chatId, batch.actorWid), batch.scopeId);
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

function linkRequestKey(requestToken: string): string {
  return `link-request:${requestToken.toUpperCase()}`;
}
