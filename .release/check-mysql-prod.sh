#!/usr/bin/env bash
set -euo pipefail

echo "=== MySQL container ==="
docker inspect aigc-mysql --format 'Started={{.State.StartedAt}} Created={{.Created}} RestartCount={{.RestartCount}}'

echo "=== mysql-data birth ==="
stat /opt/ad-picture-web-codex/mysql-data | grep -E 'Birth|Modify'

echo "=== backup mysql-data sizes ==="
for d in /opt/ad-picture-web-codex.bak.20260625-172347/mysql-data \
         /opt/ad-picture-web-codex.codebak.20260625-173826/mysql-data \
         /opt/ad-picture-web-codex.codebak.20260625-184849/mysql-data; do
  if [ -d "$d" ]; then
    echo -n "$d: "
    du -sh "$d"
    stat "$d" | grep Birth || true
  fi
done

echo "=== DB query (current) ==="
docker exec aigc-mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "
SELECT COUNT(*) AS workflow_runs_count FROM workflow_runs;
SELECT MIN(created_at) AS earliest_run, MAX(created_at) AS latest_run FROM workflow_runs;
SELECT id, username, created_at FROM app_users ORDER BY id;
SELECT u.username, COUNT(r.id) AS batch_count, MIN(r.created_at) AS earliest, MAX(r.created_at) AS latest
FROM workflow_runs r JOIN app_users u ON u.id = r.user_id
GROUP BY u.username ORDER BY u.username;
SELECT run_uid, status, created_at FROM workflow_runs ORDER BY created_at LIMIT 10;
"'

echo "=== liuxuan in users.json ==="
grep -i liuxuan /opt/ad-picture-web/users.json || true
