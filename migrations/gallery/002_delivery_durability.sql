DROP INDEX gallery_upload_batch_files_batch_status_idx;

ALTER TABLE gallery_upload_batch_files RENAME TO gallery_upload_batch_files_v1;

CREATE TABLE gallery_upload_batch_files (
  batch_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('staged', 'uploading', 'uploaded')),
  image_id INTEGER,
  url TEXT,
  accepted_at TEXT NOT NULL,
  upload_attempt_id TEXT,
  upload_started_at TEXT,
  uploaded_at TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  cleanup_completed_at TEXT,
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (batch_id, media_id),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE,
  CHECK (
    (status = 'staged' AND upload_attempt_id IS NULL AND upload_started_at IS NULL AND image_id IS NULL AND uploaded_at IS NULL)
    OR
    (status = 'uploading' AND upload_attempt_id IS NOT NULL AND upload_started_at IS NOT NULL AND image_id IS NULL AND uploaded_at IS NULL)
    OR
    (status = 'uploaded' AND upload_attempt_id IS NOT NULL AND upload_started_at IS NOT NULL AND uploaded_at IS NOT NULL)
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
  cleanup_pending, cleanup_completed_at
)
SELECT
  batch_id, media_id, message_id, filename, mime_type, size_bytes, status,
  image_id, url, accepted_at,
  CASE WHEN status = 'uploaded' THEN 'legacy:' || batch_id || ':' || message_id ELSE NULL END,
  CASE WHEN status = 'uploaded' THEN COALESCE(uploaded_at, accepted_at) ELSE NULL END,
  CASE WHEN status = 'uploaded' THEN COALESCE(uploaded_at, accepted_at) ELSE NULL END,
  0, NULL
FROM gallery_upload_batch_files_v1;

DROP TABLE gallery_upload_batch_files_v1;

CREATE INDEX gallery_upload_batch_files_batch_status_idx
  ON gallery_upload_batch_files(batch_id, status);

CREATE INDEX gallery_upload_batch_files_cleanup_idx
  ON gallery_upload_batch_files(cleanup_pending, batch_id);

ALTER TABLE gallery_album_announcement_files
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'dispatching', 'delivered'));

ALTER TABLE gallery_album_announcement_files
  ADD COLUMN delivery_claim_id TEXT;

ALTER TABLE gallery_album_announcement_files
  ADD COLUMN delivery_started_at TEXT;

ALTER TABLE gallery_album_announcement_files
  ADD COLUMN delivered_at TEXT;

CREATE INDEX gallery_album_announcement_files_delivery_idx
  ON gallery_album_announcement_files(announcement_id, delivery_status, position);

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_text TEXT;

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_status TEXT
    CHECK (terminal_notification_status IN ('pending', 'dispatching', 'delivered'));

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_delivery_key TEXT;

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_attempt_id TEXT;

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_started_at TEXT;

ALTER TABLE gallery_upload_batches
  ADD COLUMN terminal_notification_delivered_at TEXT;

CREATE INDEX gallery_upload_batches_terminal_notification_idx
  ON gallery_upload_batches(terminal_notification_status, updated_at);
