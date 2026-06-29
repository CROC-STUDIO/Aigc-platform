#!/usr/bin/env bash
docker exec aigc-mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "
SELECT run_uid, status, created_at FROM workflow_runs WHERE user_id=24 ORDER BY created_at;
"'

echo "=== wangzhuan batch dirs on disk ==="
find /opt/ad-picture-web-data -path '*网赚管线*batches*' -maxdepth 8 -type d 2>/dev/null | head -20
find /opt/ad-picture-web-data -path '*网赚管线*' -name 'wzb_*' 2>/dev/null | head -20
