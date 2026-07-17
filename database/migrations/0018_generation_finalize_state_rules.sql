INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
  ('workflow_run', 'queued', 'qc', 'generation_completed', NULL, 0),
  ('workflow_run', 'queued', 'partial_failed', 'generation_partial_failed', NULL, 1),
  ('workflow_run', 'running', 'partial_failed', 'generation_partial_failed', NULL, 1);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0018_generation_finalize_state_rules', 'Allow queued and running generation batches to settle after all segments finish')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
