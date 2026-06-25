-- 0003_scheduler_state_machine_rules.verify.sql

SELECT version, description
FROM app_schema_migrations
WHERE version = '0003';

SELECT entity_type, from_status, to_status, trigger_name
FROM state_transition_rules
WHERE (entity_type, from_status, to_status, trigger_name) IN (
    ('workflow_task', 'failed', 'waiting_upstream', 'scheduler_retry'),
    ('scheduler_job', 'running', 'pending', 'retry'),
    ('workflow_run', '__new__', 'queued', 'batch_created'),
    ('workflow_run', 'queued', 'running', 'batch_write'),
    ('workflow_run', '__new__', 'preview_required', 'remix_write')
)
ORDER BY entity_type, from_status, to_status, trigger_name;

SELECT entity_type, trigger_name, COUNT(*) AS rule_count
FROM state_transition_rules
WHERE trigger_name IN ('scheduler_retry', 'batch_write', 'remix_write')
GROUP BY entity_type, trigger_name
ORDER BY entity_type, trigger_name;
