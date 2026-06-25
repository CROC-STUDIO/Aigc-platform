-- 0002_scope_runtime_unique_keys.sql
-- Scope generated runtime IDs by project/run so JSON-derived ids such as ref_YYYYMMDD_001
-- can coexist across independent project roots.

ALTER TABLE asset_files
  DROP INDEX uq_asset_files_asset_uid,
  ADD UNIQUE KEY uq_asset_files_project_uid (project_id, asset_uid);

ALTER TABLE product_templates
  DROP INDEX uq_product_templates_uid,
  ADD UNIQUE KEY uq_product_templates_project_uid (project_id, template_uid);

ALTER TABLE product_template_versions
  DROP INDEX uq_template_versions_uid,
  ADD UNIQUE KEY uq_template_versions_template_uid (template_id, template_version_uid);

ALTER TABLE reference_videos
  DROP INDEX uq_reference_videos_uid,
  ADD UNIQUE KEY uq_reference_videos_project_uid (project_id, reference_video_uid);

ALTER TABLE work_estimates
  DROP INDEX uq_work_estimates_uid,
  ADD UNIQUE KEY uq_work_estimates_project_uid (project_id, estimate_uid);

ALTER TABLE workflow_runs
  DROP INDEX uq_workflow_runs_uid,
  ADD UNIQUE KEY uq_workflow_runs_project_uid (project_id, run_uid);

ALTER TABLE generation_scripts
  DROP INDEX uq_generation_scripts_uid,
  ADD UNIQUE KEY uq_generation_scripts_run_uid (run_id, script_uid);

ALTER TABLE workflow_tasks
  DROP INDEX uq_workflow_tasks_uid,
  ADD UNIQUE KEY uq_workflow_tasks_run_uid (run_id, task_uid);

ALTER TABLE workflow_outputs
  DROP INDEX uq_workflow_outputs_uid,
  ADD UNIQUE KEY uq_workflow_outputs_run_uid (run_id, output_uid);

ALTER TABLE download_packages
  DROP INDEX uq_download_packages_uid,
  ADD UNIQUE KEY uq_download_packages_project_uid (project_id, package_uid);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0002', 'Scope runtime unique keys by project and run')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
