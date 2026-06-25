ALTER TABLE workflow_tasks
  DROP CHECK ck_workflow_tasks_status;

ALTER TABLE workflow_tasks
  ADD CONSTRAINT ck_workflow_tasks_status
  CHECK (status IN (
    'pending',
    'pending_preview',
    'queued',
    'running',
    'waiting_upstream',
    'downloaded',
    'stitching',
    'qc',
    'succeeded',
    'failed',
    'skipped',
    'stopped'
  ));

INSERT INTO app_schema_migrations (version, description)
VALUES ('0010_workflow_task_pending_preview', 'Allow pending_preview workflow task status for Seedance plan preview')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
