ALTER TABLE workflow_tasks
  DROP CHECK ck_workflow_tasks_status;

ALTER TABLE workflow_tasks
  ADD CONSTRAINT ck_workflow_tasks_status
  CHECK (status IN (
    'pending',
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

DELETE FROM app_schema_migrations WHERE version = '0010_workflow_task_pending_preview';
