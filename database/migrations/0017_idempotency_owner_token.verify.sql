SELECT column_name, column_type, is_nullable, column_comment
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'idempotency_keys'
  AND column_name = 'owner_token';

SELECT version, description, applied_at
FROM app_schema_migrations
WHERE version = '0017_idempotency_owner_token';
