ALTER TABLE generation_scripts
  DROP CHECK ck_generation_scripts_duration,
  MODIFY COLUMN duration_sec SMALLINT UNSIGNED NOT NULL DEFAULT 15 COMMENT '脚本分段时长，首期固定 15',
  ADD CONSTRAINT ck_generation_scripts_duration CHECK (duration_sec IN (15));

DELETE FROM app_schema_migrations
WHERE version = '0014_generation_script_variable_duration';
