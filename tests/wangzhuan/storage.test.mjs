import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendJsonl,
  readJsonOrDefault,
  repairJsonlTail,
  wangzhuanPaths,
  writeAtomicJson
} from "../../server/wangzhuan/storage.mjs";

test("builds shared and user wangzhuan storage paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-storage-"));
  try {
    const paths = wangzhuanPaths({ sharedProjectRoot: join(root, "shared"), userProjectRoot: join(root, "user") });
    assert.equal(paths.sharedRoot, join(root, "shared", "批处理记录", "网赚管线"));
    assert.equal(paths.userRoot, join(root, "user", "批处理记录", "网赚管线"));
    assert.equal(paths.referenceVideosDir, join(root, "user", "批处理记录", "网赚管线", "reference-videos"));
    assert.equal(paths.batchesDir, join(root, "user", "批处理记录", "网赚管线", "batches"));
    assert.equal(Object.hasOwn(paths, "templatesPath"), false);
    assert.equal(Object.hasOwn(paths, "channelRulesPath"), false);
    assert.equal(Object.hasOwn(paths, "auditPath"), false);
    assert.equal(Object.hasOwn(paths, "telemetryPath"), false);
    assert.equal(Object.hasOwn(paths, "idempotencyDir"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes JSON atomically and reads defaults for missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-json-"));
  try {
    const target = join(root, "nested", "data.json");
    assert.deepEqual(await readJsonOrDefault(target, { empty: true }), { empty: true });
    await writeAtomicJson(target, { ok: true, values: [1, 2, 3] });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { ok: true, values: [1, 2, 3] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairs a JSONL file by truncating a corrupt tail line", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-jsonl-"));
  try {
    const target = join(root, "audit.jsonl");
    await appendJsonl(target, { id: 1 });
    await appendJsonl(target, { id: 2 });
    await import("node:fs/promises").then(({ appendFile }) => appendFile(target, "{broken", "utf8"));

    const result = await repairJsonlTail(target);
    assert.equal(result.removedLines, 1);
    const lines = (await readFile(target, "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line).id), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
