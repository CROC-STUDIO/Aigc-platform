import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { uploadPostProcessEnding } from "../../server/wangzhuan/postprocess.mjs";

function uploadContext(root) {
  return {
    userProjectRoot: root,
    sharedProjectRoot: root,
    userId: "test",
    async syncWangzhuanAsset({ fullPath, assetKind }) {
      return {
        assetKind,
        storageKey: `test/${assetKind}`,
        storageUrl: `https://assets.test/${assetKind}`,
        storedPath: fullPath
      };
    }
  };
}

test("post-process Ending upload accepts images and defaults them to one second", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-postprocess-image-"));
  try {
    const result = await uploadPostProcessEnding(uploadContext(root), {
      fileName: "ending.png",
      mimeType: "image/png",
      content: `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`
    });

    assert.equal(result.asset.mediaType, "image");
    assert.equal(result.asset.imageDurationSec, 1);
    assert.match(result.asset.storedPath, /postprocess-assets[/\\]ending/);
    assert.equal(existsSync(join(root, result.asset.storedPath)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-process Ending upload accepts videos without Seedance review", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-postprocess-video-"));
  try {
    const result = await uploadPostProcessEnding(uploadContext(root), {
      fileName: "ending.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("fake-video").toString("base64")}`
    });

    assert.equal(result.asset.mediaType, "video");
    assert.equal(result.asset.imageDurationSec, 1);
    assert.equal("review" in result.asset, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-process Ending upload rejects unsupported files", async () => {
  await assert.rejects(
    uploadPostProcessEnding({ userProjectRoot: "/tmp/unused" }, {
      fileName: "ending.gif",
      mimeType: "image/gif",
      content: `data:image/gif;base64,${Buffer.from("fake-gif").toString("base64")}`
    }),
    (error) => error?.code === "invalid_material"
  );
});

test("router exposes the dedicated post-process Ending upload endpoint", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/router.mjs", import.meta.url), "utf8");

  assert.match(source, /import \{ uploadPostProcessEnding \} from "\.\/postprocess\.mjs";/);
  assert.match(source, /url\.pathname === "\/api\/wangzhuan\/postprocess-assets\/ending"/);
  assert.match(source, /uploadPostProcessEnding\(scoped, await context\.readJson\(req\)\)/);
});
