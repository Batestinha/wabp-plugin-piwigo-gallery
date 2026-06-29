import {
  EnrollmentStatus,
  KnownAccessSourceKind,
  type PrismaClient
} from '@prisma/client';
import { prisma } from '../../../platform/db/prisma';
import { PluginScopeResolver } from '../../../platform/pluginRuntime/runtime/pluginScopeResolver';
import { resolveBotBindingId, resolveBotProfileId } from '../../../platform/tenancy/botProfileTenant';
import {
  configConnection,
  parsePiwigoGalleryConfig,
  samePiwigoBaseUrl,
  type GalleryConnection,
  type PiwigoGalleryConfig
} from './config';
import { PIWIGO_GALLERY_PLUGIN_ID } from './manifest';

const MANAGED_GROUP_SOURCE_KINDS = [
  KnownAccessSourceKind.MANAGED_GROUP_ADMIN,
  KnownAccessSourceKind.MANAGED_GROUP_MEMBER
] as const;

export async function assertPiwigoGalleryEligibleWid(
  wid: string,
  db: PrismaClient = prisma,
  botProfileId: string = resolveBotProfileId(),
  botBindingId: string = resolveBotBindingId(undefined, botProfileId)
): Promise<void> {
  if (await isPiwigoGalleryEligibleWid(wid, db, botProfileId, botBindingId)) {
    return;
  }
  throw new Error('WhatsApp account is not a member of a Piwigo-enabled group.');
}

export async function isPiwigoGalleryEligibleWid(
  wid: string,
  db: PrismaClient = prisma,
  botProfileId: string = resolveBotProfileId(),
  botBindingId: string = resolveBotBindingId(undefined, botProfileId)
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
      botBindingId,
      identityId: identity.id,
      active: true,
      sourceKind: { in: [...MANAGED_GROUP_SOURCE_KINDS] },
      group: {
        is: {
          botBindingId,
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

  const scopeResolver = new PluginScopeResolver(db, botProfileId, botBindingId);
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

export interface ConfiguredPiwigoGalleryScope {
  scopeId: string;
  groupId: string;
  groupWid: string;
  label: string;
  config: PiwigoGalleryConfig;
  connection: GalleryConnection;
}

export async function listConfiguredPiwigoGalleryEligibleScopes(
  wid: string,
  input: {
    db?: PrismaClient | undefined;
    botProfileId?: string | undefined;
    botBindingId?: string | undefined;
    piwigoBaseUrl?: string | undefined;
  } = {}
): Promise<ConfiguredPiwigoGalleryScope[]> {
  const db = input.db ?? prisma;
  const botProfileId = input.botProfileId ?? resolveBotProfileId();
  const botBindingId = resolveBotBindingId(input.botBindingId, botProfileId);
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
    return [];
  }

  const records = await db.identityAccessRecord.findMany({
    where: {
      botBindingId,
      identityId: identity.id,
      active: true,
      sourceKind: { in: [...MANAGED_GROUP_SOURCE_KINDS] },
      group: {
        is: {
          botBindingId,
          enrollmentStatus: EnrollmentStatus.ENROLLED
        }
      }
    },
    select: {
      group: {
        select: {
          id: true,
          chatId: true,
          displayName: true
        }
      }
    },
    orderBy: { id: 'asc' }
  });

  const scopeResolver = new PluginScopeResolver(db, botProfileId, botBindingId);
  const groups = uniqueBy(records.flatMap((record) => record.group ? [record.group] : []), (group) => group.id);
  const scopes = new Map<string, ConfiguredPiwigoGalleryScope>();
  for (const group of groups) {
    const resolvedScopes = await scopeResolver.resolveGroupScopes(group.chatId);
    for (const resolved of resolvedScopes) {
      const effective = await resolveEffectivePiwigoGalleryConfig(resolved.scopeId, scopeResolver, db, botProfileId);
      if (!effective || !effective.config.enabled) {
        continue;
      }
      if (input.piwigoBaseUrl && !samePiwigoBaseUrl(effective.connection.piwigoBaseUrl, input.piwigoBaseUrl)) {
        continue;
      }
      scopes.set(`${resolved.scopeId}:${resolved.groupId}`, {
        scopeId: resolved.scopeId,
        groupId: resolved.groupId,
        groupWid: resolved.groupWid,
        label: group.displayName || resolved.groupWid,
        config: effective.config,
        connection: effective.connection
      });
    }
  }

  return [...scopes.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.scopeId.localeCompare(right.scopeId)
  );
}

async function resolveEffectivePiwigoGalleryConfig(
  scopeId: string,
  scopeResolver: PluginScopeResolver,
  db: PrismaClient,
  botProfileId: string
): Promise<{ config: PiwigoGalleryConfig; connection: GalleryConnection } | undefined> {
  let scopeIds: string[];
  try {
    scopeIds = await scopeResolver.resolveEffectiveScopeIds(scopeId);
  } catch {
    scopeIds = [scopeId];
  }

  const instances = await db.pluginInstance.findMany({
    where: {
      pluginId: PIWIGO_GALLERY_PLUGIN_ID,
      enabled: true,
      scopeId: { in: scopeIds },
      scope: { botProfileId }
    },
    select: {
      scopeId: true,
      configJson: true
    }
  });
  if (instances.length === 0) {
    return undefined;
  }

  const byScope = new Map(instances.map((instance) => [instance.scopeId, instance]));
  const merged: Record<string, unknown> = {};
  for (const candidateScopeId of scopeIds) {
    const instance = byScope.get(candidateScopeId);
    if (!instance) {
      continue;
    }
    Object.assign(merged, asRecord(instance.configJson));
  }

  const config = parsePiwigoGalleryConfig(merged);
  const connection = configConnection(config);
  return connection ? { config, connection } : undefined;
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

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}
