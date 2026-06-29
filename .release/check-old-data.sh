#!/usr/bin/env bash
echo "=== /opt/ad-picture-web* top level ==="
ls -la /opt/ | grep ad-picture || true

echo "=== docker containers ==="
docker ps -a --format '{{.Names}} | {{.CreatedAt}} | {{.Status}}'

echo "=== project-data batch dirs (sample) ==="
find /opt/ad-picture-web-data -maxdepth 5 -type d -name 'wzb_*' 2>/dev/null | head -25

echo "=== project-data oldest files ==="
find /opt/ad-picture-web-data -maxdepth 4 -type f 2>/dev/null | xargs stat -c '%y %n' 2>/dev/null | sort | head -20

echo "=== liuxuan batches in project-data ==="
find /opt/ad-picture-web-data -maxdepth 6 -type d -name 'wzb_*' 2>/dev/null | wc -l
