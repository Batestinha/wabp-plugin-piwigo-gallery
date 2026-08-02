CREATE TABLE gallery_upload_drafts (
  flow_session_id TEXT PRIMARY KEY,
  flow_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  group_id TEXT,
  group_wid TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  actor_aliases_json TEXT NOT NULL,
  actor_identity_id TEXT,
  piwigo_linked_wid TEXT,
  actor_label TEXT NOT NULL,
  accepted_extensions_json TEXT NOT NULL,
  max_file_bytes INTEGER NOT NULL CHECK (max_file_bytes > 0),
  auto_finalize_minutes INTEGER NOT NULL CHECK (auto_finalize_minutes > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (group_wid = chat_id),
  CHECK (group_wid LIKE '%@g.us')
);

CREATE INDEX gallery_upload_drafts_scope_actor_idx
  ON gallery_upload_drafts(scope_id, chat_id, actor_wid);

CREATE TRIGGER gallery_upload_drafts_immutable_target
BEFORE UPDATE OF scope_id, group_id, group_wid, chat_id, actor_wid, actor_identity_id
ON gallery_upload_drafts
WHEN OLD.scope_id IS NOT NEW.scope_id
  OR OLD.group_id IS NOT NEW.group_id
  OR OLD.group_wid IS NOT NEW.group_wid
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.actor_wid IS NOT NEW.actor_wid
  OR OLD.actor_identity_id IS NOT NEW.actor_identity_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload draft target is immutable');
END;

CREATE TABLE gallery_upload_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'finalizing', 'completed', 'cancelled', 'expired', 'failed')),
  scope_id TEXT NOT NULL,
  group_id TEXT,
  group_wid TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  actor_aliases_json TEXT NOT NULL,
  actor_identity_id TEXT,
  piwigo_linked_wid TEXT,
  actor_label TEXT NOT NULL,
  onde TEXT NOT NULL,
  quando TEXT NOT NULL,
  with_user_ids_json TEXT NOT NULL,
  accepted_extensions_json TEXT NOT NULL,
  max_file_bytes INTEGER NOT NULL CHECK (max_file_bytes > 0),
  auto_finalize_minutes INTEGER NOT NULL CHECK (auto_finalize_minutes > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  auto_finalize_at TEXT NOT NULL,
  last_accepted_at TEXT,
  deadline_generation INTEGER NOT NULL DEFAULT 1 CHECK (deadline_generation > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  finalization_claim_id TEXT,
  finalization_claimed_at TEXT,
  finalization_claim_expires_at TEXT,
  album_label TEXT,
  error TEXT,
  CHECK (group_wid = chat_id),
  CHECK (group_wid LIKE '%@g.us'),
  CHECK (
    (finalization_claim_id IS NULL AND finalization_claimed_at IS NULL AND finalization_claim_expires_at IS NULL)
    OR
    (finalization_claim_id IS NOT NULL AND finalization_claimed_at IS NOT NULL AND finalization_claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX gallery_upload_batches_scope_status_idx
  ON gallery_upload_batches(scope_id, status, auto_finalize_at);
CREATE INDEX gallery_upload_batches_target_actor_idx
  ON gallery_upload_batches(scope_id, chat_id, actor_wid, status);

CREATE TRIGGER gallery_upload_batches_immutable_target
BEFORE UPDATE OF scope_id, group_id, group_wid, chat_id, actor_wid, actor_identity_id
ON gallery_upload_batches
WHEN OLD.scope_id IS NOT NEW.scope_id
  OR OLD.group_id IS NOT NEW.group_id
  OR OLD.group_wid IS NOT NEW.group_wid
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.actor_wid IS NOT NEW.actor_wid
  OR OLD.actor_identity_id IS NOT NEW.actor_identity_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch target is immutable');
END;

CREATE TABLE gallery_upload_batch_files (
  batch_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('staged', 'uploaded')),
  image_id INTEGER,
  url TEXT,
  accepted_at TEXT NOT NULL,
  uploaded_at TEXT,
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (batch_id, media_id),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE
);

CREATE INDEX gallery_upload_batch_files_batch_status_idx
  ON gallery_upload_batch_files(batch_id, status);

CREATE TABLE gallery_active_batch_actors (
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, chat_id, actor_wid),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE
);

CREATE INDEX gallery_active_batch_actors_batch_idx
  ON gallery_active_batch_actors(batch_id);

CREATE TABLE gallery_link_requests (
  token_key TEXT PRIMARY KEY,
  request_token TEXT NOT NULL,
  request_id TEXT NOT NULL,
  phone TEXT,
  phone_digits TEXT,
  whatsapp_jid TEXT NOT NULL,
  site_label TEXT NOT NULL,
  link_choice_count INTEGER NOT NULL CHECK (link_choice_count >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX gallery_link_requests_expiry_idx
  ON gallery_link_requests(expires_at);

CREATE TABLE gallery_link_request_aliases (
  wid TEXT PRIMARY KEY,
  token_key TEXT NOT NULL,
  FOREIGN KEY (token_key) REFERENCES gallery_link_requests(token_key) ON DELETE CASCADE
);

CREATE INDEX gallery_link_request_aliases_token_idx
  ON gallery_link_request_aliases(token_key);

CREATE TABLE gallery_link_request_scopes (
  token_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  scope_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (token_key, position),
  FOREIGN KEY (token_key) REFERENCES gallery_link_requests(token_key) ON DELETE CASCADE
);

CREATE INDEX gallery_link_request_scopes_scope_idx
  ON gallery_link_request_scopes(scope_id, token_key);

CREATE TABLE gallery_album_announcements (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  album_id TEXT,
  album_name TEXT NOT NULL,
  site_label TEXT NOT NULL,
  user_display_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  announce_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'announced', 'skipped', 'failed')),
  error TEXT,
  announced_at TEXT,
  claim_id TEXT,
  claim_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (scope_id, dedupe_key),
  CHECK (
    (claim_id IS NULL AND claim_expires_at IS NULL)
    OR
    (claim_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX gallery_album_announcements_due_idx
  ON gallery_album_announcements(status, announce_at);

CREATE TABLE gallery_album_announcement_files (
  announcement_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  image_id INTEGER,
  file_id TEXT,
  download_token TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  PRIMARY KEY (announcement_id, position),
  FOREIGN KEY (announcement_id) REFERENCES gallery_album_announcements(id) ON DELETE CASCADE,
  CHECK (image_id IS NOT NULL OR file_id IS NOT NULL OR download_token IS NOT NULL)
);

CREATE TABLE gallery_registration_otps (
  request_id TEXT PRIMARY KEY,
  wid TEXT NOT NULL,
  display_name TEXT,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX gallery_registration_otps_expiry_idx
  ON gallery_registration_otps(expires_at);

CREATE TABLE gallery_legacy_imports (
  record_id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL,
  scope_id TEXT,
  imported_at TEXT NOT NULL
);
