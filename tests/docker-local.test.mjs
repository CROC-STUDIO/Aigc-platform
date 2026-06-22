import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local Docker image installs ffprobe and runs as non-root", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /FROM node:22\.11\.0-bookworm-slim/);
  assert.match(dockerfile, /apt-get install[\s\S]*ffmpeg/);
  assert.match(dockerfile, /mkdir -p \/data\/state \/data\/project-data/);
  assert.match(dockerfile, /chown -R node:node \/data/);
  assert.match(dockerfile, /COPY --chown=node:node package\*\.json \.\//);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /CMD \["node", "server\.mjs"\]/);
});

test("local compose starts MySQL and keeps runtime config out of the image", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  const schedulerRulesMigration = await readFile(new URL("../database/migrations/0003_scheduler_state_machine_rules.sql", import.meta.url), "utf8");

  assert.match(compose, /mysql:\s*\n\s*image: mysql:8\.4\.6/);
  assert.match(compose, /MYSQL_DATABASE:\s*\$\{AIGC_MYSQL_DATABASE:-aigc_platform\}/);
  assert.match(compose, /MYSQL_USER:\s*\$\{AIGC_MYSQL_USER:-aigc_app\}/);
  assert.match(compose, /aigc_mysql_data:\/var\/lib\/mysql/);
  assert.match(compose, /\.\/database\/migrations:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /AIGC_DB_HOST:\s*mysql/);
  assert.match(compose, /AIGC_DB_NAME:\s*\$\{AIGC_MYSQL_DATABASE:-aigc_platform\}/);
  assert.match(compose, /AIGC_DB_USER:\s*\$\{AIGC_MYSQL_USER:-aigc_app\}/);
  assert.match(compose, /AIGC_DB_PASSWORD:\s*\$\{AIGC_MYSQL_PASSWORD:-aigc_app_dev_only\}/);
  assert.match(compose, /\$\{AIGC_HOST_PORT:-5182\}:5182/);
  assert.match(compose, /AIGC_PROJECT_ROOT:\s*\/data\/project-data\/PROJECT_ROOT_P/);
  assert.match(compose, /AIGC_CONFIG_PATH:\s*\/data\/state\/config\.json/);
  assert.match(compose, /AIGC_USERS_PATH:\s*\/data\/state\/users\.json/);
  assert.match(compose, /VIDEO_AIGC_API_KEY:\s*\$\{VIDEO_AIGC_API_KEY:-\}/);
  assert.match(compose, /WANGZHUAN_SEEDANCE_ENDPOINT:\s*\$\{WANGZHUAN_SEEDANCE_ENDPOINT:-https:\/\/skylink-gateway\.com\/api\/v1\}/);
  assert.match(compose, /WANGZHUAN_SEEDANCE_MODEL:\s*\$\{WANGZHUAN_SEEDANCE_MODEL:-dreamina-seedance-2-0-260128\}/);
  assert.match(compose, /WANGZHUAN_LLM_API_KEY:\s*\$\{WANGZHUAN_LLM_API_KEY:-\}/);
  assert.match(compose, /\.\.\/project-data:\/data\/project-data/);
  assert.match(compose, /aigc_state:\/data\/state/);

  assert.match(dockerignore, /^users\.json$/m);
  assert.match(dockerignore, /^config\.json$/m);
  assert.doesNotMatch(dockerignore, /^config\.default\.json$/m);
  assert.match(dockerignore, /^project-data$/m);
  assert.match(dockerignore, /^\.git$/m);
  assert.match(schedulerRulesMigration, /scheduler_retry/);
  assert.match(schedulerRulesMigration, /app_schema_migrations[\s\S]*0003/);
});
