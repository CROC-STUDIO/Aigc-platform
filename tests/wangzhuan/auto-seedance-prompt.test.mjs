import assert from "node:assert/strict";
import test from "node:test";

import { autoGenerateSeedancePrompt } from "../../server/wangzhuan/auto-seedance-prompt.mjs";

function makeBatch(overrides = {}) {
  return {
    batchId: "wzb_20260709000000_abcd",
    request: {
      batchName: "Demo batch",
      targetRegion: "US",
      targetRegions: ["US"],
      language: "en-US",
      languages: ["en-US"],
      outputRatio: "9:16",
      knowledgeNotes: "Keep real product UI.",
      ...overrides.request
    },
    estimate: {
      durationSec: 15,
      outputRatio: "9:16",
      ...overrides.estimate
    },
    templateSnapshot: {
      draft: {
        productName: "Demo App",
        ...overrides.templateDraft
      }
    },
    decomposition: {
      scene: "phone closeup",
      style: "ugc proof",
      ...overrides.decomposition
    },
    branchDrafts: overrides.branchDrafts || [
      {
        branchId: "branch_1",
        branchLabel: "改写 3.1",
        productName: "Demo App",
        productLink: "https://example.test/app",
        cta: "Install now",
        ending: "Try it today",
        materialDirection: "真实演示",
        voiceoverStyle: "自然口播",
        customPrompt: "突出真实 UI",
        negativePrompt: "不要水印",
        regions: ["US"],
        languages: ["en-US"]
      }
    ],
    ...overrides
  };
}

test("autoGenerateSeedancePrompt chooses refine when approved assets exist", async () => {
  const context = {
    getBatchDetail: async () => ({ batch: makeBatch() }),
    confirmBatchAssets: async (_context, batchId) => ({
      batch: makeBatch({
        batchId,
        branchDrafts: [
          {
            branchId: "branch_1",
            branchLabel: "改写 3.1",
            productName: "Demo App",
            productLink: "https://example.test/app",
            cta: "Install now",
            ending: "Try it today",
            materialDirection: "真实演示",
            voiceoverStyle: "自然口播",
            customPrompt: "突出真实 UI",
            negativePrompt: "不要水印",
            regions: ["US"],
            languages: ["en-US"],
            assetFileNames: { productScreenshot_1: "shot1.png" },
            assetUrls: { productScreenshot_1: "https://cdn.test/shot1.png" },
            assetStorageKeys: { productScreenshot_1: "s3://shot1" },
            assetStoredPaths: { productScreenshot_1: "批处理记录/网赚管线/product-assets/branch_1/productScreenshot_1/shot1.png" },
            assetReviews: { productScreenshot_1: { assetId: "asset_1", status: "approved" } }
          }
        ]
      }),
      branches: [
        {
          branchId: "branch_1",
          branchLabel: "改写 3.1",
          productName: "Demo App",
          productLink: "https://example.test/app",
          cta: "Install now",
          ending: "Try it today",
          materialDirection: "真实演示",
          voiceoverStyle: "自然口播",
          customPrompt: "突出真实 UI",
          negativePrompt: "不要水印",
          regions: ["US"],
          languages: ["en-US"],
          assetFileNames: { productScreenshot_1: "shot1.png" },
          assetUrls: { productScreenshot_1: "https://cdn.test/shot1.png" },
          assetStorageKeys: { productScreenshot_1: "s3://shot1" },
          assetStoredPaths: { productScreenshot_1: "批处理记录/网赚管线/product-assets/branch_1/productScreenshot_1/shot1.png" },
          assetReviews: { productScreenshot_1: { assetId: "asset_1", status: "approved" } }
        }
      ],
      reviewResult: { ok: true, failures: [], assetsByBranch: [] }
    }),
    refineSeedancePromptWithApprovedAssets: async (input) => {
      assert.equal(input.batchId, "wzb_20260709000000_abcd");
      assert.equal(input.productContext.productName, "Demo App");
      assert.equal(input.approvedAssets.length, 1);
      assert.deepEqual(input.forbiddenItems, ["不要水印"]);
      return {
        promptDraftUid: "cpd_refine",
        batchId: input.batchId,
        draftType: "refine",
        version: 1,
        status: "ready",
        prompt: "refined prompt",
        negativePrompt: "no clutter",
        reasoningSummary: "summary",
        complianceChecks: ["approved only"],
        warnings: [],
        approvedAssetKeysUsed: ["productScreenshot_1"],
        usesApprovedAssets: true
      };
    }
  };

  const result = await autoGenerateSeedancePrompt(context, "wzb_20260709000000_abcd", { requestId: "req_test" });
  assert.equal(result.mode, "refine");
  assert.equal(result.approvedAssetCount, 1);
  assert.equal(result.promptDraft.promptDraftUid, "cpd_refine");
});

test("autoGenerateSeedancePrompt falls back to base when no approved assets exist", async () => {
  const context = {
    getBatchDetail: async () => ({ batch: makeBatch() }),
    confirmBatchAssets: async () => ({
      batch: makeBatch(),
      branches: makeBatch().branchDrafts,
      reviewResult: { ok: true, failures: [], assetsByBranch: [] }
    }),
    generateBaseSeedancePrompt: async (input) => {
      assert.equal(input.approvedAssets.length, 0);
      assert.equal(input.style, "真实演示");
      return {
        promptDraftUid: "cpd_base",
        batchId: input.batchId,
        draftType: "base",
        version: 1,
        status: "ready",
        prompt: "base prompt",
        negativePrompt: "no clutter",
        reasoningSummary: "summary",
        complianceChecks: ["base"],
        warnings: [],
        approvedAssetKeysUsed: [],
        usesApprovedAssets: false
      };
    }
  };

  const result = await autoGenerateSeedancePrompt(context, "wzb_20260709000000_abcd", {});
  assert.equal(result.mode, "base");
  assert.equal(result.approvedAssetCount, 0);
  assert.equal(result.promptDraft.promptDraftUid, "cpd_base");
});

test("autoGenerateSeedancePrompt rejects when decomposition is not ready", async () => {
  const context = {
    getBatchDetail: async () => ({
      batch: makeBatch({ decomposition: null })
    })
  };

  await assert.rejects(
    autoGenerateSeedancePrompt(context, "wzb_20260709000000_abcd", {}),
    (error) => {
      assert.equal(error.code, "validation_error");
      assert.equal(error.data.reason, "decomposition_not_ready");
      return true;
    }
  );
});
