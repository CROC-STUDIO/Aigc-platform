import assert from "node:assert/strict";
import test from "node:test";

import {
  branchMediaFields,
  dedupeLeakedBranchAssets,
  normalizeBranchDrafts,
  resolveBranchMediaRefs
} from "../../server/wangzhuan/branches.mjs";
import { mergeBranchMediaDraft } from "../../server/wangzhuan/seedance-provider.mjs";
import { validateSeedancePlan } from "../../server/wangzhuan/plan-preview.mjs";

test("normalizeBranchDrafts keeps assets isolated per explicit fission branch", () => {
  const draft = {
    displayName: "Product A",
    productName: "Product A",
    assetUrls: {
      productIcon: "https://example.com/a-icon.png",
      productScreenshot: "https://example.com/a-shot.png"
    },
    branches: [
      {
        branchId: "branch_1",
        branchLabel: "改写 3.1",
        productName: "Product A",
        cta: "Install",
        materialDirection: "痛点开场",
        assetUrls: {
          productIcon: "https://example.com/a-icon.png",
          productScreenshot: "https://example.com/a-shot.png"
        }
      },
      {
        branchId: "branch_2",
        branchLabel: "改写 3.2",
        productName: "Product B",
        cta: "Play now",
        materialDirection: "余额刺激"
      }
    ]
  };

  const branches = normalizeBranchDrafts(draft);

  assert.equal(branches.length, 2);
  assert.equal(branches[0].assetUrls.productIcon, "https://example.com/a-icon.png");
  assert.equal(branches[1].assetUrls.productIcon, undefined);
  assert.deepEqual(branches[1].assetUrls, {});
  assert.equal(branches[1].branches, undefined);
});

test("normalizeBranchDrafts isolates assets when branch omits assetUrls key entirely", () => {
  const draft = {
    productName: "Product A",
    assetUrls: { productIcon: "https://example.com/a-icon.png" },
    branches: [
      {
        branchId: "branch_1",
        productName: "Product A",
        cta: "Install",
        materialDirection: "A",
        assetUrls: { productIcon: "https://example.com/a-icon.png" }
      },
      {
        branchId: "branch_2",
        productName: "Product B",
        cta: "Play",
        materialDirection: "B"
      }
    ]
  };

  const branch2 = normalizeBranchDrafts(draft).find((item) => item.branchId === "branch_2");
  assert.deepEqual(branch2.assetUrls, {});
  assert.deepEqual(branch2.assetReviews, {});
});

test("normalizeBranchDrafts inherits root assets for single-entry branches array", () => {
  const draft = {
    productName: "Product A",
    cta: "Install",
    materialDirection: "跟随竞品",
    assetUrls: { productIcon: "https://example.com/root-icon.png" },
    branches: [
      {
        branchId: "branch_1",
        productName: "Product A",
        cta: "Install",
        materialDirection: "跟随竞品"
      }
    ]
  };

  const branches = normalizeBranchDrafts(draft);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].assetUrls.productIcon, "https://example.com/root-icon.png");
});

test("normalizeBranchDrafts still inherits root assets for legacy single-branch drafts", () => {
  const draft = {
    displayName: "Legacy Product",
    productName: "Legacy Product",
    cta: "Install",
    materialDirection: "跟随竞品",
    assetUrls: {
      productIcon: "https://example.com/legacy-icon.png"
    }
  };

  const branches = normalizeBranchDrafts(draft);

  assert.equal(branches.length, 1);
  assert.equal(branches[0].assetUrls.productIcon, "https://example.com/legacy-icon.png");
});

test("branchMediaFields drops orphan review metadata without uploaded asset", () => {
  const media = branchMediaFields({
    assetReviews: {
      productIcon: { assetId: "asset_1", status: "approved" }
    }
  });

  assert.deepEqual(media.assetUrls, {});
  assert.deepEqual(media.assetReviews, {});
});

test("branchMediaFields preserves asset content hashes and drops reviews for different content", () => {
  const media = branchMediaFields({
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetContentHashes: { productIcon: "sha256:new-content" },
    assetReviews: {
      productIcon: {
        assetId: "asset_old",
        status: "approved",
        contentHash: "sha256:old-content"
      }
    }
  });

  assert.deepEqual(media.assetContentHashes, { productIcon: "sha256:new-content" });
  assert.deepEqual(media.assetReviews, {});
});

test("branchMediaFields does not bind a legacy hashless review to content-addressed media", () => {
  const media = branchMediaFields({
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetContentHashes: { productIcon: "sha256:new-content" },
    assetReviews: {
      productIcon: { assetId: "asset_legacy", status: "approved" }
    }
  });

  assert.deepEqual(media.assetReviews, {});
});

test("branchMediaFields does not inherit a hash or review when an override changes stable storage identity", () => {
  const media = branchMediaFields({
    assetFileNames: { productIcon: "replacement.png" },
    assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/replacement.png" },
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/replacement.png" }
  }, {
    inheritFrom: {
      assetFileNames: { productIcon: "original.png" },
      assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/original.png" },
      assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/original.png" },
      assetContentHashes: { productIcon: "sha256:original-content" },
      assetReviews: {
        productIcon: {
          assetId: "asset_original",
          status: "approved",
          contentHash: "sha256:original-content"
        }
      }
    }
  });

  assert.deepEqual(media.assetContentHashes, {});
  assert.deepEqual(media.assetReviews, {});
});

test("resolveBranchMediaRefs ignores foreign branch urls from llm output", () => {
  const branch = {
    assetUrls: {
      productIcon: "https://example.com/b-only.png"
    }
  };
  const refs = resolveBranchMediaRefs(branch, {
    productIcon: "https://example.com/a-icon.png",
    productScreenshot: "https://example.com/a-shot.png"
  });

  assert.deepEqual(refs, {
    productIcon: "https://example.com/b-only.png"
  });
});

test("validateSeedancePlan clamps mediaRefs to the current branch assets", () => {
  const payload = validateSeedancePlan({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Prompt",
    imagePrompt: "Image",
    cta: "CTA",
    negativePrompt: "None",
    mediaRefs: {
      productIcon: "https://example.com/a-icon.png",
      productScreenshot: "https://example.com/a-shot.png"
    }
  }, {
    branch: {
      branchId: "branch_2",
      assetUrls: {}
    },
    branchId: "branch_2"
  });

  assert.deepEqual(payload.mediaRefs, {});
});

test("dedupeLeakedBranchAssets removes cloned assets duplicated from branch 1", () => {
  const branches = dedupeLeakedBranchAssets([
    {
      branchId: "branch_1",
      productName: "Product A",
      cta: "Install",
      materialDirection: "A",
      assetUrls: { productIcon: "https://example.com/icon.png" },
      assetStorageKeys: { productIcon: "key_a" },
      assetFileNames: { productIcon: "a.png" }
    },
    {
      branchId: "branch_2",
      productName: "Product B",
      cta: "Play",
      materialDirection: "B",
      assetUrls: { productIcon: "https://example.com/icon.png" },
      assetStorageKeys: { productIcon: "key_a" },
      assetFileNames: { productIcon: "a.png" }
    }
  ]);

  assert.deepEqual(branches[1].assetUrls, {});
  assert.deepEqual(branches[1].assetStorageKeys, {});
});

test("validateSeedancePlan strips slot refs when branch has no assets", () => {
  const payload = validateSeedancePlan({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Use 图片1 as icon and 视频1 for motion",
    imagePrompt: "Show 图片1 clearly",
    cta: "CTA",
    negativePrompt: "None",
    mediaRefs: { productIcon: "https://example.com/a-icon.png" }
  }, {
    branch: { branchId: "branch_2", assetUrls: {} },
    branchId: "branch_2"
  });

  assert.match(payload.seedancePrompt, /产品画面/);
  assert.doesNotMatch(payload.seedancePrompt, /图片1/);
  assert.match(payload.imagePrompt, /产品画面/);
  assert.deepEqual(payload.mediaRefs, {});
});

test("mergeBranchMediaDraft does not backfill missing assets from stale script draft", () => {
  const merged = mergeBranchMediaDraft(
    {
      branchId: "branch_2",
      assetUrls: {}
    },
    {
      branchId: "branch_2",
      assetUrls: {
        productIcon: "https://example.com/a-icon.png"
      },
      assetReviews: {
        productIcon: { assetId: "asset_1", status: "approved" }
      }
    }
  );

  assert.deepEqual(merged.assetUrls, {});
  assert.deepEqual(merged.assetReviews, {});
});

test("mergeBranchMediaDraft preserves an approved review when the latest draft still points to the same asset", () => {
  const latest = {
    branchId: "branch_1",
    assetFileNames: { productIcon: "icon.png" },
    assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetContentHashes: { productIcon: "sha256:same-content" },
    assetReviews: {}
  };
  const base = {
    ...latest,
    assetReviews: {
      productIcon: {
        assetId: "asset_same_content",
        status: "approved",
        contentHash: "sha256:same-content"
      }
    }
  };

  const merged = mergeBranchMediaDraft(latest, base);

  assert.deepEqual(merged.assetReviews, base.assetReviews);
});

test("mergeBranchMediaDraft preserves legacy approved reviews using stable storage identity", () => {
  const latest = {
    branchId: "branch_1",
    assetFileNames: { productIcon: "icon.png" },
    assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetReviews: {}
  };
  const base = {
    ...latest,
    assetReviews: {
      productIcon: { assetId: "asset_legacy", status: "approved" }
    }
  };

  assert.deepEqual(mergeBranchMediaDraft(latest, base).assetReviews, base.assetReviews);
});

test("mergeBranchMediaDraft does not bind a legacy hashless review to a newly hashed asset", () => {
  const latest = {
    branchId: "branch_1",
    assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetContentHashes: { productIcon: "sha256:new-content" },
    assetReviews: {}
  };
  const base = {
    branchId: "branch_1",
    assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetReviews: {
      productIcon: { assetId: "asset_legacy", status: "approved" }
    }
  };

  assert.deepEqual(mergeBranchMediaDraft(latest, base).assetReviews, {});
});

test("mergeBranchMediaDraft rejects an approved review for replaced content at the same path", () => {
  const merged = mergeBranchMediaDraft(
    {
      branchId: "branch_1",
      assetFileNames: { productIcon: "icon.png" },
      assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
      assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
      assetContentHashes: { productIcon: "sha256:new-content" },
      assetReviews: {
        productIcon: {
          assetId: "asset_for_old_content",
          status: "approved",
          contentHash: "sha256:old-content"
        }
      }
    },
    {
      branchId: "branch_1",
      assetFileNames: { productIcon: "icon.png" },
      assetStorageKeys: { productIcon: "uploads/branch_1/productIcon/icon.png" },
      assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
      assetContentHashes: { productIcon: "sha256:old-content" },
      assetReviews: {
        productIcon: {
          assetId: "asset_for_old_content",
          status: "approved",
          contentHash: "sha256:old-content"
        }
      }
    }
  );

  assert.deepEqual(
    merged.assetReviews,
    {},
    "an approved assetId must not survive when the content hash no longer matches"
  );
});
