import assert from "node:assert/strict";
import test from "node:test";

import {
  findContinuitySourceTask,
  isGenerationTaskSubmitReady
} from "../../server/wangzhuan/pipeline.mjs";

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

test("30s three-slice request stays on legacy two-segment continuity gating", () => {
  const batch = {
    estimate: {
      durationSec: 30,
      request: { sliceStrategy: "three_slice" }
    },
    tasks: [
      task({ generationTaskId: "gen_three_1", segmentIndex: 1 }),
      task({ generationTaskId: "gen_three_2", segmentIndex: 2 }),
      task({ generationTaskId: "gen_three_3", segmentIndex: 3 })
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[0]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[1]), false);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[2]), false);
});

test("30s auto multi-slice request stays on legacy two-segment continuity gating", () => {
  const batch = {
    estimate: {
      durationSec: 30,
      request: { sliceStrategy: "auto_10_15s_multi_slice" }
    },
    tasks: [
      task({ generationTaskId: "gen_auto_1", segmentIndex: 1 }),
      task({ generationTaskId: "gen_auto_2", segmentIndex: 2 })
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[0]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[1]), false);
});

test("non-30s slices in different story segments do not use continuity gating", () => {
  const batch = {
    estimate: {
      durationSec: 36,
      request: { sliceStrategy: "three_slice" }
    },
    tasks: [
      task({ generationTaskId: "gen_36_1", segmentIndex: 1, storySegmentIndex: 1, seedanceSliceIndex: 1 }),
      task({ generationTaskId: "gen_36_2", segmentIndex: 2, storySegmentIndex: 2, seedanceSliceIndex: 1 }),
      task({ generationTaskId: "gen_36_3", segmentIndex: 3, storySegmentIndex: 3, seedanceSliceIndex: 1 })
    ]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[0]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[1]), true);
  assert.equal(isGenerationTaskSubmitReady(batch, batch.tasks[2]), true);
});

test("non-30s slices from same story segment require previous tail-frame continuity", () => {
  const firstSlice = task({
    generationTaskId: "gen_story_1",
    segmentIndex: 1,
    storySegmentIndex: 1,
    seedanceSliceIndex: 1,
    status: "downloaded",
    outputPath: "批处理记录/segments/gen_story_1.mp4"
  });
  const secondSlice = task({
    generationTaskId: "gen_story_2",
    segmentIndex: 2,
    storySegmentIndex: 1,
    seedanceSliceIndex: 2,
    status: "pending"
  });
  const batch = {
    estimate: {
      durationSec: 26,
      request: { sliceStrategy: "story_beat_split_8_15s" }
    },
    tasks: [firstSlice, secondSlice]
  };

  assert.equal(isGenerationTaskSubmitReady(batch, secondSlice), false);

  const reviewedSecondSlice = {
    ...secondSlice,
    continuityReference: {
      storedPath: "批处理记录/continuity/gen_story_1_last_frame.jpg",
      review: { assetId: "asset_tail_frame", status: "approved" }
    }
  };

  assert.equal(isGenerationTaskSubmitReady({
    ...batch,
    tasks: [firstSlice, reviewedSecondSlice]
  }, reviewedSecondSlice), true);
});

test("continuity groups follow previousSliceId across arbitrary story segments", () => {
  const first = task({
    generationTaskId: "gen_chain_1",
    segmentIndex: 1,
    storySegmentIndex: 1,
    seedanceSliceIndex: 1,
    continuityGroupId: "cg_story",
    continuitySliceId: "cg_story_slice_1",
    continuitySequence: 1,
    previousSliceId: "",
    continuityReferenceNeeded: false,
    status: "downloaded",
    outputPath: "segments/gen_chain_1.mp4",
    attempts: 2
  });
  const second = task({
    generationTaskId: "gen_chain_2",
    segmentIndex: 2,
    storySegmentIndex: 2,
    seedanceSliceIndex: 2,
    continuityGroupId: "cg_story",
    continuitySliceId: "cg_story_slice_2",
    continuitySequence: 2,
    previousSliceId: "cg_story_slice_1",
    continuityReferenceNeeded: true,
    continuityReference: {
      sourceGenerationTaskId: "gen_chain_1",
      sourceOutputPath: "segments/gen_chain_1.mp4",
      sourceAttempt: 2,
      review: { assetId: "asset_chain_1", status: "approved" }
    }
  });
  const third = task({
    generationTaskId: "gen_chain_3",
    segmentIndex: 3,
    storySegmentIndex: 3,
    seedanceSliceIndex: 3,
    continuityGroupId: "cg_story",
    continuitySliceId: "cg_story_slice_3",
    continuitySequence: 3,
    previousSliceId: "cg_story_slice_2",
    continuityReferenceNeeded: true
  });
  const independentGroupStart = task({
    generationTaskId: "gen_independent_1",
    segmentIndex: 4,
    storySegmentIndex: 4,
    seedanceSliceIndex: 4,
    continuityGroupId: "cg_proof",
    continuitySliceId: "cg_proof_slice_1",
    continuitySequence: 1,
    previousSliceId: "",
    continuityReferenceNeeded: false
  });
  const batch = {
    estimate: { durationSec: 42 },
    tasks: [first, second, third, independentGroupStart]
  };

  assert.equal(findContinuitySourceTask(batch.tasks, second), first);
  assert.equal(findContinuitySourceTask(batch.tasks, third), null);
  assert.equal(isGenerationTaskSubmitReady(batch, second), true);
  assert.equal(isGenerationTaskSubmitReady(batch, third), false);
  assert.equal(isGenerationTaskSubmitReady(batch, independentGroupStart), true);
});
