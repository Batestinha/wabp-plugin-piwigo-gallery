ALTER TABLE gallery_upload_batch_files
  ADD COLUMN upload_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (upload_retry_count >= 0);

ALTER TABLE gallery_upload_batch_files
  ADD COLUMN upload_next_retry_at TEXT;

ALTER TABLE gallery_upload_batch_files
  ADD COLUMN upload_last_error TEXT;

CREATE INDEX gallery_upload_batch_files_retry_idx
  ON gallery_upload_batch_files(status, upload_next_retry_at, batch_id);
