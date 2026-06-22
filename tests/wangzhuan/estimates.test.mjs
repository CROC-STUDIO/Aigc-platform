import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import {
  estimateBatch,
  loadEstimate,
  startBatchFromEstimate
} from "../../server/wangzhuan/estimates.mjs";
import {
  closeWangzhuanFactsPool,
  loadBatchDetailFromMysql,
  setWangzhuanFactsPoolForTest
} from "../../server/wangzhuan/mysql-facts.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";

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

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

function context(root, overrides = {}) {
  const ctx = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
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
    cta: "Install today"
  };
}

async function fixture(root, draft = baseDraft) {
  ensureFactsPool();
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

async function resetFactsPool() {
  activePool = null;
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
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
    await resetFactsPool();
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
    await resetFactsPool();
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
      () => estimateBatch({
        ...fx.ctx,
        capabilities: { stitcher: { status: "unavailable" } }
      }, request(fx, { durationSec: 30, variantCount: 3 })),
      { code: "stitcher_unavailable" }
    );
  } finally {
    await resetFactsPool();
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

    const detail = await loadBatchDetailFromMysql(fx.ctx, started.batch.batchId);
    assert.equal(detail.batch.batchId, started.batch.batchId);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("estimates and starts every configured branch with its own prompt inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-branches-"));
  try {
    const branchDraft = {
      ...baseDraft,
      displayName: "Multi Branch Reward",
      productName: "News Cash",
      cta: "Open the news offer",
      ending: "Try the news path today",
      materialDirection: "新闻主播壳",
      customPrompt: "Use a blue virtual news studio.",
      assetFileNames: {
        productIcon: "news-icon.png"
      },
      assetUrls: {
        productIcon: "https://cdn.example.com/wangzhuan/news-icon.png",
        productScreenshot: "https://cdn.example.com/wangzhuan/news-screen.png"
      },
      branches: [
        {
          branchId: "branch_news",
          branchLabel: "新闻主播壳",
          productName: "News Cash",
          cta: "Open the news offer",
          ending: "Try the news path today",
          materialDirection: "新闻主播壳",
          customPrompt: "Use a blue virtual news studio.",
          assetFileNames: {
            productIcon: "news-icon.png"
          },
          assetStorageKeys: {
            productIcon: "uploads/wangzhuan/news-icon.png"
          },
          assetUrls: {
            productIcon: "https://cdn.example.com/wangzhuan/news-icon.png",
            productScreenshot: "https://cdn.example.com/wangzhuan/news-screen.png"
          }
        },
        {
          branchId: "branch_wallet",
          branchLabel: "钱包提现壳",
          productName: "Wallet Win",
          cta: "Check the wallet task",
          ending: "Try the wallet path today",
          materialDirection: "提现按钮",
          customPrompt: "Focus on a wallet dashboard and withdrawal button.",
          assetFileNames: {
            productIcon: "wallet-icon.png"
          },
          assetUrls: {
            productIcon: "https://cdn.example.com/wangzhuan/wallet-icon.png",
            productScreenshot: "https://cdn.example.com/wangzhuan/wallet-screen.png"
          }
        }
      ]
    };
    const fx = await fixture(root, branchDraft);
    const estimated = await estimateBatch(fx.ctx, request(fx, { variantCount: 2 }));

    assert.equal(estimated.estimate.branchCount, 2);
    assert.equal(estimated.estimate.variantCount, 2);
    assert.equal(estimated.estimate.scriptCount, 4);
    assert.equal(estimated.estimate.seedanceSegmentCount, 4);
    assert.equal(estimated.estimate.imageTaskCount, 4);
    assert.deepEqual(
      estimated.estimate.branchSummaries.map((branch) => [branch.branchId, branch.productName, branch.cta]),
      [
        ["branch_news", "News Cash", "Open the news offer"],
        ["branch_wallet", "Wallet Win", "Check the wallet task"]
      ]
    );

    const started = await startBatchFromEstimate(fx.ctx, {
      idempotencyKey: "idem_start_branch_estimate",
      estimateId: estimated.estimate.estimateId
    });
    const { batch } = started;

    assert.equal(batch.scripts.length, 4);
    assert.equal(batch.tasks.length, 4);
    assert.deepEqual([...new Set(batch.scripts.map((script) => script.branchId))], ["branch_news", "branch_wallet"]);
    assert.deepEqual(batch.scripts.map((script) => script.branchVariantIndex), [1, 2, 1, 2]);
    assert.equal(batch.scripts.some((script) => script.body.includes("News Cash") && script.body.includes("新闻主播壳")), true);
    assert.equal(batch.scripts.some((script) => script.body.includes("Wallet Win") && script.body.includes("提现按钮")), true);

    const newsTask = batch.tasks.find((task) => task.branchId === "branch_news");
    const walletTask = batch.tasks.find((task) => task.branchId === "branch_wallet");
    const newsPrompt = await readFile(join(fx.ctx.userProjectRoot, newsTask.promptPath), "utf8");
    const walletPrompt = await readFile(join(fx.ctx.userProjectRoot, walletTask.promptPath), "utf8");

    assert.match(newsPrompt, /Product: News Cash/);
    assert.match(newsPrompt, /CTA: Open the news offer/);
    assert.match(newsPrompt, /Material direction: 新闻主播壳/);
    assert.match(newsPrompt, /Product icon URL: https:\/\/cdn\.example\.com\/wangzhuan\/news-icon\.png/);
    assert.doesNotMatch(newsPrompt, /Product icon asset: news-icon\.png/);
    assert.match(newsPrompt, /Additional user prompt: Use a blue virtual news studio\./);
    assert.match(walletPrompt, /Product: Wallet Win/);
    assert.match(walletPrompt, /CTA: Check the wallet task/);
    assert.match(walletPrompt, /Material direction: 提现按钮/);
    assert.match(walletPrompt, /Product icon URL: https:\/\/cdn\.example\.com\/wangzhuan\/wallet-icon\.png/);
    assert.match(walletPrompt, /Additional user prompt: Focus on a wallet dashboard and withdrawal button\./);
  } finally {
    await resetFactsPool();
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
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
