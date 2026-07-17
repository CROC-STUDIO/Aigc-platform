CREATE TABLE IF NOT EXISTS scheduler_jobs_candidate LIKE scheduler_jobs;

INSERT INTO app_schema_migrations (version, description)
VALUES ('0019_candidate_scheduler_jobs', 'Add an isolated scheduler queue for the candidate runtime')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
