#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.defaults.sh
source "$ROOT/.release/env.defaults.sh"
if [ -f "$ROOT/.release/env.local.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/.release/env.local.sh"
fi
RELEASE_TAR="$ROOT/.release/aigc-platform-release.tar.gz"
DEPLOY_SH="$ROOT/.release/deploy-remote.sh"
PROD_ENV="${PROD_ENV:-}"

if [ ! -f "$RELEASE_TAR" ]; then
  echo "missing $RELEASE_TAR, run: bash .release/pack-release.sh" >&2
  exit 1
fi

SFTP_BATCH="$(mktemp)"
{
  printf 'put %s /tmp/aigc-platform-release.tar.gz\n' "$RELEASE_TAR"
  printf 'put %s /tmp/deploy-aigc-platform.sh\n' "$DEPLOY_SH"
  if [ -n "$PROD_ENV" ] && [ -f "$PROD_ENV" ]; then
    printf 'put %s /tmp/aigc-platform.prod.env\n' "$PROD_ENV"
  fi
  printf 'bye\n'
} > "$SFTP_BATCH"

sftp -P "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -o "User=$JMS_LOGIN" -b "$SFTP_BATCH" "$JMS_HOST"
rm -f "$SFTP_BATCH"

echo
echo "Uploaded. On remote root shell run:"
echo "  chmod +x /tmp/deploy-aigc-platform.sh"
echo "  bash /tmp/deploy-aigc-platform.sh"
