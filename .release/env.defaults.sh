# shellcheck shell=bash
# 生产发布默认连接信息。复制为 env.local.sh 并按需覆盖，勿提交 env.local.sh。
#
#   cp .release/env.defaults.sh .release/env.local.sh
#   source .release/env.local.sh

JMS_HOST="${JMS_HOST:-jump.corp.touka.plus}"
JMS_PORT="${JMS_PORT:-2222}"
JMS_KEY="${JMS_KEY:-$HOME/.ssh/jumpserver_rsa}"
JMS_LOGIN="${JMS_LOGIN:-liuxuan@dev@8.219.102.128}"

PROD_APP_ROOT="${PROD_APP_ROOT:-/opt/ad-picture-web-codex}"
PROD_HOST_PORT="${PROD_HOST_PORT:-5177}"
PROD_MYSQL_HOST_PORT="${PROD_MYSQL_HOST_PORT:-3307}"
