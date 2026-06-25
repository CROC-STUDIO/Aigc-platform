DELETE FROM state_transition_rules
WHERE trigger_name = 'remix_write'
  AND (
    (entity_type = 'workflow_task' AND from_status IN ('queued', 'running') AND to_status = 'qc')
    OR (entity_type = 'workflow_run' AND from_status IN ('queued', 'running', 'qc', 'preview_required') AND to_status = 'stopped')
    OR (entity_type = 'workflow_task' AND from_status IN ('queued', 'running', 'qc') AND to_status = 'stopped')
  );

DELETE FROM app_schema_migrations
WHERE version = '0004_remix_task_qc_state_rules';
