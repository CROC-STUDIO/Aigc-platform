import assert from "node:assert/strict";
import test from "node:test";

import {
  createBackgroundJob,
  getBackgroundJob,
  isPlanSignatureStale,
  planDraftSignature,
  resetBackgroundJobsForTest
} from "../../server/wangzhuan/background-jobs.mjs";

function waitForJob(jobId, expectedStatus) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const job = getBackgroundJob(jobId);
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

  const done = await waitForJob(job.id, "succeeded");

  assert.equal(done.status, "succeeded");
  assert.equal(done.progress, 100);
  assert.deepEqual(done.result.decomposition, { scene: "desk", subject: "phone" });
  assert.ok(done.events.some((event) => event.message === "开始拆解"));
});

test("background job records failed status and safe error message", async () => {
  const job = createBackgroundJob("seedance_plan", async () => {
    throw new Error("provider timeout");
  });

  const failed = await waitForJob(job.id, "failed");

  assert.equal(failed.status, "failed");
  assert.equal(failed.progress, 100);
  assert.equal(failed.error.message, "provider timeout");
});

test("background job bounds events", async () => {
  const job = createBackgroundJob("decomposition", async ({ log }) => {
    for (let index = 0; index < 100; index += 1) {
      log(`event ${index}`);
    }
    return { ok: true };
  });

  const done = await waitForJob(job.id, "succeeded");

  assert.equal(done.events.length, 80);
  assert.equal(done.events.at(-1).type, "succeeded");
  assert.ok(!done.events.some((event) => event.message === "event 0"));
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
    disclaimerOverlay: { position: "bottom_center", fontSize: 22 },
    disclaimerOverlayEnabled: true,
    disclaimerOverlayPosition: "bottom_center",
    disclaimerOverlayFontSize: 22
  };

  const signature = planDraftSignature(base);

  assert.equal(
    isPlanSignatureStale(signature, {
      ...base,
      disclaimerOverlay: { position: "bottom_left", fontSize: 30 },
      disclaimerOverlayPosition: "bottom_left",
      disclaimerOverlayFontSize: 30
    }),
    false
  );
  assert.equal(isPlanSignatureStale(signature, { ...base, productName: "Other App" }), true);
  assert.equal(isPlanSignatureStale(signature, { ...base, disclaimer: "changed disclaimer" }), false);
});
