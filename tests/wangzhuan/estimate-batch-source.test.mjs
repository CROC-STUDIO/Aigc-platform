import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "public", "wangzhuan.js"), "utf8");

test("estimateBatch does not read estimate data before the estimate API response", () => {
  const fnStart = source.indexOf("async function estimateBatch()");
  assert.ok(fnStart >= 0, "estimateBatch should exist");

  const fnSource = source.slice(fnStart, source.indexOf("\nasync function loadBatchDetail", fnStart));
  const estimateApiIndex = fnSource.indexOf('const data = await apiEnvelope("/api/wangzhuan/batches/estimate"');
  assert.ok(estimateApiIndex >= 0, "estimate API call should exist");

  const preEstimate = fnSource.slice(0, estimateApiIndex);
  assert.equal(
    preEstimate.includes("estimate: data.estimate"),
    false,
    "saveDraftBatch must not reference data.estimate before estimate API returns"
  );
});
