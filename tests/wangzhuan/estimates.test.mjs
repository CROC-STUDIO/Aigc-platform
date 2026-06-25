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
  prepareBatchPlanFromEstimate,
  startBatchFromEstimate
} from "../../server/wangzhuan/estimates.mjs";
import {
  closeWangzhuanFactsPool,
  loadBatchDetailFromMysql,
  syncBatchFacts,
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

test("estimates a batch from inline launch draft without saved template", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-est-inline-"));
  try {
    ensureFactsPool();
    const ctx = context(root);
    const checked = await checkReferenceVideo(ctx, validUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_decompose_inline",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: decomposition()
    });

    const result = await estimateBatch(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      projectName: "Inline Project",
      batchName: "inline_batch",
      targetChannel: "tiktok_ads",
      targetRegion: "BR",
      targetRegions: ["BR", "PT"],
      language: "pt-BR",
      languages: ["pt-BR", "en-US"],
      promiseLevel: "strong_conversion",
      durationSec: 15,
      variantCount: 2,
      requestedConcurrency: 2,
      outputRatio: "16:9",
      disclaimer: "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos",
      disclaimerPresetId: "auto",
      disclaimerPreset: "auto",
      disclaimerLanguage: "pt",
      disclaimerOverlay: {
        enabled: true,
        position: "bottom_left",
        fontSize: 24,
        boxHeight: 156,
        bottomMargin: 72,
        horizontalMargin: 48
      },
      templateSnapshot: {
        draft: {
          projectName: "Inline Project",
          batchName: "inline_batch",
          displayName: "Inline Draft",
          productName: "Lucky Cash",
          productLink: "https://play.google.com/store/apps/details?id=perkplay",
          cta: "Install now",
          ending: "Claim rewards today",
          currencySymbol: "R$",
          materialDirection: "本地奖励场景",
          voiceoverStyle: "Brazilian creator",
          promiseLevel: "strong_conversion",
          regions: ["BR", "PT"],
          languages: ["pt-BR", "en-US"],
          targetChannels: ["tiktok_ads"]
        }
      },
      branches: [
        {
          branchId: "branch_inline",
          branchLabel: "Inline Draft",
          productName: "Lucky Cash",
          productLink: "https://play.google.com/store/apps/details?id=perkplay",
          cta: "Install now",
          language: "pt-BR,en-US",
          regions: ["BR", "PT"],
          targetChannel: "tiktok_ads",
          materialDirection: "本地奖励场景",
          voiceoverStyle: "Brazilian creator",
          promiseLevel: "strong_conversion",
          ending: "Claim rewards today",
          currencySymbol: "R$"
        }
      ]
    });

    assert.equal(result.estimate.durationSec, 15);
    assert.equal(result.estimate.outputRatio, "16:9");
    assert.equal(result.estimate.branchCount, 1);
    assert.equal(result.estimate.scriptCount, 2);
    assert.equal(result.estimate.targetRegions.includes("BR"), true);
    assert.equal(result.estimate.languages.includes("pt-BR"), true);

    const loaded = await loadEstimate(ctx, result.estimate.estimateId);
    assert.equal(loaded.templateSnapshot?.templateId, undefined);
    assert.equal(loaded.templateSnapshot?.versionId, undefined);
    assert.equal(loaded.templateSnapshot?.draft?.productName, "Lucky Cash");
    assert.equal(loaded.request.templateId, undefined);
    assert.equal(loaded.request.templateSnapshot.draft.productName, "Lucky Cash");
    assert.equal(loaded.request.disclaimer, "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos");
    assert.equal(loaded.request.disclaimerPresetId, "auto");
    assert.equal(loaded.request.disclaimerPreset, "auto");
    assert.equal(loaded.request.disclaimerLanguage, "pt");
    assert.equal(loaded.request.disclaimerByLanguage["pt-BR"], "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos");
    assert.equal(loaded.request.disclaimerByLanguage["en-US"], "Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.");
    assert.equal(loaded.request.disclaimerOverlay.position, "bottom_left");
    assert.equal(loaded.request.disclaimerOverlay.fontSize, 24);
    assert.equal(loaded.request.disclaimerOverlay.boxHeight, 156);
    assert.equal(loaded.request.disclaimerOverlay.bottomMargin, 72);
    assert.equal(loaded.request.disclaimerOverlay.horizontalMargin, 48);
    assert.deepEqual(loaded.request.targetRegions, ["BR", "PT"]);
    assert.deepEqual(loaded.request.languages, ["pt-BR", "en-US"]);

    const started = await startBatchFromEstimate(ctx, {
      idempotencyKey: "idem_start_inline_estimate_hash",
      estimateId: result.estimate.estimateId
    });
    assert.equal(started.batch.templateSnapshot?.draft?.productName, "Lucky Cash");

    const detail = await loadBatchDetailFromMysql(ctx, started.batch.batchId);
    assert.equal(detail.batch.templateSnapshot?.draft?.productName, "Lucky Cash");
    assert.equal(detail.batch.templateSnapshot?.templateId, undefined);
    assert.equal(detail.batch.templateSnapshot?.versionId, undefined);

    await syncBatchFacts(ctx, {
      ...detail.batch,
      status: "stopped",
      stoppedAt: new Date().toISOString()
    }, "user_stop");

    const replanned = await estimateBatch(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      projectName: "Inline Project",
      batchName: "inline_batch",
      targetChannel: "tiktok_ads",
      targetRegion: "BR",
      targetRegions: ["BR", "PT"],
      language: "pt-BR",
      languages: ["pt-BR", "en-US"],
      promiseLevel: "strong_conversion",
      durationSec: 15,
      variantCount: 2,
      requestedConcurrency: 2,
      outputRatio: "16:9",
      disclaimer: "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos",
      disclaimerPresetId: "auto",
      disclaimerPreset: "auto",
      disclaimerLanguage: "pt",
      disclaimerOverlay: {
        enabled: true,
        position: "bottom_left",
        fontSize: 24,
        boxHeight: 156,
        bottomMargin: 72,
        horizontalMargin: 48
      },
      templateSnapshot: {
        draft: {
          projectName: "Inline Project",
          batchName: "inline_batch",
          displayName: "Inline Draft",
          productName: "Lucky Cash",
          productLink: "https://play.google.com/store/apps/details?id=perkplay",
          cta: "Install now",
          ending: "Claim rewards today",
          currencySymbol: "R$",
          materialDirection: "本地奖励场景",
          voiceoverStyle: "Brazilian creator",
          promiseLevel: "strong_conversion",
          regions: ["BR", "PT"],
          languages: ["pt-BR", "en-US"],
          targetChannels: ["tiktok_ads"]
        }
      },
      branches: [
        {
          branchId: "branch_inline",
          branchLabel: "Inline Draft",
          productName: "Lucky Cash",
          productLink: "https://play.google.com/store/apps/details?id=perkplay",
          cta: "Install now",
          language: "pt-BR,en-US",
          regions: ["BR", "PT"],
          targetChannel: "tiktok_ads",
          materialDirection: "本地奖励场景",
          voiceoverStyle: "Brazilian creator",
          promiseLevel: "strong_conversion",
          ending: "Claim rewards today",
          currencySymbol: "R$"
        }
      ]
    });

    const planned = await prepareBatchPlanFromEstimate({
      ...ctx,
      callWangzhuanLlm: async () => JSON.stringify({
        hook: "Earn with daily tasks",
        body: "Show a believable phone reward flow",
        voiceover: "Show the reward flow clearly",
        imagePrompt: "Vertical first frame with phone and reward UI",
        seedancePrompt: "Create a vertical reward ad with uploaded references",
        negativePrompt: "No competitor branding",
        cta: "Install now",
        complianceNotes: ["Keep claims realistic"]
      })
    }, {
      idempotencyKey: "idem_plan_inline_estimate_hash",
      estimateId: replanned.estimate.estimateId,
      llmConfig: { provider: "mock", model: "gpt-5.4", endpoint: "http://localhost/mock", temperature: 0.2 },
      knowledgeNotes: ""
    });
    assert.equal(planned.batch.status, "preview_required");
    assert.ok(planned.plans.length > 0);
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

test("plan reuses an existing draft batch id so earlier steps remain resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-draft-reuse-"));
  try {
    await resetFactsPool();
    ensureFactsPool();
    const fx = await fixture(root);
    const draftBatchId = "wzb_20260624193000_abcd";
    await syncBatchFacts(fx.ctx, {
      batchId: draftBatchId,
      status: "checking",
      userId: "alice",
      referenceVideo: { referenceVideoId: fx.referenceVideoId, fileName: "demo.mp4", status: "pass" },
      decomposition: decomposition(),
      request: {
        sourceStep: "decomposition_confirmed",
        referenceVideoId: fx.referenceVideoId
      },
      tasks: []
    }, "batch_draft_saved");

    const estimated = await estimateBatch(fx.ctx, request(fx, {
      variantCount: 1
    }));
    const { prepareBatchPlanFromEstimate } = await import("../../server/wangzhuan/estimates.mjs");
    const planned = await prepareBatchPlanFromEstimate({
      ...fx.ctx,
      callWangzhuanLlm: async () => JSON.stringify({
        hook: "Earn with daily tasks",
        body: "Show a believable phone reward flow with clear in-app progression",
        voiceover: "Show the reward flow clearly",
        imagePrompt: "Vertical first frame with phone, reward UI, and a clear task state",
        seedancePrompt: "Create a vertical reward ad with the uploaded references",
        negativePrompt: "No competitor branding",
        cta: "Install now",
        complianceNotes: ["Keep claims realistic"]
      })
    }, {
      idempotencyKey: "idem_plan_reuse_draft",
      batchId: draftBatchId,
      estimateId: estimated.estimate.estimateId,
      llmConfig: { provider: "mock", model: "gpt-5.4", endpoint: "http://localhost/mock", temperature: 0.2 },
      knowledgeNotes: ""
    });

    assert.equal(planned.batch.batchId, draftBatchId);
    const loaded = await loadBatchDetailFromMysql(fx.ctx, draftBatchId);
    assert.equal(loaded?.batch?.batchId, draftBatchId);
    assert.equal(loaded?.batch?.status, "preview_required");
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
