ALTER TABLE gallery_upload_batches
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual', 'community-event'));

ALTER TABLE gallery_upload_batches
  ADD COLUMN source_ref TEXT;

ALTER TABLE gallery_upload_batches
  ADD COLUMN source_snapshot_json TEXT;

CREATE INDEX gallery_upload_batches_source_idx
  ON gallery_upload_batches(scope_id, source_kind, source_ref);

CREATE TRIGGER gallery_upload_batches_valid_source_insert
BEFORE INSERT ON gallery_upload_batches
WHEN NOT (
  (NEW.source_kind = 'manual' AND NEW.source_ref IS NULL AND NEW.source_snapshot_json IS NULL)
  OR
  (NEW.source_kind = 'community-event' AND LENGTH(TRIM(NEW.source_ref)) > 0 AND LENGTH(TRIM(NEW.source_snapshot_json)) > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch album source is invalid');
END;

CREATE TRIGGER gallery_upload_batches_immutable_source
BEFORE UPDATE OF source_kind, source_ref, source_snapshot_json
ON gallery_upload_batches
WHEN OLD.source_kind IS NOT NEW.source_kind
  OR OLD.source_ref IS NOT NEW.source_ref
  OR OLD.source_snapshot_json IS NOT NEW.source_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'gallery upload batch album source is immutable');
END;
