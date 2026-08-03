ALTER TABLE gallery_upload_drafts
  ADD COLUMN collection_chat_id TEXT NOT NULL DEFAULT '';

UPDATE gallery_upload_drafts
   SET collection_chat_id = chat_id
 WHERE collection_chat_id = '';

CREATE INDEX gallery_upload_drafts_collection_actor_idx
  ON gallery_upload_drafts(scope_id, collection_chat_id, actor_wid);

CREATE TRIGGER gallery_upload_drafts_immutable_collection
BEFORE UPDATE OF collection_chat_id
ON gallery_upload_drafts
WHEN OLD.collection_chat_id IS NOT NEW.collection_chat_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload draft collection inbox is immutable');
END;

ALTER TABLE gallery_upload_batches
  ADD COLUMN collection_chat_id TEXT NOT NULL DEFAULT '';

UPDATE gallery_upload_batches
   SET collection_chat_id = chat_id
 WHERE collection_chat_id = '';

CREATE INDEX gallery_upload_batches_collection_actor_idx
  ON gallery_upload_batches(scope_id, collection_chat_id, actor_wid, status);

CREATE TRIGGER gallery_upload_batches_immutable_collection
BEFORE UPDATE OF collection_chat_id
ON gallery_upload_batches
WHEN OLD.collection_chat_id IS NOT NEW.collection_chat_id
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch collection inbox is immutable');
END;

ALTER TABLE gallery_active_batch_actors RENAME TO gallery_active_batch_actors_v4;

CREATE TABLE gallery_active_batch_actors (
  scope_id TEXT NOT NULL,
  collection_chat_id TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, collection_chat_id, actor_wid),
  FOREIGN KEY (batch_id) REFERENCES gallery_upload_batches(id) ON DELETE CASCADE
);

INSERT INTO gallery_active_batch_actors (
  scope_id, collection_chat_id, actor_wid, batch_id, created_at
)
SELECT scope_id, chat_id, actor_wid, batch_id, created_at
  FROM gallery_active_batch_actors_v4;

DROP TABLE gallery_active_batch_actors_v4;

CREATE INDEX gallery_active_batch_actors_batch_idx
  ON gallery_active_batch_actors(batch_id);

CREATE UNIQUE INDEX gallery_active_private_batch_actor_idx
  ON gallery_active_batch_actors(collection_chat_id, actor_wid)
  WHERE collection_chat_id NOT LIKE '%@g.us';
