DROP TABLE IF EXISTS scheduler_jobs_candidate;

DELETE FROM app_schema_migrations
WHERE version = '0019_candidate_scheduler_jobs';
