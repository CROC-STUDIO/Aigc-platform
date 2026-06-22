import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { getBatchDetail, submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { pollUpstreamBatch } from "../../server/wangzhuan/upstream-poll.mjs";

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
  return {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
    capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } },
    ...overrides
  };
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

test("mock upstream poll completes 15s batches into qc with segment outputs", async () => {
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

test("mock upstream poll completes 30s batches into qc with stitched outputs", async () => {
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
