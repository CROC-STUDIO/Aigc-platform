ALTER TABLE workflow_outputs
  DROP CHECK ck_workflow_outputs_kind;

ALTER TABLE workflow_outputs
  ADD CONSTRAINT ck_workflow_outputs_kind
  CHECK (output_kind IN ('segment_video', 'stitched_video', 'stitch_failed', 'remix_video', 'image'));

DELETE FROM app_schema_migrations
WHERE version = '0016_expanded_video_output_kind';
