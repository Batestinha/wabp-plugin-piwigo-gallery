import {
  EnrollmentStatus,
  KnownAccessSourceKind,
  type PrismaClient
} from '@prisma/client';
import { prisma } from '../../../platform/db/prisma';
import { PluginScopeResolver } from '../../../platform/pluginRuntime/runtime/pluginScopeResolver';
import { resolveBotProfileId } from '../../../platform/tenancy/botProfileTenant';
import { PIWIGO_GALLERY_PLUGIN_ID } from './manifest';

const MANAGED_GROUP_SOURCE_KINDS = [
  KnownAccessSourceKind.MANAGED_GROUP_ADMIN,
  KnownAccessSourceKind.MANAGED_GROUP_MEMBER
] as const;

export async function assertPiwigoGalleryEligibleWid(
  wid: string,
  db: PrismaClient = prisma,
  botProfileId: string = resolveBotProfileId()
): Promise<void> {
  if (await isPiwigoGalleryEligibleWid(wid, db, botProfileId)) {
    return;
  }
  throw new Error('WhatsApp account is not a member of a Piwigo-enabled group.');
}

export async function isPiwigoGalleryEligibleWid(
  wid: string,
  db: PrismaClient = prisma,
  botProfileId: string = resolveBotProfileId()
): Promise<boolean> {
  const identity = await db.waIdentity.findFirst({
    where: {
      OR: [
        { wid },
        { aliases: { some: { wid } } }
      ]
    },
    select: { id: true }
  });
  if (!identity) {
    return false;
  }

  const records = await db.identityAccessRecord.findMany({
    where: {
      botProfileId,
      identityId: identity.id,
      active: true,
      sourceKind: { in: [...MANAGED_GROUP_SOURCE_KINDS] },
      group: {
        is: {
          botProfileId,
          enrollmentStatus: EnrollmentStatus.ENROLLED
        }
      }
    },
    select: {
      group: {
        select: {
          id: true,
          chatId: true
        }
      }
    }
  });

  const scopeResolver = new PluginScopeResolver(db, botProfileId);
  const groups = uniqueBy(records.flatMap((record) => record.group ? [record.group] : []), (group) => group.id);
  for (const group of groups) {
    const scopes = await scopeResolver.resolveGroupScopes(group.chatId);
    for (const scope of scopes) {
      if (await scopeHasPiwigoGalleryEnabled(scope.scopeId, scopeResolver, db, botProfileId)) {
        return true;
      }
    }
  }
  return false;
}

async function scopeHasPiwigoGalleryEnabled(
  scopeId: string,
  scopeResolver: PluginScopeResolver,
  db: PrismaClient,
  botProfileId: string
): Promise<boolean> {
  let scopeIds: string[];
  try {
    scopeIds = await scopeResolver.resolveEffectiveScopeIds(scopeId);
  } catch {
    scopeIds = [scopeId];
  }
  const plugin = await db.pluginInstance.findFirst({
    where: {
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      enabled: true,
      scopeId: { in: scopeIds },
      scope: { botProfileId }
    },
    select: { id: true }
  });
  return Boolean(plugin);
}

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}
