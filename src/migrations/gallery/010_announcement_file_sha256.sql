ALTER TABLE gallery_album_announcement_files
  ADD COLUMN sha256 TEXT
    CHECK (
      sha256 IS NULL
      OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
    );

UPDATE gallery_album_announcements
   SET status = 'failed',
       error = 'Album announcement media predates immutable SHA-256 capture.',
       claim_id = NULL,
       claim_expires_at = NULL,
       download_next_retry_at = NULL,
       download_last_error = 'Album announcement media predates immutable SHA-256 capture.',
       version = version + 1
 WHERE status = 'pending';
