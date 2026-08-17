import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginExternalActionRegistration } from '../../../platform/pluginRuntime/pluginExternalActions';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { PluginExternalActionRegistrationContext } from '../../../platform/pluginRuntime/types';
import { parsePiwigoGalleryConfig } from './config';
import {
  PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
  PIWIGO_GALLERY_EXTERNAL_ACTIONS,
  PIWIGO_GALLERY_PLUGIN_ID
} from './manifest';
import {
  bindAlbumAnnouncementTarget,
  GalleryStorageConflictError,
  getAlbumAnnouncementByDedupeKey,
  saveAlbumAnnouncement,
  type PiwigoAlbumAnnouncementFile,
  type StoredPiwigoAlbumAnnouncement
} from './store';
import { preparedGalleryDatabase } from './storageRuntime';

export const piwigoGalleryExternalActionSchemas = {
  albumUploadObserved: z.object({
    eventId: z.string().trim().min(1).max(160),
    scopeId: z.string().trim().min(1),
    albumId: z.union([z.string().trim().min(1), z.number().int().positive()]),
    albumName: z.string().trim().min(1).max(200),
    siteLabel: z.string().trim().min(1).max(120),
    userDisplayName: z.string().trim().min(1).max(120),
    observedAt: z.string().trim().datetime().optional(),
    files: z.array(z.object({
      imageId: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      filename: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().min(1).max(120)
    }).strict()).min(1).max(50)
  }).strict()
};

const outputSchemas = {
  albumUploadObserved: z.object({
    accepted: z.boolean(),
    duplicate: z.boolean(),
    announcementId: z.string().optional(),
    announceAt: z.string().optional(),
    reason: z.string().optional()
  }).strict()
};

type AnyExternalActionRegistration = PluginExternalActionRegistration<any, any>;

export function createPiwigoGalleryExternalActions(
  context: PluginExternalActionRegistrationContext
): AnyExternalActionRegistration[] {
  const runtime = new PiwigoGalleryExternalActionRuntime(context);
  return [{
    actionId: PIWIGO_GALLERY_EXTERNAL_ACTIONS.albumUploadObserved,
    inputSchema: piwigoGalleryExternalActionSchemas.albumUploadObserved,
    outputSchema: outputSchemas.albumUploadObserved,
    resolveScopeId: (input) => input.scopeId,
    handler: (input, call) => runtime.observeAlbumUpload(input, call.signal)
  }];
}

class PiwigoGalleryExternalActionRuntime {
  constructor(private readonly context: PluginExternalActionRegistrationContext) {}

  async observeAlbumUpload(
    input: z.infer<typeof piwigoGalleryExternalActionSchemas.albumUploadObserved>,
    signal: AbortSignal
  ): Promise<z.infer<typeof outputSchemas.albumUploadObserved>> {
    const database = await this.database();
    const config = parsePiwigoGalleryConfig(await this.context.configFor(input.scopeId));
    const albumId = String(input.albumId);
    const dedupeKey = `album:${albumId}`;
    const observedAt = input.observedAt ?? new Date().toISOString();
    const observedDeadline = new Date(Math.max(
      Date.now(),
      new Date(observedAt).getTime() + config.newAlbumAnnouncementDelayMinutes * 60_000
    )).toISOString();
    const catchUpDeadline = new Date(
      Date.now() + config.newAlbumAnnouncementDelayMinutes * 60_000
    ).toISOString();
    let validatedGroupWid: string | undefined;
    const resolveAnnouncementGroup = async (
      capturedGroupWid?: string | undefined
    ): Promise<{ announcementGroupWid?: string | undefined; reason?: string | undefined }> => {
      const announcementGroupWid = capturedGroupWid
        || config.announcementGroupWid
        || await this.context.communityAnnouncementGroupWidForScope?.(input.scopeId);
      if (!announcementGroupWid) {
        return { reason: 'announcementGroupWid is not configured for this scope' };
      }
      if (validatedGroupWid !== announcementGroupWid) {
        if (!(await this.groupBelongsToScope(input.scopeId, announcementGroupWid))) {
          return { reason: 'announcementGroupWid does not belong to the callback scope' };
        }
        validatedGroupWid = announcementGroupWid;
      }
      throwIfAborted(signal);
      return { announcementGroupWid };
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let existing = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
      if (!existing) {
        if (!config.newAlbumAnnouncementsEnabled) {
          return { accepted: false, duplicate: false, reason: 'new album announcements are disabled for this scope' };
        }
        const target = await resolveAnnouncementGroup();
        if (!target.announcementGroupWid) {
          return { accepted: false, duplicate: false, reason: target.reason };
        }
        existing = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
        if (existing) continue;
        const announcementId = randomUUID();
        try {
          const announcement = saveAlbumAnnouncement(database, {
            id: announcementId,
            dedupeKey,
            scopeId: input.scopeId,
            announcementGroupWid: target.announcementGroupWid,
            albumId,
            albumName: input.albumName,
            siteLabel: input.siteLabel,
            userDisplayName: input.userDisplayName,
            files: input.files.map(albumObservationFile),
            observedAt,
            announceAt: observedDeadline,
            status: 'pending'
          });
          throwIfAborted(signal);
          await enqueueAlbumAnnouncement(this.context, announcement, target.announcementGroupWid, false);
          return { accepted: true, duplicate: false, announcementId, announceAt: observedDeadline };
        } catch (error) {
          if (getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey)) continue;
          throw error;
        }
      }

      const catchUpDedupeKey = albumCatchUpDedupeKey(input.scopeId, existing.id);
      let catchUp = getAlbumAnnouncementByDedupeKey(database, input.scopeId, catchUpDedupeKey);
      assertAlbumAnnouncementDigestIntegrity(
        [...existing.files, ...(catchUp?.files ?? [])],
        input.files
      );
      const missingFiles = missingAlbumAnnouncementFiles(
        [...existing.files, ...(catchUp?.files ?? [])],
        input.files
      );

      if (missingFiles.length === 0) {
        const catchUpImageIds = new Set(catchUp?.files.map((file) => file.imageId) ?? []);
        const duplicate = catchUp && input.files.some((file) => catchUpImageIds.has(file.imageId))
          ? catchUp
          : existing;
        if (duplicate.status === 'pending' && config.newAlbumAnnouncementsEnabled) {
          if (!duplicate.announcementGroupWid) {
            const target = await resolveAnnouncementGroup(existing.announcementGroupWid);
            if (!target.announcementGroupWid) {
              return {
                accepted: true,
                duplicate: true,
                announcementId: duplicate.id,
                announceAt: duplicate.announceAt,
                reason: target.reason
              };
            }
            if (duplicate.id === existing.id) {
              bindAlbumAnnouncementTarget(database, {
                scopeId: input.scopeId,
                announcementId: existing.id,
                announcementGroupWid: target.announcementGroupWid
              });
              continue;
            }
            throw httpError(500, 'The stored album catch-up announcement target is missing.');
          }
          throwIfAborted(signal);
          await enqueueAlbumAnnouncement(
            this.context,
            duplicate,
            duplicate.announcementGroupWid,
            true
          );
        }
        return {
          accepted: true,
          duplicate: true,
          announcementId: duplicate.id,
          announceAt: duplicate.announceAt
        };
      }

      const terminalCatchUpEligible = existing.status === 'announced'
        && existing.announcedAt !== undefined
        && new Date(observedAt).getTime() <= new Date(existing.announcedAt).getTime();
      if (existing.status !== 'pending' && !terminalCatchUpEligible) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: existing.status === 'announced'
            ? 'the upload was observed after this album announcement completed'
            : `the album announcement is already ${existing.status}`
        };
      }
      if (catchUp && catchUp.status !== 'pending') {
        return {
          accepted: false,
          duplicate: true,
          announcementId: catchUp.id,
          announceAt: catchUp.announceAt,
          reason: `the album catch-up announcement is already ${catchUp.status}`
        };
      }
      if (!config.newAlbumAnnouncementsEnabled) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: 'new album announcements are disabled for this scope'
        };
      }

      if (existing.status === 'pending' && hasActiveAlbumAnnouncementClaim(existing, Date.now())) {
        throw httpError(425, 'The album announcement is currently being delivered; retry this observation.');
      }
      const useCatchUp = existing.status !== 'pending';
      if (!useCatchUp) {
        if (!existing.announcementGroupWid) {
          const target = await resolveAnnouncementGroup();
          if (!target.announcementGroupWid) {
            return {
              accepted: false,
              duplicate: true,
              announcementId: existing.id,
              announceAt: existing.announceAt,
              reason: 'the stored announcement target could not be resolved inside the callback scope'
            };
          }
          bindAlbumAnnouncementTarget(database, {
            scopeId: input.scopeId,
            announcementId: existing.id,
            announcementGroupWid: target.announcementGroupWid
          });
          continue;
        }
        const announcementGroupWid = existing.announcementGroupWid;
        try {
          existing = saveAlbumAnnouncement(database, {
            ...existing,
            files: [...existing.files.map((file) => ({ ...file })), ...missingFiles],
            observedAt: existing.observedAt < observedAt ? existing.observedAt : observedAt,
            announceAt: existing.announceAt > observedDeadline ? existing.announceAt : observedDeadline,
            ...(existing.claimId ? { claimId: undefined, claimExpiresAt: undefined } : {})
          }, existing.version);
        } catch (error) {
          if (error instanceof GalleryStorageConflictError) continue;
          throw error;
        }
        throwIfAborted(signal);
        await enqueueAlbumAnnouncement(this.context, existing, announcementGroupWid, true);
        return {
          accepted: true,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt
        };
      }

      const target = await resolveAnnouncementGroup(existing.announcementGroupWid);
      if (!target.announcementGroupWid) {
        return {
          accepted: false,
          duplicate: true,
          announcementId: existing.id,
          announceAt: existing.announceAt,
          reason: target.reason
        };
      }
      const latestBase = getAlbumAnnouncementByDedupeKey(database, input.scopeId, dedupeKey);
      const latestCatchUp = getAlbumAnnouncementByDedupeKey(database, input.scopeId, catchUpDedupeKey);
      if (
        !latestBase
        || latestBase.version !== existing.version
        || latestCatchUp?.version !== catchUp?.version
      ) {
        continue;
      }
      existing = latestBase;
      catchUp = latestCatchUp;
      if (!existing.announcementGroupWid) {
        bindAlbumAnnouncementTarget(database, {
          scopeId: input.scopeId,
          announcementId: existing.id,
          announcementGroupWid: target.announcementGroupWid
        });
        continue;
      }
      const upserted = upsertAlbumCatchUp(database, {
        base: existing,
        dedupeKey: catchUpDedupeKey,
        announcementGroupWid: target.announcementGroupWid,
        albumId,
        albumName: input.albumName,
        siteLabel: input.siteLabel,
        userDisplayName: input.userDisplayName,
        incomingFiles: input.files,
        observedAt,
        announceAt: catchUpDeadline,
        nowMs: Date.now()
      });
      throwIfAborted(signal);
      if (upserted.announcement.status === 'pending') {
        await enqueueAlbumAnnouncement(
          this.context,
          upserted.announcement,
          target.announcementGroupWid,
          !upserted.created
        );
      }
      return {
        accepted: upserted.rejectedReason === undefined,
        duplicate: !upserted.created,
        announcementId: upserted.announcement.id,
        announceAt: upserted.announcement.announceAt,
        ...(upserted.rejectedReason ? { reason: upserted.rejectedReason } : {})
      };
    }

    throw httpError(503, 'The album announcement changed concurrently; retry this observation.');
  }

  private database() {
    return preparedGalleryDatabase(this.context.dataStore, this.context.databases);
  }

  private async groupBelongsToScope(scopeId: string, groupWid: string): Promise<boolean> {
    const coveredGroups = await this.context.coveredGroupsForScope?.(scopeId);
    return coveredGroups?.some((group) => group.groupWid.toLowerCase() === groupWid.toLowerCase()) ?? false;
  }
}

function enqueueAlbumAnnouncement(
  context: PluginExternalActionRegistrationContext,
  announcement: {
    id: string;
    scopeId: string;
    announceAt: string;
    downloadRetryCount?: number | undefined;
    downloadNextRetryAt?: string | undefined;
    version?: number | undefined;
  },
  groupWid: string,
  recovery: boolean
): Promise<void> {
  const dueAt = announcement.downloadNextRetryAt
    && new Date(announcement.downloadNextRetryAt).getTime() > new Date(announcement.announceAt).getTime()
    ? announcement.downloadNextRetryAt
    : announcement.announceAt;
  const recoveryDedupeSuffix = recovery
    ? `:callback-recovery:v${announcement.version ?? 1}:r${announcement.downloadRetryCount ?? 0}:${dueAt}`
    : '';
  return enqueuePluginJob(context.queue, {
    pluginId: PIWIGO_GALLERY_PLUGIN_ID,
    jobName: PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB,
    scopeId: announcement.scopeId,
    groupWid,
    runAt: new Date(dueAt),
    payload: { announcementId: announcement.id },
    dedupeKey: `${PIWIGO_GALLERY_ANNOUNCE_NEW_ALBUM_JOB}:${announcement.id}${recoveryDedupeSuffix}`
  });
}

type AlbumObservationFile = {
  imageId: number;
  sha256: string;
  filename: string;
  mimeType: string;
};

function albumObservationFile(file: AlbumObservationFile): PiwigoAlbumAnnouncementFile {
  return {
    imageId: file.imageId,
    sha256: file.sha256,
    filename: file.filename,
    mimeType: file.mimeType
  };
}

function assertAlbumAnnouncementDigestIntegrity(
  existing: readonly PiwigoAlbumAnnouncementFile[],
  incoming: readonly AlbumObservationFile[]
): void {
  const digests = new Map<number, string | undefined>();
  for (const file of existing) {
    if (file.imageId !== undefined) digests.set(file.imageId, file.sha256);
  }
  for (const file of incoming) {
    if (digests.has(file.imageId) && digests.get(file.imageId) !== file.sha256) {
      throw httpError(409, `Piwigo image ${file.imageId} was observed with a conflicting SHA-256 digest.`);
    }
    digests.set(file.imageId, file.sha256);
  }
}

function missingAlbumAnnouncementFiles(
  existing: readonly PiwigoAlbumAnnouncementFile[],
  incoming: readonly AlbumObservationFile[]
): PiwigoAlbumAnnouncementFile[] {
  const missing: PiwigoAlbumAnnouncementFile[] = [];
  const imageIds = new Set(
    existing
      .map((file) => file.imageId)
      .filter((imageId): imageId is number => imageId !== undefined)
  );
  for (const file of incoming) {
    if (imageIds.has(file.imageId)) continue;
    missing.push(albumObservationFile(file));
    imageIds.add(file.imageId);
  }
  return missing;
}

function hasActiveAlbumAnnouncementClaim(
  announcement: Pick<StoredPiwigoAlbumAnnouncement, 'claimId' | 'claimExpiresAt'>,
  nowMs: number
): boolean {
  return Boolean(
    announcement.claimId
    && announcement.claimExpiresAt
    && new Date(announcement.claimExpiresAt).getTime() > nowMs
  );
}

function albumCatchUpDedupeKey(scopeId: string, baseAnnouncementId: string): string {
  return `album-followup:${opaqueKey(scopeId, baseAnnouncementId)}`;
}

function upsertAlbumCatchUp(
  db: PluginDatabase,
  input: {
    base: StoredPiwigoAlbumAnnouncement;
    dedupeKey: string;
    announcementGroupWid: string;
    albumId: string;
    albumName: string;
    siteLabel: string;
    userDisplayName: string;
    incomingFiles: readonly AlbumObservationFile[];
    observedAt: string;
    announceAt: string;
    nowMs: number;
  }
): { announcement: StoredPiwigoAlbumAnnouncement; created: boolean; rejectedReason?: string | undefined } {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = getAlbumAnnouncementByDedupeKey(db, input.base.scopeId, input.dedupeKey);
    assertAlbumAnnouncementDigestIntegrity(
      [...input.base.files, ...(existing?.files ?? [])],
      input.incomingFiles
    );
    const missingFiles = missingAlbumAnnouncementFiles(
      [...input.base.files, ...(existing?.files ?? [])],
      input.incomingFiles
    );
    if (existing) {
      if (missingFiles.length === 0) {
        return { announcement: existing, created: false };
      }
      if (existing.status !== 'pending') {
        return {
          announcement: existing,
          created: false,
          rejectedReason: `the album catch-up announcement is already ${existing.status}`
        };
      }
      if (hasActiveAlbumAnnouncementClaim(existing, input.nowMs)) {
        throw httpError(425, 'The album catch-up announcement is currently being delivered; retry this observation.');
      }
      try {
        const announcement = saveAlbumAnnouncement(db, {
          ...existing,
          files: [...existing.files.map((file) => ({ ...file })), ...missingFiles],
          observedAt: existing.observedAt < input.observedAt ? existing.observedAt : input.observedAt,
          announceAt: existing.announceAt > input.announceAt ? existing.announceAt : input.announceAt,
          ...(existing.claimId ? { claimId: undefined, claimExpiresAt: undefined } : {})
        }, existing.version);
        return { announcement, created: false };
      } catch (error) {
        if (error instanceof GalleryStorageConflictError) continue;
        throw error;
      }
    }

    const announcementId = randomUUID();
    try {
      const announcement = saveAlbumAnnouncement(db, {
        id: announcementId,
        dedupeKey: input.dedupeKey,
        scopeId: input.base.scopeId,
        announcementGroupWid: input.announcementGroupWid,
        albumId: input.albumId,
        albumName: input.albumName,
        siteLabel: input.siteLabel,
        userDisplayName: input.userDisplayName,
        files: missingFiles,
        observedAt: input.observedAt,
        announceAt: input.announceAt,
        status: 'pending'
      });
      return { announcement, created: true };
    } catch (error) {
      if (getAlbumAnnouncementByDedupeKey(db, input.base.scopeId, input.dedupeKey)) continue;
      throw error;
    }
  }
  throw httpError(503, 'The album catch-up announcement changed concurrently; retry this observation.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Piwigo external action was aborted.');
  }
}

function opaqueKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
