ALTER TABLE generation_scripts
  MODIFY COLUMN duration_sec DECIMAL(10,3) NOT NULL DEFAULT 15 COMMENT '脚本分段时长，支持 8-30 秒 Seedance 切片',
  DROP CHECK ck_generation_scripts_duration,
  ADD CONSTRAINT ck_generation_scripts_duration CHECK (duration_sec BETWEEN 8 AND 30);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0014_generation_script_variable_duration', 'Allow generation_scripts.duration_sec to store variable 8-30s Seedance slice duration')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
