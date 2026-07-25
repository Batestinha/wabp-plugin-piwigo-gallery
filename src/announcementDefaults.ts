import { EnrollmentStatus, type PrismaClient } from '@prisma/client';

export async function defaultPiwigoAnnouncementGroupWidForScope(input: {
  db: PrismaClient;
  runtimeBindingId: string;
  scopeId: string;
}): Promise<string | undefined> {
  const communityGroupWid = await communityGroupWidForScope(input);
  if (!communityGroupWid) {
    return undefined;
  }
  const announcementGroup = await input.db.groupRegistry.findFirst({
    where: {
      runtimeBindingId: input.runtimeBindingId,
      enrollmentStatus: EnrollmentStatus.ENROLLED,
      communityMetadata: {
        is: {
          linkedParentChatId: communityGroupWid,
          isCommunityAnnounce: true
        }
      }
    },
    orderBy: [{ displayName: 'asc' }, { chatId: 'asc' }],
    select: { chatId: true }
  });
  return announcementGroup?.chatId;
}

async function communityGroupWidForScope(input: {
  db: PrismaClient;
  runtimeBindingId: string;
  scopeId: string;
}): Promise<string | undefined> {
  const policyGroup = await input.db.groupRegistry.findFirst({
    where: {
      runtimeBindingId: input.runtimeBindingId,
      communityPolicy: {
        is: {
          enabled: true
        }
      },
      scopes: {
        some: {
          scopeId: input.scopeId,
          directlyAttached: true
        }
      }
    },
    orderBy: [{ displayName: 'asc' }, { chatId: 'asc' }],
    select: { chatId: true }
  });
  if (policyGroup?.chatId) {
    return policyGroup.chatId;
  }
  const scopedCommunityGroup = await input.db.groupRegistry.findFirst({
    where: {
      runtimeBindingId: input.runtimeBindingId,
      scopes: {
        some: { scopeId: input.scopeId }
      },
      communityMetadata: {
        is: {
          isCommunity: true
        }
      }
    },
    orderBy: [{ displayName: 'asc' }, { chatId: 'asc' }],
    select: { chatId: true }
  });
  return scopedCommunityGroup?.chatId;
}
