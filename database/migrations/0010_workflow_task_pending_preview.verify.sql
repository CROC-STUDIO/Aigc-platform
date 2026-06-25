SELECT 1
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE()
  AND table_name = 'workflow_tasks'
  AND constraint_name = 'ck_workflow_tasks_status'
  AND check_clause LIKE '%pending_preview%'
LIMIT 1;
