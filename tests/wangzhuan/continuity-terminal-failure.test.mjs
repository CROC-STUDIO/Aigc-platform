import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pollUpstreamBatch } from "../../server/wangzhuan/upstream-poll.mjs";

function generationTask(generationTaskId, overrides = {}) {
  return {
    generationTaskId,
    branchId: "branch_a",
    branchVariantIndex: 1,
    segmentIndex: 1,
    status: "pending",
    ...overrides
  };
}

async function pollBatch(batch) {
  const root = await mkdtemp(join(tmpdir(), "wz-continuity-terminal-"));
  const state = { batch };
  let submissionCalls = 0;
  try {
    const result = await pollUpstreamBatch({
      userId: "tester",
      user: { username: "tester" },
      userProjectRoot: root,
      sharedProjectRoot: root,
      seedanceProviderClient: { provider: "seedance" },
      readBatchForTest: async () => state.batch,
      writeBatchForTest: async (next) => {
        state.batch = next;
        return next;
      },
      submitPendingGenerationTasksForTest: async () => {
        submissionCalls += 1;
        return { batch: state.batch, submittedCount: 0, failedSubmitCount: 0 };
      }
    }, batch.batchId);
    return { result, submissionCalls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("failed continuity predecessors settle dependent tasks instead of leaving them pending", async () => {
  const cases = [
    {
      name: "30 second continuity plan",
      batch: {
        batchId: "wzb_20260717010101_a001",
        status: "partial_failed",
        estimate: { durationSec: 30 },
        tasks: [
          generationTask("gen_30_source", {
            segmentIndex: 1,
            status: "failed",
            errorCode: "upstream_failed",
            errorMessage: "Seedance rejected the first segment"
          }),
          generationTask("gen_30_dependent", { segmentIndex: 2 }),
          generationTask("gen_30_other_variant", {
            branchVariantIndex: 2,
            segmentIndex: 1,
            status: "downloaded",
            outputPath: "segments/gen_30_other_variant.mp4"
          })
        ],
        outputs: [{
          outputId: "out_a001_001",
          kind: "stitched_video",
          generationTaskIds: ["gen_30_other_variant"]
        }]
      },
      dependentTaskId: "gen_30_dependent",
      sourceTaskId: "gen_30_source"
    },
    {
      name: "continuous story slice",
      batch: {
        batchId: "wzb_20260717010102_a002",
        status: "running",
        estimate: { durationSec: 24 },
        tasks: [
          generationTask("gen_story_source", {
            storySegmentIndex: 1,
            seedanceSliceIndex: 1,
            status: "failed",
            errorCode: "upstream_failed",
            errorMessage: "Seedance rejected the first slice"
          }),
          generationTask("gen_story_dependent", {
            segmentIndex: 2,
            storySegmentIndex: 1,
            seedanceSliceIndex: 2
          })
        ],
        outputs: []
      },
      dependentTaskId: "gen_story_dependent",
      sourceTaskId: "gen_story_source"
    }
  ];

  for (const entry of cases) {
    const { result, submissionCalls } = await pollBatch(entry.batch);
    const dependent = result.batch.tasks.find((task) => task.generationTaskId === entry.dependentTaskId);
    assert.equal(dependent.status, "failed", entry.name);
    assert.equal(dependent.errorCode, "continuity_reference_failed", entry.name);
    assert.match(dependent.errorMessage, new RegExp(entry.sourceTaskId), entry.name);
    assert.equal(result.batch.status, "partial_failed", entry.name);
    assert.equal(result.needsPoll, false, entry.name);
    assert.equal(submissionCalls, 0, entry.name);
  }
});
