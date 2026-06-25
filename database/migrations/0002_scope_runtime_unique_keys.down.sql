-- 0002_scope_runtime_unique_keys.down.sql
-- Rollback for local development only. Do not run on data sets where duplicate
-- runtime ids already exist across projects or runs.

ALTER TABLE download_packages
  DROP INDEX uq_download_packages_project_uid,
  ADD UNIQUE KEY uq_download_packages_uid (package_uid);

ALTER TABLE workflow_outputs
  DROP INDEX uq_workflow_outputs_run_uid,
  ADD UNIQUE KEY uq_workflow_outputs_uid (output_uid);

ALTER TABLE workflow_tasks
  DROP INDEX uq_workflow_tasks_run_uid,
  ADD UNIQUE KEY uq_workflow_tasks_uid (task_uid);

ALTER TABLE generation_scripts
  DROP INDEX uq_generation_scripts_run_uid,
  ADD UNIQUE KEY uq_generation_scripts_uid (script_uid);

ALTER TABLE workflow_runs
  DROP INDEX uq_workflow_runs_project_uid,
  ADD UNIQUE KEY uq_workflow_runs_uid (run_uid);

ALTER TABLE work_estimates
  DROP INDEX uq_work_estimates_project_uid,
  ADD UNIQUE KEY uq_work_estimates_uid (estimate_uid);

ALTER TABLE reference_videos
  DROP INDEX uq_reference_videos_project_uid,
  ADD UNIQUE KEY uq_reference_videos_uid (reference_video_uid);

ALTER TABLE product_template_versions
  DROP INDEX uq_template_versions_template_uid,
  ADD UNIQUE KEY uq_template_versions_uid (template_version_uid);

ALTER TABLE product_templates
  DROP INDEX uq_product_templates_project_uid,
  ADD UNIQUE KEY uq_product_templates_uid (template_uid);

ALTER TABLE asset_files
  DROP INDEX uq_asset_files_project_uid,
  ADD UNIQUE KEY uq_asset_files_asset_uid (asset_uid);
