# Piwigo Gallery

Authorized gallery uploads, event album selection, durable media delivery and upload-derived announcements.

Standalone WABS package `official.piwigo-gallery` version `0.17.3`, requiring WABP core API `^0.3.3`. The plugin ID, account-owned `gallery` database, data version 11, configuration, identity bindings, upload claims and receipt formats are preserved. All eleven SQL migrations are included unchanged. The historical subject migration 011 remains an explicitly coordinated operator migration; packaging must not replay it or silently erase an older store.

WABP supplies current enabled scope memberships, the configured issuer's verified federated identities, authorization, transport, media storage, database connections, durable flows and job persistence. Existing enabled configuration layers keep their inheritance order and shallow merge behavior. No Prisma client or WABP host runtime is bundled. The shared SDK, exact runtime dependencies, Portuguese messages and the unmodified event album contract are included with source commits, checksums and licenses.

The versioned upload-only boundary remains enforced. This plugin does not own user registration, login, passwords or identity linking. Callback deliveries retain their captured targets and deduplication keys across retries.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, rebuilds identical archives and loads them outside the repository. Tests use fixture databases and mocked effects. Installation and scope enablement are separate; signed WABS entries identify immutable release bytes.

The community announcement-group default is declared through generic control metadata. The console resolves that default from the selected scope while retaining explicitly configured values.

## Typed templates and WhatsApp mentions

Message editors support exact choice and text comparisons, numeric thresholds,
boolean values, availability checks, nested All/Any rules and Otherwise branches.
Existing bare conditions retain their original presence meaning. Comparisons use
canonical values separately from translated display text; missing values do not
satisfy negative comparisons, while zero and false remain available.

Type `@` in a supported message body or caption to insert a person, a group link,
or a contextual recipient. Group links and native all-members mentions are distinct;
the editor only offers targets supported by that destination. Mentions in hidden
branches do not resolve or notify anyone. Native poll titles/options, group names
and calendar text remain plain text. Durable delivery stores rendered text and
recipient metadata together so retries keep the original notification intent.
