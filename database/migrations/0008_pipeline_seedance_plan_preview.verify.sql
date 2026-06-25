SELECT COUNT(*) AS plan_preview_rules
FROM state_transition_rules
WHERE trigger_name = 'plan_confirmed';
