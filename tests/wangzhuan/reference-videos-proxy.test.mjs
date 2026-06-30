import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { WangzhuanError } from "../../server/wangzhuan/http.mjs";
import { checkReferenceVideo, draftReferenceVideoDecomposition } from "../../server/wangzhuan/reference-videos.mjs";

function dataUrl(bytes) {
  return `data:video/mp4;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
}

test("large reference videos use compressed proxy for S3 and decomposition", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-proxy-"));
  const calls = [];
  try {
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      nextReferenceVideoId: async () => "ref_20260630_001",
      syncReferenceVideoFact: async () => ({ skipped: false, referenceVideoId: 1 }),
      recordTelemetryEvent: async () => {},
      probeReferenceVideo: async ({ filePath }) => filePath.endsWith("decomposition-proxy.mp4")
        ? {
          durationSec: 60,
          width: 480,
          height: 854,
          fps: 15,
          bitRateBps: 950000,
          videoCodec: "h264",
          audioStreams: [{ codec: "aac", channels: 1, bitRateBps: 64000 }],
          canExtractFrame: true
        }
        : {
          durationSec: 60,
          width: 1080,
          height: 1920,
          fps: 30,
          bitRateBps: 8500000,
          videoCodec: "h264",
          audioStreams: [{ codec: "aac", channels: 2, bitRateBps: 128000 }],
          canExtractFrame: true
        },
      createReferenceVideoProxy: async ({ targetPath, settings }) => {
        await writeFile(targetPath, Buffer.alloc(6 * 1024 * 1024, 2));
        return { path: targetPath, crf: settings.crfLadder[0], sizeBytes: 6 * 1024 * 1024 };
      },
      syncWangzhuanAsset: async ({ fullPath, assetKind }) => {
        calls.push({ fullPath, assetKind });
        return {
          storageKey: "s3/reference/decomposition-proxy.mp4",
          storageUrl: "https://cdn.example.com/reference/decomposition-proxy.mp4"
        };
      }
    };

    const result = await checkReferenceVideo(context, {
      fileName: "big-reference.mp4",
      mimeType: "video/mp4",
      content: dataUrl(12 * 1024 * 1024)
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].fullPath, /decomposition-proxy\.mp4$/);
    assert.equal(result.referenceVideo.sizeBytes, 6 * 1024 * 1024);
    assert.equal(result.referenceVideo.originalSizeBytes, 12 * 1024 * 1024);
    assert.match(result.referenceVideo.storedPath, /decomposition-proxy\.mp4$/);
    assert.match(result.referenceVideo.originalStoredPath, /original\.mp4$/);
    assert.equal(result.referenceVideo.decompositionProxy.crf, 35);
    assert.equal(result.referenceVideo.decompositionProxy.targetBytes, 8 * 1024 * 1024);
    assert.equal(result.referenceVideo.previewUrl, "https://cdn.example.com/reference/decomposition-proxy.mp4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition tries S3 file_url first and falls back to base64 when URL is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-fallback-"));
  const calls = [];
  const fallbackEvents = [];
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_002/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_002"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_002",
        fileName: "reference.mp4",
        mimeType: "video/mp4",
        status: "pass",
        storedPath: videoRelativePath,
        storageKey: "uploads/reference/decomposition-proxy.mp4",
        storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
        durationSec: 30,
        width: 480,
        height: 854,
        fps: 15
      }),
      callWangzhuanLlm: async ({ referenceVideo }) => {
        calls.push({
          fileUrl: referenceVideo.fileUrl || "",
          hasFileDataUrl: Boolean(referenceVideo.fileDataUrl)
        });
        if (calls.length === 1) {
          throw new WangzhuanError("model_failed", "模型拆解请求失败", {
            inputMode: "file_url",
            upstreamMessage: "video link is not accessible"
          });
        }
        return JSON.stringify({
          scene: "office",
          subject: "phone",
          action: "tap",
          camera: "close-up",
          lighting: "bright",
          style: "realistic",
          quality: "high",
          hook: "earn rewards"
        });
      }
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_002",
      llmConfig: { apiKey: "test-key", maxRetries: 0 }
    }, {
      streamHandlers: {
        onFallback: (event) => fallbackEvents.push(event)
      }
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].fileUrl, "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4");
    assert.equal(calls[0].hasFileDataUrl, false);
    assert.equal(calls[1].fileUrl, "");
    assert.equal(calls[1].hasFileDataUrl, true);
    assert.equal(result.decomposition.scene, "office");
    assert.equal(result.warnings.at(-1).code, "reference_video_file_url_fallback");
    assert.deepEqual(fallbackEvents[0], {
      from: "file_url",
      to: "file_data",
      reason: "video link is not accessible"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
