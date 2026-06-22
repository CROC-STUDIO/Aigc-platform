-- Allow remix provider callbacks to materialize an output and move task state directly to QC.

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
    ('workflow_task', 'queued', 'qc', 'remix_write', NULL, 0),
    ('workflow_task', 'running', 'qc', 'remix_write', NULL, 0),
    ('workflow_run', 'queued', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_run', 'running', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_run', 'qc', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_run', 'preview_required', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_task', 'queued', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_task', 'running', 'stopped', 'remix_write', 'remix:own', 1),
    ('workflow_task', 'qc', 'stopped', 'remix_write', 'remix:own', 1);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0004_remix_task_qc_state_rules', 'Allow remix task queued/running to qc during remix writeback')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
