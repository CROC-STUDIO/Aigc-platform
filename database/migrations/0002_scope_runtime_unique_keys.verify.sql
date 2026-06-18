-- 0002_scope_runtime_unique_keys.verify.sql

SELECT
  table_name,
  index_name,
  GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_in_index
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND index_name IN (
    'uq_asset_files_project_uid',
    'uq_product_templates_project_uid',
    'uq_template_versions_template_uid',
    'uq_reference_videos_project_uid',
    'uq_work_estimates_project_uid',
    'uq_workflow_runs_project_uid',
    'uq_generation_scripts_run_uid',
    'uq_workflow_tasks_run_uid',
    'uq_workflow_outputs_run_uid',
    'uq_download_packages_project_uid'
  )
GROUP BY table_name, index_name
ORDER BY table_name, index_name;

SELECT version, description
FROM app_schema_migrations
WHERE version = '0002';
