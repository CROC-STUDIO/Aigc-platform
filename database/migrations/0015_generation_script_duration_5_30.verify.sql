SELECT
  constraint_name,
  check_clause
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE()
  AND constraint_name = 'ck_generation_scripts_duration'
  AND check_clause LIKE '%between 5 and 30%';

SELECT version
FROM app_schema_migrations
WHERE version = '0015_generation_script_duration_5_30';
