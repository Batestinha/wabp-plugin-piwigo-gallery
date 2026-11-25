import { withMessageSlot } from './messageSlot';
import type { CommandPlugin } from '@wabs/plugin-sdk/command-plugin';
import { requireScopeId, type CommandResult } from '@wabs/plugin-sdk/commands';
import { manifest } from './manifest';

const piwigo: CommandPlugin = {
  manifest,
  registerCommands(context) {
    context.router.register('gallery', '*', {
      pluginId: manifest.pluginId, plane: 'group_operation', interaction: 'either_same_chat',
      requiresManagedGroup: true, requiresCurrentManagedGroupMembership: true,
      currentManagedGroupMembershipMode: 'effective_scope',
      privateManagedTarget: { mode: 'infer_group_or_community', collapseCommunities: true },
      mutation: 'durable', auditAction: 'piwigo.gallery.invoke',
      help: { familyKey: 'official.piwigo-gallery.title', featureId: 'piwigo-gallery', topicId: 'piwigo-gallery',
        descriptionKey: 'official.piwigo-gallery.description', usage: '/gallery' }
    }, async ctx => {
      if (ctx.actor && context.services) {
        try {
          return await context.services.call<CommandResult>({
            serviceId: 'official.integration-manager.capability.v1', method: 'invoke', scopeId: requireScopeId(ctx),
            actorIdentityId: ctx.actor.identityAddress.identityId, groupWid: ctx.groupWid, signal: ctx.signal,
            input: { capabilityId: 'gallery.media.upload.v1', command: 'gallery', messageId: ctx.message.id,
              chatId: ctx.message.chatId, surface: ctx.message.context, args: ctx.remainingArgs ?? ctx.command.args }
          });
        } catch { /* Return a localized reply when the dependency or scope is unavailable. */ }
      }
      return { handled: true, text: ctx.t('official.piwigo-gallery.unavailable'), ...withMessageSlot('official.piwigo-gallery.unavailable') };
    });
  }
};
export default piwigo;
