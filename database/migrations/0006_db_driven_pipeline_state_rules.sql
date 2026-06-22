INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_run', 'queued', 'failed', 'batch_write', NULL, 1),
  ('workflow_run', 'partial_failed', 'qc', 'stitch_completed', NULL, 0),
  ('workflow_task', 'waiting_upstream', 'downloaded', 'batch_write', NULL, 0);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0006_db_driven_pipeline_state_rules', 'Add DB-driven batch/task transition rules for pipeline sync')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
