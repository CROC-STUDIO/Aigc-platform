#!/usr/bin/env bash
set -euo pipefail

# 在正式机 root shell 执行：解包 code-only 发布包并只重建 app。
# 用法：
#   bash /tmp/deploy-code-only-aigc-platform.sh /tmp/ad-picture-web-codex-code-only-20260629-150000.tar.gz

APP_ROOT="${APP_ROOT:-/opt/ad-picture-web-codex}"
HOST_PORT="${AIGC_HOST_PORT:-5177}"
PKG="${1:-}"

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "usage: $0 /tmp/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz" >&2
  exit 1
fi

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    echo "missing docker compose" >&2
    exit 1
  fi
}

COMPOSE="$(compose_cmd)"

echo "=== AIGC Platform code-only deploy ==="
date
echo "package: $PKG"
echo "app root: $APP_ROOT"

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p /opt/release-backup
tar --exclude='mysql-data' \
    --exclude='.env' \
    --exclude='config.json' \
    --exclude='users.json' \
    -czf "/opt/release-backup/ad-picture-web-codex-code-${TS}.tar.gz" \
    "$APP_ROOT"
echo "[backup] /opt/release-backup/ad-picture-web-codex-code-${TS}.tar.gz"

ROLLBACK_TAG="ad-picture-web-codex-app:rollback-${TS}"
docker tag ad-picture-web-codex-app:latest "$ROLLBACK_TAG" 2>/dev/null || true
printf '%s\n' "$ROLLBACK_TAG" > "$APP_ROOT/.last-rollback-tag"
echo "[backup] docker image tag: $ROLLBACK_TAG"

cd "$APP_ROOT"
tar -xzf "$PKG" -C "$APP_ROOT"

BUILD_ARGS=(build app)
if [ "${DEPLOY_NO_CACHE:-0}" = "1" ]; then
  BUILD_ARGS=(build --no-cache app)
fi

$COMPOSE "${BUILD_ARGS[@]}"
$COMPOSE up -d app

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsSI "http://127.0.0.1:${HOST_PORT}/" | head -1
$COMPOSE ps
echo "APP_URL=http://127.0.0.1:${HOST_PORT}/"
echo "=== code-only deploy complete ==="
