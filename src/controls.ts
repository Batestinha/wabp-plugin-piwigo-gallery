import { defineControl } from '../../../platform/operatorConsole/controlCatalog/define';
import type { ControlDescriptor, ControlSchemaMetadata, ControlUiHint } from '../../../platform/operatorConsole/controlCatalog/types';
import { PIWIGO_GALLERY_PLUGIN_ID } from './manifest';

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
    ui: input.ui,
    restartRequirement: 'NO_RESTART',
    dangerous: input.dangerous ?? false,
    confirmation: input.dangerous
      ? { required: true, message: input.confirmationMessage ?? 'This changes the Piwigo gallery integration.' }
      : undefined,
    sensitivity: input.sensitive ? { sensitive: true, redact: 'configured-state' } : { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/gallery status', '/gallery configure', '/send gallery', '/upload'],
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
    description: 'Maximum accepted WhatsApp document size for gallery uploads.',
    order: 50,
    schema: { type: 'number', unit: 'bytes', min: 1, max: 25 * 1024 * 1024 * 1024 },
    ui: { widget: 'number' }
  }),
  control({
    path: 'mediaDumpDocumentsHint',
    label: 'Media dump hint',
    description: 'Quote-reply text sent when WhatsApp photos/videos arrive as a media dump. Leave blank to use the localized language-pack message.',
    order: 60,
    schema: { type: 'string', max: 500 },
    ui: { widget: 'text' }
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
    ui: { widget: 'entity-picker', label: 'Group' }
  }),
  control({
    path: 'newAlbumAnnouncementDelayMinutes',
    label: 'Announcement delay',
    description: 'Minutes after Piwigo reports a new album upload before the WhatsApp album announcement is sent.',
    order: 90,
    schema: { type: 'number', min: 1, max: 1440 },
    ui: { widget: 'number' }
  })
];
