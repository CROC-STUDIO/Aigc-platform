SELECT COUNT(*) AS expected_nine_rules
FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
    ('workflow_task', 'queued', 'qc', 'remix_write'),
    ('workflow_task', 'running', 'qc', 'remix_write'),
    ('workflow_run', 'queued', 'stopped', 'remix_write'),
    ('workflow_run', 'running', 'stopped', 'remix_write'),
    ('workflow_run', 'qc', 'stopped', 'remix_write'),
    ('workflow_run', 'preview_required', 'stopped', 'remix_write'),
    ('workflow_task', 'queued', 'stopped', 'remix_write'),
    ('workflow_task', 'running', 'stopped', 'remix_write'),
    ('workflow_task', 'qc', 'stopped', 'remix_write')
);
