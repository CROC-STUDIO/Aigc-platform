#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${ROOT_DIR}/.release"
TIMESTAMP="${1:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="ad-picture-web-codex-code-only-${TIMESTAMP}.tar.gz"
PACKAGE_PATH="${RELEASE_DIR}/${PACKAGE_NAME}"

mkdir -p "${RELEASE_DIR}"

echo "Project root: ${ROOT_DIR}"
echo "Output: ${PACKAGE_PATH}"

INCLUDE_PATHS=(
  "public"
  "server"
  "database"
  "scripts"
  "server.mjs"
  "package.json"
  "package-lock.json"
  "config.default.json"
  "README.md"
)

for item in "${INCLUDE_PATHS[@]}"; do
  if [[ ! -e "${ROOT_DIR}/${item}" ]]; then
    echo "Missing required package path: ${item}" >&2
    exit 1
  fi
done

echo "Including runtime paths:"
printf '  - %s\n' "${INCLUDE_PATHS[@]}"

tar --exclude='.DS_Store' \
    --exclude='._*' \
    -czf "${PACKAGE_PATH}" \
    -C "${ROOT_DIR}" \
    "${INCLUDE_PATHS[@]}"

echo "Created package: ${PACKAGE_PATH}"
echo "Upload example:"
printf "printf 'put %s /tmp/%s\\nbye\\n' | sftp -P \"2222\" -o IdentitiesOnly=yes -i \"\$HOME/.ssh/jumpserver_rsa\" -o User=\"liuxuan@dev@8.219.102.128\" \"jump.corp.touka.plus\"\n" \
  "${PACKAGE_PATH}" "${PACKAGE_NAME}"
