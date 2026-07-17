ALTER TABLE idempotency_keys
  DROP COLUMN owner_token;

DELETE FROM app_schema_migrations
WHERE version = '0017_idempotency_owner_token';
