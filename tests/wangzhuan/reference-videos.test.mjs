import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkReferenceVideo,
  decomposeReferenceVideo,
  loadReferenceVideoProbe,
  validateVideoDecomposition
} from "../../server/wangzhuan/reference-videos.mjs";

const baseVideo = Buffer.from("fake mp4 bytes");

function dataUrl(buffer = baseVideo, mimeType = "video/mp4") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function context(root, config = {}) {
  return {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    config
  };
}

function validUpload(overrides = {}) {
  return {
    fileName: "Cash Demo.mp4",
    mimeType: "video/mp4",
    content: dataUrl(),
    durationSec: 28.5,
    width: 720,
    height: 1280,
    canExtractFrame: true,
    ...overrides
  };
}

function validDecomposition(overrides = {}) {
  return {
    scene: "Phone reward app landing screen",
    subject: "Hand holding a phone",
    action: "User taps the reward button",
    camera: "Close-up vertical shot",
    lighting: "Bright indoor lighting",
    style: "Clean app demo",
    quality: "HD",
    hook: "Earn rewards with daily tasks",
    phoneUi: "Reward list",
    rewardFeedback: "Coins appear after tap",
    cta: "Download now",
    disclaimer: "Rewards vary by user",
    ...overrides
  };
}

test("checks and stores a valid reference video without exposing absolute paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-"));
  try {
    const result = await checkReferenceVideo(context(root), validUpload());

    assert.match(result.referenceVideo.referenceVideoId, /^ref_\d{8}_\d{3}$/);
    assert.equal(result.referenceVideo.fileName, "Cash Demo.mp4");
    assert.equal(result.referenceVideo.mimeType, "video/mp4");
    assert.equal(result.referenceVideo.sizeBytes, baseVideo.length);
    assert.equal(result.referenceVideo.durationSec, 28.5);
    assert.equal(result.referenceVideo.width, 720);
    assert.equal(result.referenceVideo.height, 1280);
    assert.equal(result.referenceVideo.ratio, "9:16");
    assert.equal(result.referenceVideo.canExtractFrame, true);
    assert.equal(result.referenceVideo.status, "pass");
    assert.deepEqual(result.referenceVideo.issues, []);
    assert.match(result.referenceVideo.storedPath, /^批处理记录\/网赚管线\/reference-videos\/ref_/);
    assert.equal(result.referenceVideo.storedPath.includes(root), false);

    const loaded = await loadReferenceVideoProbe(context(root), result.referenceVideo.referenceVideoId);
    assert.equal(loaded.referenceVideoId, result.referenceVideo.referenceVideoId);
    const stored = await readFile(join(context(root).userProjectRoot, result.referenceVideo.storedPath));
    assert.deepEqual(stored, baseVideo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects oversized reference uploads before writing a probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-limit-"));
  try {
    await assert.rejects(
      () => checkReferenceVideo(context(root, { wangzhuan: { limits: { maxUploadVideoBytes: 4 } } }), validUpload()),
      { code: "file_too_large" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns a failed probe for unusable reference metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-fail-"));
  try {
    const result = await checkReferenceVideo(context(root), validUpload({
      durationSec: 2,
      width: 1024,
      height: 1024,
      canExtractFrame: false
    }));

    assert.equal(result.referenceVideo.status, "fail");
    assert.deepEqual(result.referenceVideo.issues.map((issue) => issue.field), ["durationSec", "ratio", "canExtractFrame"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates and stores a manual decomposition for a checked reference video", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-decompose-"));
  try {
    const checked = await checkReferenceVideo(context(root), validUpload());
    const result = await decomposeReferenceVideo(context(root), {
      idempotencyKey: "idem_decompose_1",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: validDecomposition()
    });

    assert.equal(result.decomposition.referenceVideoId, checked.referenceVideo.referenceVideoId);
    assert.equal(result.decomposition.schemaVersion, "video_decomposition.v1");
    assert.deepEqual(result.decomposition.missingFields, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition validation reports missing required schema fields", () => {
  const result = validateVideoDecomposition("ref_20260617_001", validDecomposition({ hook: "" }));
  assert.deepEqual(result.missingFields, ["hook"]);
});

test("decompose requires idempotency key and rejects invalid schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-schema-"));
  try {
    const checked = await checkReferenceVideo(context(root), validUpload());
    await assert.rejects(
      () => decomposeReferenceVideo(context(root), {
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        decomposition: validDecomposition()
      }),
      { code: "validation_error" }
    );

    await assert.rejects(
      () => decomposeReferenceVideo(context(root), {
        idempotencyKey: "idem_decompose_bad",
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        decomposition: validDecomposition({ scene: "", hook: "" })
      }),
      { code: "schema_invalid" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
