ALTER TABLE gallery_album_announcements
  ADD COLUMN announcement_group_wid TEXT;

ALTER TABLE gallery_album_announcements
  ADD COLUMN download_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (download_retry_count >= 0);

ALTER TABLE gallery_album_announcements
  ADD COLUMN download_next_retry_at TEXT;

ALTER TABLE gallery_album_announcements
  ADD COLUMN download_last_error TEXT;

CREATE INDEX gallery_album_announcements_retry_idx
  ON gallery_album_announcements(status, download_next_retry_at, announce_at);
