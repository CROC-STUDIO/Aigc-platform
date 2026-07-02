import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlanPreviewBatch,
  enrichPlanGenerationError
} from "../../server/wangzhuan/estimates.mjs";
import { WangzhuanError } from "../../server/wangzhuan/http.mjs";

test("buildPlanPreviewBatch creates empty preview_required draft batch", () => {
  const batch = buildPlanPreviewBatch(
    { userId: "u1", projectName: "demo_project" },
    {
      estimate: { estimateId: "est_1", variantCount: 2 },
      request: { batchName: "测试批次", targetChannel: "generic" },
      templateSnapshot: { draft: {} },
      referenceVideo: { referenceVideoId: "ref_20260626_001" },
      decomposition: { scene: "kitchen" }
    },
    { batchId: "wzb_20260626010101_abcd", createdAt: "2026-06-26T01:01:01.000Z" },
    [{ branchId: "branch_1", branchLabel: "改写 3.1" }]
  );

  assert.equal(batch.batchId, "wzb_20260626010101_abcd");
  assert.equal(batch.status, "preview_required");
  assert.equal(batch.previewType, "seedance_plan");
  assert.deepEqual(batch.plans, []);
  assert.deepEqual(batch.scripts, []);
  assert.equal(batch.userBatchName, "测试批次");
  assert.equal(batch.projectRoot, "demo_project");
  assert.equal(batch.request.branches.length, 1);
});

test("buildPlanPreviewBatch does not reuse terminal draft batch ids", () => {
  const batch = buildPlanPreviewBatch(
    { userId: "u1", projectName: "demo_project" },
    {
      estimate: { estimateId: "est_1", variantCount: 1 },
      request: { batchName: "重新生成预案", targetChannel: "generic" },
      templateSnapshot: { draft: {} },
      referenceVideo: { referenceVideoId: "ref_20260629_001" },
      decomposition: { scene: "street" }
    },
    {
      batchId: "wzb_20260629093333_0596",
      status: "stopped",
      createdAt: "2026-06-29T09:33:33.000Z"
    },
    [{ branchId: "branch_1", branchLabel: "改写 1" }]
  );

  assert.notEqual(batch.batchId, "wzb_20260629093333_0596");
  assert.equal(batch.status, "preview_required");
});

test("enrichPlanGenerationError attaches batchId to WangzhuanError data", () => {
  const error = enrichPlanGenerationError(
    new WangzhuanError("model_failed", "upstream failed", { upstreamMessage: "bad key" }),
    "wzb_20260626010101_abcd"
  );

  assert.equal(error.code, "model_failed");
  assert.equal(error.data.batchId, "wzb_20260626010101_abcd");
  assert.equal(error.data.upstreamMessage, "bad key");
});

test("enrichPlanGenerationError wraps unknown errors", () => {
  const error = enrichPlanGenerationError(new Error("boom"), "wzb_20260626010101_abcd");
  assert.equal(error.code, "internal_error");
  assert.equal(error.message, "boom");
  assert.equal(error.data.batchId, "wzb_20260626010101_abcd");
});

test("enrichPlanGenerationError leaves error unchanged without batchId", () => {
  const original = new WangzhuanError("validation_error", "bad input");
  assert.equal(enrichPlanGenerationError(original, null), original);
});
