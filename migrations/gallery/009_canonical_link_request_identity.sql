DELETE FROM gallery_link_requests;

DROP TABLE gallery_link_request_scopes;
DROP TABLE gallery_link_request_aliases;
DROP TABLE gallery_link_requests;

CREATE TABLE gallery_link_requests (
  token_key TEXT PRIMARY KEY,
  request_token TEXT NOT NULL,
  request_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  whatsapp_jid TEXT NOT NULL,
  site_label TEXT NOT NULL,
  link_choice_count INTEGER NOT NULL CHECK (link_choice_count >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX gallery_link_requests_expiry_idx
  ON gallery_link_requests(expires_at);

CREATE UNIQUE INDEX gallery_link_requests_identity_idx
  ON gallery_link_requests(identity_id);

CREATE UNIQUE INDEX gallery_link_requests_whatsapp_jid_idx
  ON gallery_link_requests(whatsapp_jid);

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

DELETE FROM gallery_registration_otps;
DROP TABLE gallery_registration_otps;

CREATE TABLE gallery_registration_otps (
  request_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  whatsapp_jid TEXT NOT NULL,
  display_name TEXT,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX gallery_registration_otps_expiry_idx
  ON gallery_registration_otps(expires_at);
