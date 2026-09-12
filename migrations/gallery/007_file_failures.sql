DROP INDEX gallery_upload_batch_files_batch_status_idx;
DROP INDEX gallery_upload_batch_files_cleanup_idx;
DROP INDEX gallery_upload_batch_files_retry_idx;

ALTER TABLE gallery_upload_batch_files RENAME TO gallery_upload_batch_files_v2;

CREATE TABLE gallery_upload_batch_files (
  batch_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('staged', 'uploading', 'uploaded', 'failed')),
  image_id INTEGER,
  url TEXT,
  accepted_at TEXT NOT NULL,
  upload_attempt_id TEXT,
  upload_started_at TEXT,
  uploaded_at TEXT,
  upload_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (upload_retry_count >= 0),
  upload_next_retry_at TEXT,
  upload_last_error TEXT,
  failure_code TEXT,
  failed_at TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  cleanup_completed_at TEXT,
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (batch_id, media_id),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE,
  CHECK (
    (status = 'staged' AND upload_attempt_id IS NULL AND upload_started_at IS NULL
      AND image_id IS NULL AND uploaded_at IS NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (status = 'uploading' AND upload_attempt_id IS NOT NULL AND upload_started_at IS NOT NULL
      AND image_id IS NULL AND uploaded_at IS NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (status = 'uploaded' AND upload_attempt_id IS NOT NULL AND upload_started_at IS NOT NULL
      AND uploaded_at IS NOT NULL AND failure_code IS NULL AND failed_at IS NULL)
    OR
    (status = 'failed' AND image_id IS NULL AND uploaded_at IS NULL
      AND upload_last_error IS NOT NULL AND failure_code IS NOT NULL AND failed_at IS NOT NULL)
  ),
  CHECK (
    (cleanup_pending = 0)
    OR
    (cleanup_pending = 1 AND cleanup_completed_at IS NULL)
  )
);

INSERT INTO gallery_upload_batch_files (
  batch_id, media_id, message_id, filename, mime_type, size_bytes, status,
  image_id, url, accepted_at, upload_attempt_id, upload_started_at, uploaded_at,
  upload_retry_count, upload_next_retry_at, upload_last_error, failure_code, failed_at,
  cleanup_pending, cleanup_completed_at
)
SELECT
  batch_id, media_id, message_id, filename, mime_type, size_bytes, status,
  image_id, url, accepted_at, upload_attempt_id, upload_started_at, uploaded_at,
  upload_retry_count, upload_next_retry_at, upload_last_error, NULL, NULL,
  cleanup_pending, cleanup_completed_at
FROM gallery_upload_batch_files_v2;

DROP TABLE gallery_upload_batch_files_v2;

CREATE INDEX gallery_upload_batch_files_batch_status_idx
  ON gallery_upload_batch_files(batch_id, status);

CREATE INDEX gallery_upload_batch_files_cleanup_idx
  ON gallery_upload_batch_files(cleanup_pending, batch_id);

CREATE INDEX gallery_upload_batch_files_retry_idx
  ON gallery_upload_batch_files(status, upload_next_retry_at, batch_id);
