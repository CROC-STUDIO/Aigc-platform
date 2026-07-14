import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { WangzhuanError } from "../../server/wangzhuan/http.mjs";
import {
  buildSceneAwareFrameTimestamps,
  buildBatchReferenceFrameExtractionPlan,
  checkReferenceVideo,
  draftReferenceVideoDecomposition,
  findReusableReferenceVideo
} from "../../server/wangzhuan/reference-videos.mjs";

function dataUrl(bytes) {
  return `data:video/mp4;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
}

function validDecompositionJson(overrides = {}) {
  return JSON.stringify({
    scene: "office",
    subject: "phone",
    action: "tap",
    camera: "close-up",
    lighting: "bright",
    style: "realistic",
    quality: "high",
    hook: "earn rewards",
    ...overrides
  });
}

function probeFixture(referenceVideoId, videoRelativePath, overrides = {}) {
  return {
    referenceVideoId,
    fileName: "reference.mp4",
    mimeType: "video/mp4",
    status: "pass",
    storedPath: videoRelativePath,
    storageKey: "uploads/reference/decomposition-proxy.mp4",
    storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
    durationSec: 30,
    width: 480,
    height: 854,
    fps: 15,
    ...overrides
  };
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

test("reference video reuse check can find local probe by file hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-reuse-"));
  try {
    const referenceDir = join(root, "批处理记录", "网赚管线", "reference-videos", "ref_20260714_001");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(referenceDir, "probe.json"), JSON.stringify({
      referenceVideoId: "ref_20260714_001",
      fileName: "reference.mp4",
      mimeType: "video/mp4",
      fileHash: "b".repeat(64),
      status: "pass",
      storedPath: "批处理记录/网赚管线/reference-videos/ref_20260714_001/decomposition-proxy.mp4",
      durationSec: 12,
      width: 480,
      height: 854,
      ratio: "9:16"
    }));

    const result = await findReusableReferenceVideo({
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {}
    }, {
      fileHash: "b".repeat(64),
      fileName: "reference.mp4",
      mimeType: "video/mp4",
      sizeBytes: 19001403
    });

    assert.equal(result.hit, true);
    assert.equal(result.referenceVideo.referenceVideoId, "ref_20260714_001");
    assert.match(result.referenceVideo.previewUrl, /^\/file\?path=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition tries S3 file_url first and falls back to frames-only when URL is unavailable", async () => {
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
      detectReferenceVideoScenes: async () => [],
      headProbeReferenceUrl: async () => ({ ok: true }),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" }
      ],
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
            upstreamMessage: "video link is not accessible",
            reason: "request_failed"
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
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-4o",
        apiKey: "test-key",
        maxRetries: 0
      }
    }, {
      streamHandlers: {
        onFallback: (event) => fallbackEvents.push(event)
      }
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].fileUrl, "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4");
    assert.equal(calls[0].hasFileDataUrl, false);
    assert.equal(calls[1].fileUrl, "");
    assert.equal(calls[1].hasFileDataUrl, false);
    assert.equal(result.decomposition.scene, "office");
    assert.equal(result.warnings.at(-1).code, "reference_video_frames_only_fallback");
    assert.deepEqual(fallbackEvents[0], {
      from: "file_url",
      to: "frames_only",
      reason: "video link is not accessible"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition honors explicit zero retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-zero-retry-"));
  let calls = 0;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_077/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_077"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_077",
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
      callWangzhuanLlm: async () => {
        calls += 1;
        throw new WangzhuanError("model_failed", "模型拆解请求超时", {
          inputMode: "file_url",
          reason: "timeout"
        });
      }
    };

    await assert.rejects(
      draftReferenceVideoDecomposition(context, {
        referenceVideoId: "ref_20260630_077",
        llmConfig: { apiKey: "test-key", maxRetries: 0 }
      }),
      /模型拆解请求超时/
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gpt-5.5 decomposition uses scene-aware frames and no video file_url", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gpt55-"));
  const calls = [];
  const frameRequests = [];
  const originalFetch = globalThis.fetch;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_055/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_055"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    globalThis.fetch = async (url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      calls.push({ url: String(url), body });
      assert.doesNotMatch(String(url), /\/responses$/);
      assert.match(String(url), /\/chat\/completions$/);
      assert.equal(body.model, "gpt-5.5");
      const parts = body.messages?.flatMap((message) => message.content || []) || [];
      assert.equal(parts.some((part) => part?.type === "file"), false);
      assert.equal(parts.filter((part) => part?.type === "image_url").length, 4);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              scene: "office",
              subject: "phone",
              action: "tap",
              camera: "close-up",
              lighting: "bright",
              style: "realistic",
              quality: "high",
              hook: "earn rewards"
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      detectReferenceVideoScenes: async () => [0.8, 9.8],
      extractReferenceFrames: async ({ timestampsSec }) => {
        frameRequests.push(timestampsSec);
        return timestampsSec.map((timestampSec, index) => ({
          index,
          timestampSec,
          dataUrl: `data:image/jpeg;base64,${Buffer.from(`frame-${index}`).toString("base64")}`
        }));
      },
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_055",
        fileName: "reference.mp4",
        mimeType: "video/mp4",
        status: "pass",
        storedPath: videoRelativePath,
        storageKey: "uploads/reference/decomposition-proxy.mp4",
        storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
        durationSec: 11,
        width: 480,
        height: 854,
        fps: 15
      })
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_055",
      fileHash: "same-video-hash",
      language: "zh-CN",
      targetRegion: "CN",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.5",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(frameRequests[0], [0.25, 3.67, 7.33, 10.75]);
    assert.equal(result.decomposition.scene, "office");

    const cached = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_055",
      fileHash: "same-video-hash",
      language: "zh-CN",
      targetRegion: "CN",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.5",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(cached.draft.source, "cache");
    assert.equal(cached.decomposition.scene, "office");
    assert.equal(cached.warnings[0].code, "decomposition_cache_hit");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("url-capable model sends video URL only and still pre-extracts scene-aware frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gemini-"));
  const calls = [];
  const frameRequests = [];
  const originalFetch = globalThis.fetch;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_031/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_031"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    globalThis.fetch = async (url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      calls.push({ url: String(url), body });
      assert.match(String(url), /\/chat\/completions$/);
      assert.equal(body.model, "gemini-3.1-pro-preview");
      const parts = body.messages?.flatMap((message) => message.content || []) || [];
      const filePart = parts.find((part) => part?.type === "file");
      assert.equal(filePart?.file?.file_url, "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4");
      assert.equal(parts.filter((part) => part?.type === "image_url").length, 0);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              scene: "factory",
              subject: "worker",
              action: "show phone",
              camera: "medium shot",
              lighting: "bright",
              style: "ugc",
              quality: "clear",
              hook: "earning question"
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      detectReferenceVideoScenes: async () => [0.7, 6.8],
      headProbeReferenceUrl: async () => ({ ok: true }),
      extractReferenceFrames: async ({ timestampsSec }) => {
        frameRequests.push(timestampsSec);
        return timestampsSec.map((timestampSec, index) => ({
          index,
          timestampSec,
          dataUrl: `data:image/jpeg;base64,${Buffer.from(`gemini-frame-${index}`).toString("base64")}`
        }));
      },
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_031",
        fileName: "reference.mp4",
        mimeType: "video/mp4",
        status: "pass",
        storedPath: videoRelativePath,
        storageKey: "uploads/reference/decomposition-proxy.mp4",
        storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
        durationSec: 8.4,
        width: 480,
        height: 854,
        fps: 15
      })
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_031",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gemini-3.1-pro-preview",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(frameRequests[0], [0.25, 2.27, 4.53, 7.6, 8.15]);
    assert.equal(result.decomposition.scene, "factory");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("scene-aware frame sampling merges tiny scenes and uses 1/2/4 dynamic budgets with forced start/end", () => {
  const timestamps = buildSceneAwareFrameTimestamps(24, [4, 16], {
    mediumSceneThresholdSec: 6,
    longSceneThresholdSec: 15,
    maxFrames: 28
  });
  assert.deepEqual(timestamps, [
    0.25,
    2,
    8,
    12,
    18.67,
    21.33,
    23.75
  ]);
});

test("scene-aware frame sampling never exceeds the configured budget", () => {
  const sceneCuts = Array.from({ length: 24 }, (_, index) => index + 1);
  const timestamps = buildSceneAwareFrameTimestamps(30, sceneCuts, {
    longSceneThresholdSec: 100,
    maxFrames: 28
  });
  assert.ok(timestamps.length <= 28);
  assert.equal(timestamps[0], 0.25);
  assert.equal(timestamps.at(-1), 29.75);
});

test("batch frame extraction plan maps all timestamps into one ffmpeg filter graph", () => {
  const plan = buildBatchReferenceFrameExtractionPlan("/tmp/llm-frames", [0.25, 2.6, 10.75]);
  assert.match(plan.filterComplex, /\[0:v\]split=3\[v0\]\[v1\]\[v2\]/);
  assert.match(plan.filterComplex, /trim=start=0.25/);
  assert.match(plan.filterComplex, /trim=start=2.6/);
  assert.match(plan.filterComplex, /trim=start=10.75/);
  assert.equal(plan.outputs.length, 3);
  assert.deepEqual(plan.outputs.map((item) => item.timestampSec), [0.25, 2.6, 10.75]);
  assert.equal(plan.outputArgs.filter((item) => item === "-map").length, 3);
});

test("decomposition dumps both llm request and llm response artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-dumps-"));
  const originalFetch = globalThis.fetch;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_088/decomposition-proxy.mp4";
    const videoDir = join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_088");
    const videoPath = join(root, videoRelativePath);
    await mkdir(videoDir, { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            scene: "factory",
            subject: "worker",
            action: "show phone",
            camera: "medium shot",
            lighting: "bright",
            style: "ugc",
            quality: "clear",
            hook: "earning question"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_088",
        fileName: "reference.mp4",
        mimeType: "video/mp4",
        status: "pass",
        storedPath: videoRelativePath,
        storageKey: "uploads/reference/decomposition-proxy.mp4",
        storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
        durationSec: 10,
        width: 480,
        height: 854,
        fps: 15
      })
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_088",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gemini-3.1-pro-preview",
        apiKey: "test-key",
        maxRetries: 0
      }
    }, {
      requestId: "req_20260630000000_dump"
    });

    assert.equal(result.decomposition.scene, "factory");
    const requestDump = JSON.parse(await readFile(join(videoDir, "llm-request-req_20260630000000_dump.json"), "utf8"));
    const responseDump = JSON.parse(await readFile(join(videoDir, "llm-response-req_20260630000000_dump.json"), "utf8"));
    assert.equal(requestDump.requestId, "req_20260630000000_dump");
    assert.equal(responseDump.requestId, "req_20260630000000_dump");
    assert.equal(responseDump.response.status, 200);
    assert.equal(responseDump.response.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming decomposition dumps both llm request and llm response artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-stream-dumps-"));
  const originalFetch = globalThis.fetch;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260630_089/decomposition-proxy.mp4";
    const videoDir = join(root, "批处理记录/网赚管线/reference-videos/ref_20260630_089");
    const videoPath = join(root, videoRelativePath);
    await mkdir(videoDir, { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    globalThis.fetch = async () => new Response([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"scene\\\":\\\"office\\\"\"}}]}",
      "",
      "data: {\"choices\":[{\"delta\":{\"content\":\",\\\"subject\\\":\\\"phone\\\",\\\"action\\\":\\\"tap\\\",\\\"camera\\\":\\\"close-up\\\",\\\"lighting\\\":\\\"bright\\\",\\\"style\\\":\\\"realistic\\\",\\\"quality\\\":\\\"high\\\",\\\"hook\\\":\\\"earn rewards\\\"}\"}}]}",
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => ({
        referenceVideoId: "ref_20260630_089",
        fileName: "reference.mp4",
        mimeType: "video/mp4",
        status: "pass",
        storedPath: videoRelativePath,
        storageKey: "uploads/reference/decomposition-proxy.mp4",
        storageUrl: "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4",
        durationSec: 10,
        width: 480,
        height: 854,
        fps: 15
      })
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_089",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.5",
        apiKey: "test-key",
        maxRetries: 0
      }
    }, {
      requestId: "req_20260630000000_stream_dump",
      streamHandlers: {
        onRequest: () => {},
        onDelta: () => {}
      }
    });

    assert.equal(result.decomposition.scene, "office");
    const requestDump = JSON.parse(await readFile(join(videoDir, "llm-request-req_20260630000000_stream_dump.json"), "utf8"));
    const responseDump = JSON.parse(await readFile(join(videoDir, "llm-response-req_20260630000000_stream_dump.json"), "utf8"));
    assert.equal(requestDump.requestId, "req_20260630000000_stream_dump");
    assert.equal(responseDump.requestId, "req_20260630000000_stream_dump");
    assert.equal(responseDump.response.ok, true);
    assert.equal(responseDump.response.mode, "chat.completions.stream");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition retries invalid_json with compact prompt and succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-invalid-json-retry-"));
  const retryEvents = [];
  let calls = 0;
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260709_001/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260709_001"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => probeFixture("ref_20260709_001", videoRelativePath),
      callWangzhuanLlm: async ({ messages }) => {
        calls += 1;
        const prompt = messages
          .flatMap((message) => Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (calls === 1) return "not-json{{{";
        assert.match(prompt, /更紧凑、合法的 JSON 拆解结果/);
        assert.match(prompt, /必须优先保证这 8 个字段/);
        return validDecompositionJson();
      }
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260709_001",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-4o",
        apiKey: "test-key",
        maxRetries: 1
      }
    }, {
      streamHandlers: {
        onRetry: (event) => retryEvents.push(event)
      }
    });

    assert.equal(calls, 2);
    assert.equal(result.decomposition.scene, "office");
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].reason, "invalid_json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long reference videos use compact prompt on first decomposition attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-long-video-compact-"));
  const prompts = [];
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260710_001/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260710_001"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      extractReferenceFrames: async () => [],
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => probeFixture("ref_20260710_001", videoRelativePath, {
        durationSec: 62
      }),
      callWangzhuanLlm: async ({ messages }) => {
        const prompt = messages
          .flatMap((message) => Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
          .join("\n");
        prompts.push(prompt);
        return validDecompositionJson({
          storySegments: [{
            storySegmentIndex: 1,
            startSec: 0,
            endSec: 20,
            durationSec: 20,
            scene: "office",
            subject: "phone",
            action: "tap",
            camera: "close-up",
            lighting: "bright",
            style: "realistic",
            quality: "high",
            sliceSplitHints: [{ splitSec: 12, reason: "hook shifts into proof" }]
          }]
        });
      }
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260710_001",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.4",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(result.decomposition.scene, "office");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /更紧凑、合法的 JSON 拆解结果/);
    assert.match(prompts[0], /必须输出 storySegments/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decomposition uses scene-aware frames directly when no public URL is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-frames-only-"));
  const fallbackEvents = [];
  const calls = [];
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260709_002/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260709_002"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      detectReferenceVideoScenes: async () => [],
      extractReferenceFrames: async () => ([
        { dataUrl: "data:image/jpeg;base64,aaa", timestampSec: 1 }
      ]),
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => probeFixture("ref_20260709_002", videoRelativePath, {
        storageUrl: "",
        storageKey: ""
      }),
      callWangzhuanLlm: async ({ referenceVideo, messages }) => {
        const hasFilePart = messages.some((message) => Array.isArray(message.content)
          && message.content.some((part) => part?.type === "file"));
        calls.push({
          hasFileDataUrl: Boolean(referenceVideo.fileDataUrl),
          hasFilePart,
          frameCount: referenceVideo.frameCount
        });
        return validDecompositionJson({ scene: "frames-only-office" });
      }
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260709_002",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-4o",
        apiKey: "test-key",
        maxRetries: 0
      }
    }, {
      streamHandlers: {
        onFallback: (event) => fallbackEvents.push(event)
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasFileDataUrl, false);
    assert.equal(calls[0].hasFilePart, false);
    assert.equal(calls[0].frameCount, 1);
    assert.equal(result.decomposition.scene, "frames-only-office");
    assert.equal(fallbackEvents.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreachable public URL (HEAD fails) falls back to scene-aware frames before calling the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-head-fail-"));
  const calls = [];
  const headProbes = [];
  try {
    const videoRelativePath = "批处理记录/网赚管线/reference-videos/ref_20260710_009/decomposition-proxy.mp4";
    const videoPath = join(root, videoRelativePath);
    await mkdir(join(root, "批处理记录/网赚管线/reference-videos/ref_20260710_009"), { recursive: true });
    await writeFile(videoPath, Buffer.from("video bytes"));
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      config: {},
      detectReferenceVideoScenes: async () => [],
      headProbeReferenceUrl: async ({ fileUrl }) => {
        headProbes.push(fileUrl);
        return { ok: false, reason: "http_status_403" };
      },
      extractReferenceFrames: async () => ([
        { dataUrl: "data:image/jpeg;base64,aaa", timestampSec: 1 }
      ]),
      recordTelemetryEvent: async () => {},
      loadReferenceVideoProbe: async () => probeFixture("ref_20260710_009", videoRelativePath),
      callWangzhuanLlm: async ({ referenceVideo, messages }) => {
        const hasFilePart = messages.some((message) => Array.isArray(message.content)
          && message.content.some((part) => part?.type === "file"));
        calls.push({ hasFilePart, frameCount: referenceVideo.frameCount, fileUrl: referenceVideo.fileUrl || "" });
        return validDecompositionJson({ scene: "head-fallback-office" });
      }
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260710_009",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "doubao-seed-2-0-lite-260428",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(headProbes.length, 1);
    assert.equal(headProbes[0], "https://cdn.example.com/uploads/reference/decomposition-proxy.mp4");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasFilePart, false);
    assert.equal(calls[0].fileUrl, "");
    assert.equal(calls[0].frameCount, 1);
    assert.equal(result.decomposition.scene, "head-fallback-office");
    assert.ok(result.warnings.some((warning) => warning.code === "reference_video_url_head_unreachable"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
