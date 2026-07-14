import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("expanded video workflow outputs are accepted by the MySQL constraint", async () => {
  const migration = await readFile(new URL("database/migrations/0016_expanded_video_output_kind.sql", root), "utf8");
  assert.match(migration, /ck_workflow_outputs_kind/);
  assert.match(migration, /'expanded_video'/);
});

test("stuck stitching batches can use the idempotent retry path", async () => {
  const stitch = await readFile(new URL("server/wangzhuan/stitch.mjs", root), "utf8");
  assert.match(stitch, /STITCH_READY_TASK_STATUSES = new Set\(\["downloaded", "succeeded", "qc"\]\)/);
  assert.match(stitch, /\["partial_failed", "stitching"\]\.includes\(batch\.status\)/);
  assert.match(stitch, /batch\.status === "qc" && hasPostProcessFailures/);
  assert.match(stitch, /status: "partial_failed" \}, "qc_partial_failed"/);
  assert.match(stitch, /stitchBatchSegments\(context, batchId, \{ replaceDerivedOutputs: true \}\)/);
  assert.match(stitch, /const stitchReports = options\.replaceDerivedOutputs\s+\? \[\]/);
  const mysqlFacts = await readFile(new URL("server/wangzhuan/mysql-facts.mjs", root), "utf8");
  assert.match(mysqlFacts, /batch\.replaceDerivedOutputs === true/);
  assert.match(mysqlFacts, /DELETE wo FROM workflow_outputs wo/);
  assert.match(mysqlFacts, /\? \{ postProcessFailures: batch\.postProcessFailures \}/);
  assert.match(mysqlFacts, /output\.subtitlePostProcess = probe\.subtitlePostProcess/);
});
