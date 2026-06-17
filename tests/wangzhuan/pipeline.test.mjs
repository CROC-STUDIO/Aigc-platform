import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import {
  getBatchDetail,
  stopBatch,
  submitPendingGenerationTasks
} from "../../server/wangzhuan/pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";

const baseDraft = {
  displayName: "Cash Reward US EN",
  productName: "Lucky Cash",
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
    config: {},
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

async function fixture(root, overrides = {}) {
  const ctx = context(root, overrides.context);
  const saved = await saveTemplate(ctx, { mode: "create", draft: overrides.draft || baseDraft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: "idem_decompose_pipeline",
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
    durationSec: 15,
    variantCount: overrides.variantCount || 2,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  const started = await startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_pipeline_${overrides.variantCount || 2}`,
    estimateId: estimated.estimate.estimateId
  });
  return { ctx, started };
}

test("start prepares 15s scripts, prompt files, and pending generation tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-pipeline-start-"));
  try {
    const { ctx, started } = await fixture(root, { variantCount: 2 });
    const batch = started.batch;

    assert.equal(batch.status, "queued");
    assert.equal(batch.scripts.length, 2);
    assert.equal(batch.tasks.length, 2);
    assert.equal(batch.outputs.length, 0);

    for (const [index, script] of batch.scripts.entries()) {
      assert.match(script.scriptId, /^scr_[a-f0-9]{4}_\d{3}$/);
      assert.equal(script.batchId, batch.batchId);
      assert.equal(script.variantIndex, index + 1);
      assert.equal(script.segmentIndex, 1);
      assert.equal(script.durationSec, 15);
      assert.equal(isAbsolute(script.scriptPath), false);
      assert.equal(isAbsolute(script.promptPath), false);
      assert.equal(script.scriptPath.includes(root), false);
      assert.equal(script.promptPath.includes(root), false);

      const scriptJson = JSON.parse(await readFile(join(ctx.userProjectRoot, script.scriptPath), "utf8"));
      assert.equal(scriptJson.scriptId, script.scriptId);
      assert.equal(scriptJson.cta, "Download now");
      assert.match(await readFile(join(ctx.userProjectRoot, script.promptPath), "utf8"), /Lucky Cash/);
    }

    for (const task of batch.tasks) {
      assert.match(task.generationTaskId, /^gen_[a-f0-9]{4}_\d{3}$/);
      assert.equal(task.status, "pending");
      assert.equal(task.remoteUrlStored, false);
      assert.equal(Object.hasOwn(task, "remoteUrl"), false);
      assert.equal(Object.hasOwn(task, "imageTaskId"), false);
      assert.equal(Object.hasOwn(task, "seedanceTaskId"), false);
      assert.equal(existsSync(join(ctx.userProjectRoot, task.promptPath)), true);
    }

    const paths = wangzhuanPaths(ctx);
    assert.equal(existsSync(join(paths.batchesDir, batch.batchId, "task-map", "task-id-map.json")), true);
    assert.equal(existsSync(join(paths.batchesDir, batch.batchId, "tasks.jsonl")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mock submit assigns local task ids and keeps remote URLs out of manifest and task map", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-pipeline-submit-"));
  try {
    const { ctx, started } = await fixture(root, { variantCount: 2 });
    const result = await submitPendingGenerationTasks(ctx, started.batch.batchId);

    assert.equal(result.submittedCount, 2);
    assert.equal(result.batch.status, "running");
    for (const task of result.batch.tasks) {
      assert.equal(task.status, "waiting_upstream");
      assert.match(task.imageTaskId, /^mock_img_gen_[a-f0-9]{4}_\d{3}$/);
      assert.match(task.seedanceTaskId, /^mock_seedance_gen_[a-f0-9]{4}_\d{3}$/);
      assert.equal(task.remoteUrlStored, false);
      assert.equal(Object.hasOwn(task, "remoteUrl"), false);
      assert.equal(task.attempts, 1);
      assert.ok(task.startedAt);
    }

    const taskMapPath = join(wangzhuanPaths(ctx).batchesDir, started.batch.batchId, "task-map", "task-id-map.json");
    const taskMapText = await readFile(taskMapPath, "utf8");
    assert.match(taskMapText, /mock_seedance_gen_/);
    assert.doesNotMatch(taskMapText, /"remoteUrl"\s*:|"remote_url"\s*:|https?:\/\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop before mock submit marks pending tasks stopped and prevents later submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-pipeline-stop-"));
  try {
    const { ctx, started } = await fixture(root, { variantCount: 2 });
    const stopped = await stopBatch(ctx, started.batch.batchId, { reason: "user_cancelled" });

    assert.equal(stopped.batch.status, "stopped");
    assert.equal(stopped.stoppedCount, 2);
    for (const task of stopped.batch.tasks) {
      assert.equal(task.status, "stopped");
      assert.equal(Object.hasOwn(task, "imageTaskId"), false);
      assert.equal(Object.hasOwn(task, "seedanceTaskId"), false);
    }

    const submitted = await submitPendingGenerationTasks(ctx, started.batch.batchId);
    assert.equal(submitted.submittedCount, 0);
    assert.equal(submitted.batch.status, "stopped");
    for (const task of submitted.batch.tasks) {
      assert.equal(Object.hasOwn(task, "imageTaskId"), false);
      assert.equal(Object.hasOwn(task, "seedanceTaskId"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch detail returns manifest events and a download summary without package output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-pipeline-detail-"));
  try {
    const { ctx, started } = await fixture(root, { variantCount: 1 });
    const detail = await getBatchDetail(ctx, started.batch.batchId);

    assert.equal(detail.batch.batchId, started.batch.batchId);
    assert.equal(detail.batch.scripts.length, 1);
    assert.equal(detail.batch.tasks.length, 1);
    assert.equal(Array.isArray(detail.events), true);
    assert.deepEqual(detail.downloadSummary, {
      outputsTotal: 0,
      downloadEligibleCount: 0,
      packageReady: false,
      missingFiles: []
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start prepares 30s batches as two 15s segments when mock stitcher is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-pipeline-30s-"));
  try {
    const ctx = context(root, {
      capabilities: { stitcher: { status: "available", provider: "mock_stitch" } }
    });
    const saved = await saveTemplate(ctx, { mode: "create", draft: baseDraft });
    const checked = await checkReferenceVideo(ctx, validUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_decompose_pipeline_30s",
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
      promiseLevel: "strong_conversion",
      durationSec: 30,
      variantCount: 1,
      requestedConcurrency: 1,
      outputRatio: "9:16"
    });

    assert.equal(estimated.estimate.scriptCount, 2);
    assert.equal(estimated.estimate.seedanceSegmentCount, 2);
    assert.equal(estimated.estimate.stitchTaskCount, 1);
    const started = await startBatchFromEstimate(ctx, {
      idempotencyKey: "idem_start_pipeline_30s",
      estimateId: estimated.estimate.estimateId
    });

    assert.equal(started.batch.status, "queued");
    assert.equal(started.batch.scripts.length, 2);
    assert.equal(started.batch.tasks.length, 2);
    assert.deepEqual(started.batch.scripts.map((script) => script.segmentIndex), [1, 2]);
    assert.equal(started.batch.outputs.length, 0);

    const batchEntries = await readdir(wangzhuanPaths(ctx).batchesDir);
    assert.equal(batchEntries.includes(started.batch.batchId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
