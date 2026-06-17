import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import {
  estimateBatch,
  loadEstimate,
  startBatchFromEstimate
} from "../../server/wangzhuan/estimates.mjs";

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
    cta: "Install today"
  };
}

async function fixture(root, draft = baseDraft) {
  const ctx = context(root);
  const saved = await saveTemplate(ctx, { mode: "create", draft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: "idem_decompose",
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: decomposition()
  });
  return {
    ctx,
    template: saved.template,
    referenceVideoId: checked.referenceVideo.referenceVideoId
  };
}

function request(fx, overrides = {}) {
  return {
    templateId: fx.template.templateId,
    versionId: fx.template.versionId,
    referenceVideoId: fx.referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: fx.template.draft.promiseLevel,
    durationSec: 15,
    variantCount: 5,
    requestedConcurrency: 2,
    outputRatio: "9:16",
    ...overrides
  };
}

test("estimates a 15s batch and persists limits, capabilities, and snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-ok-"));
  try {
    const fx = await fixture(root);
    const result = await estimateBatch(fx.ctx, request(fx));

    assert.match(result.estimate.estimateId, /^est_\d{8}_\d{3}$/);
    assert.equal(result.estimate.durationSec, 15);
    assert.equal(result.estimate.variantCount, 5);
    assert.equal(result.estimate.scriptCount, 5);
    assert.equal(result.estimate.seedanceSegmentCount, 5);
    assert.equal(result.estimate.stitchTaskCount, 0);
    assert.equal(result.estimate.imageTaskCount, 5);
    assert.equal(result.estimate.requestedConcurrency, 2);
    assert.equal(result.estimate.confirmationRequired, false);
    assert.equal(result.estimate.hardBlocked, false);
    assert.deepEqual(result.estimate.blockedReasons, []);
    assert.equal(result.capabilities.stitcher.status, "not_required");
    assert.equal(result.limits.hardGenerationTasks, 50);

    const loaded = await loadEstimate(fx.ctx, result.estimate.estimateId);
    assert.equal(loaded.estimate.estimateId, result.estimate.estimateId);
    assert.equal(loaded.templateSnapshot.versionId, fx.template.versionId);
    assert.equal(loaded.referenceVideo.referenceVideoId, fx.referenceVideoId);
    assert.equal(loaded.decomposition.schemaVersion, "video_decomposition.v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires user-maintained truth rules for strong commitment estimate", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-strong-"));
  try {
    const fx = await fixture(root, { ...baseDraft, promiseLevel: "stable" });
    await assert.rejects(
      () => estimateBatch(fx.ctx, request(fx, { promiseLevel: "strong_commitment" })),
      { code: "strong_rule_missing" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks hard limits and missing 30s stitcher capability before upstream work", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-limits-"));
  try {
    const fx = await fixture(root);
    await assert.rejects(
      () => estimateBatch(fx.ctx, request(fx, { variantCount: 51 })),
      { code: "hard_limit_exceeded" }
    );

    await assert.rejects(
      () => estimateBatch(fx.ctx, request(fx, { durationSec: 30, variantCount: 3 })),
      { code: "stitcher_unavailable" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns confirmation token for soft limits and validates it on start", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-confirm-"));
  try {
    const fx = await fixture(root);
    const estimated = await estimateBatch(fx.ctx, request(fx, { variantCount: 11 }));

    assert.equal(estimated.estimate.confirmationRequired, true);
    assert.match(estimated.estimate.confirmationToken, /^confirm_[a-f0-9]{16}$/);

    await assert.rejects(
      () => startBatchFromEstimate(fx.ctx, {
        idempotencyKey: "idem_start_missing",
        estimateId: estimated.estimate.estimateId
      }),
      { code: "limit_confirmation_required" }
    );

    const started = await startBatchFromEstimate(fx.ctx, {
      idempotencyKey: "idem_start_ok",
      estimateId: estimated.estimate.estimateId,
      confirmationToken: estimated.estimate.confirmationToken
    });
    assert.match(started.batch.batchId, /^wzb_\d{14}_[a-f0-9]{4}$/);
    assert.equal(started.batch.status, "queued");
    assert.equal(started.batch.projectRoot.includes(root), false);
    assert.equal(started.batch.estimate.estimateId, estimated.estimate.estimateId);

    const manifest = JSON.parse(await readFile(join(wangzhuanPaths(fx.ctx).batchesDir, started.batch.batchId, "batch.json"), "utf8"));
    assert.equal(manifest.batchId, started.batch.batchId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start is idempotent and refuses a second running batch in the same user project", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-lock-"));
  try {
    const fx = await fixture(root);
    const firstEstimate = await estimateBatch(fx.ctx, request(fx, { idempotencyKey: "idem_est_1" }));
    const first = await startBatchFromEstimate(fx.ctx, {
      idempotencyKey: "idem_start_1",
      estimateId: firstEstimate.estimate.estimateId
    });
    const replay = await startBatchFromEstimate(fx.ctx, {
      idempotencyKey: "idem_start_1",
      estimateId: firstEstimate.estimate.estimateId
    });
    assert.equal(replay.batch.batchId, first.batch.batchId);

    const secondEstimate = await estimateBatch(fx.ctx, request(fx, { idempotencyKey: "idem_est_2", variantCount: 2 }));
    await assert.rejects(
      () => startBatchFromEstimate(fx.ctx, {
        idempotencyKey: "idem_start_2",
        estimateId: secondEstimate.estimate.estimateId
      }),
      { code: "batch_already_running" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
