DELETE FROM gallery_upload_drafts;

UPDATE gallery_upload_batch_files
   SET cleanup_pending = 1,
       cleanup_completed_at = NULL
 WHERE batch_id IN (
   SELECT id
     FROM gallery_upload_batches
    WHERE status IN ('collecting', 'finalizing')
 );

UPDATE gallery_upload_batches
   SET status = 'failed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       deadline_generation = deadline_generation + 1,
       version = version + 1,
       finalization_claim_id = NULL,
       finalization_claimed_at = NULL,
       finalization_claim_expires_at = NULL,
       error = 'Upload batch invalidated while migrating active ownership to canonical identities; start a new upload.'
 WHERE status IN ('collecting', 'finalizing');

ALTER TABLE gallery_upload_drafts DROP COLUMN actor_aliases_json;
ALTER TABLE gallery_upload_batches DROP COLUMN actor_aliases_json;

DROP TABLE gallery_active_batch_actors;

CREATE TABLE gallery_active_batch_identities (
  scope_id TEXT NOT NULL,
  collection_chat_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, collection_chat_id, actor_identity_id),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE
);

CREATE INDEX gallery_active_batch_identities_batch_idx
  ON gallery_active_batch_identities(batch_id);

CREATE UNIQUE INDEX gallery_active_private_batch_identity_idx
  ON gallery_active_batch_identities(collection_chat_id, actor_identity_id)
  WHERE collection_chat_id NOT LIKE '%@g.us';
