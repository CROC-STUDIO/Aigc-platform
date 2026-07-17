#!/usr/bin/env bash
set -euo pipefail

# 正式机发布入口。必须显式声明 --production，避免候选验证误发到 5177。
# 用法：
#   bash .release/deploy-local.sh --production [code-only|full]
#   bash .release/deploy-local.sh --production code-only --remote

set -a
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.defaults.sh
source "$ROOT/.release/env.defaults.sh"
if [ -f "$ROOT/.release/env.local.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/.release/env.local.sh"
fi
set +a

MODE="code-only"
RUN_REMOTE=""
PRODUCTION_CONFIRMED="false"

for arg in "$@"; do
  case "$arg" in
    code-only|full)
      MODE="$arg"
      ;;
    --remote)
      RUN_REMOTE="--remote"
      ;;
    --production)
      PRODUCTION_CONFIRMED="true"
      ;;
    *)
      echo "usage: $0 --production [code-only|full] [--remote]" >&2
      exit 1
      ;;
  esac
done

if [ "$PRODUCTION_CONFIRMED" != "true" ]; then
  echo "Refusing production deployment without --production. Use docker compose for the local candidate on port 8000." >&2
  exit 2
fi

cd "$ROOT"

case "$MODE" in
  code-only)
    bash scripts/jms-ops.sh check
    bash scripts/package-code-only.sh
    bash .release/upload-code-only.sh
    PKG="$(ls -t .release/ad-picture-web-codex-code-only-*.tar.gz | head -1)"
    PKG_NAME="$(basename "$PKG")"
    REMOTE_CMD="chmod +x /tmp/deploy-code-only-aigc-platform.sh && bash /tmp/deploy-code-only-aigc-platform.sh /tmp/${PKG_NAME}"
    ;;
  full)
    bash scripts/jms-ops.sh check
    bash .release/pack-release.sh
    bash .release/upload-release.sh
    REMOTE_CMD="chmod +x /tmp/deploy-aigc-platform.sh && bash /tmp/deploy-aigc-platform.sh"
    ;;
  *)
    echo "usage: $0 --production [code-only|full] [--remote]" >&2
    exit 1
    ;;
esac

if [ "$RUN_REMOTE" = "--remote" ]; then
  echo
  echo "Running remote deploy via SSH..."
  bash scripts/jms-ops.sh sudo-exec -- "$REMOTE_CMD"
else
  echo
  echo "Next on production (root shell):"
  echo "  $REMOTE_CMD"
fi
