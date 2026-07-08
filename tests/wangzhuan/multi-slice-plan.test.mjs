import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildGenerationPlanRecord } from "../../server/wangzhuan/plan-preview.mjs";
import {
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

test("prepareBatchForPipeline source writes slice duration and role into payloads", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");

  assert.match(source, /const slicePlan = buildSlicePlan\(/);
  assert.match(source, /const segmentMultiplier = slicePlan\.length/);
  assert.match(source, /durationSec: slice\.durationSec/);
  assert.match(source, /segmentRole: planRecord\?\.segmentRole \|\| slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: planRecord\?\.sliceDurationSec \|\| slice\.durationSec/);
  assert.match(source, /segmentRole: slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: slice\.durationSec/);
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
