#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/prod-triage-sql.sh --run-uid <run_uid> [--run-id <run_id>] [--reference-video-id <reference_video_id>]

Examples:
  scripts/prod-triage-sql.sh --run-uid wzb_20260629030631_8be5 --run-id 479 --reference-video-id 388
  scripts/prod-triage-sql.sh --run-uid wzb_20260629030631_8be5

This script prints SQL only. Copy the output to the production server and run it with:
  sudo docker exec -it aigc-mysql sh -lc "mysql -uroot -p'<mysql-root-password>' -e \"$(cat triage.sql)\""
EOF
}

RUN_UID=""
RUN_ID=""
REFERENCE_VIDEO_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-uid)
      RUN_UID="${2:-}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --reference-video-id)
      REFERENCE_VIDEO_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${RUN_UID}" ]]; then
  echo "--run-uid is required" >&2
  usage >&2
  exit 1
fi

if [[ -n "${RUN_ID}" && ! "${RUN_ID}" =~ ^[0-9]+$ ]]; then
  echo "--run-id must be numeric" >&2
  exit 1
fi

if [[ -n "${REFERENCE_VIDEO_ID}" && ! "${REFERENCE_VIDEO_ID}" =~ ^[0-9]+$ ]]; then
  echo "--reference-video-id must be numeric" >&2
  exit 1
fi

cat <<EOF
USE aigc_platform;

SELECT id, run_uid, status, reference_video_id, created_at, updated_at, started_at, finished_at
FROM workflow_runs
WHERE run_uid='${RUN_UID}';

SELECT id, run_uid, status, reference_video_id, created_at, updated_at, started_at, finished_at
FROM workflow_runs
ORDER BY id DESC
LIMIT 20;

SELECT id, task_uid, task_kind, status, provider, provider_job_id, attempts, error_code, error_message, created_at, updated_at
FROM workflow_tasks
WHERE run_id = ${RUN_ID:-"(SELECT id FROM workflow_runs WHERE run_uid='${RUN_UID}' LIMIT 1)"}
ORDER BY id;

SELECT sj.id, sj.job_uid, sj.job_type, sj.status, sj.attempts, sj.run_after, sj.locked_at, sj.lock_expires_at,
       sj.last_error_code, sj.last_error_message, sj.updated_at, wt.task_uid
FROM scheduler_jobs sj
LEFT JOIN workflow_tasks wt ON wt.id = sj.task_id
WHERE sj.run_id = ${RUN_ID:-"(SELECT id FROM workflow_runs WHERE run_uid='${RUN_UID}' LIMIT 1)"}
ORDER BY sj.id;
EOF

if [[ -n "${REFERENCE_VIDEO_ID}" ]]; then
  cat <<EOF

SELECT rv.id, rv.reference_video_uid, rv.status, rv.duration_sec, rv.width, rv.height, rv.ratio,
       rv.can_extract_frame, rv.created_at, rv.updated_at,
       af.file_name, af.mime_type, af.size_bytes, af.storage_relative_path
FROM reference_videos rv
LEFT JOIN asset_files af ON af.id = rv.asset_file_id
WHERE rv.id = ${REFERENCE_VIDEO_ID};

SELECT id, reference_video_id, status, schema_version, created_at
FROM video_decompositions
WHERE reference_video_id = ${REFERENCE_VIDEO_ID}
ORDER BY id DESC;
EOF
fi
