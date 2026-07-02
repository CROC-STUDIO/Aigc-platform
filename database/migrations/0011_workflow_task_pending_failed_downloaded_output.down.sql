DELETE FROM state_transition_rules
WHERE entity_type = 'workflow_task'
  AND from_status = 'pending'
  AND to_status = 'failed'
  AND trigger_name = 'downloaded_output';

DELETE FROM app_schema_migrations
WHERE version = '0011_workflow_task_pending_failed_downloaded_output';
