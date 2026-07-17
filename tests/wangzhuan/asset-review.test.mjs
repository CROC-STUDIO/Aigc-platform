import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureAssetReviewsApproved,
  reviewSeedanceAsset,
  validateAssetReviewState
} from "../../server/wangzhuan/asset-review.mjs";

function makeContext(root, overrides = {}) {
  return {
    userProjectRoot: root,
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://seedance.test",
          apiKey: "test-key"
        }
      }
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        asset_id: "asset_reviewed_1",
        status: "approved",
        content_url: "https://cdn.test/asset.png"
      })
    }),
    ...overrides
  };
}

test("reviewSeedanceAsset falls back to local storedPath when storage key is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "asset-review-fallback-"));
  const relativePath = "批处理记录/网赚管线/product-assets/branch_1/productScreenshot/shot1.png";
  const fullPath = join(root, relativePath);
  await mkdir(join(root, "批处理记录/网赚管线/product-assets/branch_1/productScreenshot"), { recursive: true });
  await writeFile(fullPath, Buffer.from("local-image-bytes"));

  const context = makeContext(root, {
    openWangzhuanObjectStream: async () => {
      const error = new Error("The specified key does not exist.");
      error.code = "NoSuchKey";
      throw error;
    }
  });

  const result = await reviewSeedanceAsset(context, {
    assetKey: "productScreenshot",
    fileName: "shot1.png",
    mimeType: "image/png",
    storageKey: "uploads/missing/shot1.png",
    storedPath: relativePath
  });

  assert.equal(result.assetId, "asset_reviewed_1");
  assert.equal(result.status, "approved");
});

test("reviewSeedanceAsset still fails when storage key is missing and local file does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "asset-review-missing-"));
  const context = makeContext(root, {
    openWangzhuanObjectStream: async () => {
      const error = new Error("The specified key does not exist.");
      error.code = "NoSuchKey";
      throw error;
    }
  });

  await assert.rejects(
    reviewSeedanceAsset(context, {
      assetKey: "productScreenshot",
      fileName: "shot1.png",
      mimeType: "image/png",
      storageKey: "uploads/missing/shot1.png",
      storedPath: "批处理记录/网赚管线/product-assets/branch_1/productScreenshot/shot1.png"
    }),
    (error) => {
      assert.equal(error?.code, "ENOENT");
      return true;
    }
  );
});

test("reviewSeedanceAsset loads product_info assets from configured product library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "asset-review-product-info-"));
  const productInfoRoot = join(root, "product_info");
  const assetsDir = join(productInfoRoot, "DemoProduct", "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "icon.png"), Buffer.from("product-info-icon"));

  let uploadedBytes = 0;
  let uploadedMimeType = "";
  const context = makeContext(root, {
    productInfoRoot,
    fetch: async (_url, options) => {
      const file = options.body.get("file");
      uploadedBytes = Buffer.from(await file.arrayBuffer()).length;
      uploadedMimeType = file.type;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          asset_id: "asset_product_info_icon",
          status: "approved",
          content_url: "https://cdn.test/icon.png"
        })
      };
    }
  });

  const result = await reviewSeedanceAsset(context, {
    assetKey: "productIcon",
    fileName: "icon.png",
    storageKey: "product_info/DemoProduct/assets/icon.png",
    storedPath: "product_info/DemoProduct/assets/icon.png"
  });

  assert.equal(uploadedBytes, Buffer.byteLength("product-info-icon"));
  assert.equal(uploadedMimeType, "image/png");
  assert.equal(result.assetId, "asset_product_info_icon");
  assert.equal(result.status, "approved");
});

test("ensureAssetReviewsApproved waits for pending Seedance asset review to settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "asset-review-wait-"));
  const productInfoRoot = join(root, "product_info");
  const assetsDir = join(productInfoRoot, "DemoProduct", "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "icon.png"), Buffer.from("product-info-icon"));

  let detailCalls = 0;
  const context = makeContext(root, {
    productInfoRoot,
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://seedance.test",
          apiKey: "test-key"
        },
        seedanceAssetReview: {
          waitTimeoutMs: 500,
          pollIntervalMs: 10
        }
      }
    },
    fetch: async (url) => {
      if (String(url).includes("/assets/upload")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            asset_id: "asset_wait_1",
            status: "pending",
            content_url: "https://cdn.test/icon.png"
          })
        };
      }
      detailCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          asset_id: "asset_wait_1",
          status: detailCalls >= 2 ? "approved" : "pending",
          content_url: "https://cdn.test/icon.png"
        })
      };
    }
  });

  const result = await ensureAssetReviewsApproved(context, [{
    branchId: "branch_1",
    assetFileNames: { productIcon: "icon.png" },
    assetStorageKeys: { productIcon: "product_info/DemoProduct/assets/icon.png" },
    assetStoredPaths: { productIcon: "product_info/DemoProduct/assets/icon.png" },
    assetContentHashes: { productIcon: "sha256:product-info-icon" },
    assetUrls: {},
    assetReviews: {}
  }]);

  assert.equal(result.reviewResult.ok, true);
  assert.equal(result.branches[0].assetReviews.productIcon.assetId, "asset_wait_1");
  assert.equal(result.branches[0].assetReviews.productIcon.status, "approved");
  assert.equal(result.branches[0].assetReviews.productIcon.contentHash, "sha256:product-info-icon");
  assert.equal(detailCalls, 2);
});

test("ensureAssetReviewsApproved re-reviews a hashless approval when content identity is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "asset-review-content-identity-"));
  const relativePath = "批处理记录/网赚管线/product-assets/branch_1/productIcon/icon.png";
  await mkdir(join(root, "批处理记录/网赚管线/product-assets/branch_1/productIcon"), { recursive: true });
  await writeFile(join(root, relativePath), Buffer.from("new-icon-content"));
  let reviewCalls = 0;
  const context = makeContext(root, {
    reviewProductAsset: async () => {
      reviewCalls += 1;
      return { assetId: "asset_new_content", status: "approved" };
    }
  });

  const result = await ensureAssetReviewsApproved(context, [{
    branchId: "branch_1",
    assetFileNames: { productIcon: "icon.png" },
    assetStoredPaths: { productIcon: relativePath },
    assetContentHashes: { productIcon: "sha256:new-icon-content" },
    assetReviews: {
      productIcon: { assetId: "asset_legacy", status: "approved" }
    }
  }]);

  assert.equal(reviewCalls, 1);
  assert.equal(result.branches[0].assetReviews.productIcon.assetId, "asset_new_content");
  assert.equal(result.branches[0].assetReviews.productIcon.contentHash, "sha256:new-icon-content");
});

test("ensureAssetReviewsApproved reviews every suffixed reference asset", async () => {
  const reviewedKeys = [];
  const context = makeContext("/tmp/unused", {
    reviewProductAsset: async (asset) => {
      reviewedKeys.push(asset.assetKey);
      return { assetId: `asset_${asset.assetKey}`, status: "approved" };
    }
  });
  const assetFileNames = {
    productIcon: "icon.png",
    productScreenshot: "shot-1.png",
    productScreenshot_2: "shot-2.png",
    productScreenshot_3: "shot-3.png",
    productRecording: "recording-1.mp4",
    productRecording_2: "recording-2.mp4"
  };
  const assetStoredPaths = Object.fromEntries(
    Object.entries(assetFileNames).map(([key, fileName]) => [key, `product-assets/branch_1/${key}/${fileName}`])
  );

  const result = await ensureAssetReviewsApproved(context, [{
    branchId: "branch_1",
    assetFileNames,
    assetStoredPaths,
    assetUrls: {},
    assetReviews: {}
  }]);

  assert.deepEqual(reviewedKeys, [
    "productIcon",
    "productScreenshot",
    "productScreenshot_2",
    "productScreenshot_3",
    "productRecording",
    "productRecording_2"
  ]);
  assert.equal(result.reviewResult.ok, true);
  assert.deepEqual(Object.keys(result.branches[0].assetReviews), reviewedKeys);
});

test("selected reference files cannot be confirmed before upload and review", () => {
  const result = validateAssetReviewState([{
    branchId: "branch_1",
    branchLabel: "改写 3.1",
    assetFileNames: { productScreenshot_2: "pending-shot.png" },
    assetUrls: {},
    assetStorageKeys: {},
    assetStoredPaths: {},
    assetReviews: {}
  }]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((item) => item.assetKey), ["productScreenshot_2"]);
  assert.match(result.failures[0].reason, /上传并审核/);
});
