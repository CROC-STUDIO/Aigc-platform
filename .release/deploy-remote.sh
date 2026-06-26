#!/usr/bin/env bash
set -euo pipefail

echo "=== Touka AIGC Platform Deploy ==="
date

APP_ROOT="/opt/ad-picture-web-codex"
RELEASE_TAR="/tmp/aigc-platform-release.tar.gz"
PROD_ENV="/tmp/aigc-platform.prod.env"
HOST_PORT="${AIGC_HOST_PORT:-5177}"

if [ ! -f "$RELEASE_TAR" ]; then
  echo "missing release tarball: $RELEASE_TAR" >&2
  exit 1
fi

mkdir -p /opt/ad-picture-web /opt/ad-picture-web-data /opt/ad-picture-web-codex
mkdir -p "$APP_ROOT/mysql-data"

echo "[prep] backup current tree"
SYNC_BACKUP="/opt/ad-picture-web-codex.syncbak.$(date +%Y%m%d-%H%M%S)"
if [ -d "$APP_ROOT" ] && [ -f "$APP_ROOT/server.mjs" ]; then
  cp -a "$APP_ROOT" "$SYNC_BACKUP"
  printf '%s\n' "$SYNC_BACKUP" > "$APP_ROOT/.last-sync-backup"
fi

echo "[prep] backup current image tag"
ROLLBACK_TAG="ad-picture-web-codex-app:rollback-$(date +%Y%m%d-%H%M)"
docker tag ad-picture-web-codex-app:latest "$ROLLBACK_TAG" 2>/dev/null || true
mkdir -p "$APP_ROOT"
printf '%s\n' "$ROLLBACK_TAG" > "$APP_ROOT/.last-rollback-tag"

echo "[prep] extract release"
TMP_DIR="$(mktemp -d /tmp/aigc-platform-release.XXXXXX)"
tar -xzf "$RELEASE_TAR" -C "$TMP_DIR"
test -f "$TMP_DIR/server.mjs"
test -f "$TMP_DIR/Dockerfile"
test -f "$TMP_DIR/.release/docker-compose.prod.yml"

echo "[sync] copy application files"
shopt -s dotglob
for item in "$TMP_DIR"/*; do
  name="$(basename "$item")"
  case "$name" in
    .env|mysql-data) continue ;;
  esac
  rm -rf "$APP_ROOT/$name"
  cp -a "$item" "$APP_ROOT/"
done
shopt -u dotglob

cp "$APP_ROOT/.release/docker-compose.prod.yml" "$APP_ROOT/docker-compose.yml"

if [ ! -f "$APP_ROOT/.env" ]; then
  if [ -f "$PROD_ENV" ]; then
    echo "[env] apply uploaded prod env"
    cp "$PROD_ENV" "$APP_ROOT/.env"
  else
    echo "missing $APP_ROOT/.env and no $PROD_ENV uploaded" >&2
    exit 1
  fi
fi

if [ ! -f /opt/ad-picture-web-codex/config.json ] && [ ! -f /opt/ad-picture-web/config.json ]; then
  echo "[state] seed config.json from config.default.json"
  cp "$APP_ROOT/config.default.json" /opt/ad-picture-web-codex/config.json
fi

if [ ! -f /opt/ad-picture-web/users.json ]; then
  echo "[state] seed /opt/ad-picture-web/users.json"
  cat > /opt/ad-picture-web/users.json <<'EOF'
{
  "users": [
    {
      "username": "admin",
      "password": "admin123",
      "displayName": "管理员",
      "role": "admin"
    }
  ]
}
EOF
fi

chmod 600 "$APP_ROOT/.env" || true

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

echo "[docker] build and start"
cd "$APP_ROOT"
$COMPOSE build --no-cache app
$COMPOSE up -d mysql

echo "[docker] wait for mysql"
for i in $(seq 1 30); do
  status="$(docker inspect --format='{{.State.Health.Status}}' aigc-mysql 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 2
done
docker inspect --format='{{.State.Health.Status}}' aigc-mysql

$COMPOSE up -d app

echo "[verify] wait for app health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS "http://127.0.0.1:${HOST_PORT}/" >/dev/null
curl -fsS "http://127.0.0.1:${HOST_PORT}/api/auth" | head -c 200
echo

echo "=== Deploy complete ==="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'aigc-|NAMES' || true
echo "APP_URL=http://127.0.0.1:${HOST_PORT}/"
