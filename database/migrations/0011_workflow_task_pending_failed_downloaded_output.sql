INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_task', 'pending', 'failed', 'downloaded_output', NULL, 1);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0011_workflow_task_pending_failed_downloaded_output', 'Allow pending workflow task failures during downloaded_output continuity writeback')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
