SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name = 'scheduler_jobs_candidate';

SELECT COUNT(*) AS matching_column_count
FROM information_schema.columns candidate
INNER JOIN information_schema.columns formal
  ON formal.table_schema = candidate.table_schema
  AND formal.table_name = 'scheduler_jobs'
  AND formal.column_name = candidate.column_name
  AND formal.column_type = candidate.column_type
WHERE candidate.table_schema = DATABASE()
  AND candidate.table_name = 'scheduler_jobs_candidate';
