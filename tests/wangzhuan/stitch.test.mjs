import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import {
  closeWangzhuanFactsPool,
  setWangzhuanFactsPoolForTest
} from "../../server/wangzhuan/mysql-facts.mjs";
import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import {
  preflightStitcher,
  retryStitch,
  stitchBatchSegments
} from "../../server/wangzhuan/stitch.mjs";
import { pollUpstreamBatch } from "../../server/wangzhuan/upstream-poll.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";
import { prepareDownloadedSegmentsWithoutStitch, testSeedanceProviderClient } from "./test-providers.mjs";

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
  defaultDurationSec: 30,
  promiseLevel: "strong_conversion"
};

function context(root, overrides = {}) {
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
    durationSec: 30,
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

async function thirtySecondFixture(root, overrides = {}) {
  setWangzhuanFactsPoolForTest(fakePool());
  const ctx = context(root, overrides.context);
  const saved = await saveTemplate(ctx, { mode: "create", draft: overrides.draft || baseDraft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: `idem_decompose_stitch_${overrides.suffix || "ok"}`,
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
    durationSec: 30,
    variantCount: overrides.variantCount || 1,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  const started = await startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_stitch_${overrides.suffix || "ok"}`,
    estimateId: estimated.estimate.estimateId
  });
  return { ctx, estimated, started };
}

async function resetFactsPool() {
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

test("preflight reports supported or unavailable stitcher without calling a real provider", () => {
  const supported = preflightStitcher({
    capabilities: { stitcher: { status: "available", provider: "ffmpeg", version: "test" } }
  });
  assert.equal(supported.status, "supported");
  assert.equal(supported.provider, "ffmpeg");
  assert.equal(supported.version, "test");

  const unsupported = preflightStitcher({ capabilities: { stitcher: { status: "unavailable" } } });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.provider, "unknown");
});

test("ffmpeg stitch writes segment outputs, a stitched output, and a succeeded stitch report", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-ok-"));
  try {
    const { ctx, started } = await thirtySecondFixture(root);
    await submitPendingGenerationTasks(ctx, started.batch.batchId);
    const polled = await pollUpstreamBatch(ctx, started.batch.batchId);
    const batch = polled.batch;

    assert.equal(batch.status, "qc");
    assert.equal(batch.outputs.length, 3);
    assert.equal(batch.outputs.filter((output) => output.kind === "segment_video").length, 2);
    const stitched = batch.outputs.find((output) => output.kind === "stitched_video");
    assert.ok(stitched);
    assert.equal(stitched.durationSec, 30);
    assert.equal(stitched.qcStatus, "not_started");
    assert.equal(stitched.downloadEligible, false);
    assert.equal(isAbsolute(stitched.filePath), false);
    assert.equal(stitched.filePath.includes(root), false);
    assert.equal(existsSync(join(ctx.userProjectRoot, stitched.filePath)), true);

    const report = JSON.parse(await readFile(join(ctx.userProjectRoot, stitched.stitchReportPath), "utf8"));
    assert.equal(report.schemaVersion, "stitch_report.v1");
    assert.equal(report.status, "succeeded");
    assert.equal(report.outputId, stitched.outputId);
    assert.equal(report.segmentOutputIds.length, 2);
    assert.equal(report.tool.provider, "ffmpeg");
    assert.equal(report.tool.preflightStatus, "supported");

    const taskMapText = await readFile(join(wangzhuanPaths(ctx).batchesDir, batch.batchId, "task-map", "task-id-map.csv"), "utf8");
    assert.match(taskMapText, /out_[a-f0-9]{4}_\d{3}/);
    assert.doesNotMatch(taskMapText, /remoteUrl|remote_url/);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("stitch failure keeps segments, writes failed report, and marks batch partial_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-fail-"));
  try {
    const { ctx, started } = await thirtySecondFixture(root, { suffix: "fail" });
    await prepareDownloadedSegmentsWithoutStitch(ctx, started.batch.batchId);

    const detail = await stitchBatchSegments(ctx, started.batch.batchId, { forceFail: true });
    const batch = detail.batch;

    assert.equal(batch.status, "partial_failed");
    assert.equal(batch.outputs.filter((output) => output.kind === "segment_video").length, 2);
    assert.equal(batch.outputs.some((output) => output.kind === "stitched_video"), false);
    assert.equal(batch.stitchReports.length, 1);

    const report = JSON.parse(await readFile(join(ctx.userProjectRoot, batch.stitchReports[0].reportPath), "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.errorCode, "stitch_failed");
    assert.equal(report.errorMessage.includes(root), false);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("retry-stitch is idempotent and can turn a failed stitch into a qc-ready batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-retry-"));
  try {
    const { ctx, started } = await thirtySecondFixture(root, { suffix: "retry" });
    await prepareDownloadedSegmentsWithoutStitch(ctx, started.batch.batchId);
    await stitchBatchSegments(ctx, started.batch.batchId, { forceFail: true });

    const retried = await retryStitch(ctx, started.batch.batchId, { idempotencyKey: "idem_retry_stitch_1" });
    assert.equal(retried.batch.status, "qc");
    assert.equal(retried.batch.outputs.filter((output) => output.kind === "stitched_video").length, 1);
    assert.equal(retried.batch.stitchReports.at(-1).status, "succeeded");
    assert.notEqual(retried.batch.stitchReports[0].outputId, retried.batch.stitchReports.at(-1).outputId);

    const replay = await retryStitch(ctx, started.batch.batchId, { idempotencyKey: "idem_retry_stitch_1" });
    assert.equal(replay.batch.batchId, retried.batch.batchId);
    assert.equal(replay.batch.stitchReports.length, retried.batch.stitchReports.length);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("stitching without submitted segment task ids fails with no_segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-no-segments-"));
  try {
    const { ctx, started } = await thirtySecondFixture(root, { suffix: "no_segments" });

    await assert.rejects(
      () => stitchBatchSegments(ctx, started.batch.batchId),
      { code: "no_segments" }
    );
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
