-- Verification queries for 0001_mysql_foundation.
-- Run after applying the migration in a test database.

SELECT VERSION() AS mysql_version;
SHOW VARIABLES LIKE 'version_comment';

SELECT COUNT(*) AS foundation_table_count
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'app_schema_migrations',
    'app_users',
    'auth_sessions',
    'auth_login_attempts',
    'rbac_roles',
    'rbac_permissions',
    'rbac_role_permissions',
    'user_roles',
    'projects',
    'project_members',
    'asset_files',
    'product_templates',
    'product_template_versions',
    'project_default_template_versions',
    'channel_rules',
    'reference_videos',
    'video_decompositions',
    'work_estimates',
    'workflow_runs',
    'generation_scripts',
    'workflow_tasks',
    'task_attempts',
    'scheduler_jobs',
    'workflow_outputs',
    'qc_reports',
    'stitch_reports',
    'remix_regions',
    'download_packages',
    'download_package_items',
    'idempotency_keys',
    'state_transition_rules',
    'state_transition_events',
    'resource_locks',
    'audit_events',
    'telemetry_events'
  );

SELECT version, applied_at
FROM app_schema_migrations
WHERE version = '0001_mysql_foundation';

SELECT role_key
FROM rbac_roles
ORDER BY role_key;

SELECT permission_key
FROM rbac_permissions
ORDER BY permission_key;

SELECT r.role_key, COUNT(*) AS permission_count
FROM rbac_roles r
JOIN rbac_role_permissions rp ON rp.role_id = r.id
GROUP BY r.role_key
ORDER BY r.role_key;

SELECT channel, promise_level, rule_uid
FROM channel_rules
WHERE project_id IS NULL
ORDER BY channel, promise_level;

SELECT entity_type, COUNT(*) AS transition_count
FROM state_transition_rules
GROUP BY entity_type
ORDER BY entity_type;

SELECT COUNT(*) AS unsafe_absolute_path_constraints
FROM information_schema.check_constraints
WHERE constraint_schema = DATABASE()
  AND constraint_name = 'ck_asset_files_relative_path';
