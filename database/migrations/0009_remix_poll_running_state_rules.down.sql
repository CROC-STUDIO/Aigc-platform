DELETE FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
  ('workflow_run', 'queued', 'running', 'remix_write'),
  ('workflow_task', 'queued', 'running', 'remix_write')
);

DELETE FROM app_schema_migrations
WHERE version = '0009_remix_poll_running_state_rules';
