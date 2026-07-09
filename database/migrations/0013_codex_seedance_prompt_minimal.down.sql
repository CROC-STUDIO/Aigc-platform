DROP TABLE IF EXISTS codex_exec_jobs;
DROP TABLE IF EXISTS codex_prompt_drafts;

DELETE FROM app_schema_migrations
WHERE version = '0013_codex_seedance_prompt_minimal';
