import assert from "node:assert/strict";
import test from "node:test";

import { runUpstreamPollJob } from "../../server/wangzhuan/scheduler.mjs";

test("runUpstreamPollJob runs QC when upstream polling reaches qc without another poll", async () => {
  const calls = [];
  const context = { userId: "u1" };
  const job = {
    jobType: "upstream_poll",
    runUid: "wzb_20260629010101_abcd",
    payload: { batchId: "wzb_20260629010101_abcd" }
  };
  const deps = {
    pollUpstreamBatch: async (_context, batchId) => {
      calls.push(["poll", batchId]);
      return { batch: { batchId, status: "qc" }, needsPoll: false, polledCount: 1 };
    },
    runBatchQc: async (_context, batchId) => {
      calls.push(["qc", batchId]);
      return { batch: { batchId, status: "succeeded" }, reports: [{ qcStatus: "pass" }] };
    }
  };

  const result = await runUpstreamPollJob(context, job, deps);

  assert.deepEqual(calls.map((item) => item[0]), ["poll", "qc"]);
  assert.equal(result.batch.status, "succeeded");
  assert.equal(result.qc.reports[0].qcStatus, "pass");
});
