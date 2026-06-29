import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_SUBMIT_MODE,
  buildAutoSubmitIdempotencyKey,
  runAutoSubmitPipeline
} from "../../server/wangzhuan/auto-submit.mjs";

test("runAutoSubmitPipeline automatically plans, confirms, submits, polls and runs QC", async () => {
  const calls = [];
  const context = { userId: "u1" };
  const request = {
    idempotencyKey: "idem_submit_001",
    referenceVideoId: "ref_20260629_001",
    variantCount: 2
  };
  const deps = {
    estimateBatch: async (_context, payload) => {
      calls.push(["estimate", payload.idempotencyKey]);
      return { estimate: { estimateId: "est_20260629_001", confirmationRequired: false } };
    },
    prepareBatchPlanFromEstimate: async (_context, payload) => {
      calls.push(["plan", payload.idempotencyKey, payload.estimateId]);
      return {
        batch: { batchId: "wzb_20260629010101_abcd", status: "preview_required" },
        plans: [{ planId: "plan_1" }, { planId: "plan_2" }]
      };
    },
    confirmBatchPlan: async (_context, batchId, payload) => {
      calls.push(["confirm", payload.idempotencyKey, batchId, payload.confirmedPlanIds]);
      return { batch: { batchId, status: "queued" } };
    },
    submitPendingGenerationTasks: async (_context, batchId) => {
      calls.push(["submit", batchId]);
      return { batch: { batchId, status: "running" }, submittedCount: 2 };
    },
    pollUpstreamBatch: async (_context, batchId) => {
      calls.push(["poll", batchId]);
      return { batch: { batchId, status: "qc" }, needsPoll: false };
    },
    runBatchQc: async (_context, batchId) => {
      calls.push(["qc", batchId]);
      return { batch: { batchId, status: "succeeded" }, reports: [{ qcStatus: "pass" }] };
    }
  };

  const result = await runAutoSubmitPipeline(context, request, deps);

  assert.equal(result.mode, AUTO_SUBMIT_MODE.submitted);
  assert.equal(result.batch.status, "succeeded");
  assert.deepEqual(calls.map((item) => item[0]), ["estimate", "plan", "confirm", "submit", "poll", "qc"]);
  assert.deepEqual(calls[2][3], ["plan_1", "plan_2"]);
});

test("runAutoSubmitPipeline stops at confirmation_required before expensive planning", async () => {
  const calls = [];
  const result = await runAutoSubmitPipeline(
    {},
    { idempotencyKey: "idem_submit_002", variantCount: 99 },
    {
      estimateBatch: async () => {
        calls.push("estimate");
        return {
          estimate: {
            estimateId: "est_20260629_002",
            confirmationRequired: true,
            confirmationToken: "confirm_cost"
          }
        };
      },
      prepareBatchPlanFromEstimate: async () => {
        calls.push("plan");
        throw new Error("should not plan before user confirms limits");
      }
    }
  );

  assert.equal(result.mode, AUTO_SUBMIT_MODE.confirmationRequired);
  assert.equal(result.estimate.estimateId, "est_20260629_002");
  assert.deepEqual(calls, ["estimate"]);
});

test("buildAutoSubmitIdempotencyKey derives stable per-stage keys", () => {
  assert.equal(
    buildAutoSubmitIdempotencyKey("idem_submit_003", "plan"),
    buildAutoSubmitIdempotencyKey("idem_submit_003", "plan")
  );
  assert.notEqual(
    buildAutoSubmitIdempotencyKey("idem_submit_003", "plan"),
    buildAutoSubmitIdempotencyKey("idem_submit_003", "confirm")
  );
  assert.match(buildAutoSubmitIdempotencyKey("idem_submit_003", "confirm"), /^auto_confirm_/);
});
