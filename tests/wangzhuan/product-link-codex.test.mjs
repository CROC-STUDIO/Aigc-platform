import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateSeedancePromptFromParsedProductLink,
  getParsedProductLinkReviewStatus,
  parseProductLinkForSeedance,
  reviewParsedProductLinkAssets
} from "../../server/wangzhuan/product-link-codex.mjs";

function makeContext(root) {
  return {
    userProjectRoot: root,
    sharedProjectRoot: root,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", url.endsWith(".mp4") ? "video/mp4" : "image/png"]]),
      arrayBuffer: async () => (url.endsWith(".mp4") ? Buffer.from("video-bytes") : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    }),
    inspectStorePageProvider: async () => ({
      candidates: {
        productName: "Demo App",
        shortDescription: "Fast hook utility app",
        description: "A demo app description",
        icon: { url: "https://assets.test/icon.png", label: "icon" },
        screenshots: [
          { url: "https://assets.test/s1.png", label: "shot1" },
          { url: "https://assets.test/s2.png", label: "shot2" }
        ],
        videoPreviews: [
          { url: "https://assets.test/demo.mp4", label: "video1" }
        ],
        coreSellingPoints: ["fast", "simple"]
      },
      productBrief: {
        productName: "Demo App",
        coreSellingPoints: ["fast", "simple"],
        mustShow: ["真实 UI"],
        mustAvoid: ["不要编造"]
      }
    }),
    reviewProductAsset: async (asset) => ({
      assetId: `review_${asset.assetKey}`,
      status: "approved",
      contentUrl: asset.storageUrl
    }),
    syncWangzhuanAsset: async ({ fullPath, assetKind }) => ({
      storageKey: `s3://${assetKind}`,
      storageUrl: `https://cdn.test/${encodeURIComponent(fullPath)}`,
      storedPath: fullPath,
      localOnly: false
    }),
    generateBaseSeedancePrompt: async ({ batchId, productContext, requestId }) => ({
      promptDraftUid: "cpd_base",
      batchId,
      draftType: "base",
      version: 1,
      status: "ready",
      usesApprovedAssets: false,
      prompt: `base:${productContext.title}`,
      negativePrompt: "no watermark",
      reasoningSummary: "base summary",
      complianceChecks: ["check"],
      warnings: [],
      approvedAssetKeysUsed: [],
      requestId
    }),
    refineSeedancePromptWithApprovedAssets: async ({ batchId, approvedAssets, requestId }) => ({
      promptDraftUid: "cpd_refine",
      batchId,
      draftType: "refine",
      version: 1,
      status: "ready",
      usesApprovedAssets: true,
      prompt: `refine:${approvedAssets.length}`,
      negativePrompt: "no clutter",
      reasoningSummary: "refine summary",
      complianceChecks: ["approved only"],
      warnings: [],
      approvedAssetKeysUsed: approvedAssets.map((item) => item.assetKey),
      requestId
    })
  };
}

test("parseProductLinkForSeedance normalizes product context and candidate assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-link-parse-"));
  const context = makeContext(root);
  const result = await parseProductLinkForSeedance(context, { url: "https://play.google.com/store/apps/details?id=demo.app" });

  assert.equal(result.productContext.title, "Demo App");
  assert.equal(result.candidateAssets.length, 4);
  assert.equal(result.candidateAssets[0].assetKey, "productIcon");
  assert.equal(result.candidateAssets[1].assetKey, "productScreenshot_1");
});

test("reviewParsedProductLinkAssets downloads, uploads, reviews, and persists approved assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-link-review-"));
  const context = makeContext(root);
  const parsed = await parseProductLinkForSeedance(context, { url: "https://play.google.com/store/apps/details?id=demo.app" });
  const review = await reviewParsedProductLinkAssets(context, {
    batchId: "wzb_20260709000000_abcd",
    parseUid: parsed.parseUid,
    candidateAssetIds: [parsed.candidateAssets[0].candidateAssetId, parsed.candidateAssets[1].candidateAssetId]
  });

  assert.equal(review.items.length, 2);
  assert.equal(review.summary.approvedCount, 2);
  assert.equal(review.summary.approvedAssets[0].reviewStatus, "approved");

  const stored = await getParsedProductLinkReviewStatus(context, "wzb_20260709000000_abcd");
  assert.equal(stored.summary.approvedCount, 2);
});

test("generateSeedancePromptFromParsedProductLink uses parsed product context and approved assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "product-link-prompt-"));
  const context = makeContext(root);
  const parsed = await parseProductLinkForSeedance(context, { url: "https://play.google.com/store/apps/details?id=demo.app" });
  await reviewParsedProductLinkAssets(context, {
    batchId: "wzb_20260709000000_abcd",
    parseUid: parsed.parseUid,
    candidateAssetIds: [parsed.candidateAssets[0].candidateAssetId]
  });

  const base = await generateSeedancePromptFromParsedProductLink(context, {
    batchId: "wzb_20260709000000_abcd",
    parseUid: parsed.parseUid,
    targetRegion: "US",
    language: "en"
  }, "base");
  assert.equal(base.prompt, "base:Demo App");

  const refine = await generateSeedancePromptFromParsedProductLink(context, {
    batchId: "wzb_20260709000000_abcd",
    parseUid: parsed.parseUid,
    targetRegion: "US",
    language: "en"
  }, "refine");
  assert.equal(refine.prompt, "refine:1");

  const input = JSON.parse(await readFile(join(
    root,
    "批处理记录",
    "网赚管线",
    "product-link",
    "wzb_20260709000000_abcd",
    "codex-refine-input.json"
  ), "utf8"));
  assert.equal(input.approvedAssets.length, 1);
});
