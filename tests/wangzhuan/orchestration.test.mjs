import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { getBatchDetail, submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { closeWangzhuanFactsPool, setWangzhuanFactsPoolForTest } from "../../server/wangzhuan/mysql-facts.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { pollUpstreamBatch } from "../../server/wangzhuan/upstream-poll.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";
import { testSeedanceProviderClient } from "./test-providers.mjs";

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

async function resetFactsPool() {
  activePool = null;
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

test.afterEach(async () => {
  await resetFactsPool();
});

const baseDraft = {
  displayName: "Cash Reward US EN",
  productName: "Lucky Cash",
  productLink: "https://play.google.com/store/apps/details?id=lucky.cash",
  cta: "Download now",
  ending: "Claim your bonus today",
  currencySymbol: "$",
  language: "en-US",
  regions: ["US"],
  targetChannels: ["meta_ads"],
  defaultOutputRatio: "9:16",
  defaultDurationSec: 15,
  promiseLevel: "strong_conversion"
};

function context(root, overrides = {}) {
  ensureFactsPool();
  const ctx = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
    seedanceProviderClient: testSeedanceProviderClient(),
    capabilities: { stitcher: { status: "available", provider: "ffmpeg", version: "test" } },
    ...overrides
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

function validUpload() {
  return {
    fileName: "demo.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
    durationSec: 15,
    width: 720,
    height: 1280,
    canExtractFrame: true
  };
}

function decomposition() {
  return {
    scene: "Phone app reward screen",
    subject: "Hand holding phone",
    action: "User taps a reward task",
    camera: "Close-up vertical shot",
    lighting: "Bright indoor lighting",
    style: "Clean app demo",
    quality: "HD",
    hook: "Earn rewards with daily tasks",
    rewardFeedback: "Coins appear after task completion",
    cta: "Install today"
  };
}

async function startedBatch(root, durationSec, overrides = {}) {
  const ctx = context(root, overrides.context);
  const saved = await saveTemplate(ctx, { mode: "create", draft: overrides.draft || baseDraft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: `idem_decompose_orchestration_${durationSec}`,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: decomposition()
  });
  const estimated = await estimateBatch(ctx, {
    templateId: saved.template.templateId,
    versionId: saved.template.versionId,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: saved.template.draft.promiseLevel,
    durationSec,
    variantCount: overrides.variantCount || 1,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  const started = await startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_orchestration_${durationSec}`,
    estimateId: estimated.estimate.estimateId
  });
  await submitPendingGenerationTasks(ctx, started.batch.batchId);
  return { ctx, started };
}

test("upstream poll completes 15s batches into qc with segment outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-15-"));
  try {
    const { ctx, started } = await startedBatch(root, 15);
    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);

    assert.equal(polled.batch.status, "qc");
    assert.equal(polled.batch.tasks.every((task) => task.status === "downloaded"), true);
    assert.equal(polled.batch.outputs.length, 1);
    assert.equal(polled.batch.outputs[0].kind, "segment_video");
    assert.equal(polled.batch.outputs[0].durationSec, 15);
    assert.equal(existsSync(join(ctx.userProjectRoot, polled.batch.outputs[0].filePath)), true);

    const detail = await getBatchDetail(ctx, started.batch.batchId);
    assert.equal(detail.batch.status, "qc");
    assert.equal(detail.downloadSummary.outputsTotal, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream poll overlays disclaimer on final 15s segment outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-15-disclaimer-"));
  try {
    const { ctx, started } = await startedBatch(root, 15, {
      draft: {
        ...baseDraft,
        disclaimer: "Final reward details depend on in-app rules and task completion."
      }
    });
    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);

    assert.equal(polled.batch.status, "qc");
    assert.equal(polled.batch.outputs.length, 1);
    assert.equal(polled.batch.outputs[0].kind, "segment_video");
    assert.equal(polled.batch.outputs[0].disclaimerOverlay?.applied, true);
    assert.match(polled.batch.outputs[0].disclaimerOverlay?.text || "", /task completion/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream poll completes 30s batches into qc with stitched outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-30-"));
  try {
    const { ctx, started } = await startedBatch(root, 30);
    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);

    assert.equal(polled.batch.status, "qc");
    assert.equal(polled.batch.outputs.filter((output) => output.kind === "segment_video").length, 2);
    const stitched = polled.batch.outputs.find((output) => output.kind === "stitched_video");
    assert.ok(stitched);
    assert.equal(stitched.durationSec, 30);
    assert.equal(existsSync(join(ctx.userProjectRoot, stitched.filePath)), true);

    const report = JSON.parse(await readFile(join(ctx.userProjectRoot, stitched.stitchReportPath), "utf8"));
    assert.equal(report.status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote seedance poll downloads completed tasks through provider client", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-remote-"));
  const calls = [];
  try {
    const { ctx, started } = await startedBatch(root, 15, {
      context: {
        seedanceProviderClient: {
          provider: "seedance",
          async createTask() {
            return { taskId: "remote_task_001", status: "queued", responsePayload: { id: "remote_task_001", status: "queued" } };
          },
          async getTask(taskId) {
            calls.push({ taskId });
            return {
              taskId,
              status: "succeeded",
              videoUrl: "https://cdn.example.com/output.mp4",
              responsePayload: { id: taskId, status: "succeeded", content: { video_url: "https://cdn.example.com/output.mp4" } }
            };
          },
          async downloadVideo(url) {
            calls.push({ url });
            return Buffer.from("remote mp4 bytes");
          }
        }
      }
    });

    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);
    assert.equal(polled.batch.status, "qc");
    assert.equal(calls.some((call) => call.taskId === "remote_task_001"), true);
    assert.equal(calls.some((call) => call.url === "https://cdn.example.com/output.mp4"), true);
    assert.match(await readFile(join(ctx.userProjectRoot, polled.batch.tasks[0].outputPath), "utf8"), /remote mp4 bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream poll waits for video url when Seedance reports succeeded early", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-succeeded-no-url-"));
  let pollCount = 0;
  try {
    const { ctx, started } = await startedBatch(root, 15, {
      context: {
        seedanceProviderClient: {
          provider: "seedance",
          async createTask() {
            return { taskId: "remote_task_002", status: "queued", responsePayload: { id: "remote_task_002", status: "queued" } };
          },
          async getTask(taskId) {
            pollCount += 1;
            if (pollCount === 1) {
              return {
                taskId,
                status: "succeeded",
                videoUrl: "",
                responsePayload: { id: taskId, status: "succeeded", content: {} }
              };
            }
            return {
              taskId,
              status: "succeeded",
              videoUrl: "https://cdn.example.com/output-late.mp4",
              responsePayload: {
                id: taskId,
                status: "succeeded",
                content: { video_url: "https://cdn.example.com/output-late.mp4" }
              }
            };
          },
          async downloadVideo() {
            return Buffer.from("late mp4 bytes");
          }
        }
      }
    });

    const first = await pollUpstreamBatch(ctx, started.batch.batchId);
    assert.equal(first.batch.tasks[0].status, "waiting_upstream");
    assert.equal(first.batch.tasks[0].responseSummary.waitingForVideoUrl, true);

    const second = await pollUpstreamBatch(ctx, started.batch.batchId);
    assert.equal(second.batch.tasks[0].status, "downloaded");
    assert.equal(second.batch.status, "qc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream poll recovers failed tasks that missed the initial video url", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-orchestration-recover-failed-"));
  try {
    const { ctx, started } = await startedBatch(root, 15, {
      context: {
        seedanceProviderClient: {
          provider: "seedance",
          async createTask() {
            return { taskId: "remote_task_003", status: "queued", responsePayload: { id: "remote_task_003", status: "queued" } };
          },
          async getTask(taskId) {
            return {
              taskId,
              status: "succeeded",
              videoUrl: "https://cdn.example.com/recovered.mp4",
              responsePayload: {
                id: taskId,
                status: "succeeded",
                content: { video_url: "https://cdn.example.com/recovered.mp4" }
              }
            };
          },
          async downloadVideo() {
            return Buffer.from("recovered mp4 bytes");
          }
        }
      }
    });

    const { syncBatchFacts, loadBatchDetailFromMysql } = await import("../../server/wangzhuan/mysql-facts.mjs");
    const batch = (await loadBatchDetailFromMysql(ctx, started.batch.batchId)).batch;
    await syncBatchFacts(ctx, {
      ...batch,
      tasks: batch.tasks.map((task) => ({
        ...task,
        status: "failed",
        errorCode: "upstream_failed",
        errorMessage: "Seedance 上游未返回视频地址",
        seedanceTaskId: "remote_task_003",
        responseSummary: {
          status: "succeeded",
          upstreamStatus: "succeeded",
          videoUrlStored: false
        }
      }))
    }, "batch_write");

    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);
    assert.equal(polled.batch.tasks[0].status, "downloaded");
    assert.equal(polled.batch.status, "qc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
