import { defineControl } from '../../../../packages/plugin-sdk/src/controls';
import type { ControlDescriptor, ControlSchemaMetadata, ControlUiHint } from '../../../../packages/plugin-sdk/src/controls-types';
import { PIWIGO_GALLERY_PLUGIN_ID } from './manifest';
import { piwigoGalleryMessages } from './messages';

function control(input: {
  path: string;
  label: string;
  description: string;
  order: number;
  schema: ControlSchemaMetadata;
  ui: ControlUiHint;
  dangerous?: boolean | undefined;
  sensitive?: boolean | undefined;
  confirmationMessage?: string | undefined;
}): ControlDescriptor {
  return defineControl({
    id: `plugin.${PIWIGO_GALLERY_PLUGIN_ID}.${input.path}`,
    label: input.label,
    description: input.description,
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Piwigo Gallery',
    order: input.order,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: PIWIGO_GALLERY_PLUGIN_ID, path: input.path },
    schema: input.schema,
    ui: { helpText: input.description, ...input.ui },
    restartRequirement: 'NO_RESTART',
    dangerous: input.dangerous ?? false,
    confirmation: input.dangerous
      ? { required: true, message: input.confirmationMessage ?? 'This changes the Piwigo gallery integration.' }
      : undefined,
    sensitivity: input.sensitive ? { sensitive: true, redact: 'configured-state' } : { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/gallery status', '/gallery configure', '/gallery upload'],
    relatedActionIds: []
  });
}

export const piwigoGalleryControls: ControlDescriptor[] = [
  control({
    path: 'enabled',
    label: 'Enabled',
    description: 'Enable Piwigo gallery uploads in this scope.',
    order: 10,
    schema: { type: 'boolean' },
    ui: { widget: 'toggle' }
  }),
  control({
    path: 'access.allowScopeMemberUploads',
    label: 'Gallery upload access',
    description: 'Manage who may upload to the Piwigo gallery in this scope.',
    order: 30,
    schema: { type: 'boolean' },
    ui: {
      widget: 'builder',
      builderId: 'official.piwigo-gallery.access.v1'
    }
  }),
  control({
    path: 'autoFinalizeMinutes',
    label: 'Auto-finalize minutes',
    description: 'Minutes after the last accepted document before a gallery upload is finalized automatically.',
    order: 40,
    schema: { type: 'number', min: 1, max: 1440 },
    ui: { widget: 'number' }
  }),
  control({
    path: 'maxFileBytes',
    label: 'Max file size',
    description: 'Optional WhatsApp document size cap for gallery uploads. Set 0 for no plugin-specific limit.',
    order: 50,
    schema: { type: 'number', unit: 'bytes', min: 0, max: 25 * 1024 * 1024 * 1024 },
    ui: { widget: 'number', helpText: 'Set 0 to rely on WhatsApp, available storage, and the gallery server without an additional plugin cap.' }
  }),
  control({
    path: 'mediaDumpDocumentsHint',
    label: 'Media dump hint',
    description: 'Optional quote-reply text sent when WhatsApp photos/videos arrive as a media dump.',
    order: 60,
    schema: { type: 'string', max: 500 },
    ui: {
      widget: 'text',
      placeholder: piwigoGalleryMessages['official.piwigo-gallery.mediaDumpDocumentsHint'],
      helpText: `Custom WhatsApp reply for media-dump albums. Leave empty to use the default localized message: ${piwigoGalleryMessages['official.piwigo-gallery.mediaDumpDocumentsHint']}`,
      multiline: true,
      templateDialect: 'conditional-presence-v1',
      templateActivation: 'when-used',
      templateVariables: [
        { token: 'actorDisplayName', label: 'Sender display name', sampleValue: 'Diogo' }
      ],
      templateConditionVariables: [
        { token: 'actorDisplayName', label: 'Sender display name', sampleValue: 'Diogo' },
        { token: 'isGroup', label: 'Group chat', sampleValue: 'true' },
        { token: 'isPrivate', label: 'Private chat', sampleValue: 'true' }
      ],
      templateEmptyResult: 'suppress'
    }
  }),
  control({
    path: 'newAlbumAnnouncementsEnabled',
    label: 'New album announcements',
    description: 'Announce newly populated Piwigo albums to a WhatsApp group.',
    order: 70,
    schema: { type: 'boolean' },
    ui: { widget: 'toggle' }
  }),
  control({
    path: 'announcementGroupWid',
    label: 'Announcement group',
    description: 'WhatsApp group JID inside this scope where new album announcements are sent.',
    order: 80,
    schema: { type: 'string' },
    ui: {
      widget: 'entity-picker',
      label: 'Group',
      placeholder: 'Select announcement group',
      helpText: 'WhatsApp group inside this scope that receives new-album announcements. Community scopes default to their WhatsApp announcement group when one is known.'
    }
  }),
  control({
    path: 'newAlbumAnnouncementDelayMinutes',
    label: 'Announcement delay minutes',
    description: 'Minutes after Piwigo reports a new album upload before the WhatsApp album announcement is sent.',
    order: 100,
    schema: { type: 'number', unit: 'minutes', min: 1, max: 1440 },
    ui: { widget: 'number' }
  }),
  control({
    path: 'newAlbumAnnouncementTemplate',
    label: 'Announcement text',
    description: 'Optional WhatsApp caption template for a new album announcement.',
    order: 90,
    schema: { type: 'string', max: 500 },
    ui: {
      widget: 'text',
      label: 'Announcement template',
      placeholder: piwigoGalleryMessages['official.piwigo-gallery.albumAnnouncementCaption'],
      helpText: 'Use {album}, {site}, and {user}. Leave empty to use the localized message for the scope.',
      multiline: true,
      templateDialect: 'conditional-presence-v1',
      templateActivation: 'when-condition-used',
      templateVariables: [
        { token: 'album', label: 'Album name', sampleValue: 'Summer Walk' },
        { token: 'site', label: 'Gallery site', sampleValue: 'Community Gallery' },
        { token: 'user', label: 'Uploader', sampleValue: 'Diogo' }
      ],
      templateConditionVariables: [
        { token: 'album', label: 'Album name', sampleValue: 'Summer Walk' },
        { token: 'site', label: 'Gallery site', sampleValue: 'Community Gallery' },
        { token: 'user', label: 'Uploader', sampleValue: 'Diogo' }
      ],
      templateEmptyResult: 'suppress'
    }
  })
];
