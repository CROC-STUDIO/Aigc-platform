SELECT
  constraint_name,
  check_clause
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE()
  AND constraint_name = 'ck_generation_scripts_duration'
  AND check_clause LIKE '%between 8 and 30%';

SELECT
  column_name,
  column_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'generation_scripts'
  AND column_name = 'duration_sec'
  AND column_type = 'decimal(10,3)';

SELECT version
FROM app_schema_migrations
WHERE version = '0014_generation_script_variable_duration';
