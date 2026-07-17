ALTER TABLE idempotency_keys
  ADD COLUMN owner_token VARCHAR(80) NULL
  COMMENT 'processing claim owner token; rotated on takeover and required for fenced completion'
  AFTER request_hash;

INSERT INTO app_schema_migrations (version, description)
VALUES ('0017_idempotency_owner_token', 'Fence idempotency processing claims with renewable owner tokens')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
