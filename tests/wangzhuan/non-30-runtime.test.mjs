import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { qcPathHelpers } from "../../server/wangzhuan/qc.mjs";
import { finalizeSegmentBatch } from "../../server/wangzhuan/stitch.mjs";

const { videoSpecCheck, downloadEligibility, shouldRunModelVideoQc } = qcPathHelpers;

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "wz-non-30-runtime-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildBatch(root) {
  const promptPath = "prompts/gen_abcd_001_seedance.txt";
  return {
    batchId: "wzb_20260707121212_abcd",
    userId: "tester",
    status: "running",
    estimate: {
      durationSec: 16,
      outputRatio: "9:16",
      request: {
        outputRatio: "9:16",
        targetChannel: "tiktok"
      }
    },
    templateSnapshot: {
      draft: {
        productName: "Drama Gold",
        language: "pt-BR",
        regions: ["BR"],
        currencySymbol: "R$",
        targetChannels: ["tiktok"],
        promiseLevel: "stable"
      }
    },
    scripts: [{
      scriptId: "scr_abcd_001",
      batchId: "wzb_20260707121212_abcd",
      variantIndex: 1,
      segmentIndex: 1,
      durationSec: 16,
      hook: "Drama Gold reward check",
      body: "Drama Gold shows task progress and reward feedback.",
      cta: "",
      ending: "",
      promptPath,
      scriptPath: "scripts/scr_abcd_001.json",
      branchId: "branch_1",
      branchLabel: "BR workers",
      branchVariantIndex: 1
    }],
    tasks: [{
      generationTaskId: "gen_abcd_001",
      seedanceTaskId: "seedance_remote_001",
      scriptId: "scr_abcd_001",
      branchId: "branch_1",
      branchLabel: "BR workers",
      branchVariantIndex: 1,
      segmentIndex: 1,
      durationSec: 16,
      status: "downloaded",
      outputPath: "upstream/gen_abcd_001.mp4",
      promptPath
    }],
    outputs: [],
    _root: root
  };
}

function buildMixedOutcomeBatch(root) {
  const batch = buildBatch(root);
  return {
    ...batch,
    estimate: {
      ...batch.estimate,
      durationSec: 24
    },
    scripts: [
      {
        ...batch.scripts[0],
        durationSec: 12
      },
      {
        ...batch.scripts[0],
        scriptId: "scr_abcd_002",
        segmentIndex: 2,
        durationSec: 12,
        promptPath: "prompts/gen_abcd_002_seedance.txt",
        scriptPath: "scripts/scr_abcd_002.json"
      }
    ],
    tasks: [
      {
        ...batch.tasks[0],
        durationSec: 12
      },
      {
        ...batch.tasks[0],
        generationTaskId: "gen_abcd_002",
        seedanceTaskId: "seedance_remote_002",
        scriptId: "scr_abcd_002",
        segmentIndex: 2,
        durationSec: 12,
        status: "failed",
        outputPath: "",
        errorCode: "upstream_failed",
        errorMessage: "Seedance failed",
        promptPath: "prompts/gen_abcd_002_seedance.txt"
      }
    ],
    _root: root
  };
}

async function writeBatchFiles(root, batch) {
  await mkdir(join(root, "upstream"), { recursive: true });
  await mkdir(join(root, "prompts"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "upstream/gen_abcd_001.mp4"), "fake-video", "utf8");
  for (const task of batch.tasks) {
    await writeFile(join(root, task.promptPath), "Seedance prompt", "utf8");
    await writeFile(join(root, "prompts", `${task.generationTaskId}_image.txt`), "Image prompt", "utf8");
  }
  for (const script of batch.scripts) {
    await writeFile(join(root, script.scriptPath), JSON.stringify(script), "utf8");
  }
}

function testContext(root, state) {
  return {
    userId: "tester",
    user: { username: "tester" },
    userProjectRoot: root,
    sharedProjectRoot: root,
    config: {
      wangzhuan: {
        qcLlm: {
          preferVideoUrl: true
        }
      }
    },
    readBatchForTest: async () => state.batch,
    writeBatchForTest: async (batch) => {
      state.batch = batch;
      return batch;
    },
    getChannelRulesForTest: async () => ({ rules: [] }),
    syncWangzhuanAsset: async ({ fullPath, assetKind }) => ({
      assetKind,
      storageKey: `mock/${assetKind}.mp4`,
      storageUrl: `https://cdn.example.test/${assetKind}.mp4`,
      storedPath: fullPath.slice(root.length).replace(/^[\\/]+/, ""),
      localOnly: false
    }),
    callWangzhuanQcLlm: async () => JSON.stringify({
      passed: true,
      score: 0.95,
      summary: "Non-30 segment output is acceptable.",
      issues: []
    })
  };
}

test("non-30 16s segment finalizes to qc with exact output duration", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildBatch(root) };
    await writeBatchFiles(root, state.batch);

    const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    assert.equal(finalized.status, "qc");
    assert.equal(finalized.outputs.length, 1);
    assert.equal(finalized.outputs[0].kind, "segment_video");
    assert.equal(finalized.outputs[0].durationSec, 16);
    assert.equal(finalized.tasks[0].status, "downloaded");
    assert.equal((await readFile(join(root, finalized.outputs[0].filePath), "utf8")), "fake-video");
  });
});

test("QC accepts passing non-30 segment output as final downloadable output", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildBatch(root) };
    await writeBatchFiles(root, state.batch);
    state.batch = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    const output = state.batch.outputs[0];
    assert.equal(videoSpecCheck(testContext(root, state), output).status, "pass");
    assert.equal(shouldRunModelVideoQc(testContext(root, state), state.batch, output), true);
    assert.equal(downloadEligibility(state.batch, output, "pass"), true);
  });
});

test("non-30 mixed outcome materializes successful slices and settles partial_failed", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildMixedOutcomeBatch(root) };
    await writeBatchFiles(root, state.batch);

    const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    assert.equal(finalized.status, "partial_failed");
    assert.equal(finalized.outputs.length, 1);
    assert.equal(finalized.outputs[0].generationTaskIds[0], "gen_abcd_001");
    assert.equal(finalized.outputs[0].durationSec, 12);
    assert.equal(finalized.tasks[0].status, "downloaded");
    assert.equal(finalized.tasks[1].status, "failed");
    assert.equal((await readFile(join(root, finalized.outputs[0].filePath), "utf8")), "fake-video");
  });
});
