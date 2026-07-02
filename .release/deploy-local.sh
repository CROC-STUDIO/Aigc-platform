#!/usr/bin/env bash
set -euo pipefail

# 本地一键：打 code-only 包并上传到正式机。
# 用法：
#   bash .release/deploy-local.sh              # 默认 code-only
#   bash .release/deploy-local.sh full           # 全量包（含 Dockerfile / compose）
#   bash .release/deploy-local.sh code-only --remote   # 上传后尝试 SSH 触发远端部署

set -a
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.defaults.sh
source "$ROOT/.release/env.defaults.sh"
if [ -f "$ROOT/.release/env.local.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/.release/env.local.sh"
fi
set +a

MODE="${1:-code-only}"
RUN_REMOTE="${2:-}"

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
    echo "usage: $0 [code-only|full] [--remote]" >&2
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
