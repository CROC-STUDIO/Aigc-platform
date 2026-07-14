import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { uploadObjectFile } from "../../server/object-storage.mjs";

test("uploadObjectFile sends ContentLength for S3-compatible stream uploads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aigc-object-storage-"));
  const filePath = join(dir, "segment.mp4");
  const bytes = Buffer.from("fake video bytes");
  await writeFile(filePath, bytes);

  let capturedInput = null;
  const client = {
    async send(command) {
      capturedInput = command.input;
      return {};
    }
  };
  try {
    await uploadObjectFile({
      env: {
        S3_BUCKET: "bucket",
        AWS_REGION: "us-east-1",
        S3_UPLOAD_TIMEOUT_MS: "1000"
      },
      client,
      filePath,
      storageKey: "uploads/segment.mp4",
      contentType: "video/mp4"
    });
    assert.equal(capturedInput.ContentLength, bytes.length);
    assert.equal(capturedInput.ContentType, "video/mp4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
