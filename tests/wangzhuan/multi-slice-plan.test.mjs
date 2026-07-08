import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildGenerationPlanRecord } from "../../server/wangzhuan/plan-preview.mjs";
import {
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
