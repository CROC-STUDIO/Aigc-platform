#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/.release/env.defaults.sh"
if [ -f "$ROOT/.release/env.local.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/.release/env.local.sh"
fi

JMS_HOST="${JMS_HOST:?missing JMS_HOST}"
JMS_PORT="${JMS_PORT:?missing JMS_PORT}"
JMS_KEY="${JMS_KEY:?missing JMS_KEY}"
JMS_USER="${JMS_USER:-}"
ASSET_USER="${ASSET_USER:-}"
ASSET="${ASSET:-}"
JMS_LOGIN="${JMS_LOGIN:-}"

if [ -z "$JMS_LOGIN" ]; then
  if [ -z "$JMS_USER" ] || [ -z "$ASSET_USER" ] || [ -z "$ASSET" ]; then
    echo "missing JMS_LOGIN or JMS_USER/ASSET_USER/ASSET" >&2
    exit 1
  fi
  JMS_LOGIN="${JMS_USER}@${ASSET_USER}@${ASSET}"
fi

SSH_BASE=(ssh -p "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY")
SFTP_BASE=(sftp -P "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY")

print_usage() {
  cat <<'EOF'
usage:
  bash scripts/jms-ops.sh check
  bash scripts/jms-ops.sh ssh
  bash scripts/jms-ops.sh exec -- 'command'
  bash scripts/jms-ops.sh sudo-exec -- 'command'
  bash scripts/jms-ops.sh put <local> <remote>
  bash scripts/jms-ops.sh get <remote> <local>
  bash scripts/jms-ops.sh put-batch <batch-file>
  bash scripts/jms-ops.sh sha256-up <local> <remote>
EOF
}

jms_ssh() {
  "${SSH_BASE[@]}" -l "$JMS_LOGIN" "$JMS_HOST" "$@"
}

jms_exec_sh() {
  local remote_cmd="$1"
  jms_ssh bash -lc "$remote_cmd"
}

jms_sudo_exec_sh() {
  local remote_cmd="$1"
  jms_ssh sudo -- bash -lc "$remote_cmd"
}

jms_sftp_batch() {
  local batch_file="$1"
  "${SFTP_BASE[@]}" -o "User=$JMS_LOGIN" -b "$batch_file" "$JMS_HOST"
}

cmd="${1:-}"
case "$cmd" in
  check)
    echo "== gateway =="
    "${SSH_BASE[@]}" "${JMS_USER:-${JMS_LOGIN%%@*}}@$JMS_HOST" true
    echo "== asset =="
    jms_ssh 'whoami && hostname && pwd'
    echo "== sudo =="
    jms_ssh 'sudo -n true && echo sudo_ok'
    ;;
  ssh)
    exec "${SSH_BASE[@]}" -l "$JMS_LOGIN" "$JMS_HOST"
    ;;
  exec)
    shift
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || { print_usage; exit 1; }
    jms_exec_sh "$1"
    ;;
  sudo-exec)
    shift
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || { print_usage; exit 1; }
    jms_sudo_exec_sh "$1"
    ;;
  put)
    local_path="${2:-}"
    remote_path="${3:-}"
    [ -n "$local_path" ] && [ -n "$remote_path" ] || { print_usage; exit 1; }
    batch="$(mktemp)"
    printf 'put %s %s\nbye\n' "$local_path" "$remote_path" > "$batch"
    jms_sftp_batch "$batch"
    rm -f "$batch"
    ;;
  get)
    remote_path="${2:-}"
    local_path="${3:-}"
    [ -n "$remote_path" ] && [ -n "$local_path" ] || { print_usage; exit 1; }
    batch="$(mktemp)"
    printf 'get %s %s\nbye\n' "$remote_path" "$local_path" > "$batch"
    jms_sftp_batch "$batch"
    rm -f "$batch"
    ;;
  put-batch)
    batch_file="${2:-}"
    [ -n "$batch_file" ] && [ -f "$batch_file" ] || { print_usage; exit 1; }
    jms_sftp_batch "$batch_file"
    ;;
  sha256-up)
    local_path="${2:-}"
    remote_path="${3:-}"
    [ -n "$local_path" ] && [ -n "$remote_path" ] || { print_usage; exit 1; }
    local_hash="$(shasum -a 256 "$local_path" | awk '{print $1}')"
    remote_hash="$(jms_ssh "sha256sum $(printf '%q' "$remote_path") | awk '{print \\$1}'")"
    echo "local : $local_hash"
    echo "remote: $remote_hash"
    [ "$local_hash" = "$remote_hash" ]
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
