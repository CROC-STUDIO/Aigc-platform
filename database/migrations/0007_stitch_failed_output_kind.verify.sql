SELECT constraint_name
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE()
  AND constraint_name = 'ck_workflow_outputs_kind'
  AND check_clause LIKE '%stitch_failed%';
