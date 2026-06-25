INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_run', '__new__', 'preview_required', 'batch_created', NULL, 0),
  ('workflow_run', 'preview_required', 'queued', 'plan_confirmed', NULL, 0),
  ('workflow_run', 'preview_required', 'stopped', 'user_stop', 'batch:own', 1),
  ('workflow_task', '__new__', 'pending_preview', 'batch_write', NULL, 0),
  ('workflow_task', 'pending_preview', 'pending', 'plan_confirmed', NULL, 0),
  ('workflow_task', 'pending_preview', 'stopped', 'user_stop', 'batch:own', 1);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0008_pipeline_seedance_plan_preview', 'Add pipeline Seedance plan preview state transitions')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
