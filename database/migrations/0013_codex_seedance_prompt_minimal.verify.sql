SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('codex_prompt_drafts', 'codex_exec_jobs')
ORDER BY table_name;

SELECT version
FROM app_schema_migrations
WHERE version = '0013_codex_seedance_prompt_minimal';
