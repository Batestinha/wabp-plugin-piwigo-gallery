import {
  EnrollmentStatus,
  KnownAccessSourceKind,
  type PrismaClient
} from '@prisma/client';
import { prisma } from '../../../platform/db/prisma';
import { PluginScopeResolver } from '../../../platform/pluginRuntime/runtime/pluginScopeResolver';
import { resolveRuntimeBindingId, resolveWhatsAppAccountId } from '../../../platform/tenancy/accountTenant';
import {
  configConnection,
  parsePiwigoGalleryConfig,
  type GalleryConnection,
  type GalleryConnectionDefaults,
  type PiwigoGalleryConfig
} from './config';
import { PIWIGO_GALLERY_PLUGIN_ID } from './manifest';

const MANAGED_GROUP_SOURCE_KINDS = [
  KnownAccessSourceKind.MANAGED_GROUP_ADMIN,
  KnownAccessSourceKind.MANAGED_GROUP_MEMBER
] as const;

export async function assertPiwigoGalleryEligibleIdentity(
  identityId: string,
  db: PrismaClient = prisma,
  whatsAppAccountId: string = resolveWhatsAppAccountId(),
  runtimeBindingId: string = resolveRuntimeBindingId(undefined, whatsAppAccountId)
): Promise<void> {
  if (await isPiwigoGalleryEligibleIdentity(identityId, db, whatsAppAccountId, runtimeBindingId)) {
    return;
  }
  throw new Error('WhatsApp identity is not a member of a Piwigo-enabled group.');
}

export async function isPiwigoGalleryEligibleIdentity(
  identityId: string,
  db: PrismaClient = prisma,
  whatsAppAccountId: string = resolveWhatsAppAccountId(),
  runtimeBindingId: string = resolveRuntimeBindingId(undefined, whatsAppAccountId)
): Promise<boolean> {
  const authoritativeIdentityId = identityId.trim();
  if (!authoritativeIdentityId) {
    return false;
  }

  const records = await db.identityAccessRecord.findMany({
    where: {
      runtimeBindingId,
      identityId: authoritativeIdentityId,
      active: true,
      sourceKind: { in: [...MANAGED_GROUP_SOURCE_KINDS] },
      group: {
        is: {
          runtimeBindingId,
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

  const scopeResolver = new PluginScopeResolver(db, whatsAppAccountId, runtimeBindingId);
  const groups = uniqueBy(records.flatMap((record) => record.group ? [record.group] : []), (group) => group.id);
  for (const group of groups) {
    const scopes = await scopeResolver.resolveGroupScopes(group.chatId);
    for (const scope of scopes) {
      if (await scopeHasPiwigoGalleryEnabled(scope.scopeId, scopeResolver, db, whatsAppAccountId)) {
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
  managementMode?: 'OBSERVE' | 'ASSIST' | 'MANAGE' | undefined;
  /** Human-readable logical gallery/scope label, independent of a physical child group. */
  scopeLabel?: string | undefined;
  label: string;
  config: PiwigoGalleryConfig;
  connection: GalleryConnection;
}

export async function listConfiguredPiwigoGalleryEligibleScopes(
  identityId: string,
  input: GalleryConnectionDefaults & {
    db?: PrismaClient | undefined;
    whatsAppAccountId?: string | undefined;
    runtimeBindingId?: string | undefined;
  }
): Promise<ConfiguredPiwigoGalleryScope[]> {
  const db = input.db ?? prisma;
  const whatsAppAccountId = input.whatsAppAccountId ?? resolveWhatsAppAccountId();
  const runtimeBindingId = resolveRuntimeBindingId(input.runtimeBindingId, whatsAppAccountId);
  const authoritativeIdentityId = identityId.trim();
  if (!authoritativeIdentityId) {
    return [];
  }

  const records = await db.identityAccessRecord.findMany({
    where: {
      runtimeBindingId,
      identityId: authoritativeIdentityId,
      active: true,
      sourceKind: { in: [...MANAGED_GROUP_SOURCE_KINDS] },
      group: {
        is: {
          runtimeBindingId,
          enrollmentStatus: EnrollmentStatus.ENROLLED
        }
      }
    },
    select: {
      group: {
        select: {
          id: true,
          chatId: true,
          displayName: true,
          communityMetadata: {
            select: {
              linkedParentChatId: true
            }
          }
        }
      }
    },
    orderBy: { id: 'asc' }
  });

  const scopeResolver = new PluginScopeResolver(db, whatsAppAccountId, runtimeBindingId);
  const groups = uniqueBy(records.flatMap((record) => record.group ? [record.group] : []), (group) => group.id);
  const scopes = new Map<string, ConfiguredPiwigoGalleryScope>();
  const scopeLabels = new Map<string, string>();
  for (const group of groups) {
    const resolvedScopes = await scopeResolver.resolveGroupScopes(group.chatId);
    for (const resolved of resolvedScopes) {
      const effective = await resolveEffectivePiwigoGalleryConfig(
        resolved.scopeId,
        scopeResolver,
        db,
        whatsAppAccountId,
        input
      );
      if (!effective || !effective.config.enabled) {
        continue;
      }
      let scopeLabel = scopeLabels.get(resolved.scopeId);
      if (!scopeLabel) {
        const scope = await db.scope.findUnique({
          where: { id: resolved.scopeId },
          select: { name: true }
        });
        scopeLabel = scope?.name?.trim() || group.displayName || resolved.groupWid;
        scopeLabels.set(resolved.scopeId, scopeLabel);
      }
      scopes.set(`${resolved.scopeId}:${resolved.groupId}`, {
        scopeId: resolved.scopeId,
        groupId: resolved.groupId,
        groupWid: resolved.groupWid,
        managementMode: resolved.managementMode,
        scopeLabel,
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
  whatsAppAccountId: string,
  connectionDefaults: GalleryConnectionDefaults
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
      scope: { whatsAppAccountId }
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
  const connection = configConnection(config, connectionDefaults);
  return connection ? { config, connection } : undefined;
}

async function scopeHasPiwigoGalleryEnabled(
  scopeId: string,
  scopeResolver: PluginScopeResolver,
  db: PrismaClient,
  whatsAppAccountId: string
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
      scope: { whatsAppAccountId }
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
