INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_run', 'preview_required', 'preview_required', 'batch_draft_saved', NULL, 0);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0012_preview_required_batch_draft_saved', 'Allow preview_required pipeline batches to save draft snapshots without changing run state')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
