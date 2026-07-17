DELETE FROM state_transition_rules
WHERE (entity_type = 'workflow_run' AND from_status = 'queued' AND to_status = 'qc' AND trigger_name = 'generation_completed')
   OR (entity_type = 'workflow_run' AND from_status = 'queued' AND to_status = 'partial_failed' AND trigger_name = 'generation_partial_failed')
   OR (entity_type = 'workflow_run' AND from_status = 'running' AND to_status = 'partial_failed' AND trigger_name = 'generation_partial_failed');

DELETE FROM app_schema_migrations
WHERE version = '0018_generation_finalize_state_rules';
