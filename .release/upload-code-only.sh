#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.defaults.sh
source "$ROOT/.release/env.defaults.sh"
if [ -f "$ROOT/.release/env.local.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/.release/env.local.sh"
fi

PKG="${1:-}"
if [ -z "$PKG" ]; then
  PKG="$(ls -t "$ROOT/.release"/ad-picture-web-codex-code-only-*.tar.gz 2>/dev/null | head -1 || true)"
fi

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "missing code-only package. run: bash scripts/package-code-only.sh" >&2
  exit 1
fi

PKG_NAME="$(basename "$PKG")"
REMOTE_PKG="/tmp/$PKG_NAME"
DEPLOY_SH="$ROOT/.release/deploy-code-only-remote.sh"

SFTP_BATCH="$(mktemp)"
{
  printf 'put %s %s\n' "$PKG" "$REMOTE_PKG"
  printf 'put %s /tmp/deploy-code-only-aigc-platform.sh\n' "$DEPLOY_SH"
  printf 'bye\n'
} > "$SFTP_BATCH"

sftp -P "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -o "User=$JMS_LOGIN" -b "$SFTP_BATCH" "$JMS_HOST"
rm -f "$SFTP_BATCH"

echo
echo "Uploaded: $REMOTE_PKG"
echo "Remote deploy (root shell):"
echo "  chmod +x /tmp/deploy-code-only-aigc-platform.sh"
echo "  bash /tmp/deploy-code-only-aigc-platform.sh $REMOTE_PKG"
