-- Allow remix provider polling to persist queued -> running transitions.

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_run', 'queued', 'running', 'remix_write', NULL, 0),
  ('workflow_task', 'queued', 'running', 'remix_write', NULL, 0);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0009_remix_poll_running_state_rules', 'Allow remix poll writeback for queued to running provider status')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
