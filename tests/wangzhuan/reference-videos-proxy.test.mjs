import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("gpt-5.5 decomposition uses chat completions with 1fps frames and no video file_url", async () => {
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
      assert.equal(parts.filter((part) => part?.type === "image_url").length, 3);
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
        durationSec: 2.4,
        width: 480,
        height: 854,
        fps: 15
      })
    };

    const result = await draftReferenceVideoDecomposition(context, {
      referenceVideoId: "ref_20260630_055",
      llmConfig: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.5",
        apiKey: "test-key",
        maxRetries: 0
      }
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(frameRequests[0], [0.5, 1.5, 2.3]);
    assert.equal(result.decomposition.scene, "office");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("gemini decomposition keeps S3 URL and uses 1fps default frames", async () => {
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
      assert.equal(parts.filter((part) => part?.type === "image_url").length, 3);
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
        durationSec: 2.4,
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
    assert.deepEqual(frameRequests[0], [0.5, 1.5, 2.3]);
    assert.equal(result.decomposition.scene, "factory");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
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
