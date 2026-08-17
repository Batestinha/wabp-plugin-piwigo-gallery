CREATE TABLE gallery_topomare_subject_cutover_guard (
  active_or_legacy_runtime_rows INTEGER NOT NULL CHECK (active_or_legacy_runtime_rows = 0)
);

-- Schema 011 is deliberately destructive and new-only. The coordinated cutover
-- tooling must first capture/export the exact frozen schema-010 store set. This
-- local transaction then refuses every state that could still be owned by the
-- removed link/OTP runtime or by an in-flight flow, upload, cleanup, callback,
-- announcement, claim, or delivery outbox.
INSERT INTO gallery_topomare_subject_cutover_guard (active_or_legacy_runtime_rows)
SELECT
    (SELECT COUNT(*) FROM gallery_upload_drafts)
  + (SELECT COUNT(*) FROM gallery_upload_batches
       WHERE status IN ('collecting', 'finalizing')
          OR finalization_claim_id IS NOT NULL
          OR finalization_claimed_at IS NOT NULL
          OR finalization_claim_expires_at IS NOT NULL
          OR terminal_notification_status IN ('pending', 'dispatching'))
  + (SELECT COUNT(*) FROM gallery_active_batch_identities)
  + (SELECT COUNT(*) FROM gallery_upload_batch_files
       WHERE status IN ('staged', 'uploading')
          OR cleanup_pending = 1)
  + (SELECT COUNT(*) FROM gallery_link_requests)
  + (SELECT COUNT(*) FROM gallery_registration_otps)
  + (SELECT COUNT(*) FROM gallery_album_announcements
       WHERE status = 'pending'
          OR claim_id IS NOT NULL
          OR claim_expires_at IS NOT NULL)
  + (SELECT COUNT(*) FROM gallery_album_announcement_files
       WHERE delivery_status IN ('pending', 'dispatching'));

DROP TABLE gallery_topomare_subject_cutover_guard;

DROP TABLE gallery_link_request_scopes;
DROP TABLE gallery_link_requests;
DROP TABLE gallery_registration_otps;
DROP TABLE gallery_legacy_imports;

ALTER TABLE gallery_upload_drafts DROP COLUMN piwigo_linked_wid;
ALTER TABLE gallery_upload_batches DROP COLUMN piwigo_linked_wid;

ALTER TABLE gallery_upload_drafts ADD COLUMN topomare_user_id TEXT;
ALTER TABLE gallery_upload_drafts ADD COLUMN piwigo_user_id INTEGER;
ALTER TABLE gallery_upload_batches ADD COLUMN topomare_user_id TEXT;
ALTER TABLE gallery_upload_batches ADD COLUMN piwigo_user_id INTEGER;

CREATE INDEX gallery_upload_drafts_topomare_user_idx
  ON gallery_upload_drafts(topomare_user_id, scope_id);

CREATE INDEX gallery_upload_drafts_piwigo_user_idx
  ON gallery_upload_drafts(piwigo_user_id, scope_id);

CREATE INDEX gallery_upload_batches_topomare_user_idx
  ON gallery_upload_batches(topomare_user_id, scope_id, status);

CREATE INDEX gallery_upload_batches_piwigo_user_idx
  ON gallery_upload_batches(piwigo_user_id, scope_id, status);

CREATE TRIGGER gallery_upload_drafts_require_subject_insert
BEFORE INSERT ON gallery_upload_drafts
WHEN NEW.topomare_user_id IS NULL
  OR length(NEW.topomare_user_id) != 36
  OR substr(NEW.topomare_user_id, 1, 8) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 9, 1) != '-'
  OR substr(NEW.topomare_user_id, 10, 4) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 14, 1) != '-'
  OR substr(NEW.topomare_user_id, 15, 1) NOT GLOB '[1-8]'
  OR substr(NEW.topomare_user_id, 16, 3) NOT GLOB '[0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 19, 1) != '-'
  OR substr(NEW.topomare_user_id, 20, 1) NOT GLOB '[89ab]'
  OR substr(NEW.topomare_user_id, 21, 3) NOT GLOB '[0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 24, 1) != '-'
  OR substr(NEW.topomare_user_id, 25, 12) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR typeof(NEW.piwigo_user_id) != 'integer'
  OR NEW.piwigo_user_id <= 0
  OR NEW.piwigo_user_id > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'gallery upload draft requires one canonical Topomare/Piwigo subject binding');
END;

CREATE TRIGGER gallery_upload_drafts_immutable_subject
BEFORE UPDATE OF topomare_user_id, piwigo_user_id ON gallery_upload_drafts
WHEN OLD.topomare_user_id IS NOT NEW.topomare_user_id
  OR OLD.piwigo_user_id IS NOT NEW.piwigo_user_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload draft subject binding is immutable');
END;

CREATE TRIGGER gallery_upload_batches_require_subject_insert
BEFORE INSERT ON gallery_upload_batches
WHEN NEW.topomare_user_id IS NULL
  OR length(NEW.topomare_user_id) != 36
  OR substr(NEW.topomare_user_id, 1, 8) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 9, 1) != '-'
  OR substr(NEW.topomare_user_id, 10, 4) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 14, 1) != '-'
  OR substr(NEW.topomare_user_id, 15, 1) NOT GLOB '[1-8]'
  OR substr(NEW.topomare_user_id, 16, 3) NOT GLOB '[0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 19, 1) != '-'
  OR substr(NEW.topomare_user_id, 20, 1) NOT GLOB '[89ab]'
  OR substr(NEW.topomare_user_id, 21, 3) NOT GLOB '[0-9a-f][0-9a-f][0-9a-f]'
  OR substr(NEW.topomare_user_id, 24, 1) != '-'
  OR substr(NEW.topomare_user_id, 25, 12) NOT GLOB
       '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  OR typeof(NEW.piwigo_user_id) != 'integer'
  OR NEW.piwigo_user_id <= 0
  OR NEW.piwigo_user_id > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch requires one canonical Topomare/Piwigo subject binding');
END;

CREATE TRIGGER gallery_upload_batches_immutable_subject
BEFORE UPDATE OF topomare_user_id, piwigo_user_id ON gallery_upload_batches
WHEN OLD.topomare_user_id IS NOT NEW.topomare_user_id
  OR OLD.piwigo_user_id IS NOT NEW.piwigo_user_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch subject binding is immutable');
END;

CREATE TRIGGER gallery_upload_batches_no_terminal_revival
BEFORE UPDATE OF status ON gallery_upload_batches
WHEN OLD.status IN ('completed', 'cancelled', 'expired', 'failed')
 AND NEW.status IN ('collecting', 'finalizing')
BEGIN
  SELECT RAISE(ABORT, 'terminal gallery upload batches cannot be revived');
END;

CREATE TRIGGER gallery_active_batch_identities_require_live_subject
BEFORE INSERT ON gallery_active_batch_identities
WHEN NOT EXISTS (
  SELECT 1
    FROM gallery_upload_batches batch
   WHERE batch.id = NEW.batch_id
     AND batch.scope_id = NEW.scope_id
     AND batch.collection_chat_id = NEW.collection_chat_id
     AND batch.actor_identity_id = NEW.actor_identity_id
     AND batch.status IN ('collecting', 'finalizing')
     AND batch.topomare_user_id IS NOT NULL
     AND batch.piwigo_user_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'active gallery upload claims require one live subject-bound batch');
END;

CREATE TRIGGER gallery_upload_batch_files_require_v4_attempt_insert
BEFORE INSERT ON gallery_upload_batch_files
WHEN NEW.upload_attempt_id IS NOT NULL
 AND (
      length(NEW.upload_attempt_id) < 16
   OR length(NEW.upload_attempt_id) > 127
   OR substr(NEW.upload_attempt_id, 1, 3) != 'v4:'
   OR substr(NEW.upload_attempt_id, 4, 1) NOT GLOB '[A-Za-z0-9]'
   OR NEW.upload_attempt_id GLOB '*[^A-Za-z0-9._:-]*'
 )
BEGIN
  SELECT RAISE(ABORT, 'gallery upload file requires a canonical v4 idempotency key');
END;

CREATE TRIGGER gallery_upload_batch_files_require_v4_attempt_update
BEFORE UPDATE OF upload_attempt_id ON gallery_upload_batch_files
WHEN NEW.upload_attempt_id IS NOT NULL
 AND (
      length(NEW.upload_attempt_id) < 16
   OR length(NEW.upload_attempt_id) > 127
   OR substr(NEW.upload_attempt_id, 1, 3) != 'v4:'
   OR substr(NEW.upload_attempt_id, 4, 1) NOT GLOB '[A-Za-z0-9]'
   OR NEW.upload_attempt_id GLOB '*[^A-Za-z0-9._:-]*'
 )
BEGIN
  SELECT RAISE(ABORT, 'gallery upload file requires a canonical v4 idempotency key');
END;

CREATE TRIGGER gallery_upload_batch_files_immutable_attempt
BEFORE UPDATE OF upload_attempt_id ON gallery_upload_batch_files
WHEN OLD.upload_attempt_id IS NOT NULL
 AND OLD.upload_attempt_id IS NOT NEW.upload_attempt_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload file v4 idempotency key is immutable');
END;
