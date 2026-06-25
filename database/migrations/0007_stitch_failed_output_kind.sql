ALTER TABLE workflow_outputs
  DROP CHECK ck_workflow_outputs_kind;

ALTER TABLE workflow_outputs
  ADD CONSTRAINT ck_workflow_outputs_kind
  CHECK (output_kind IN ('segment_video', 'stitched_video', 'stitch_failed', 'remix_video', 'image'));

INSERT INTO app_schema_migrations (version, description)
VALUES ('0007_stitch_failed_output_kind', 'Allow internal stitch_failed workflow outputs for failed stitch report facts')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
