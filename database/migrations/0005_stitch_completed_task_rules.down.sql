DELETE FROM state_transition_rules
WHERE entity_type = 'workflow_task'
  AND trigger_name = 'stitch_completed'
  AND from_status IN ('waiting_upstream', 'downloaded')
  AND to_status = 'qc';

DELETE FROM app_schema_migrations
WHERE version = '0005_stitch_completed_task_rules';
