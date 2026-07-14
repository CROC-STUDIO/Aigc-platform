import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  normalizeSeedancePayloadDuration
} from "../../server/wangzhuan/seedance-provider.mjs";

function reviewed(assetId) {
  return { assetId, status: "approved" };
}

function batchWithTailAssets() {
  const branchDraft = {
    branchId: "branch_1",
    assetUrls: {
      productIcon: "https://assets.test/icon.png",
      ctaAsset: "https://assets.test/cta.png",
      endingAsset: "https://assets.test/ending.png"
    },
    assetStoredPaths: {
      productIcon: "product-assets/branch_1/productIcon/icon.png",
      ctaAsset: "product-assets/branch_1/ctaAsset/cta.png",
      endingAsset: "product-assets/branch_1/endingAsset/ending.png"
    },
    assetReviews: {
      productIcon: reviewed("asset_icon"),
      ctaAsset: reviewed("asset_cta"),
      endingAsset: reviewed("asset_ending")
    }
  };
  return {
    branchDrafts: [branchDraft],
    scripts: [
      { scriptId: "script_1", branchId: "branch_1", branchDraft },
      { scriptId: "script_2", branchId: "branch_1", branchDraft }
    ],
    tasks: [
      { generationTaskId: "gen_1", scriptId: "script_1", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 1 },
      { generationTaskId: "gen_2", scriptId: "script_2", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 2 }
    ]
  };
}

test("CTA and Ending images are not submitted as Seedance references before final slice", () => {
  const batch = batchWithTailAssets();
  const media = collectSeedanceMedia(batch, batch.tasks[0]);

  assert.deepEqual(media.map((item) => item.assetKey), ["productIcon"]);
});

test("CTA and Ending images are submitted as references only for final Seedance slice", () => {
  const batch = batchWithTailAssets();
  const media = collectSeedanceMedia(batch, batch.tasks[1]);

  assert.deepEqual(media.map((item) => item.assetKey), ["productIcon", "ctaAsset", "endingAsset"]);
  assert.deepEqual(media.map((item) => item.assetId), ["asset_icon", "asset_cta", "asset_ending"]);
});

test("Seedance payload duration is rounded up to an integer for upstream validation", () => {
  assert.equal(normalizeSeedancePayloadDuration(11.398), 12);
  assert.equal(normalizeSeedancePayloadDuration("8.1"), 9);
  assert.equal(normalizeSeedancePayloadDuration(15), 15);
  assert.equal(normalizeSeedancePayloadDuration("bad"), 15);

  const payload = buildSeedanceGenerationPayload({
    model: "dreamina-seedance-2-0-fast-260128",
    prompt: "test prompt",
    duration: 11.398
  });
  assert.equal(payload.duration, 12);
});
