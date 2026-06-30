import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
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
});

test("workbenchHref carries remix restore params", () => {
  assert.equal(
    workbenchHref("remix", "preview_required", "wzr_20260626010101_abcd"),
    "/competitor-remix.html?restore=1&remixId=wzr_20260626010101_abcd#remixNodeDelivery"
  );
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
