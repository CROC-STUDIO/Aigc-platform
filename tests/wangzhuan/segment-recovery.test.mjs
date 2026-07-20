import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRetryEligibility,
  classifyStitchSelection,
  currentSegmentOutput,
  enrichSegmentRecovery,
  groupRecoveryTasks,
  recoveryGroupKey
} from "../../server/wangzhuan/segment-recovery.mjs";

function buildBatch() {
  const tasks = [];
  const outputs = [];
  for (let variantIndex = 1; variantIndex <= 3; variantIndex += 1) {
    for (let segmentIndex = 1; segmentIndex <= 3; segmentIndex += 1) {
      const ordinal = ((variantIndex - 1) * 3) + segmentIndex;
      const generationTaskId = `gen_be06_${String(ordinal).padStart(3, "0")}`;
      tasks.push({
        generationTaskId,
        scriptId: `scr_be06_${String(ordinal).padStart(3, "0")}`,
        branchId: "branch_1",
        branchLabel: "默认分支",
        branchVariantIndex: variantIndex,
        segmentIndex,
        status: "downloaded",
        attempts: 1,
        maxAttempts: 2
      });
      outputs.push({
        outputId: `out_${String(ordinal).padStart(3, "0")}`,
        kind: "segment_video",
        generationTaskIds: [generationTaskId],
        filePath: `segments/${generationTaskId}.mp4`,
        createdAt: `2026-07-17T05:${String(ordinal).padStart(2, "0")}:00.000Z`
      });
    }
  }
  return {
    batchId: "wzb_20260717051112_be06",
    status: "partial_failed",
    tasks,
    outputs
  };
}

test("recoveryGroupKey uses branch and branch variant", () => {
  assert.equal(recoveryGroupKey({ branchId: "branch_1", branchVariantIndex: 3 }), "branch_1:3");
  assert.equal(recoveryGroupKey({ variantIndex: 2 }), "default:2");
});

test("asset review failures require repair instead of retry", () => {
  assert.deepEqual(classifyRetryEligibility({
    status: "failed",
    attempts: 0,
    maxAttempts: 2,
    errorCode: "asset_review_pending"
  }), {
    status: "repair_required",
    canRetry: false,
    reason: "asset_review_pending"
  });
});

test("explicit retryable provider failure can retry before attempt limit", () => {
  assert.deepEqual(classifyRetryEligibility({
    status: "failed",
    attempts: 1,
    maxAttempts: 2,
    errorCode: "upstream_failed",
    responseSummary: { retryable: true }
  }), {
    status: "retryable",
    canRetry: true,
    reason: "upstream_failed"
  });
});

test("failed task at its attempt limit is exhausted", () => {
  assert.equal(classifyRetryEligibility({
    status: "failed",
    attempts: 2,
    maxAttempts: 2,
    errorCode: "upstream_failed",
    responseSummary: { retryable: true }
  }).status, "retry_exhausted");
});

test("active task is running and an unclassified failure is unavailable", () => {
  assert.equal(classifyRetryEligibility({ status: "waiting_upstream" }).status, "running");
  assert.equal(classifyRetryEligibility({
    status: "failed",
    attempts: 1,
    maxAttempts: 2,
    errorCode: "validation_error"
  }).status, "unavailable");
});

test("current output makes a segment ready and newest replacement wins", () => {
  const task = {
    generationTaskId: "gen_be06_001",
    status: "failed",
    errorCode: "asset_review_pending"
  };
  const batch = {
    tasks: [task],
    outputs: [
      {
        outputId: "out_original",
        kind: "segment_video",
        generationTaskIds: [task.generationTaskId],
        createdAt: "2026-07-17T05:10:00.000Z"
      },
      {
        outputId: "out_replacement",
        kind: "segment_video",
        generationTaskIds: [task.generationTaskId],
        fulfillmentSource: "user_replacement",
        createdAt: "2026-07-17T05:20:00.000Z"
      }
    ]
  };

  assert.equal(currentSegmentOutput(batch, task).outputId, "out_replacement");
  assert.equal(classifyRetryEligibility(task, currentSegmentOutput(batch, task)).status, "replacement_ready");
});

test("be06 tasks group into three ordered variants with ordered segments", () => {
  const batch = buildBatch();
  batch.tasks.reverse();

  const groups = groupRecoveryTasks(batch);

  assert.deepEqual(groups.map((group) => [group.key, group.tasks.length]), [
    ["branch_1:1", 3],
    ["branch_1:2", 3],
    ["branch_1:3", 3]
  ]);
  assert.deepEqual(groups[0].tasks.map((task) => task.segmentIndex), [1, 2, 3]);
});

test("enrichSegmentRecovery adds attempts, current output and availability without mutation", () => {
  const batch = buildBatch();
  const sourceTask = batch.tasks[0];
  const attemptHistory = [{ attemptNo: 1, status: "succeeded" }];

  const enriched = enrichSegmentRecovery(batch, new Map([[sourceTask.generationTaskId, attemptHistory]]));

  assert.notEqual(enriched, batch);
  assert.notEqual(enriched.tasks[0], sourceTask);
  assert.equal(sourceTask.attemptHistory, undefined);
  assert.deepEqual(enriched.tasks[0].attemptHistory, attemptHistory);
  assert.equal(enriched.tasks[0].currentOutput.outputId, "out_001");
  assert.equal(enriched.tasks[0].retryEligibility.status, "ready");
  assert.equal(enriched.tasks[0].availability, "ready");
  assert.equal(enriched.tasks[0].recoveryGroupKey, "branch_1:1");
});

test("stitch selection preserves order and classifies complete, partial and mixed", () => {
  const batch = buildBatch();

  const complete = classifyStitchSelection(batch, ["out_003", "out_001", "out_002"]);
  assert.equal(complete.kind, "complete");
  assert.deepEqual(complete.sourceGroups, ["branch_1:1"]);
  assert.deepEqual(complete.outputs.map((output) => output.outputId), ["out_003", "out_001", "out_002"]);

  const partial = classifyStitchSelection(batch, ["out_001", "out_003"]);
  assert.equal(partial.kind, "partial");
  assert.deepEqual(partial.sourceGroups, ["branch_1:1"]);

  const mixed = classifyStitchSelection(batch, ["out_001", "out_004"]);
  assert.equal(mixed.kind, "mixed");
  assert.deepEqual(mixed.sourceGroups, ["branch_1:1", "branch_1:2"]);
});

test("stitch selection ignores missing and duplicate output ids", () => {
  const result = classifyStitchSelection(buildBatch(), ["out_001", "out_missing", "out_001"]);

  assert.equal(result.kind, "partial");
  assert.deepEqual(result.outputs.map((output) => output.outputId), ["out_001"]);
});

test("recovery marks descendants waiting or stale against the current predecessor version", () => {
  const batch = buildBatch();
  const parent = batch.tasks[0];
  const child = batch.tasks[1];
  parent.continuityGroupId = "cg_story";
  parent.continuitySliceId = "cg_story_slice_1";
  parent.attempts = 2;
  parent.currentOutputId = "out_001";
  child.continuityGroupId = "cg_story";
  child.continuitySliceId = "cg_story_slice_2";
  child.previousSliceId = "cg_story_slice_1";
  child.continuityReferenceNeeded = true;
  child.attemptHistory = [{
    attemptNo: 1,
    status: "succeeded",
    continuityParent: {
      generationTaskId: parent.generationTaskId,
      continuitySliceId: parent.continuitySliceId,
      attemptNo: 1,
      outputId: "out_parent_old",
      outputPath: "segments/parent-old.mp4"
    }
  }];

  const stale = enrichSegmentRecovery(batch);
  assert.equal(stale.tasks[1].availability, "continuity_stale");
  assert.equal(stale.tasks[1].retryEligibility.canRetry, true);
  assert.equal(stale.tasks[1].continuityState.parentAttemptNo, 2);
  assert.equal(stale.tasks[1].continuityState.recordedParentAttemptNo, 1);

  const waitingBatch = structuredClone(batch);
  waitingBatch.outputs = waitingBatch.outputs.filter((output) => output.outputId !== "out_001");
  waitingBatch.tasks[0].currentOutputId = "";
  waitingBatch.tasks[0].status = "failed";
  waitingBatch.tasks[1].attemptHistory = [];
  const waiting = enrichSegmentRecovery(waitingBatch);
  assert.equal(waiting.tasks[1].availability, "waiting_predecessor");
});

test("stitch selection rejects stale lineage and reversed continuity order", () => {
  const batch = buildBatch();
  const parent = batch.tasks[0];
  const child = batch.tasks[1];
  parent.continuityGroupId = "cg_story";
  parent.continuitySliceId = "cg_story_slice_1";
  parent.attempts = 2;
  child.continuityGroupId = "cg_story";
  child.continuitySliceId = "cg_story_slice_2";
  child.previousSliceId = "cg_story_slice_1";
  child.requestSummary = {
    continuityParent: {
      generationTaskId: parent.generationTaskId,
      continuitySliceId: parent.continuitySliceId,
      attemptNo: 1,
      outputId: "out_parent_old"
    }
  };

  const stale = classifyStitchSelection(batch, ["out_001", "out_002"]);
  assert.equal(stale.continuityCompatible, false);
  assert.equal(stale.continuityErrors[0].code, "continuity_parent_stale");

  child.requestSummary.continuityParent.attemptNo = 2;
  child.requestSummary.continuityParent.outputId = "out_001";
  const reversed = classifyStitchSelection(batch, ["out_002", "out_001"]);
  assert.equal(reversed.continuityCompatible, false);
  assert.equal(reversed.continuityErrors[0].code, "continuity_order_invalid");

  const compatible = classifyStitchSelection(batch, ["out_001", "out_002"]);
  assert.equal(compatible.continuityCompatible, true);
});
