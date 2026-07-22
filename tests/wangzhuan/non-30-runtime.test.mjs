import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { qcPathHelpers } from "../../server/wangzhuan/qc.mjs";
import { finalizeSegmentBatch, hasMultiSliceStitchGroups, isBatchReadyForStitch, stitchBatchSegments } from "../../server/wangzhuan/stitch.mjs";
import { pollUpstreamBatch } from "../../server/wangzhuan/upstream-poll.mjs";

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

function buildTwoVariantPartialBatch(root) {
  const batch = buildMixedOutcomeBatch(root);
  return {
    ...batch,
    scripts: [
      ...batch.scripts,
      {
        ...batch.scripts[0],
        scriptId: "scr_abcd_003",
        variantIndex: 3,
        segmentIndex: 1,
        branchVariantIndex: 2,
        durationSec: 12,
        promptPath: "prompts/gen_abcd_003_seedance.txt",
        scriptPath: "scripts/scr_abcd_003.json"
      },
      {
        ...batch.scripts[1],
        scriptId: "scr_abcd_004",
        variantIndex: 4,
        segmentIndex: 2,
        branchVariantIndex: 2,
        durationSec: 12,
        promptPath: "prompts/gen_abcd_004_seedance.txt",
        scriptPath: "scripts/scr_abcd_004.json"
      }
    ],
    tasks: [
      {
        ...batch.tasks[0],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_001.mp4"
      },
      {
        ...batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      },
      {
        ...batch.tasks[0],
        generationTaskId: "gen_abcd_003",
        seedanceTaskId: "seedance_remote_003",
        scriptId: "scr_abcd_003",
        segmentIndex: 1,
        branchVariantIndex: 2,
        durationSec: 12,
        status: "downloaded",
        outputPath: "upstream/gen_abcd_001.mp4",
        promptPath: "prompts/gen_abcd_003_seedance.txt"
      },
      {
        ...batch.tasks[1],
        generationTaskId: "gen_abcd_004",
        seedanceTaskId: "seedance_remote_004",
        scriptId: "scr_abcd_004",
        segmentIndex: 2,
        branchVariantIndex: 2,
        durationSec: 12,
        status: "failed",
        outputPath: "",
        errorCode: "upstream_failed",
        errorMessage: "Seedance failed",
        promptPath: "prompts/gen_abcd_004_seedance.txt"
      }
    ]
  };
}

async function writeBatchFiles(root, batch) {
  await mkdir(join(root, "upstream"), { recursive: true });
  await mkdir(join(root, "prompts"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "upstream/gen_abcd_001.mp4"), "fake-video", "utf8");
  await writeFile(join(root, "upstream/gen_abcd_002.mp4"), "fake-video-2", "utf8").catch(() => {});
  for (const task of batch.tasks) {
    await writeFile(join(root, task.promptPath), "Seedance prompt", "utf8");
    await writeFile(join(root, "prompts", `${task.generationTaskId}_image.txt`), "Image prompt", "utf8");
  }
  for (const script of batch.scripts) {
    await writeFile(join(root, script.scriptPath), JSON.stringify(script), "utf8");
  }
}

async function installFakeFfmpeg(root, { logPath = "", failConcat = false } = {}) {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const ffmpegPath = join(binDir, "ffmpeg");
  await writeFile(ffmpegPath, `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg fake"
  exit 0
fi
out=""
previous=""
for arg in "$@"; do
  if [ "$WZ_TEST_FFMPEG_FAIL_CONCAT" = "1" ] && [ "$previous" = "-f" ] && [ "$arg" = "concat" ]; then
    exit 1
  fi
  previous="$arg"
  out="$arg"
done
if [ -n "$WZ_TEST_FFMPEG_LOG" ]; then
  printf '%s\n' "$*" >> "$WZ_TEST_FFMPEG_LOG"
fi
if [ "$out" != "-" ]; then
  printf 'stitched-video' > "$out"
fi
exit 0
`, "utf8");
  await chmod(ffmpegPath, 0o755);
  const ffprobePath = join(binDir, "ffprobe");
  await writeFile(ffprobePath, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_name":"h264","profile":"High","pix_fmt":"yuv420p","width":720,"height":1280}],"format":{"duration":"12.000000","size":"2048"}}
JSON
exit 0
`, "utf8");
  await chmod(ffprobePath, 0o755);
  const previousPath = process.env.PATH || "";
  const previousLogPath = process.env.WZ_TEST_FFMPEG_LOG;
  const previousFailConcat = process.env.WZ_TEST_FFMPEG_FAIL_CONCAT;
  process.env.PATH = `${binDir}:${previousPath}`;
  if (logPath) process.env.WZ_TEST_FFMPEG_LOG = logPath;
  else delete process.env.WZ_TEST_FFMPEG_LOG;
  if (failConcat) process.env.WZ_TEST_FFMPEG_FAIL_CONCAT = "1";
  else delete process.env.WZ_TEST_FFMPEG_FAIL_CONCAT;
  return () => {
    process.env.PATH = previousPath;
    if (previousLogPath === undefined) delete process.env.WZ_TEST_FFMPEG_LOG;
    else process.env.WZ_TEST_FFMPEG_LOG = previousLogPath;
    if (previousFailConcat === undefined) delete process.env.WZ_TEST_FFMPEG_FAIL_CONCAT;
    else process.env.WZ_TEST_FFMPEG_FAIL_CONCAT = previousFailConcat;
  };
}

async function enableDisclaimerOverlay(root, batch) {
  const relativePath = "overlays/disclaimer.png";
  await mkdir(join(root, "overlays"), { recursive: true });
  await writeFile(join(root, relativePath), "fake-overlay", "utf8");
  batch.estimate.request.disclaimerOverlay = {
    enabled: true,
    imageStoredPath: relativePath,
    position: "bottom_center"
  };
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
    recordTelemetryEvent: async () => ({}),
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

test("QC accepts passing non-30 stitched output as downloadable final output", () => {
  const batch = {
    estimate: {
      durationSec: 56,
      request: { outputRatio: "9:16" }
    }
  };
  const output = {
    sourceType: "pipeline",
    kind: "stitched_video",
    durationSec: 56
  };
  assert.equal(downloadEligibility(batch, output, "pass"), true);
  assert.equal(downloadEligibility(batch, output, "fail"), true);
});

test("QC keeps stitched delivery outputs eligible even when content QC fails", () => {
  const batch = {
    estimate: {
      durationSec: 30,
      request: { outputRatio: "9:16" }
    }
  };
  const output = {
    sourceType: "pipeline",
    kind: "stitched_video",
    durationSec: 30,
    outputId: "out_abcd_010"
  };
  assert.equal(downloadEligibility(batch, output, "manual_required"), true);
  assert.equal(downloadEligibility(batch, output, "fail"), true);
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

test("partial_failed retry completion replaces stale multi-slice delivery", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const batch = buildMixedOutcomeBatch(root);
      batch.status = "partial_failed";
      batch.estimate.durationSec = 30;
      batch.request = { postProcess: { subtitles: { enabled: false } } };
      batch.tasks[1] = {
        ...batch.tasks[1],
        status: "waiting_upstream",
        outputPath: "",
        errorCode: undefined,
        errorMessage: undefined
      };
      batch.outputs = [{
        outputId: "out_abcd_090",
        sourceType: "pipeline",
        batchId: batch.batchId,
        kind: "stitched_video",
        generationTaskIds: ["gen_abcd_001"],
        durationSec: 12,
        filePath: "stitched/stale.mp4",
        previewUrl: "https://cdn.example.test/stale.mp4"
      }];
      const state = { batch };
      await writeBatchFiles(root, state.batch);
      const context = {
        ...testContext(root, state),
        seedanceProviderClient: {
          provider: "seedance",
          async getTask(taskId) {
            assert.equal(taskId, "seedance_remote_002");
            return {
              taskId,
              status: "succeeded",
              videoUrl: "https://cdn.example.test/gen_abcd_002.mp4",
              responsePayload: { status: "succeeded" }
            };
          },
          async downloadVideo() {
            return Buffer.from("fake-video-2", "utf8");
          }
        }
      };

      const result = await pollUpstreamBatch(context, state.batch.batchId);
      const stitched = result.batch.outputs.filter((output) => output.kind === "stitched_video");

      assert.equal(result.polledCount, 1);
      assert.equal(result.batch.status, "qc");
      assert.equal(stitched.length, 1);
      assert.notEqual(stitched[0].outputId, "out_abcd_090");
      assert.deepEqual(stitched[0].generationTaskIds, ["gen_abcd_001", "gen_abcd_002"]);
      assert.equal(result.batch.outputs.some((output) => output.outputId === "out_abcd_090"), false);
      assert.equal(result.batch.replaceDerivedOutputs, true);
    } finally {
      restorePath();
    }
  });
});

test("qc retry completion materializes a missing single-slice delivery", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildBatch(root) };
    state.batch.status = "qc";
    state.batch.request = { postProcess: { subtitles: { enabled: false } } };
    await writeBatchFiles(root, state.batch);

    const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    assert.equal(finalized.status, "qc");
    assert.equal(finalized.outputs.length, 1);
    assert.equal(finalized.outputs[0].kind, "segment_video");
    assert.deepEqual(finalized.outputs[0].generationTaskIds, ["gen_abcd_001"]);
  });
});

test("partial_failed recovery keeps the batch partial while failed slices remain", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildMixedOutcomeBatch(root) };
    state.batch.status = "partial_failed";
    state.batch.request = { postProcess: { subtitles: { enabled: false } } };
    await writeBatchFiles(root, state.batch);

    const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    assert.equal(finalized.status, "partial_failed");
    assert.equal(finalized.outputs.length, 1);
    assert.deepEqual(finalized.outputs[0].generationTaskIds, ["gen_abcd_001"]);
    assert.equal(finalized.tasks[1].status, "failed");
  });
});

test("active polling submits ready pending tasks even when upstream status is unchanged", async () => {
  await withTempRoot(async (root) => {
    const batch = buildMixedOutcomeBatch(root);
    batch.status = "running";
    batch.estimate.durationSec = 16;
    batch.request = { postProcess: { subtitles: { enabled: false } } };
    batch.scripts[1] = {
      ...batch.scripts[1],
      segmentIndex: 1,
      branchVariantIndex: 2,
      variantIndex: 2
    };
    batch.tasks[0] = {
      ...batch.tasks[0],
      status: "waiting_upstream",
      outputPath: ""
    };
    batch.tasks[1] = {
      ...batch.tasks[1],
      status: "pending",
      segmentIndex: 1,
      branchVariantIndex: 2,
      variantIndex: 2,
      outputPath: "",
      errorCode: undefined,
      errorMessage: undefined
    };
    const state = { batch };
    await writeBatchFiles(root, state.batch);
    let submittedCount = 0;
    const context = {
      ...testContext(root, state),
      async submitPendingGenerationTasksForTest() {
        submittedCount += 1;
        state.batch = {
          ...state.batch,
          tasks: state.batch.tasks.map((task) => task.generationTaskId === "gen_abcd_002"
            ? {
                ...task,
                status: "waiting_upstream",
                seedanceTaskId: "seedance_retry_slot_002",
                providerJobId: "seedance_retry_slot_002"
              }
            : task)
        };
        return { batch: state.batch, submittedCount: 1, failedSubmitCount: 0 };
      },
      seedanceProviderClient: {
        provider: "seedance",
        config: {},
        async getTask(taskId) {
          return {
            taskId,
            status: "queued",
            videoUrl: "",
            responsePayload: { status: "queued" }
          };
        },
        async createTask() {
          throw new Error("poll should use the pending submission dependency");
        }
      }
    };

    const result = await pollUpstreamBatch(context, state.batch.batchId);

    assert.equal(submittedCount, 1);
    assert.equal(result.needsPoll, true);
    assert.equal(result.batch.tasks[1].status, "waiting_upstream");
    assert.equal(result.batch.tasks[1].seedanceTaskId, "seedance_retry_slot_002");
  });
});

test("non-30 polling reuses covered delivery and replaces it only after a new slice is ready", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const batch = buildMixedOutcomeBatch(root);
      batch.status = "partial_failed";
      batch.estimate.durationSec = 24;
      batch.tasks[1] = {
        ...batch.tasks[1],
        status: "waiting_upstream",
        outputPath: "",
        errorCode: undefined,
        errorMessage: undefined,
        responseSummary: { upstreamStatus: "queued", upstreamPollAttempts: 0 }
      };
      batch.outputs = [
        {
          outputId: "out_abcd_080",
          sourceType: "pipeline",
          batchId: batch.batchId,
          kind: "segment_video",
          generationTaskIds: ["gen_abcd_001"],
          durationSec: 12,
          filePath: "upstream/gen_abcd_001.mp4",
          subtitlePostProcess: { enabled: true, status: "succeeded" }
        },
        {
          outputId: "out_abcd_081",
          sourceType: "pipeline",
          batchId: batch.batchId,
          kind: "stitched_video",
          generationTaskIds: ["gen_abcd_001"],
          durationSec: 12,
          filePath: "stitched/existing.mp4",
          previewUrl: "https://cdn.example.test/existing.mp4"
        }
      ];
      const state = { batch };
      await writeBatchFiles(root, state.batch);
      let upstreamStatus = "queued";
      const context = {
        ...testContext(root, state),
        seedanceProviderClient: {
          provider: "seedance",
          async getTask(taskId) {
            return {
              taskId,
              status: upstreamStatus,
              videoUrl: upstreamStatus === "succeeded" ? "https://cdn.example.test/gen_abcd_002.mp4" : "",
              responsePayload: { status: upstreamStatus }
            };
          },
          async downloadVideo() {
            return Buffer.from("fake-video-2", "utf8");
          }
        }
      };

      const waiting = await pollUpstreamBatch(context, state.batch.batchId);
      assert.deepEqual(
        waiting.batch.outputs.filter((output) => output.kind === "stitched_video").map((output) => output.outputId),
        ["out_abcd_081"]
      );

      upstreamStatus = "succeeded";
      const completed = await pollUpstreamBatch(context, state.batch.batchId);
      const stitched = completed.batch.outputs.filter((output) => output.kind === "stitched_video");
      assert.equal(stitched.length, 1);
      assert.notEqual(stitched[0].outputId, "out_abcd_081");
      assert.deepEqual(stitched[0].generationTaskIds, ["gen_abcd_001", "gen_abcd_002"]);
      assert.equal(completed.batch.replaceDerivedOutputs, true);
    } finally {
      restorePath();
    }
  });
});

test("queued and running poll progress survives task reloads", async () => {
  await withTempRoot(async (root) => {
    const batch = buildBatch(root);
    batch.status = "running";
    batch.tasks[0] = {
      ...batch.tasks[0],
      status: "waiting_upstream",
      outputPath: "",
      upstreamPollAttempts: undefined,
      responseSummary: { upstreamStatus: "queued", upstreamPollAttempts: 0 }
    };
    const state = { batch };
    await writeBatchFiles(root, state.batch);
    const statuses = ["queued", "running"];
    const baseContext = testContext(root, state);
    const context = {
      ...baseContext,
      async writeBatchForTest(next) {
        state.batch = {
          ...next,
          tasks: next.tasks.map((task) => {
            const reloaded = { ...task };
            delete reloaded.upstreamPollAttempts;
            return reloaded;
          })
        };
        return state.batch;
      },
      seedanceProviderClient: {
        provider: "seedance",
        async getTask(taskId) {
          const status = statuses.shift();
          return { taskId, status, videoUrl: "", responsePayload: { status } };
        }
      }
    };

    const first = await pollUpstreamBatch(context, state.batch.batchId);
    assert.equal(first.batch.tasks[0].responseSummary.upstreamPollAttempts, 1);
    assert.equal(first.batch.tasks[0].responseSummary.upstreamStatus, "queued");

    const second = await pollUpstreamBatch(context, state.batch.batchId);
    assert.equal(second.batch.tasks[0].responseSummary.upstreamPollAttempts, 2);
    assert.equal(second.batch.tasks[0].responseSummary.upstreamStatus, "running");
  });
});

test("non-30 multi-slice batch becomes stitch-ready when a post-processable slice is available", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildMixedOutcomeBatch(root) };

    assert.equal(isBatchReadyForStitch(state.batch), true);

    state.batch.tasks[1] = {
      ...state.batch.tasks[1],
      status: "downloaded",
      outputPath: "upstream/gen_abcd_002.mp4",
      errorCode: undefined,
      errorMessage: undefined
    };

    assert.equal(isBatchReadyForStitch(state.batch), true);
  });
});

test("a multi-slice group with one successful slice is stitch-ready without optional post-processing", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildMixedOutcomeBatch(root) };
    state.batch.request = { postProcess: { subtitles: { enabled: false } } };
    await writeBatchFiles(root, state.batch);

    assert.equal(isBatchReadyForStitch(state.batch), true);

    const restorePath = await installFakeFfmpeg(root);
    try {
      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.filter((output) => output.kind === "stitched_video");
      assert.equal(detail.batch.status, "partial_failed");
      assert.equal(stitched.length, 1);
      assert.deepEqual(stitched[0].generationTaskIds, ["gen_abcd_001"]);
    } finally {
      restorePath();
    }
  });
});

test("partial_failed single-slice variants return to qc after every retry succeeds", async () => {
  await withTempRoot(async (root) => {
    const batch = buildBatch(root);
    batch.status = "partial_failed";
    batch.request = { postProcess: { subtitles: { enabled: false } } };
    batch.scripts.push({
      ...batch.scripts[0],
      scriptId: "scr_abcd_002",
      variantIndex: 2,
      branchVariantIndex: 2,
      promptPath: "prompts/gen_abcd_002_seedance.txt",
      scriptPath: "scripts/scr_abcd_002.json"
    });
    batch.tasks.push({
      ...batch.tasks[0],
      generationTaskId: "gen_abcd_002",
      seedanceTaskId: "seedance_remote_002",
      scriptId: "scr_abcd_002",
      branchVariantIndex: 2,
      outputPath: "upstream/gen_abcd_002.mp4",
      promptPath: "prompts/gen_abcd_002_seedance.txt"
    });
    const state = { batch };
    await writeBatchFiles(root, state.batch);

    assert.equal(hasMultiSliceStitchGroups(state.batch), false);
    const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);

    assert.equal(finalized.status, "qc");
    assert.equal(finalized.outputs.filter((output) => output.kind === "segment_video").length, 2);
  });
});

test("a 30 second batch with all slices failed settles instead of retrying no_segments", async () => {
  await withTempRoot(async (root) => {
    const batch = buildMixedOutcomeBatch(root);
    batch.estimate.durationSec = 30;
    batch.request = { postProcess: { subtitles: { enabled: false } } };
    batch.tasks = batch.tasks.map((task) => ({
      ...task,
      status: "failed",
      outputPath: "",
      errorCode: "upstream_failed",
      errorMessage: "Seedance failed"
    }));
    const state = { batch };
    await writeBatchFiles(root, state.batch);

    const result = await pollUpstreamBatch(testContext(root, state), state.batch.batchId);

    assert.equal(result.batch.status, "partial_failed");
    assert.equal(result.needsPoll, false);
    assert.equal(result.batch.outputs.length, 0);
  });
});

test("non-30 multi-variant batch delivers available slices even when another slice failed", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const state = { batch: buildTwoVariantPartialBatch(root) };
      await writeBatchFiles(root, state.batch);

      assert.equal(isBatchReadyForStitch(state.batch), true);

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.filter((output) => output.kind === "stitched_video");
      const segmentOutputs = detail.batch.outputs.filter((output) => output.kind === "segment_video");
      const reports = detail.batch.stitchReports || [];

      assert.equal(detail.batch.status, "partial_failed");
      assert.equal(stitched.length, 2);
      assert.deepEqual(stitched.map((output) => output.generationTaskIds), [["gen_abcd_001", "gen_abcd_002"], ["gen_abcd_003"]]);
      assert.equal(segmentOutputs.length, 3);
      assert.equal(reports.filter((report) => report.status === "succeeded").length, 2);
      assert.equal(reports.filter((report) => report.status === "failed").length, 0);
    } finally {
      restorePath();
    }
  });
});

test("non-30 multi-slice batch stitches downloaded slices by branch variant", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      await writeBatchFiles(root, state.batch);

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.find((output) => output.kind === "stitched_video");

      assert.equal(detail.batch.status, "qc");
      assert.ok(stitched);
      assert.deepEqual(stitched.generationTaskIds, ["gen_abcd_001", "gen_abcd_002"]);
      assert.equal(stitched.durationSec, 24);
      assert.equal((await readFile(join(root, stitched.filePath), "utf8")), "stitched-video");
    } finally {
      restorePath();
    }
  });
});

test("15s multi-slice batch concatenates and embeds disclaimer in one encode", async () => {
  await withTempRoot(async (root) => {
    const ffmpegLog = join(root, "ffmpeg.log");
    const restorePath = await installFakeFfmpeg(root, { logPath: ffmpegLog });
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.estimate.durationSec = 15;
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      await enableDisclaimerOverlay(root, state.batch);
      await writeBatchFiles(root, state.batch);

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const segmentOutputs = detail.batch.outputs.filter((output) => output.kind === "segment_video");
      const stitched = detail.batch.outputs.find((output) => output.kind === "stitched_video");
      const calls = (await readFile(ffmpegLog, "utf8")).trim().split("\n");
      const concatIndex = calls.findIndex((line) => line.includes("-f concat"));
      const overlayCalls = calls.filter((line) => line.includes("-filter_complex"));
      const overlayIndex = calls.findIndex((line) => line.includes("-filter_complex"));

      assert.equal(detail.batch.status, "qc");
      assert.equal(segmentOutputs.length, 2);
      assert.deepEqual(segmentOutputs.map((output) => output.disclaimerOverlay.applied), [false, false]);
      assert.deepEqual(
        await Promise.all(segmentOutputs.map((output) => readFile(join(root, output.filePath), "utf8"))),
        ["fake-video", "fake-video-2"]
      );
      assert.equal(stitched?.disclaimerOverlay?.applied, true);
      assert.ok(concatIndex >= 0);
      assert.equal(overlayIndex, concatIndex);
      assert.equal(overlayCalls.length, 1);
    } finally {
      restorePath();
    }
  });
});

test("single 15s slice still applies disclaimer while materializing final segment", async () => {
  await withTempRoot(async (root) => {
    const ffmpegLog = join(root, "ffmpeg.log");
    const restorePath = await installFakeFfmpeg(root, { logPath: ffmpegLog });
    try {
      const state = { batch: buildBatch(root) };
      state.batch.estimate.durationSec = 15;
      state.batch.request = { postProcess: { subtitles: { enabled: false } } };
      state.batch.scripts[0].durationSec = 15;
      state.batch.tasks[0].durationSec = 15;
      await enableDisclaimerOverlay(root, state.batch);
      await writeBatchFiles(root, state.batch);

      const finalized = await finalizeSegmentBatch(testContext(root, state), state.batch.batchId);
      const calls = (await readFile(ffmpegLog, "utf8")).trim().split("\n");

      assert.equal(finalized.status, "qc");
      assert.equal(finalized.outputs.length, 1);
      assert.equal(finalized.outputs[0].disclaimerOverlay.applied, true);
      assert.equal(calls.filter((line) => line.includes("-filter_complex")).length, 1);
      assert.equal(calls.some((line) => line.includes("-f concat")), false);
    } finally {
      restorePath();
    }
  });
});

test("single slice appends independent Ending and embeds the full-duration disclaimer", async () => {
  await withTempRoot(async (root) => {
    const ffmpegLog = join(root, "ffmpeg.log");
    const restorePath = await installFakeFfmpeg(root, { logPath: ffmpegLog });
    try {
      const state = { batch: buildBatch(root) };
      state.batch.request = {
        postProcess: {
          ending: {
            enabled: true,
            fileName: "ending.png",
            mediaType: "image",
            storedPath: "postprocess-assets/ending/ending.png",
            imageDurationSec: 1
          }
        }
      };
      await enableDisclaimerOverlay(root, state.batch);
      await writeBatchFiles(root, state.batch);
      await mkdir(join(root, "postprocess-assets/ending"), { recursive: true });
      await writeFile(join(root, "postprocess-assets/ending/ending.png"), "fake-ending", "utf8");

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.find((output) => output.kind === "stitched_video");
      const calls = (await readFile(ffmpegLog, "utf8")).trim().split("\n");
      const endingIndex = calls.findIndex((line) => line.includes("ending.png") && line.includes("anullsrc"));
      const concatIndex = calls.findIndex((line) => line.includes("-f concat"));
      const overlayIndex = calls.findIndex((line) => line.includes("-filter_complex"));

      assert.equal(detail.batch.status, "qc");
      assert.equal(stitched.durationSec, 17);
      assert.equal(stitched.postProcessEnding.durationSec, 1);
      assert.equal(stitched.disclaimerOverlay.applied, true);
      assert.ok(endingIndex >= 0);
      assert.ok(concatIndex > endingIndex);
      assert.equal(overlayIndex, concatIndex);
    } finally {
      restorePath();
    }
  });
});

test("real concat failure settles multi-slice batch as partial_failed", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root, { failConcat: true });
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      await writeBatchFiles(root, state.batch);

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.find((output) => output.kind === "stitched_video");
      const report = detail.batch.stitchReports.at(-1);

      assert.equal(detail.batch.status, "partial_failed");
      assert.equal(state.batch.status, "partial_failed");
      assert.equal(stitched, undefined);
      assert.equal(detail.batch.outputs.filter((output) => output.kind === "segment_video").length, 2);
      assert.deepEqual(detail.batch.tasks.map((task) => task.status), ["downloaded", "downloaded"]);
      assert.equal(report.status, "failed");
      assert.equal(report.errorCode, "stitch_failed");
      assert.ok(report.reportPath);
    } finally {
      restorePath();
    }
  });
});

test("failed retry stitch keeps the previous downloadable delivery", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root, { failConcat: true });
    try {
      const batch = buildMixedOutcomeBatch(root);
      batch.status = "partial_failed";
      batch.tasks[1] = {
        ...batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      batch.outputs = [{
        outputId: "out_abcd_090",
        sourceType: "pipeline",
        batchId: batch.batchId,
        branchId: "branch_1",
        branchVariantIndex: 1,
        kind: "stitched_video",
        generationTaskIds: ["gen_abcd_001"],
        durationSec: 12,
        filePath: "stitched/previous.mp4",
        previewUrl: "https://cdn.example.test/previous.mp4",
        downloadEligible: true
      }];
      const state = { batch };
      await writeBatchFiles(root, state.batch);

      const detail = await stitchBatchSegments(
        testContext(root, state),
        state.batch.batchId,
        { replaceDerivedOutputs: true }
      );

      assert.equal(detail.batch.status, "partial_failed");
      assert.ok(detail.batch.outputs.some((output) => output.outputId === "out_abcd_090"));
    } finally {
      restorePath();
    }
  });
});

test("missing source during segment materialization settles batch as partial_failed", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/missing.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      await writeBatchFiles(root, state.batch);

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const report = detail.batch.stitchReports.at(-1);

      assert.equal(detail.batch.status, "partial_failed");
      assert.equal(state.batch.status, "partial_failed");
      assert.equal(detail.batch.outputs.length, 0);
      assert.equal(report.status, "failed");
      assert.equal(report.errorCode, "missing_required_file");
      assert.match(report.errorMessage, /分段视频文件缺失/);
    } finally {
      restorePath();
    }
  });
});

test("concurrent stitch requests share one in-flight concat", async () => {
  await withTempRoot(async (root) => {
    const ffmpegLog = join(root, "ffmpeg.log");
    const restorePath = await installFakeFfmpeg(root, { logPath: ffmpegLog });
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      await writeBatchFiles(root, state.batch);
      const context = testContext(root, state);

      const [first, second] = await Promise.all([
        stitchBatchSegments(context, state.batch.batchId),
        stitchBatchSegments(context, state.batch.batchId)
      ]);
      const calls = (await readFile(ffmpegLog, "utf8")).trim().split("\n");

      assert.equal(first.batch.status, "qc");
      assert.equal(second.batch.status, "qc");
      assert.equal(calls.filter((line) => line.includes("-f concat")).length, 1);
    } finally {
      restorePath();
    }
  });
});

test("stitched batch keeps CTA and Ending product images inside the final Seedance slice", async () => {
  await withTempRoot(async (root) => {
    const restorePath = await installFakeFfmpeg(root);
    try {
      const state = { batch: buildMixedOutcomeBatch(root) };
      state.batch.tasks[1] = {
        ...state.batch.tasks[1],
        status: "downloaded",
        outputPath: "upstream/gen_abcd_002.mp4",
        errorCode: undefined,
        errorMessage: undefined
      };
      const branchDraft = {
        assetStoredPaths: {
          ctaAsset: "product-assets/branch_1/ctaAsset/cta.png",
          endingAsset: "product-assets/branch_1/endingAsset/ending.png"
        },
        assetFileNames: {
          ctaAsset: "cta.png",
          endingAsset: "ending.png"
        }
      };
      state.batch.scripts = state.batch.scripts.map((script) => ({
        ...script,
        branchDraft
      }));
      await writeBatchFiles(root, state.batch);
      await mkdir(join(root, "product-assets/branch_1/ctaAsset"), { recursive: true });
      await mkdir(join(root, "product-assets/branch_1/endingAsset"), { recursive: true });
      await writeFile(join(root, "product-assets/branch_1/ctaAsset/cta.png"), "fake-cta-image", "utf8");
      await writeFile(join(root, "product-assets/branch_1/endingAsset/ending.png"), "fake-ending-image", "utf8");

      const detail = await stitchBatchSegments(testContext(root, state), state.batch.batchId);
      const stitched = detail.batch.outputs.find((output) => output.kind === "stitched_video");

      assert.ok(stitched);
      assert.equal(stitched.durationSec, 24);
      assert.deepEqual(stitched.tailSegments || [], []);
      const report = detail.batch.stitchReports.at(-1);
      assert.deepEqual(report.tailSegments || [], []);
    } finally {
      restorePath();
    }
  });
});

test("single Seedance slice with product reference images does not require stitch", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildBatch(root) };
    state.batch.request = { postProcess: { subtitles: { enabled: false } } };
    state.batch.scripts[0] = {
      ...state.batch.scripts[0],
      branchDraft: {
        assetStoredPaths: {
          ctaAsset: "product-assets/branch_1/ctaAsset/cta.png"
        }
      }
    };
    state.batch.tasks[0] = {
      ...state.batch.tasks[0],
      seedanceTaskId: "seedance_remote_001",
      status: "downloaded",
      outputPath: "upstream/gen_abcd_001.mp4"
    };

    assert.equal(hasMultiSliceStitchGroups(state.batch), false);
    assert.equal(isBatchReadyForStitch(state.batch), false);
  });
});

test("single Seedance slice with requested expansion size enters stitch post-processing", async () => {
  await withTempRoot(async (root) => {
    const state = { batch: buildBatch(root) };
    state.batch.request = {
      postProcess: {
        expansionSizes: [{ targetWidth: 800, targetHeight: 800 }]
      }
    };

    assert.equal(hasMultiSliceStitchGroups(state.batch), true);
    assert.equal(isBatchReadyForStitch(state.batch), true);
  });
});
