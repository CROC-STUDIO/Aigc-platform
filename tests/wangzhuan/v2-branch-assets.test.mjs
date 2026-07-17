import assert from "node:assert/strict";
import test from "node:test";

import {
  branchHasReferenceAsset,
  pruneOrphanAssetReviews
} from "../../public/wangzhuan-branch-assets.js";

test("v2 branch asset review pruning keeps real assets and drops orphan reviews", () => {
  const branch = {
    branchId: "branch_1",
    assetFileNames: { productIcon: "icon.png" },
    assetUrls: {},
    assetStorageKeys: { productIcon: "uploads/icon.png" },
    assetStoredPaths: {},
    assetReviews: {
      productIcon: { assetId: "asset_icon", status: "approved" },
      productRecording: { status: "pending" }
    }
  };

  const result = pruneOrphanAssetReviews(branch);

  assert.equal(branchHasReferenceAsset(branch, "productIcon"), true);
  assert.equal(branchHasReferenceAsset(branch, "productRecording"), false);
  assert.deepEqual(result.assetReviews, {
    productIcon: { assetId: "asset_icon", status: "approved" }
  });
});

test("v2 branch asset detection supports legacy relative paths", () => {
  assert.equal(branchHasReferenceAsset({
    assetRelativePaths: { productScreenshot: "product_info/demo/screenshot.png" }
  }, "productScreenshot"), true);
});

test("v2 branch asset pruning keeps content hashes and rejects reviews for replaced content", () => {
  const result = pruneOrphanAssetReviews({
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

  assert.deepEqual(result.assetContentHashes, { productIcon: "sha256:new-content" });
  assert.deepEqual(result.assetReviews, {});
});

test("v2 branch asset pruning rejects a legacy hashless review for hashed content", () => {
  const result = pruneOrphanAssetReviews({
    assetStoredPaths: { productIcon: "product-assets/branch_1/productIcon/icon.png" },
    assetContentHashes: { productIcon: "sha256:new-content" },
    assetReviews: {
      productIcon: { assetId: "asset_legacy", status: "approved" }
    }
  });

  assert.deepEqual(result.assetReviews, {});
});
