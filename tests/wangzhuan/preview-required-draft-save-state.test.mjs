import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("state transition rules allow preview_required draft save without changing run status", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /\["workflow_run", "preview_required", "preview_required", "batch_draft_saved", null, 0\]/
  );
});

test("batch detail lookup is scoped by project_id before run_uid", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function loadBatchRunRow");
  const end = source.indexOf("function referenceSnapshotFromRunRow", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(body, /WHERE wr\.run_type = 'pipeline'\s+AND wr\.project_id = \?\s+AND wr\.run_uid = \?/s);
});
