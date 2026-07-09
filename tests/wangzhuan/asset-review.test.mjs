import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewSeedanceAsset } from "../../server/wangzhuan/asset-review.mjs";

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
