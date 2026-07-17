import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { uploadProductAsset } from "../../server/wangzhuan/product-assets.mjs";

test("CTA and Ending assets reject video uploads before storage", async () => {
  const content = `data:video/mp4;base64,${Buffer.from("fake-video").toString("base64")}`;
  for (const assetKey of ["ctaAsset", "endingAsset"]) {
    await assert.rejects(
      uploadProductAsset({ userProjectRoot: "/tmp/unused" }, {
        branchId: "branch_1",
        assetKey,
        fileName: `${assetKey}.mp4`,
        mimeType: "video/mp4",
        content
      }),
      (error) => {
        assert.equal(error?.code, "invalid_material");
        assert.match(error?.message || "", /只能上传图片/);
        return true;
      }
    );
  }
});

test("uploaded product assets persist an immutable content hash with the review", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-product-asset-hash-"));
  const bytes = Buffer.from("stable-product-icon-bytes");
  const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const result = await uploadProductAsset({
    userProjectRoot: root,
    sharedProjectRoot: root,
    syncWangzhuanAsset: async () => ({
      storageKey: "uploads/branch_1/productIcon/icon.png",
      storageUrl: "https://cdn.test/icon.png"
    }),
    reviewProductAsset: async () => ({
      assetId: "asset_icon_1",
      status: "approved"
    })
  }, {
    branchId: "branch_1",
    assetKey: "productIcon",
    fileName: "icon.png",
    mimeType: "image/png",
    content: `data:image/png;base64,${bytes.toString("base64")}`
  });

  assert.equal(result.asset.contentHash, expectedHash);
  assert.equal(result.asset.review.contentHash, expectedHash);
});
