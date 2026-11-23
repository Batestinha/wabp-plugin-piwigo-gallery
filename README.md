# Piwigo

Lets members upload photos and videos to Piwigo albums with /gallery. Each scope can set upload limits, provide album hints and choose whether to announce uploads. Members can also start an upload by sharing a media album. Enable Integration Manager and Piwigo in each participating scope. Configure maximum files and bytes, album hints and announcements in Piwigo settings. The Gallery server also enforces its own limits.

Pending announcements use the upload's originating scope even when the destination is another chat. Existing uploads retain their staging references, job IDs and delivery receipts across restarts.

The managed plugin reuses `official.piwigo-gallery` and its account-owned SQLite database. For active standalone installations, drain drafts, upload batches and callbacks and match the configured Workspace endpoint before running the coordinated WABP upgrade. Keep the Gallery database, its migrations and receipts with the account. Managed releases from 1.0.1 retain the database for inspection and recovery. Only the standalone cutover operator applies the historical SQL in `migrations/gallery`.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive` to verify and package a release.
