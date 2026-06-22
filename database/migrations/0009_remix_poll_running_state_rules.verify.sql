SELECT COUNT(*) AS expected_two_rules
FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
  ('workflow_run', 'queued', 'running', 'remix_write'),
  ('workflow_task', 'queued', 'running', 'remix_write')
);
