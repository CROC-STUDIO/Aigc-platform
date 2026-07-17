import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBackgroundJob,
  getBackgroundJob,
  isPlanSignatureStale,
  planDraftSignature,
  resetBackgroundJobsForTest
} from "../../server/wangzhuan/background-jobs.mjs";

function waitForJob(context, jobId, expectedStatus) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const job = await getBackgroundJob(context, jobId);
      if (job?.status === expectedStatus) {
        clearInterval(timer);
        resolve(job);
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${expectedStatus}`));
      }
    }, 5);
  });
}

test.beforeEach(() => {
  resetBackgroundJobsForTest();
});

test("background job starts queued and resolves with events", async () => {
  const job = createBackgroundJob("decomposition", async ({ log, progress }) => {
    log("开始拆解");
    progress(45, "模型处理中");
    return { decomposition: { scene: "desk", subject: "phone" } };
  });

  assert.equal(job.status, "queued");
  assert.equal(job.type, "decomposition");

  const done = await waitForJob(null, job.id, "succeeded");

  assert.equal(done.status, "succeeded");
  assert.equal(done.progress, 100);
  assert.deepEqual(done.result.decomposition, { scene: "desk", subject: "phone" });
  assert.ok(done.events.some((event) => event.message === "开始拆解"));
});

test("background job records failed status and safe error message", async () => {
  const job = createBackgroundJob("seedance_plan", async () => {
    throw new Error("provider timeout");
  });

  const failed = await waitForJob(null, job.id, "failed");

  assert.equal(failed.status, "failed");
  assert.equal(failed.progress, 100);
  assert.equal(failed.error.message, "provider timeout");
});

test("background job invokes onError hook before persisting failure", async () => {
  const calls = [];
  const job = createBackgroundJob("decomposition", async () => {
    throw new Error("provider timeout");
  }, {
    onError: async ({ error, job: publicJob }) => {
      calls.push({
        message: error.message,
        jobId: publicJob.id,
        status: publicJob.status
      });
    }
  });

  const failed = await waitForJob(null, job.id, "failed");

  assert.equal(failed.status, "failed");
  assert.deepEqual(calls, [{
    message: "provider timeout",
    jobId: job.id,
    status: "running"
  }]);
});

test("background job bounds events", async () => {
  const job = createBackgroundJob("decomposition", async ({ log }) => {
    for (let index = 0; index < 100; index += 1) {
      log(`event ${index}`);
    }
    return { ok: true };
  });

  const done = await waitForJob(null, job.id, "succeeded");

  assert.equal(done.events.length, 80);
  assert.equal(done.events.at(-1).type, "succeeded");
  assert.ok(!done.events.some((event) => event.message === "event 0"));
});

test("background job persists to file and can be reloaded without memory state", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-jobs-"));
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root
  };
  const job = createBackgroundJob("decomposition", async ({ log }) => {
    log("开始拆解");
    return { decomposition: { scene: "desk" } };
  }, { context });

  const done = await waitForJob(context, job.id, "succeeded");
  assert.equal(done.status, "succeeded");
  const startedAt = Date.now();
  let persisted = await getBackgroundJob(context, job.id);
  while (persisted?.status !== "succeeded" && Date.now() - startedAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    persisted = await getBackgroundJob(context, job.id);
  }
  assert.equal(persisted.status, "succeeded");

  resetBackgroundJobsForTest();
  const reloaded = await getBackgroundJob(context, job.id);
  assert.equal(reloaded.status, "succeeded");
  assert.deepEqual(reloaded.result.decomposition, { scene: "desk" });
  assert.ok(reloaded.events.some((event) => event.message === "开始拆解"));
});

test("background job persists retry event metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-jobs-"));
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root
  };
  const job = createBackgroundJob("decomposition", async ({ log }) => {
    log("拆解模型重试 1/3", {
      reason: "timeout",
      upstreamMessage: "Request timed out after 180s",
      code: "model_failed",
      status: 504
    });
    return { decomposition: { scene: "desk" } };
  }, { context });

  const done = await waitForJob(context, job.id, "succeeded");
  const retryEvent = done.events.find((event) => event.message === "拆解模型重试 1/3");
  assert.deepEqual(retryEvent?.data, {
    reason: "timeout",
    upstreamMessage: "Request timed out after 180s",
    code: "model_failed",
    status: 504
  });

  resetBackgroundJobsForTest();
  const reloaded = await getBackgroundJob(context, job.id);
  const persistedRetryEvent = reloaded.events.find((event) => event.message === "拆解模型重试 1/3");
  assert.deepEqual(persistedRetryEvent?.data, {
    reason: "timeout",
    upstreamMessage: "Request timed out after 180s",
    code: "model_failed",
    status: 504
  });
});

test("plan draft signature includes strong fields and ignores disclaimer overlay fields", () => {
  const base = {
    productName: "Cash App",
    productLink: "https://example.com/app",
    assets: [{ assetId: "asset_1", category: "product_icon" }],
    targetChannel: "meta_ads",
    targetRegion: "US",
    targetRegions: ["US"],
    language: "en-US",
    languages: ["en-US"],
    materialDirection: "痛点开场",
    materialDirectionCustom: "",
    voiceoverStyle: "遵循竞品",
    promiseLevel: "strong_conversion",
    currencySymbol: "$",
    cta: "Download now",
    ending: "Try today",
    variantPrompt: "变体一",
    customPrompt: "补充",
    negativePrompt: "不要水印",
    disclaimer: "post processing only",
    disclaimerOverlay: { position: "bottom_center", boxHeight: 88, imageStoredPath: "a.png" },
    disclaimerOverlayEnabled: true,
    disclaimerOverlayPosition: "bottom_center",
    disclaimerOverlayBoxHeight: 88
  };

  const signature = planDraftSignature(base);

  assert.equal(
    isPlanSignatureStale(signature, {
      ...base,
      disclaimerOverlay: { position: "bottom_left", boxHeight: 120, imageStoredPath: "b.png" },
      disclaimerOverlayPosition: "bottom_left",
      disclaimerOverlayBoxHeight: 120
    }),
    false
  );
  assert.equal(isPlanSignatureStale(signature, { ...base, productName: "Other App" }), true);
  assert.equal(isPlanSignatureStale(signature, { ...base, disclaimer: "changed disclaimer" }), false);
});

test("plan draft signature ignores transient asset review state but tracks prompt inputs", () => {
  const base = {
    productName: "Cash App",
    targetRegion: "US",
    language: "en-US",
    truthRules: { earningMechanism: "Complete tasks for points" },
    decomposition: { scene: "Kitchen", subject: "A parent using a phone" },
    branches: [{
      branchId: "branch_1",
      branchLabel: "改写 3.1",
      productName: "Cash App",
      customPrompt: "Keep the hook direct",
      assetFileNames: { productIcon: "icon.png" },
      assetUrls: { productIcon: "https://cdn.test/icon.png" },
      assetStorageKeys: { productIcon: "uploads/icon.png" },
      assetStoredPaths: { productIcon: "product-assets/icon.png" },
      assetReviews: {
        productIcon: { assetId: "asset_1", status: "pending" },
        productRecording: { status: "pending" }
      },
      postProcess: { subtitles: { fontSize: 40 } },
      disclaimerOverlay: { position: "bottom_center" }
    }]
  };
  const signature = planDraftSignature(base);

  const beforeFirstReview = {
    ...base,
    branches: [{
      ...base.branches[0],
      assetReviews: {
        productIcon: { status: "pending" }
      }
    }]
  };
  const beforeFirstReviewSignature = planDraftSignature(beforeFirstReview);
  assert.equal(isPlanSignatureStale(beforeFirstReviewSignature, {
    ...beforeFirstReview,
    branches: [{
      ...beforeFirstReview.branches[0],
      assetReviews: {
        productIcon: { assetId: "asset_first_review", status: "approved" }
      }
    }]
  }), false, "assigning the first review assetId must not invalidate an unchanged underlying asset");

  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    branches: [{
      ...base.branches[0],
      assetReviews: {
        productIcon: { assetId: "asset_1", status: "approved" },
        productRecording: { status: "pending", reviewReason: "orphan review" }
      },
      postProcess: { subtitles: { fontSize: 60 } },
      disclaimerOverlay: { position: "bottom_left" }
    }]
  }), false);
  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    truthRules: { earningMechanism: "Watch ads for points" }
  }), true);
  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    decomposition: { scene: "Bus stop", subject: "A commuter using a phone" }
  }), true);
  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    branches: [{ ...base.branches[0], customPrompt: "Use a testimonial hook" }]
  }), true);
  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    branches: [{
      ...base.branches[0],
      assetStorageKeys: { productIcon: "uploads/replacement-icon.png" }
    }]
  }), true);
  assert.equal(isPlanSignatureStale(signature, {
    ...base,
    branches: [{
      ...base.branches[0],
      assetReviews: {
        productIcon: { assetId: "asset_replacement", status: "approved" }
      }
    }]
  }), false, "review assetId changes are transient when stable storage identity is unchanged");

  const contentAddressedBase = {
    ...base,
    branches: [{
      ...base.branches[0],
      assetContentHashes: { productIcon: "sha256:old-content" },
      assetReviews: {
        productIcon: {
          assetId: "asset_old",
          status: "approved",
          contentHash: "sha256:old-content"
        }
      }
    }]
  };
  assert.equal(isPlanSignatureStale(planDraftSignature(contentAddressedBase), {
    ...contentAddressedBase,
    branches: [{
      ...contentAddressedBase.branches[0],
      assetContentHashes: { productIcon: "sha256:new-content" },
      assetReviews: {}
    }]
  }), true, "replacing the underlying asset content must invalidate the prompt");
});
