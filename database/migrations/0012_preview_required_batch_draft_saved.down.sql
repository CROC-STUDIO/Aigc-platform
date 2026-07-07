DELETE FROM state_transition_rules
WHERE entity_type = 'workflow_run'
  AND from_status = 'preview_required'
  AND to_status = 'preview_required'
  AND trigger_name = 'batch_draft_saved';

DELETE FROM app_schema_migrations
WHERE version = '0012_preview_required_batch_draft_saved';
