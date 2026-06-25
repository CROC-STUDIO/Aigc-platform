-- 0003_scheduler_state_machine_rules.down.sql
-- Runtime transition rules are additive; remove only the migration marker on rollback.

DELETE FROM app_schema_migrations WHERE version = '0003';
