-- Production rollback should be a reviewed forward migration. This file documents the previous constraint.
ALTER TABLE generation_scripts
  DROP CHECK ck_generation_scripts_duration,
  ADD CONSTRAINT ck_generation_scripts_duration CHECK (duration_sec BETWEEN 8 AND 30);

DELETE FROM app_schema_migrations
WHERE version = '0015_generation_script_duration_5_30';
