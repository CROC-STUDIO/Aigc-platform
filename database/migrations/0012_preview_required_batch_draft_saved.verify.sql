SELECT entity_type, from_status, to_status, trigger_name, is_terminal
FROM state_transition_rules
WHERE entity_type = 'workflow_run'
  AND from_status = 'preview_required'
  AND to_status = 'preview_required'
  AND trigger_name = 'batch_draft_saved';
