import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPublicUrl,
  buildStorageKey,
  deleteRecordedAssetMetadata,
  getRecordedAssetMetadata,
  normalizeContentType,
  normalizeFilename,
  objectStorageEnabled,
  projectStorageDescriptor,
  recordAssetMetadata
} from "../server/object-storage.mjs";

test("object storage settings require bucket and region before enabling S3", () => {
  assert.equal(objectStorageEnabled({ S3_BUCKET: "bucket-only" }), false);
  assert.equal(objectStorageEnabled({ AWS_REGION: "ap-southeast-1" }), false);
  assert.equal(objectStorageEnabled({ S3_BUCKET: "aigc-assets", AWS_REGION: "ap-southeast-1" }), true);
});

test("storage keys and public URLs sanitize path-like file names", () => {
  const filename = normalizeFilename("../../素材 demo.png");
  assert.equal(filename, "素材_demo.png");
  assert.equal(normalizeContentType("", filename), "image/png");

  const storageKey = buildStorageKey({
    env: { S3_PREFIX: "aigc/uploads" },
    assetId: "asset_123",
    filename: "../../素材 demo.png"
  });
  assert.equal(storageKey, "aigc/uploads/asset_123/素材_demo.png");

  assert.equal(
    buildPublicUrl(storageKey, { S3_PUBLIC_BASE_URL: "https://cdn.example.com/root/" }),
    "https://cdn.example.com/root/aigc/uploads/asset_123/%E7%B4%A0%E6%9D%90_demo.png"
  );
  assert.equal(
    buildPublicUrl(storageKey, { PUBLIC_BASE_URL: "https://api.example.com", API_PREFIX: "/api" }),
    "https://api.example.com/api/public/assets/aigc/uploads/asset_123/%E7%B4%A0%E6%9D%90_demo.png"
  );
  assert.equal(
    buildPublicUrl(storageKey, { API_PREFIX: "/api" }),
    "/api/public/assets/aigc/uploads/asset_123/%E7%B4%A0%E6%9D%90_demo.png"
  );
});

test("project storage descriptors keep user and shared assets in separate S3 namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-s3-descriptor-"));
  try {
    const sharedRoot = join(root, "shared project");
    const userRoot = join(sharedRoot, "用户数据", "alice", "shared project");
    const userFile = join(userRoot, "效果图", "batch a.png");
    const sharedFile = join(sharedRoot, "产品logo", "logo.png");

    const userDescriptor = projectStorageDescriptor({
      env: { S3_PREFIX: "uploads" },
      fullPath: userFile,
      userRoot,
      sharedRoot,
      userId: "alice"
    });
    assert.equal(userDescriptor.scope, "user");
    assert.equal(userDescriptor.relativePath, "效果图/batch a.png");
    assert.equal(userDescriptor.storageKey, "uploads/shared_project/users/alice/效果图/batch_a.png");

    const sharedDescriptor = projectStorageDescriptor({
      env: { S3_PREFIX: "uploads" },
      fullPath: sharedFile,
      userRoot,
      sharedRoot,
      userId: "alice"
    });
    assert.equal(sharedDescriptor.scope, "shared");
    assert.equal(sharedDescriptor.relativePath, "产品logo/logo.png");
    assert.equal(sharedDescriptor.storageKey, "uploads/shared_project/shared/产品logo/logo.png");

    assert.throws(
      () => projectStorageDescriptor({
        fullPath: join(root, "outside.png"),
        userRoot,
        sharedRoot,
        userId: "alice"
      }),
      /outside project roots/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset metadata index stores storage key and URL next to project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-s3-index-"));
  try {
    const userRoot = join(root, "用户数据", "alice", "project");
    const fullPath = join(userRoot, "效果图", "out.png");
    await mkdir(join(userRoot, "效果图"), { recursive: true });
    await writeFile(fullPath, "fake image");
    const descriptor = projectStorageDescriptor({
      env: {
        S3_PREFIX: "uploads",
        S3_PUBLIC_BASE_URL: "https://cdn.example.com"
      },
      fullPath,
      userRoot,
      sharedRoot: root,
      userId: "alice"
    });

    const recorded = await recordAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath,
      metadata: {
        assetKind: "generated_output",
        filename: "out.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey: descriptor.storageKey,
        storageUrl: descriptor.storageUrl
      }
    });

    assert.match(recorded.storageKey, /^uploads\/aigc-s3-index-[^/]+\/users\/alice\/效果图\/out\.png$/);
    assert.match(recorded.storageUrl, /^https:\/\/cdn\.example\.com\/uploads\/aigc-s3-index-[^/]+\/users\/alice\/%E6%95%88%E6%9E%9C%E5%9B%BE\/out\.png$/);
    assert.deepEqual(
      await getRecordedAssetMetadata({
        root: descriptor.root,
        relativePath: descriptor.relativePath
      }),
      recorded
    );

    const indexText = await readFile(join(userRoot, "批处理记录", "object-storage-assets.json"), "utf8");
    assert.match(indexText, /"storageKey"/);
    assert.doesNotMatch(indexText, /AWS_SECRET_ACCESS_KEY|SECRET/);

    await deleteRecordedAssetMetadata({ root: descriptor.root, relativePath: descriptor.relativePath });
    assert.equal(await getRecordedAssetMetadata({ root: descriptor.root, relativePath: descriptor.relativePath }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
