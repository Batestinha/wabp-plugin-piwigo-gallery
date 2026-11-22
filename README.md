# Piwigo

Piwigo owns `/gallery`, Gallery uploads, the media-album trigger and upload announcements. Enable Integration Manager and Piwigo in each participating scope. Configure maximum files and bytes, album hints and announcements in Piwigo settings. The Gallery server also enforces its own limits.

Pending announcements use the upload's originating scope even when the destination is another chat. Existing uploads retain their staging references, job IDs and delivery receipts across restarts.

Version 1.0.0 reuses `official.piwigo-gallery` and its account-owned SQLite database. For active standalone installations, drain drafts, upload batches and callbacks and match the configured Workspace endpoint before running the coordinated WABP upgrade. Keep the Gallery database, its migrations and receipts with the account.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive` to verify and package a release.
