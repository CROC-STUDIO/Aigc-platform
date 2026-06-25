DELETE FROM state_transition_rules
WHERE trigger_name IN ('plan_confirmed')
  AND entity_type IN ('workflow_run', 'workflow_task');

DELETE FROM app_schema_migrations WHERE version = '0008_pipeline_seedance_plan_preview';
