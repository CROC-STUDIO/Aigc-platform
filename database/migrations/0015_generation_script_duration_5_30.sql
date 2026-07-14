-- Forward-only compatibility migration for Seedance slices supported by the current provider contract.
ALTER TABLE generation_scripts
  DROP CHECK ck_generation_scripts_duration,
  ADD CONSTRAINT ck_generation_scripts_duration CHECK (duration_sec BETWEEN 5 AND 30);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0015_generation_script_duration_5_30', 'Allow generation_scripts.duration_sec to store 5-30s Seedance slice duration')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
