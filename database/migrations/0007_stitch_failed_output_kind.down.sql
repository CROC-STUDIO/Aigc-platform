ALTER TABLE workflow_outputs
  DROP CHECK ck_workflow_outputs_kind;

ALTER TABLE workflow_outputs
  ADD CONSTRAINT ck_workflow_outputs_kind
  CHECK (output_kind IN ('segment_video', 'stitched_video', 'remix_video', 'image'));

DELETE FROM app_schema_migrations
WHERE version = '0007_stitch_failed_output_kind';
