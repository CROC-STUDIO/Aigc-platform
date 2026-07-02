import assert from "node:assert/strict";
import test from "node:test";

import { isGenerationTaskSubmitReady } from "../../server/wangzhuan/pipeline.mjs";

function task(overrides = {}) {
  return {
    generationTaskId: overrides.generationTaskId || `gen_${overrides.branchVariantIndex || 1}_${overrides.segmentIndex || 1}`,
    branchId: overrides.branchId || "branch_a",
    branchVariantIndex: overrides.branchVariantIndex || 1,
    segmentIndex: overrides.segmentIndex || 1,
    status: overrides.status || "pending",
    outputPath: overrides.outputPath || "",
    ...overrides
  };
}

test("30s generation only submits second segment after previous segment is downloaded", () => {
  const firstSegment = task({
    generationTaskId: "gen_first",
    segmentIndex: 1,
    status: "waiting_upstream"
  });
  const secondSegment = task({
    generationTaskId: "gen_second",
    segmentIndex: 2,
    status: "pending"
  });
  const batch = {
    estimate: { durationSec: 30 },
    tasks: [firstSegment, secondSegment]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, firstSegment), false);
  assert.equal(isGenerationTaskSubmitReady(batch, secondSegment), false);

  const downloadedBatch = {
    ...batch,
    tasks: [
      { ...firstSegment, status: "downloaded", outputPath: "批处理记录/segments/gen_first.mp4" },
      secondSegment
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(downloadedBatch, secondSegment), false);

  const reviewedBatch = {
    ...downloadedBatch,
    tasks: [
      downloadedBatch.tasks[0],
      {
        ...secondSegment,
        continuityReference: {
          storedPath: "批处理记录/continuity/gen_first_last_frame.jpg",
          review: { assetId: "asset_tail_frame", status: "approved" }
        }
      }
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(reviewedBatch, reviewedBatch.tasks[1]), true);
});

test("30s generation keeps first segments for different variants independently submit-ready", () => {
  const batch = {
    estimate: { durationSec: 30 },
    tasks: [
      task({ generationTaskId: "gen_a_1", branchVariantIndex: 1, segmentIndex: 1 }),
      task({ generationTaskId: "gen_a_2", branchVariantIndex: 1, segmentIndex: 2 }),
      task({ generationTaskId: "gen_b_1", branchVariantIndex: 2, segmentIndex: 1 }),
      task({ generationTaskId: "gen_b_2", branchVariantIndex: 2, segmentIndex: 2 })
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[0]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[1]), false);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[2]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[3]), false);
});

test("15s generation preserves existing pending task submit behavior", () => {
  const pending = task({ segmentIndex: 1, status: "pending" });
  const batch = {
    estimate: { durationSec: 15 },
    tasks: [pending]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, pending), true);
});
