import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildGenerationPlanRecord } from "../../server/wangzhuan/plan-preview.mjs";
import {
  adjustSlicePlanToTargetCount,
  buildSubtitlePostProcessArtifact,
  buildSlicePlan,
  planSegmentMultiplier,
  prepareBatchForPipeline
} from "../../server/wangzhuan/pipeline.mjs";

test("planSegmentMultiplier supports three-slice output template", () => {
  assert.equal(planSegmentMultiplier({
    estimate: {
      durationSec: 36,
      request: {
        sliceStrategy: "three_slice",
        outputTemplateMode: "three_slice_net_earning"
      }
    },
    templateSnapshot: {
      draft: {
        sliceStrategy: "three_slice",
        outputTemplateMode: "three_slice_net_earning"
      }
    }
  }), 3);
});

test("buildSlicePlan creates 10-15s slices for multi-slice strategy", () => {
  assert.deepEqual(buildSlicePlan({
    durationSec: 36,
    sliceStrategy: "three_slice"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 12, durationSec: 12, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 12, endSec: 24, durationSec: 12, segmentRole: "proof_slice" },
    { segmentIndex: 3, startSec: 24, endSec: 36, durationSec: 12, segmentRole: "withdrawal_slice" }
  ]);
});

test("buildSlicePlan resolves fixed, two-slice, and auto strategies", () => {
  assert.deepEqual(buildSlicePlan({
    durationSec: 15,
    sliceStrategy: "fixed_15s"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 15, durationSec: 15, segmentRole: "hook_slice" }
  ]);
  assert.deepEqual(buildSlicePlan({
    durationSec: 30,
    sliceStrategy: "two_15s"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 15, durationSec: 15, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 15, endSec: 30, durationSec: 15, segmentRole: "proof_slice" }
  ]);
  assert.deepEqual(buildSlicePlan({
    durationSec: 40,
    sliceStrategy: "auto_10_15s_multi_slice"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 13, durationSec: 13, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 13, endSec: 26, durationSec: 13, segmentRole: "proof_slice" },
    { segmentIndex: 3, startSec: 26, endSec: 40, durationSec: 14, segmentRole: "withdrawal_slice" }
  ]);
});

test("buildSlicePlan constrains 30s multi-slice requests to legacy two-segment plan", () => {
  assert.deepEqual(buildSlicePlan({
    durationSec: 30,
    sliceStrategy: "three_slice"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 15, durationSec: 15, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 15, endSec: 30, durationSec: 15, segmentRole: "proof_slice" }
  ]);
  assert.equal(planSegmentMultiplier({
    estimate: {
      durationSec: 30,
      request: { sliceStrategy: "auto_10_15s_multi_slice" }
    }
  }), 2);
});

function assertCoherentSlicePlan(plan, durationSec) {
  assert.ok(plan.length > 0);
  let cursor = 0;
  let totalDuration = 0;
  for (const [index, slice] of plan.entries()) {
    assert.equal(slice.segmentIndex, index + 1);
    assert.equal(slice.startSec, cursor);
    assert.equal(slice.durationSec, slice.endSec - slice.startSec);
    assert.ok(slice.durationSec > 0);
    totalDuration += slice.durationSec;
    cursor = slice.endSec;
  }
  assert.equal(cursor, durationSec);
  assert.equal(totalDuration, durationSec);
}

test("buildSlicePlan keeps uneven totals coherent", () => {
  const sixteenSecondAuto = buildSlicePlan({
    durationSec: 16,
    sliceStrategy: "auto_10_15s_multi_slice"
  });
  assertCoherentSlicePlan(sixteenSecondAuto, 16);
  assert.deepEqual(sixteenSecondAuto, [
    { segmentIndex: 1, startSec: 0, endSec: 16, durationSec: 16, segmentRole: "hook_slice" }
  ]);

  const twentySecondThreeSlice = buildSlicePlan({
    durationSec: 20,
    sliceStrategy: "three_slice"
  });
  assertCoherentSlicePlan(twentySecondThreeSlice, 20);
  assert.deepEqual(twentySecondThreeSlice, [
    { segmentIndex: 1, startSec: 0, endSec: 10, durationSec: 10, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 10, endSec: 20, durationSec: 10, segmentRole: "proof_slice" }
  ]);

  const twentyNineSecondThreeSlice = buildSlicePlan({
    durationSec: 29,
    sliceStrategy: "three_slice"
  });
  assertCoherentSlicePlan(twentyNineSecondThreeSlice, 29);
  assert.deepEqual(twentyNineSecondThreeSlice, [
    { segmentIndex: 1, startSec: 0, endSec: 14, durationSec: 14, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 14, endSec: 29, durationSec: 15, segmentRole: "proof_slice" }
  ]);
});

function testContext(root) {
  return {
    userId: "tester",
    user: { username: "tester" },
    userProjectRoot: root,
    sharedProjectRoot: root,
    config: {},
    writeBatchForTest: async (batch) => batch,
    getChannelRulesForTest: async () => ({ rules: [] })
  };
}

function testBatch({ durationSec, sliceStrategy }) {
  return {
    batchId: "wzb_20260707121212_abcd",
    userId: "tester",
    status: "draft",
    createdAt: "2026-07-07T12:12:12.000Z",
    estimate: {
      durationSec,
      variantCount: 1,
      outputRatio: "9:16",
      request: {
        sliceStrategy,
        targetChannel: "tiktok"
      }
    },
    templateSnapshot: {
      draft: {
        productName: "Drama Gold",
        language: "pt-BR",
        regions: ["BR"],
        sliceStrategy,
        branches: [{
          branchId: "branch_1",
          branchLabel: "BR workers",
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          targetChannels: ["tiktok"]
        }]
      }
    },
    decomposition: {
      action: "Show drama watching and reward feedback",
      rewardFeedback: "reward feedback",
      scene: "bus stop"
    }
  };
}

test("prepareBatchForPipeline behaviorally creates coherent 36s three-slice tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-multi-slice-"));
  const prepared = await prepareBatchForPipeline(testContext(root), testBatch({
    durationSec: 36,
    sliceStrategy: "three_slice"
  }));

  assert.equal(prepared.scripts.length, 3);
  assert.equal(prepared.tasks.length, 3);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [12, 12, 12]);
  assert.deepEqual(prepared.tasks.map((task) => task.durationSec), [12, 12, 12]);
  assert.deepEqual(prepared.scripts.map((script) => script.segmentRole), ["hook_slice", "proof_slice", "withdrawal_slice"]);
  assert.deepEqual(prepared.tasks.map((task) => task.segmentRole), ["hook_slice", "proof_slice", "withdrawal_slice"]);
  assert.deepEqual(prepared.scripts.map((script) => script.sliceDurationSec), [12, 12, 12]);
  assert.deepEqual(prepared.tasks.map((task) => task.sliceDurationSec), [12, 12, 12]);
});

test("prepareBatchForPipeline keeps 30s three-slice requests on two 15s tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-30s-legacy-"));
  const prepared = await prepareBatchForPipeline(testContext(root), testBatch({
    durationSec: 30,
    sliceStrategy: "three_slice"
  }));

  assert.equal(prepared.scripts.length, 2);
  assert.equal(prepared.tasks.length, 2);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [15, 15]);
  assert.deepEqual(prepared.tasks.map((task) => task.durationSec), [15, 15]);
  assert.deepEqual(prepared.scripts.map((script) => script.segmentRole), ["hook_slice", "proof_slice"]);
  assert.deepEqual(prepared.tasks.map((task) => task.segmentRole), ["hook_slice", "proof_slice"]);
});

test("prepareBatchForPipeline fallback prompt uses coherent 16s slice duration", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-16s-fallback-"));
  const prepared = await prepareBatchForPipeline(testContext(root), testBatch({
    durationSec: 16,
    sliceStrategy: "auto_10_15s_multi_slice"
  }));

  assert.equal(prepared.scripts.length, 1);
  assert.equal(prepared.tasks.length, 1);
  assert.equal(prepared.scripts[0].durationSec, 16);
  assert.equal(prepared.tasks[0].durationSec, 16);
  const prompt = await readFile(join(root, prepared.scripts[0].promptPath), "utf8");
  assert.match(prompt, /Task: create a 16 second 9:16 Seedance image-to-video prompt\./);
  assert.doesNotMatch(prompt, /Task: create a 15 second 9:16 Seedance image-to-video prompt\./);
});

test("prepareBatchForPipeline prefers decomposition seedanceSlices over mechanical slice plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-fission-slices-"));
  const batch = testBatch({ durationSec: 40, sliceStrategy: "auto_10_15s_multi_slice" });
  batch.decomposition = {
    ...batch.decomposition,
    seedanceSlices: [
      {
        segmentIndex: 1,
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 11,
        durationSec: 11,
        segmentRole: "hook_slice",
        scene: "room",
        subject: "creator",
        action: "hook",
        camera: "selfie",
        lighting: "warm",
        style: "UGC",
        quality: "clear"
      },
      {
        segmentIndex: 2,
        storySegmentIndex: 2,
        seedanceSliceIndex: 1,
        startSec: 11,
        endSec: 24,
        durationSec: 13,
        segmentRole: "proof_slice",
        scene: "cafe",
        subject: "worker",
        action: "proof",
        camera: "close-up",
        lighting: "daylight",
        style: "UGC",
        quality: "clear"
      }
    ]
  };

  const prepared = await prepareBatchForPipeline(testContext(root), batch);
  assert.equal(prepared.scripts.length, 2);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [11, 13]);
  assert.deepEqual(prepared.scripts.map((script) => script.storySegmentIndex), [1, 2]);
  assert.deepEqual(prepared.tasks.map((task) => task.sliceDurationSec), [11, 13]);
});

test("targetSegmentCount overrides decomposition slice count", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-target-segments-"));
  const batch = testBatch({ durationSec: 24, sliceStrategy: "auto_10_15s_multi_slice" });
  batch.estimate.request.targetSegmentCount = 1;
  batch.templateSnapshot.draft.targetSegmentCount = 1;
  batch.decomposition = {
    ...batch.decomposition,
    seedanceSlices: [
      {
        segmentIndex: 1,
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 11,
        durationSec: 11,
        segmentRole: "hook_slice",
        scene: "room",
        subject: "creator",
        action: "hook",
        camera: "selfie",
        lighting: "warm",
        style: "UGC",
        quality: "clear"
      },
      {
        segmentIndex: 2,
        storySegmentIndex: 2,
        seedanceSliceIndex: 1,
        startSec: 11,
        endSec: 24,
        durationSec: 13,
        segmentRole: "proof_slice",
        scene: "cafe",
        subject: "worker",
        action: "proof",
        camera: "close-up",
        lighting: "daylight",
        style: "UGC",
        quality: "clear"
      }
    ]
  };

  assert.equal(planSegmentMultiplier(batch), 1);
  const prepared = await prepareBatchForPipeline(testContext(root), batch);
  assert.equal(prepared.scripts.length, 1);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [24]);
  assert.equal(prepared.scripts[0].targetSegmentMerge, true);
});

test("adjustSlicePlanToTargetCount can split into selected segment count", () => {
  const adjusted = adjustSlicePlanToTargetCount([
    { segmentIndex: 1, startSec: 0, endSec: 26, durationSec: 26, segmentRole: "hook_slice" }
  ], 2);

  assert.deepEqual(adjusted.map((slice) => slice.durationSec), [13, 13]);
  assert.deepEqual(adjusted.map((slice) => slice.segmentIndex), [1, 2]);
  assert.equal(adjusted[0].targetSegmentSplit, true);
  assert.equal(adjusted[1].targetSegmentSplit, true);
});

test("prepareBatchForPipeline derives slices from storySegments when seedanceSlices are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-story-slices-"));
  const batch = testBatch({ durationSec: 26, sliceStrategy: "fixed_15s" });
  batch.decomposition = {
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 26,
        durationSec: 26,
        scene: "home",
        subject: "student",
        action: "claim then app proof",
        camera: "selfie then close-up",
        lighting: "soft indoor",
        style: "UGC",
        quality: "clear",
        sliceSplitHints: [{ splitSec: 12, reason: "claim changes into app proof" }]
      }
    ]
  };

  const prepared = await prepareBatchForPipeline(testContext(root), batch);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [12, 14]);
  assert.equal(prepared.scripts[0].sliceSplitReason, "claim changes into app proof");
});

test("prepareBatchForPipeline falls back to storySegments when explicit seedanceSlices are invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-invalid-explicit-slices-"));
  const batch = testBatch({ durationSec: 16, sliceStrategy: "fixed_15s" });
  batch.decomposition = {
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 16,
        durationSec: 16,
        scene: "home",
        subject: "student",
        action: "claim then proof",
        camera: "selfie then close-up",
        lighting: "soft indoor",
        style: "UGC",
        quality: "clear"
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 31,
        durationSec: 31,
        sliceDurationSec: 31,
        scene: "bad explicit slice",
        subject: "student",
        action: "bad slice",
        camera: "selfie",
        lighting: "soft indoor",
        style: "UGC",
        quality: "clear"
      }
    ]
  };

  const prepared = await prepareBatchForPipeline(testContext(root), batch);
  assert.deepEqual(prepared.scripts.map((script) => script.durationSec), [8, 8]);
  assert.deepEqual(prepared.tasks.map((task) => task.sliceDurationSec), [8, 8]);
  assert.deepEqual(prepared.scripts.map((script) => script.storySegmentIndex), [1, 1]);
});

test("prepareBatchForPipeline passes fission slice context to LLM plan generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-fission-plan-context-"));
  const seen = [];
  const telemetry = [];
  const context = {
    ...testContext(root),
    recordTelemetryEvent: async (eventName, payload) => {
      telemetry.push({ eventName, payload });
    },
    generateSeedanceVariantPlansForTest: async () => {
      throw new Error("variant batch fixture failure");
    },
    generateSeedancePlanForTest: async (_context, input) => {
      seen.push(input);
      return {
        hook: "Hook",
        body: "Body",
        voiceover: "Voiceover",
        subtitles: ["Subtitle"],
        cta: "",
        ending: "",
        imagePrompt: "Image prompt",
        seedancePrompt: "Seedance prompt no burned subtitles.",
        negativePrompt: "No watermark",
        sliceDurationSec: input.sliceDurationSec,
        segmentRole: input.currentSlice.segmentRole,
        moneyVisuals: [],
        conversionEffectOpportunities: input.currentSlice.conversionEffectOpportunities,
        subtitleWorkflow: { burnedInSubtitles: false, postSubtitleRequired: true, provider: "pixel_tech", subtitleScript: ["Subtitle"] },
        sliceDiversity: {}
      };
    }
  };
  const batch = testBatch({ durationSec: 12, sliceStrategy: "fixed_15s" });
  batch.decomposition = {
    seedanceSlices: [{
      storySegmentIndex: 1,
      seedanceSliceIndex: 1,
      startSec: 0,
      endSec: 12,
      durationSec: 12,
      segmentRole: "hook_slice",
      conversionEffectOpportunities: [{ effect: "coin_burst" }]
    }]
  };

  const prepared = await prepareBatchForPipeline(context, batch, { useLlmPlans: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].currentSlice.storySegmentIndex, 1);
  assert.equal(seen[0].mandatoryMoneyVisualCarrier, true);
  assert.equal(prepared.warnings?.[0]?.code, "plan_variant_batch_fallback");
  assert.match(prepared.warnings?.[0]?.message || "", /variant batch fixture failure/);
  assert.equal(telemetry[0]?.eventName, "plan_variant_batch_fallback");
  assert.match(telemetry[0]?.payload?.errorMessage || "", /variant batch fixture failure/);
  assert.deepEqual(prepared.plans[0].conversionEffectOpportunities, [{ effect: "coin_burst" }]);
  assert.deepEqual(prepared.tasks[0].conversionEffectOpportunities, [{ effect: "coin_burst" }]);
});

function testPlanPayload(label, input = {}) {
  return {
    hook: `Hook ${label}`,
    body: `Body ${label}`,
    voiceover: `Voiceover ${label}`,
    subtitles: [`Subtitle ${label}`],
    cta: "",
    ending: "",
    imagePrompt: `Image prompt ${label}`,
    seedancePrompt: `Seedance prompt ${label}; no burned subtitles.`,
    negativePrompt: "No watermark",
    sliceDurationSec: input.sliceDurationSec || input.currentSlice?.durationSec || 12,
    segmentRole: input.segmentRole || input.currentSlice?.segmentRole || "hook_slice",
    moneyVisuals: ["coin_burst"],
    conversionEffectOpportunities: input.currentSlice?.conversionEffectOpportunities || [],
    subtitleWorkflow: { burnedInSubtitles: false, postSubtitleRequired: true, provider: "pixel_tech", subtitleScript: [`Subtitle ${label}`] },
    sliceDiversity: {}
  };
}

test("prepareBatchForPipeline consumes one variant-level plan for all slices", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-variant-batch-plan-"));
  const seenVariantCalls = [];
  const context = {
    ...testContext(root),
    generateSeedanceVariantPlansForTest: async (_context, input) => {
      seenVariantCalls.push(input);
      const rows = [];
      for (const [index, slice] of input.slicePlan.entries()) {
        const segmentIndex = index + 1;
        rows.push({
          branchVariantIndex: input.branchVariantIndex,
          segmentIndex,
          planPayload: testPlanPayload(`v${input.branchVariantIndex}s${segmentIndex}`, {
            currentSlice: slice,
            segmentRole: slice.segmentRole,
            sliceDurationSec: slice.durationSec
          })
        });
      }
      return rows;
    },
    generateSeedanceBranchPlansForTest: async () => {
      throw new Error("branch batch should not run by default");
    },
    generateSeedancePlanForTest: async () => {
      throw new Error("single-slice fallback should not run");
    }
  };
  const batch = testBatch({ durationSec: 36, sliceStrategy: "three_slice" });
  batch.estimate.variantCount = 3;

  const prepared = await prepareBatchForPipeline(context, batch, { useLlmPlans: true });

  assert.equal(seenVariantCalls.length, 3);
  assert.deepEqual(seenVariantCalls.map((input) => input.branchVariantIndex).sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(seenVariantCalls.map((input) => input.slicePlan.length), [3, 3, 3]);
  assert.equal(prepared.plans.length, 9);
  assert.equal(prepared.scripts.length, 9);
  assert.equal(prepared.tasks.length, 9);
  assert.deepEqual(prepared.scripts.map((script) => script.branchVariantIndex), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.deepEqual(prepared.scripts.map((script) => script.segmentIndex), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.match(prepared.scripts[8].seedancePrompt, /v3s3/);
});

test("prepareBatchForPipeline can still consume explicit branch-level plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-branch-batch-plan-"));
  const seenBranchCalls = [];
  const context = {
    ...testContext(root),
    generateSeedanceBranchPlansForTest: async (_context, input) => {
      seenBranchCalls.push(input);
      const rows = [];
      for (let branchVariantIndex = 1; branchVariantIndex <= input.variantCount; branchVariantIndex += 1) {
        for (const [index, slice] of input.slicePlan.entries()) {
          const segmentIndex = index + 1;
          rows.push({
            branchVariantIndex,
            segmentIndex,
            planPayload: testPlanPayload(`v${branchVariantIndex}s${segmentIndex}`, {
              currentSlice: slice,
              segmentRole: slice.segmentRole,
              sliceDurationSec: slice.durationSec
            })
          });
        }
      }
      return rows;
    },
    generateSeedanceVariantPlansForTest: async () => {
      throw new Error("variant batch should not run when branch batch is enabled");
    },
    generateSeedancePlanForTest: async () => {
      throw new Error("single-slice fallback should not run");
    }
  };
  const batch = testBatch({ durationSec: 36, sliceStrategy: "three_slice" });
  batch.estimate.variantCount = 3;

  const prepared = await prepareBatchForPipeline(context, batch, {
    useLlmPlans: true,
    branchBatchPlans: true,
    planBatchMode: "branch"
  });

  assert.equal(seenBranchCalls.length, 1);
  assert.equal(seenBranchCalls[0].variantCount, 3);
  assert.equal(seenBranchCalls[0].slicePlan.length, 3);
  assert.equal(prepared.plans.length, 9);
  assert.match(prepared.scripts[8].seedancePrompt, /v3s3/);
});

test("prepareBatchForPipeline limits concurrent branch-level plan generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-branch-plan-concurrency-"));
  let active = 0;
  let maxActive = 0;
  const context = {
    ...testContext(root),
    generateSeedanceBranchPlansForTest: async (_context, input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return [{
        branchVariantIndex: 1,
        segmentIndex: 1,
        planPayload: testPlanPayload(input.branch.branchId, {
          currentSlice: input.slicePlan[0],
          segmentRole: input.slicePlan[0]?.segmentRole,
          sliceDurationSec: input.slicePlan[0]?.durationSec
        })
      }];
    }
  };
  const batch = testBatch({ durationSec: 12, sliceStrategy: "fixed_15s" });
  batch.estimate.variantCount = 1;
  batch.estimate.request.branches = [
    { branchId: "branch_1", branchLabel: "Branch 1", targetChannels: ["tiktok"] },
    { branchId: "branch_2", branchLabel: "Branch 2", targetChannels: ["tiktok"] },
    { branchId: "branch_3", branchLabel: "Branch 3", targetChannels: ["tiktok"] }
  ];
  batch.templateSnapshot.draft.branches = batch.estimate.request.branches;

  const prepared = await prepareBatchForPipeline(context, batch, {
    useLlmPlans: true,
    branchBatchPlans: true,
    planBatchMode: "branch",
    planConcurrency: 2
  });

  assert.equal(maxActive, 2);
  assert.equal(prepared.scripts.length, 3);
  assert.deepEqual(prepared.scripts.map((script) => script.branchId), ["branch_1", "branch_2", "branch_3"]);
});

test("prepareBatchForPipeline limits concurrent variant-level plan generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-variant-plan-concurrency-"));
  let active = 0;
  let maxActive = 0;
  const startedVariants = [];
  const context = {
    ...testContext(root),
    generateSeedancePlanForTest: async (_context, input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      startedVariants.push(input.branchVariantIndex);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return testPlanPayload(`v${input.branchVariantIndex}s${input.segmentIndex}`, input);
    },
    generateSeedanceBranchPlansForTest: async () => {
      throw new Error("branch batch generation should be disabled");
    }
  };
  const batch = testBatch({ durationSec: 12, sliceStrategy: "fixed_15s" });
  batch.estimate.variantCount = 4;

  const prepared = await prepareBatchForPipeline(context, batch, {
    useLlmPlans: true,
    branchBatchPlans: false,
    variantBatchPlans: false,
    planConcurrency: { branch: 1, variant: 2, total: 2 }
  });

  assert.equal(maxActive, 2);
  assert.equal(prepared.scripts.length, 4);
  assert.deepEqual(startedVariants.sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual(prepared.scripts.map((script) => script.branchVariantIndex), [1, 2, 3, 4]);
  assert.deepEqual(prepared.tasks.map((task) => task.generationTaskId), [
    "gen_abcd_001",
    "gen_abcd_002",
    "gen_abcd_003",
    "gen_abcd_004"
  ]);
});

test("prepareBatchForPipeline source writes slice duration and role into payloads", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");

  assert.match(source, /const slicePlan = buildSlicePlanFromDecomposition\(batch\)/);
  assert.match(source, /const segmentMultiplier = slicePlan\.length/);
  assert.match(source, /durationSec: slice\.durationSec/);
  assert.match(source, /segmentRole: planRecord\?\.segmentRole \|\| slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: planRecord\?\.sliceDurationSec \|\| slice\.sliceDurationSec \|\| slice\.durationSec/);
  assert.match(source, /segmentRole: slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: slice\.sliceDurationSec \|\| slice\.durationSec/);
  assert.match(source, /currentSlice: slice/);
  assert.match(source, /Task: create a \$\{script\.durationSec \|\| 15\} second 9:16 Seedance image-to-video prompt/);
});

test("buildGenerationPlanRecord carries per-slice duration", () => {
  const record = buildGenerationPlanRecord({
    batch: { batchId: "wzb_20260707121212_abcd" },
    branch: {
      branchId: "branch_1",
      branchLabel: "BR workers",
      branchIndex: 1
    },
    scriptId: "scr_abcd_001",
    generationTaskId: "gen_abcd_001",
    branchVariantIndex: 1,
    segmentIndex: 1,
    sequence: 1,
    planPayload: {
      hook: "Hook",
      body: "Body",
      voiceover: "Voiceover",
      subtitles: ["Subtitle"],
      cta: "",
      ending: "",
      imagePrompt: "Image prompt",
      seedancePrompt: "Seedance prompt",
      negativePrompt: "No exact amount",
      mediaRefs: {},
      complianceNotes: [],
      segmentRole: "hook_slice",
      sliceDurationSec: 12
    }
  });

  assert.equal(record.durationSec, 12);
  assert.equal(record.sliceDurationSec, 12);
  assert.equal(record.segmentRole, "hook_slice");
});

test("buildSubtitlePostProcessArtifact exports Pixel Tech subtitle handoff data", () => {
  const artifact = buildSubtitlePostProcessArtifact({
    batchId: "wzb_20260707121212_abcd",
    scripts: [{
      scriptId: "script_1",
      branchId: "branch_1",
      segmentIndex: 1,
      durationSec: 12,
      subtitles: ["Ganhe no intervalo", "Veja as regras"],
      subtitleWorkflow: {
        burnedInSubtitles: false,
        postSubtitleRequired: true,
        provider: "pixel_tech",
        subtitleScript: ["Ganhe no intervalo", "Veja as regras"]
      }
    }],
    tasks: [{
      scriptId: "script_1",
      generationTaskId: "gen_1",
      branchId: "branch_1",
      segmentIndex: 1,
      durationSec: 12
    }]
  });

  assert.equal(artifact.schemaVersion, "subtitle-postprocess.v1");
  assert.equal(artifact.batchId, "wzb_20260707121212_abcd");
  assert.equal(artifact.provider, "pixel_tech");
  assert.equal(artifact.items[0].scriptId, "script_1");
  assert.equal(artifact.items[0].generationTaskId, "gen_1");
  assert.equal(artifact.items[0].branchId, "branch_1");
  assert.equal(artifact.items[0].segmentIndex, 1);
  assert.equal(artifact.items[0].durationSec, 12);
  assert.equal(artifact.items[0].burnedInSubtitles, false);
  assert.equal(artifact.items[0].provider, "pixel_tech");
  assert.deepEqual(artifact.items[0].subtitleScript, ["Ganhe no intervalo", "Veja as regras"]);
});

test("buildSubtitlePostProcessArtifact filters required items and falls back to script subtitles", () => {
  const artifact = buildSubtitlePostProcessArtifact({
    batchId: "wzb_20260707121212_abcd",
    scripts: [{
      scriptId: "script_required",
      branchId: "branch_1",
      segmentIndex: 2,
      durationSec: 14,
      subtitles: ["Fallback one", "Fallback two"],
      subtitleWorkflow: {
        postSubtitleRequired: true,
        provider: "pixel_tech",
        subtitleScript: []
      }
    }, {
      scriptId: "script_skipped",
      branchId: "branch_2",
      subtitles: ["Skip"],
      subtitleWorkflow: {
        postSubtitleRequired: false,
        provider: "pixel_tech",
        subtitleScript: ["Skip"]
      }
    }],
    tasks: [{
      scriptId: "script_required",
      generationTaskId: "gen_required",
      branchId: "branch_1",
      segmentIndex: 2,
      durationSec: 14
    }, {
      scriptId: "script_skipped",
      generationTaskId: "gen_skipped",
      branchId: "branch_2",
      segmentIndex: 1,
      durationSec: 15
    }]
  });

  assert.equal(artifact.items.length, 1);
  assert.equal(artifact.items[0].scriptId, "script_required");
  assert.equal(artifact.items[0].generationTaskId, "gen_required");
  assert.deepEqual(artifact.items[0].subtitleScript, ["Fallback one", "Fallback two"]);
});

test("buildSubtitlePostProcessArtifact supports legacy workflow values and task fallbacks", () => {
  const artifact = buildSubtitlePostProcessArtifact({
    batchId: "wzb_20260707121212_abcd",
    scripts: [{
      scriptId: "script_post_process",
      planId: "plan_1",
      branchId: "branch_1",
      branchVariantIndex: 1,
      segmentIndex: 1,
      subtitles: ["Legacy post process"],
      subtitleWorkflow: "post_process"
    }, {
      scriptId: "script_plan_match",
      planId: "plan_2",
      branchId: "branch_1",
      branchVariantIndex: 1,
      segmentIndex: 2,
      subtitles: ["Plan match"],
      subtitleWorkflow: {
        postSubtitleRequired: "true",
        provider: "",
        subtitleScript: ["Plan subtitle"]
      }
    }, {
      scriptId: "script_branch_match",
      branchId: "branch_2",
      branchVariantIndex: 3,
      segmentIndex: 2,
      subtitles: ["Branch fallback"],
      subtitleWorkflow: 1
    }, {
      scriptId: "script_none",
      branchId: "branch_3",
      segmentIndex: 1,
      subtitles: ["None"],
      subtitleWorkflow: "none"
    }, {
      scriptId: "script_false_string",
      branchId: "branch_4",
      segmentIndex: 1,
      subtitles: ["False"],
      subtitleWorkflow: {
        postSubtitleRequired: "false",
        subtitleScript: ["False"]
      }
    }],
    tasks: [{
      scriptId: "script_post_process",
      generationTaskId: "gen_script_match",
      branchId: "branch_1",
      branchVariantIndex: 1,
      segmentIndex: 1,
      durationSec: 12
    }, {
      planId: "plan_2",
      generationTaskId: "gen_plan_match",
      branchId: "branch_1",
      branchVariantIndex: 1,
      segmentIndex: 2,
      durationSec: 13
    }, {
      generationTaskId: "gen_branch_match",
      branchId: "branch_2",
      branchVariantIndex: 3,
      segmentIndex: 2,
      durationSec: 14
    }]
  });

  assert.deepEqual(artifact.items.map((item) => item.scriptId), [
    "script_post_process",
    "script_plan_match",
    "script_branch_match"
  ]);
  assert.deepEqual(artifact.items.map((item) => item.generationTaskId), [
    "gen_script_match",
    "gen_plan_match",
    "gen_branch_match"
  ]);
  assert.deepEqual(artifact.items.map((item) => item.durationSec), [12, 13, 14]);
  assert.deepEqual(artifact.items.map((item) => item.provider), ["pixel_tech", "pixel_tech", "pixel_tech"]);
  assert.deepEqual(artifact.items[0].subtitleScript, ["Legacy post process"]);
  assert.deepEqual(artifact.items[1].subtitleScript, ["Plan subtitle"]);
  assert.deepEqual(artifact.items[2].subtitleScript, ["Branch fallback"]);
});
