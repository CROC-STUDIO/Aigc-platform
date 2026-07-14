import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  switchProjectScope,
  workbenchFocusHash,
  workbenchHref
} from "../../public/wangzhuan-common.js";

const root = new URL("../../", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

test("workbenchHref carries batch restore params and focus hash", () => {
  assert.equal(
    workbenchHref("batch", "preview_required", "wzb_20260626010101_abcd"),
    "/wangzhuan-v2.html?restore=1&batchId=wzb_20260626010101_abcd#wzNodeBatch"
  );
  assert.equal(
    workbenchHref("batch", "running", "wzb_20260626010101_abcd"),
    "/wangzhuan-v2.html?restore=1&batchId=wzb_20260626010101_abcd#wzNodeLog"
  );
  assert.equal(
    workbenchHref("batch", "running", "wzb_20260626010101_abcd", {
      jobType: "plan",
      jobId: "planjob_1",
      projectKey: "abc123"
    }),
    "/wangzhuan-v2.html?restore=1&batchId=wzb_20260626010101_abcd&projectKey=abc123&jobType=plan&jobId=planjob_1#wzNodeLog"
  );
});

test("workbenchHref carries remix restore params", () => {
  assert.equal(
    workbenchHref("remix", "preview_required", "wzr_20260626010101_abcd"),
    "/competitor-remix.html?restore=1&remixId=wzr_20260626010101_abcd#remixNodeDelivery"
  );
});

test("switchProjectScope accepts the legacy project switch response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/api/projects/switch");
    assert.deepEqual(JSON.parse(options.body), { projectKey: "abc123" });
    return new Response(JSON.stringify({ ok: true, baseProjectRoot: "/data/project-data/cwz" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const result = await switchProjectScope("abc123");
    assert.equal(result.baseProjectRoot, "/data/project-data/cwz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("workbenchHref without id keeps legacy hash-only links", () => {
  assert.equal(workbenchHref("batch", "preview_required"), "/wangzhuan-v2.html#wzNodeBatch");
  assert.equal(workbenchHref("remix"), "/competitor-remix.html#remixNodeDelivery");
});

test("workbenchFocusHash maps pipeline status to step anchor", () => {
  assert.equal(workbenchFocusHash("batch", "preview_required"), "#wzNodeBatch");
  assert.equal(workbenchFocusHash("batch", "qc"), "#wzNodeLog");
});

test("tasks page polling only refreshes selected detail in place", async () => {
  const js = await readText("public/wangzhuan-tasks.js");
  assert.match(js, /function shouldPollPage\(\)\s*\{\s*return shouldPollDetail\(state\.detail\);\s*\}/);
  assert.match(js, /await loadSelectedDetail\(\{\s*silent:\s*true\s*\}\)/);
  assert.doesNotMatch(js, /hasActiveTasksOnPage\(\) \|\| shouldPollDetail/);
});

test("tasks page exposes recoverable background job notices", async () => {
  const js = await readText("public/wangzhuan-tasks.js");
  assert.match(js, /function renderBackgroundJobNotice/);
  assert.match(js, /job\.error\?\.recoverable/);
  assert.match(js, /重试查询拆解结果/);
  assert.match(js, /重试查询预案结果/);
  assert.match(js, /latestPlanJob/);
  assert.match(js, /latestDecompositionJob/);
  assert.match(js, /jobType: job\.type === "seedance_plan" \? "plan" : job\.type/);
  assert.match(js, /jobId: job\.id/);
});
