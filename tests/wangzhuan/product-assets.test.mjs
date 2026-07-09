import assert from "node:assert/strict";
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
