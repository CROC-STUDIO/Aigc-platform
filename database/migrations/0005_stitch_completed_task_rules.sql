INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_task', 'waiting_upstream', 'qc', 'stitch_completed', NULL, 0),
  ('workflow_task', 'downloaded', 'qc', 'stitch_completed', NULL, 0);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0005_stitch_completed_task_rules', 'Allow generation tasks to enter QC after stitch completion')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
