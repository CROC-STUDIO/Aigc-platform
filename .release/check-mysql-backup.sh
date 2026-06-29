#!/usr/bin/env bash
set -euo pipefail

echo "=== all mysql-data on /opt ==="
find /opt -maxdepth 4 -type d -name mysql-data 2>/dev/null | while read -r d; do
  echo "--- $d ---"
  du -sh "$d" 2>/dev/null || true
  stat "$d" 2>/dev/null | grep -E 'Birth|Modify' || true
  if [ -f "$d/binlog.index" ]; then
    echo "binlogs: $(wc -l < "$d/binlog.index") files, first=$(head -1 "$d/binlog.index" | xargs basename 2>/dev/null)"
    ls -lt "$d"/binlog.* 2>/dev/null | tail -3 || true
  fi
done

echo "=== backup .bak dirs timeline ==="
ls -ld /opt/ad-picture-web-codex.bak.* 2>/dev/null | head -10

echo "=== sample run_uid in backup ibd ==="
BACKUP="/opt/ad-picture-web-codex.bak.20260625-172347/mysql-data"
if [ -f "$BACKUP/aigc_platform/workflow_runs.ibd" ]; then
  strings "$BACKUP/aigc_platform/workflow_runs.ibd" | grep -oE 'wzb_[0-9]{14}_[a-f0-9]{4}' | sort -u
  echo "backup run_uid count: $(strings "$BACKUP/aigc_platform/workflow_runs.ibd" | grep -oE 'wzb_[0-9]{14}_[a-f0-9]{4}' | sort -u | wc -l)"
fi

echo "=== sample run_uid in current ibd ==="
CUR="/opt/ad-picture-web-codex/mysql-data"
if [ -f "$CUR/aigc_platform/workflow_runs.ibd" ]; then
  strings "$CUR/aigc_platform/workflow_runs.ibd" | grep -oE 'wzb_[0-9]{14}_[a-f0-9]{4}' | sort -u
  echo "current run_uid count: $(strings "$CUR/aigc_platform/workflow_runs.ibd" | grep -oE 'wzb_[0-9]{14}_[a-f0-9]{4}' | sort -u | wc -l)"
fi

echo "=== current binlog timeline ==="
ls -la /opt/ad-picture-web-codex/mysql-data/binlog.* 2>/dev/null | head -8
head -5 /opt/ad-picture-web-codex/mysql-data/binlog.index 2>/dev/null || true
