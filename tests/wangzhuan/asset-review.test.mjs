import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAssetReviewsApproved, reviewSeedanceAsset } from "../../server/wangzhuan/asset-review.mjs";

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
    assetUrls: {},
    assetReviews: {}
  }]);

  assert.equal(result.reviewResult.ok, true);
  assert.equal(result.branches[0].assetReviews.productIcon.assetId, "asset_wait_1");
  assert.equal(result.branches[0].assetReviews.productIcon.status, "approved");
  assert.equal(detailCalls, 2);
});
