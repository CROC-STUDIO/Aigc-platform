DELETE FROM state_transition_rules
WHERE (entity_type = 'workflow_run' AND from_status = 'queued' AND to_status = 'failed' AND trigger_name = 'batch_write')
   OR (entity_type = 'workflow_run' AND from_status = 'partial_failed' AND to_status = 'qc' AND trigger_name = 'stitch_completed')
   OR (entity_type = 'workflow_task' AND from_status = 'waiting_upstream' AND to_status = 'downloaded' AND trigger_name = 'batch_write');

DELETE FROM app_schema_migrations
WHERE version = '0006_db_driven_pipeline_state_rules';
