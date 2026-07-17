SELECT COUNT(*) AS required_rule_count
FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
  ('workflow_run', 'queued', 'qc', 'generation_completed'),
  ('workflow_run', 'queued', 'partial_failed', 'generation_partial_failed'),
  ('workflow_run', 'running', 'partial_failed', 'generation_partial_failed')
);

SELECT COUNT(*) AS migration_record
FROM app_schema_migrations
WHERE version = '0018_generation_finalize_state_rules';
