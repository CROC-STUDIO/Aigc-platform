#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$ROOT/.release/aigc-platform-${STAMP}-release.tar.gz"
LATEST="$ROOT/.release/aigc-platform-release.tar.gz"

mkdir -p "$ROOT/.release"
rm -f "$LATEST" "$OUT"

TMP_TAR="$(mktemp /tmp/aigc-platform-pack.XXXXXX.tar.gz)"
tar -czf "$TMP_TAR" \
  --exclude='./node_modules' \
  --exclude='./mysql-data' \
  --exclude='./project-data' \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./env.export.txt' \
  --exclude='./users.json' \
  --exclude='./config.json' \
  --exclude='./.release/aigc-platform-*-release.tar.gz' \
  --exclude='./.release/aigc-platform-release.tar.gz' \
  --exclude='./.understand-anything' \
  --exclude='./*.log' \
  -C "$ROOT" .

cp -f "$TMP_TAR" "$OUT"
cp -f "$TMP_TAR" "$LATEST"
rm -f "$TMP_TAR"
ls -lh "$OUT" "$LATEST"
tar -tzf "$LATEST" | head -20

echo
echo "Next upload (Git Bash):"
echo "  bash .release/upload-release.sh"
