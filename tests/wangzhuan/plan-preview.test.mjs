import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateBatch, prepareBatchPlanFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import {
  confirmBatchPlan,
  getBatchDetail,
  submitPendingGenerationTasks
} from "../../server/wangzhuan/pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { closeWangzhuanFactsPool, setWangzhuanFactsPoolForTest } from "../../server/wangzhuan/mysql-facts.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";

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
  promiseLevel: "strong_conversion",
  truthRules: {
    rewardAmountRange: "$0.10-$2.00",
    rewardCondition: "completing daily tasks",
    withdrawalThreshold: "$10 minimum balance",
    payoutTiming: "within 7 business days"
  },
  assetUrls: {
    productIcon: "https://cdn.example.com/wangzhuan/lucky-cash-icon.png"
  },
  materialDirection: "余额刺激",
  voiceoverStyle: "US English natural host"
};

function mockPlanPayload(suffix = "1") {
  return {
    hook: `Hook ${suffix}`,
    body: `Body ${suffix}`,
    voiceover: `Voiceover ${suffix}`,
    subtitles: [`Subtitle ${suffix}`],
    cta: "Download now",
    ending: "Try it today",
    imagePrompt: `Image prompt ${suffix}`,
    seedancePrompt: `Seedance prompt ${suffix}`,
    negativePrompt: "No competitor logos",
    mediaRefs: {
      productIcon: "https://cdn.example.com/wangzhuan/lucky-cash-icon.png"
    },
    complianceNotes: ["Do not guarantee payout timing"]
  };
}

function context(root, overrides = {}) {
  let llmCalls = 0;
  let seedanceCalls = 0;
  const ctx = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
    callWangzhuanLlm: async () => {
      llmCalls += 1;
      return JSON.stringify(mockPlanPayload(String(llmCalls)));
    },
    seedanceProviderClient: {
      provider: "mock_seedance",
      model: "mock-model",
      config: {},
      async createTask() {
        seedanceCalls += 1;
        return { taskId: `mock_seedance_${seedanceCalls}` };
      },
      async getTask(taskId) {
        return { taskId, status: "succeeded", videoUrl: "https://example.com/video.mp4" };
      },
      async downloadVideo() {
        return Buffer.from("video");
      }
    },
    get llmCallCount() {
      return llmCalls;
    },
    get seedanceCallCount() {
      return seedanceCalls;
    },
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

async function resetFactsPool() {
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

async function fixture(root, overrides = {}) {
  setWangzhuanFactsPoolForTest(fakePool());
  const ctx = context(root, overrides.context);
  const saved = await saveTemplate(ctx, { mode: "create", draft: overrides.draft || baseDraft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: "idem_decompose_plan",
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
    durationSec: overrides.durationSec || 15,
    variantCount: overrides.variantCount || 2,
    requestedConcurrency: 1,
    outputRatio: "9:16",
    branches: overrides.branches
  });
  return { ctx, estimated, saved };
}

test("plan generates one LLM plan per branch variant segment without submitting Seedance", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-single-"));
  try {
    const branchDraft = {
      ...baseDraft,
      branches: [
        {
          branchId: "branch_news",
          branchLabel: "新闻主播壳",
          productName: "News Cash",
          cta: "Open the news offer"
        },
        {
          branchId: "branch_wallet",
          branchLabel: "钱包提现壳",
          productName: "Wallet Win",
          cta: "Check the wallet task"
        }
      ]
    };
    const { ctx, estimated } = await fixture(root, {
      draft: branchDraft,
      variantCount: 2
    });
    assert.equal(estimated.estimate.branchCount, 2);
    assert.equal(estimated.estimate.seedanceSegmentCount, 4);

    const planned = await prepareBatchPlanFromEstimate(ctx, {
      idempotencyKey: "idem_plan_multi_branch",
      estimateId: estimated.estimate.estimateId
    });
    const batch = planned.batch;

    assert.equal(batch.status, "preview_required");
    assert.equal(batch.previewType, "seedance_plan");
    assert.equal(planned.plans.length, 4);
    assert.equal(batch.tasks.length, 4);
    assert.equal(ctx.llmCallCount, 4);
    assert.equal(ctx.seedanceCallCount, 0);
    assert.ok(batch.tasks.every((task) => task.status === "pending_preview"));
    assert.ok(planned.plans.every((plan) => plan.seedancePrompt.startsWith("Seedance prompt")));

    const submitAttempt = await submitPendingGenerationTasks(ctx, batch.batchId);
    assert.equal(submitAttempt.submittedCount, 0);
    assert.equal(ctx.seedanceCallCount, 0);
    assert.ok(submitAttempt.batch.tasks.every((task) => task.status === "pending_preview"));
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("confirm-plan promotes preview tasks and submits Seedance only after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-confirm-"));
  try {
    const { ctx, estimated } = await fixture(root, { variantCount: 1 });
    const planned = await prepareBatchPlanFromEstimate(ctx, {
      idempotencyKey: "idem_plan_confirm",
      estimateId: estimated.estimate.estimateId
    });
    assert.equal(planned.plans.length, 1);
    assert.equal(ctx.seedanceCallCount, 0);

    const confirmed = await confirmBatchPlan(ctx, planned.batch.batchId, {
      idempotencyKey: "idem_confirm_plan",
      confirmedPlanIds: planned.plans.map((plan) => plan.planId)
    });
    assert.equal(confirmed.batch.status, "queued");
    assert.equal(confirmed.batch.plans[0].status, "confirmed");

    const submitted = await submitPendingGenerationTasks(ctx, planned.batch.batchId);
    assert.equal(submitted.submittedCount, 1);
    assert.equal(ctx.seedanceCallCount, 1);
    assert.equal(submitted.batch.tasks[0].status, "waiting_upstream");

    const prompt = await readFile(join(ctx.userProjectRoot, submitted.batch.tasks[0].promptPath), "utf8");
    assert.match(prompt, /^Seedance prompt 1/);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("plan blocks strong commitment branches missing truth rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-strong-"));
  try {
    const { ctx, estimated } = await fixture(root, {
      draft: {
        ...baseDraft,
        promiseLevel: "stable",
        truthRules: {},
        branches: [
          {
            branchId: "branch_strong",
            branchLabel: "强承诺壳",
            productName: "Strong Cash",
            promiseLevel: "strong_commitment",
            truthRules: {}
          }
        ]
      },
      variantCount: 1
    });
    await assert.rejects(
      () => prepareBatchPlanFromEstimate(ctx, {
        idempotencyKey: "idem_plan_strong_missing",
        estimateId: estimated.estimate.estimateId
      }),
      { code: "strong_rule_missing" }
    );
    assert.equal(ctx.llmCallCount, 0);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("batch detail restores generated plans from capability snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-detail-"));
  try {
    const { ctx, estimated } = await fixture(root, { variantCount: 2 });
    const planned = await prepareBatchPlanFromEstimate(ctx, {
      idempotencyKey: "idem_plan_detail",
      estimateId: estimated.estimate.estimateId
    });
    const detail = await getBatchDetail(ctx, planned.batch.batchId);
    assert.equal(detail.batch.status, "preview_required");
    assert.equal(detail.batch.plans.length, 2);
    assert.equal(detail.batch.plans[0].branchLabel, "Cash Reward US EN");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
