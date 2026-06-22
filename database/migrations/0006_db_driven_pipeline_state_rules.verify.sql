SELECT COUNT(*) AS required_rule_count
FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
  ('workflow_run', 'queued', 'failed', 'batch_write'),
  ('workflow_run', 'partial_failed', 'qc', 'stitch_completed'),
  ('workflow_task', 'waiting_upstream', 'downloaded', 'batch_write')
);

SELECT COUNT(*) AS migration_record
FROM app_schema_migrations
WHERE version = '0006_db_driven_pipeline_state_rules';
