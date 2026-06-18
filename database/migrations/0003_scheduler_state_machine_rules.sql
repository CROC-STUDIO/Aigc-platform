-- 0003_scheduler_state_machine_rules.sql
-- Align MySQL state-transition rules with the runtime wangzhuan triggers
-- and scheduler retry worker.

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
    ('workflow_run', '__new__', 'queued', 'batch_created', NULL, 0),
    ('workflow_run', '__new__', 'queued', 'remix_write', NULL, 0),
    ('workflow_run', '__new__', 'running', 'remix_write', NULL, 0),
    ('workflow_run', '__new__', 'preview_required', 'remix_write', NULL, 0),
    ('workflow_run', '__new__', 'failed', 'remix_write', NULL, 1),
    ('workflow_run', 'queued', 'running', 'batch_write', NULL, 0),
    ('workflow_run', 'queued', 'stitching', 'stitch_progress', NULL, 0),
    ('workflow_run', 'running', 'stitching', 'stitch_progress', NULL, 0),
    ('workflow_run', 'running', 'qc', 'stitch_progress', NULL, 0),
    ('workflow_run', 'stitching', 'partial_failed', 'stitch_progress', NULL, 1),
    ('workflow_run', 'partial_failed', 'stitching', 'stitch_progress', NULL, 0),
    ('workflow_run', 'partial_failed', 'qc', 'stitch_progress', NULL, 0),
    ('workflow_run', 'running', 'succeeded', 'qc_completed', NULL, 1),
    ('workflow_run', 'running', 'partial_failed', 'qc_completed', NULL, 1),
    ('workflow_run', 'running', 'failed', 'qc_completed', NULL, 1),
    ('workflow_run', 'qc', 'succeeded', 'qc_completed', NULL, 1),
    ('workflow_run', 'qc', 'partial_failed', 'qc_completed', NULL, 1),
    ('workflow_run', 'qc', 'failed', 'qc_completed', NULL, 1),
    ('workflow_run', 'queued', 'preview_required', 'remix_write', NULL, 0),
    ('workflow_run', 'running', 'preview_required', 'remix_write', NULL, 0),
    ('workflow_run', 'qc', 'preview_required', 'remix_write', NULL, 0),
    ('workflow_run', 'queued', 'failed', 'remix_write', NULL, 1),
    ('workflow_run', 'running', 'failed', 'remix_write', NULL, 1),
    ('workflow_run', 'preview_required', 'failed', 'remix_write', NULL, 1),
    ('workflow_run', 'queued', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_run', 'qc', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_run', 'preview_required', 'stopped', 'user_stop', 'remix:own', 1),
    ('workflow_run', 'preview_required', 'succeeded', 'remix_write', 'remix:own', 1),
    ('workflow_task', '__new__', 'pending', 'batch_created', NULL, 0),
    ('workflow_task', '__new__', 'pending', 'batch_write', NULL, 0),
    ('workflow_task', '__new__', 'queued', 'remix_write', NULL, 0),
    ('workflow_task', '__new__', 'running', 'remix_write', NULL, 0),
    ('workflow_task', '__new__', 'qc', 'remix_write', NULL, 0),
    ('workflow_task', '__new__', 'succeeded', 'remix_write', NULL, 1),
    ('workflow_task', '__new__', 'failed', 'remix_write', NULL, 1),
    ('workflow_task', 'pending', 'waiting_upstream', 'batch_write', NULL, 0),
    ('workflow_task', 'waiting_upstream', 'pending', 'scheduler_retry', NULL, 0),
    ('workflow_task', 'failed', 'pending', 'scheduler_retry', NULL, 0),
    ('workflow_task', 'failed', 'waiting_upstream', 'scheduler_retry', NULL, 0),
    ('workflow_task', 'waiting_upstream', 'downloaded', 'stitch_progress', NULL, 0),
    ('workflow_task', 'waiting_upstream', 'qc', 'stitch_progress', NULL, 0),
    ('workflow_task', 'downloaded', 'qc', 'stitch_progress', NULL, 0),
    ('workflow_task', 'pending', 'failed', 'batch_write', NULL, 1),
    ('workflow_task', 'waiting_upstream', 'failed', 'batch_write', NULL, 1),
    ('workflow_task', 'qc', 'failed', 'batch_write', NULL, 1),
    ('workflow_task', 'pending', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_task', 'waiting_upstream', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_task', 'downloaded', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_task', 'qc', 'stopped', 'user_stop', 'batch:own', 1),
    ('scheduler_job', 'running', 'pending', 'retry', NULL, 0);

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
SELECT 'workflow_run', status_value, status_value, trigger_name, NULL,
       CASE WHEN status_value IN ('succeeded', 'failed', 'skipped', 'stopped') THEN 1 ELSE 0 END
FROM (
    SELECT 'draft' AS status_value UNION ALL SELECT 'checking' UNION ALL SELECT 'queued' UNION ALL
    SELECT 'running' UNION ALL SELECT 'stitching' UNION ALL SELECT 'qc' UNION ALL
    SELECT 'preview_required' UNION ALL SELECT 'succeeded' UNION ALL SELECT 'partial_failed' UNION ALL
    SELECT 'failed' UNION ALL SELECT 'skipped' UNION ALL SELECT 'stopped'
) statuses
CROSS JOIN (
    SELECT 'batch_write' AS trigger_name UNION ALL SELECT 'batch_created' UNION ALL
    SELECT 'qc_completed' UNION ALL SELECT 'stitch_progress' UNION ALL SELECT 'remix_write'
) triggers;

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
SELECT 'workflow_task', status_value, status_value, trigger_name, NULL,
       CASE WHEN status_value IN ('succeeded', 'failed', 'skipped', 'stopped') THEN 1 ELSE 0 END
FROM (
    SELECT 'pending' AS status_value UNION ALL SELECT 'queued' UNION ALL SELECT 'running' UNION ALL
    SELECT 'waiting_upstream' UNION ALL SELECT 'downloaded' UNION ALL SELECT 'stitching' UNION ALL
    SELECT 'qc' UNION ALL SELECT 'succeeded' UNION ALL SELECT 'failed' UNION ALL
    SELECT 'skipped' UNION ALL SELECT 'stopped'
) statuses
CROSS JOIN (
    SELECT 'batch_write' AS trigger_name UNION ALL SELECT 'batch_created' UNION ALL
    SELECT 'qc_completed' UNION ALL SELECT 'stitch_progress' UNION ALL SELECT 'remix_write'
) triggers;

INSERT INTO app_schema_migrations (version, description)
VALUES ('0003', 'Add runtime state-machine rules for scheduler retry worker and wangzhuan triggers')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
