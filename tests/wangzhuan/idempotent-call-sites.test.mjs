import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = {
  estimates: await readFile(new URL("../../server/wangzhuan/estimates.mjs", import.meta.url), "utf8"),
  remix: await readFile(new URL("../../server/wangzhuan/remix.mjs", import.meta.url), "utf8"),
  stitch: await readFile(new URL("../../server/wangzhuan/stitch.mjs", import.meta.url), "utf8")
};

function exportedFunctionBody(source, functionName) {
  const marker = `export async function ${functionName}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${functionName} export is missing`);
  const nextExport = source.indexOf("\nexport ", start + marker.length);
  return source.slice(start, nextExport >= 0 ? nextExport : source.length);
}

const callSites = [
  ["estimates", "estimateBatch", "batches_estimate"],
  ["estimates", "startBatchFromEstimate", "batches_start"],
  ["estimates", "prepareBatchPlanFromEstimate", "batches_plan"],
  ["estimates", "prepareBatchPlanFromEstimateStream", "batches_plan"],
  ["remix", "startDirectMaskEdit", "remix_mask_edit_start"],
  ["remix", "startRemix", "remix_start"],
  ["remix", "confirmRemixPreview", "remix_preview_confirm"],
  ["stitch", "retryStitch", "retry_stitch"]
];

for (const [sourceName, functionName, endpoint] of callSites) {
  test(`${functionName} claims atomic idempotency before its side effects`, () => {
    const body = exportedFunctionBody(sources[sourceName], functionName);
    assert.match(
      body,
      new RegExp(`runIdempotentOperation\\(\\s*context,\\s*"${endpoint}"`),
      `${functionName} must execute through the atomic idempotency wrapper`
    );
  });

  test(`${functionName} rehydrates safe idempotency summaries from the facts store`, () => {
    const body = exportedFunctionBody(sources[sourceName], functionName);
    assert.match(body, /replayResponse\s*:/, `${functionName} must rebuild its full response from stable resource IDs`);
  });
}

test("batch estimate keeps idempotency optional", () => {
  const body = exportedFunctionBody(sources.estimates, "estimateBatch");
  assert.doesNotMatch(body, /idempotencyKey 必填/);
});

test("migrated call sites do not retain the read-then-record idempotency pattern", () => {
  for (const [sourceName, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /\bloadIdempotencyFactFromMysql\b/, `${sourceName} still reads idempotency before execution`);
    assert.doesNotMatch(source, /\brecordIdempotencyFact\b/, `${sourceName} still records idempotency after execution`);
  }
});

test("batch plan SSE keeps replay, completion, and error envelopes around the atomic wrapper", () => {
  const body = exportedFunctionBody(sources.estimates, "prepareBatchPlanFromEstimateStream");
  assert.match(body, /idempotency replay/);
  assert.match(body, /writeSseDone\(/);
  assert.match(body, /writeSseError\(/);
  assert.ok(body.indexOf("runIdempotentOperation") < body.indexOf("writeSseDone("));
});
