import assert from "node:assert/strict";
import test from "node:test";

import { WangzhuanError } from "../../server/wangzhuan/http.mjs";
import { syncWangzhuanAsset } from "../../server/wangzhuan/storage.mjs";

test("syncWangzhuanAsset converts required S3 timeout into a visible WangzhuanError", async () => {
  await assert.rejects(
    () => syncWangzhuanAsset({
      userProjectRoot: "/tmp/aigc-user-root",
      sharedProjectRoot: "/tmp/aigc-shared-root",
      syncWangzhuanAsset: async () => {
        const error = new Error("S3 object upload timed out after 45000ms");
        error.name = "TimeoutError";
        throw error;
      }
    }, "/tmp/aigc-user-root/reference/original.mp4", "reference_video", { required: true }),
    (error) => {
      assert.ok(error instanceof WangzhuanError);
      assert.equal(error.code, "object_storage_upload_failed");
      assert.equal(error.status, 502);
      assert.match(error.message, /参考视频上传到 S3 超时/);
      return true;
    }
  );
});

test("syncWangzhuanAsset can use local object storage mock for browser testing", async () => {
  const previous = process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE;
  process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE = "1";
  try {
    const storage = await syncWangzhuanAsset({
      userProjectRoot: "/tmp/aigc-user-root",
      sharedProjectRoot: "/tmp/aigc-shared-root"
    }, "/tmp/aigc-user-root/reference/original.mp4", "reference_video", { required: true });
    assert.equal(storage.storageKey, "");
    assert.equal(storage.localOnly, true);
    assert.match(storage.storageUrl, /^\/file\?path=/);
    assert.equal(storage.storedPath, "reference/original.mp4");
  } finally {
    if (previous === undefined) delete process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE;
    else process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE = previous;
  }
});

test("syncWangzhuanAsset skips local mock when remote storage is preferred and configured", async () => {
  const previous = {
    local: process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE,
    bucket: process.env.S3_BUCKET,
    region: process.env.AWS_REGION
  };
  process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE = "1";
  process.env.S3_BUCKET = "bucket-for-test";
  process.env.AWS_REGION = "us-east-1";
  try {
    let preferRemoteSeen = false;
    const storage = await syncWangzhuanAsset({
      userProjectRoot: "/tmp/aigc-user-root",
      sharedProjectRoot: "/tmp/aigc-shared-root",
      syncWangzhuanAsset: async ({ preferRemote }) => {
        preferRemoteSeen = preferRemote;
        return {
          storageKey: "uploads/reference/original.mp4",
          storageUrl: "https://cdn.example.com/uploads/reference/original.mp4"
        };
      }
    }, "/tmp/aigc-user-root/reference/original.mp4", "reference_video", {
      required: true,
      preferRemote: true
    });

    assert.equal(preferRemoteSeen, true);
    assert.equal(storage.storageKey, "uploads/reference/original.mp4");
    assert.equal(storage.storageUrl, "https://cdn.example.com/uploads/reference/original.mp4");
  } finally {
    if (previous.local === undefined) delete process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE;
    else process.env.WANGZHUAN_LOCAL_OBJECT_STORAGE = previous.local;
    if (previous.bucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = previous.bucket;
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
  }
});
