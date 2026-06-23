import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadEnvFile, loadRuntimeConfig, parseEnvFileContent } from "../server/runtime-config.mjs";

test("env file parser supports comments, export syntax, and quoted values", () => {
  const parsed = parseEnvFileContent(`
    # local credentials
    AWS_REGION=ap-southeast-1
    export S3_BUCKET=harpoons3
    S3_ENDPOINT="https://s3.ap-southeast-1.amazonaws.com"
    INVALID-KEY=ignored
    EMPTY=
  `);

  assert.equal(parsed.AWS_REGION, "ap-southeast-1");
  assert.equal(parsed.S3_BUCKET, "harpoons3");
  assert.equal(parsed.S3_ENDPOINT, "https://s3.ap-southeast-1.amazonaws.com");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["INVALID-KEY"], undefined);
});

test("env file loading preserves existing process values by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-env-file-"));
  try {
    const envPath = join(root, ".env");
    await writeFile(envPath, [
      "S3_BUCKET=from-file",
      "AWS_REGION=ap-southeast-1"
    ].join("\n"), "utf8");
    const env = { S3_BUCKET: "from-shell" };

    assert.equal(loadEnvFile({ envPath, env }), true);
    assert.equal(env.S3_BUCKET, "from-shell");
    assert.equal(env.AWS_REGION, "ap-southeast-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config falls back to default config when the runtime file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-config-default-"));
  try {
    const defaultPath = join(root, "config.default.json");
    const runtimePath = join(root, "missing", "config.json");
    await writeFile(defaultPath, JSON.stringify({
      wangzhuan: {
        capabilities: {
          remix: {
            provider: "video_aigc",
            status: "supported",
            supportedOperations: ["watermark_cover"]
          }
        },
        remixProvider: {
          provider: "video_aigc",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          apiKeyEnv: "VIDEO_AIGC_API_KEY"
        }
      }
    }), "utf8");

    const loaded = await loadRuntimeConfig({ runtimePath, defaultPath });

    assert.equal(loaded.runtimeConfigExists, false);
    assert.equal(loaded.config.wangzhuan.capabilities.remix.provider, "video_aigc");
    assert.equal(loaded.config.wangzhuan.capabilities.remix.status, "supported");
    assert.equal(loaded.config.wangzhuan.remixProvider.endpoint, "https://video-aigc.skylink-gateway.com/api/v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config overrides defaults without dropping nested capability defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-config-merge-"));
  try {
    const defaultPath = join(root, "config.default.json");
    const runtimePath = join(root, "config.json");
    await writeFile(defaultPath, JSON.stringify({
      wangzhuan: {
        capabilities: {
          remix: {
            provider: "video_aigc",
            status: "supported",
            supportedOperations: ["watermark_cover", "logo_icon_cover_or_replace"]
          }
        },
        remixProvider: {
          provider: "video_aigc",
          endpoint: "https://default.example/api/v1",
          apiKeyEnv: "VIDEO_AIGC_API_KEY",
          timeoutMs: 30000
        }
      }
    }), "utf8");
    await writeFile(runtimePath, JSON.stringify({
      projectRoot: "C:/local/project",
      wangzhuan: {
        remixProvider: {
          endpoint: "https://runtime.example/api/v1",
          timeoutMs: 1000
        }
      }
    }), "utf8");

    const loaded = await loadRuntimeConfig({ runtimePath, defaultPath });

    assert.equal(loaded.runtimeConfigExists, true);
    assert.equal(loaded.config.projectRoot, "C:/local/project");
    assert.equal(loaded.config.wangzhuan.capabilities.remix.status, "supported");
    assert.deepEqual(loaded.config.wangzhuan.capabilities.remix.supportedOperations, [
      "watermark_cover",
      "logo_icon_cover_or_replace"
    ]);
    assert.equal(loaded.config.wangzhuan.remixProvider.endpoint, "https://runtime.example/api/v1");
    assert.equal(loaded.config.wangzhuan.remixProvider.apiKeyEnv, "VIDEO_AIGC_API_KEY");
    assert.equal(loaded.config.wangzhuan.remixProvider.timeoutMs, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime project paths can be stored as config-relative values", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-config-relative-"));
  try {
    const defaultPath = join(root, "config.default.json");
    const runtimePath = join(root, "app", "config.json");
    await writeFile(defaultPath, JSON.stringify({}), "utf8");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(runtimePath, JSON.stringify({
      projectRoot: "../project-data/PROJECT_ROOT_P",
      projects: [
        { name: "default", path: "../project-data/PROJECT_ROOT_P" }
      ]
    }), "utf8");

    const loaded = await loadRuntimeConfig({ runtimePath, defaultPath });

    assert.equal(loaded.config.projectRoot, "../project-data/PROJECT_ROOT_P");
    assert.deepEqual(loaded.config.projects, [
      { name: "default", path: "../project-data/PROJECT_ROOT_P" }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
