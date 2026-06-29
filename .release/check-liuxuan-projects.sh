#!/usr/bin/env bash
docker exec aigc-mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "
SELECT wr.run_uid, wr.status, wr.project_id, p.display_name, p.storage_root_hint, wr.created_at
FROM workflow_runs wr
JOIN projects p ON p.id = wr.project_id
WHERE wr.user_id = (SELECT id FROM app_users WHERE username=\"liuxuan\" LIMIT 1)
ORDER BY wr.created_at;

SELECT p.id, p.display_name, p.project_key, p.storage_root_hint, COUNT(wr.id) AS batch_count
FROM projects p
LEFT JOIN workflow_runs wr ON wr.project_id = p.id
  AND wr.user_id = (SELECT id FROM app_users WHERE username=\"liuxuan\" LIMIT 1)
GROUP BY p.id, p.display_name, p.project_key, p.storage_root_hint
HAVING batch_count > 0;

SELECT id, display_name, project_key, storage_root_hint FROM projects ORDER BY id;
"'
