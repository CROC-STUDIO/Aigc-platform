import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkReferenceVideo,
  draftReferenceVideoDecomposition,
  decomposeReferenceVideo,
  getReferenceVideoWorkflowState,
  loadReferenceVideoProbe,
  validateVideoDecomposition
} from "../../server/wangzhuan/reference-videos.mjs";
import {
  closeWangzhuanFactsPool,
  setWangzhuanFactsPoolForTest,
  syncReferenceVideoFact
} from "../../server/wangzhuan/mysql-facts.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

async function resetFactsPool() {
  activePool = null;
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

test.afterEach(async () => {
  await resetFactsPool();
});

const baseVideo = Buffer.from("fake mp4 bytes");

function dataUrl(buffer = baseVideo, mimeType = "video/mp4") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function context(root, config = {}) {
  ensureFactsPool();
  const ctx = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    extractReferenceFrames: async () => [],
    config
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

async function persistPatchedProbe(ctx, referenceVideo, patch) {
  const patched = {
    ...referenceVideo,
    ...patch
  };
  const probePath = join(ctx.userProjectRoot, dirname(referenceVideo.storedPath), "probe.json");
  await writeFile(probePath, `${JSON.stringify(patched, null, 2)}\n`, "utf8");
  const synced = await syncReferenceVideoFact(ctx, patched);
  assert.equal(synced.skipped, false);
  return patched;
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

test("checks reference video with probed media metadata instead of trusting request metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-ffprobe-"));
  try {
    const result = await checkReferenceVideo({
      ...context(root),
      mockReferenceProbe: false,
      probeReferenceVideo: async ({ filePath, request }) => {
        assert.match(filePath, /original\.mp4$/);
        assert.equal(request.durationSec, 2);
        return {
          durationSec: 28.52,
          width: 720,
          height: 1280,
          formatName: "mov,mp4,m4a,3gp,3g2,mj2",
          bitRateBps: 1842000,
          videoCodec: "h264",
          fps: 29.97,
          colorSpace: "bt709",
          pixelFormat: "yuv420p",
          audioStreams: [
            {
              codec: "aac",
              sampleRate: 44100,
              channels: 2,
              bitRateBps: 128000
            }
          ],
          canExtractFrame: true
        };
      }
    }, validUpload({
      durationSec: 2,
      width: 100,
      height: 100,
      canExtractFrame: false
    }));

    assert.equal(result.referenceVideo.durationSec, 28.52);
    assert.equal(result.referenceVideo.width, 720);
    assert.equal(result.referenceVideo.height, 1280);
    assert.equal(result.referenceVideo.formatName, "mov,mp4,m4a,3gp,3g2,mj2");
    assert.equal(result.referenceVideo.bitRateBps, 1842000);
    assert.equal(result.referenceVideo.videoCodec, "h264");
    assert.equal(result.referenceVideo.fps, 29.97);
    assert.equal(result.referenceVideo.colorSpace, "bt709");
    assert.equal(result.referenceVideo.pixelFormat, "yuv420p");
    assert.equal(result.referenceVideo.audioStreamCount, 1);
    assert.deepEqual(result.referenceVideo.audioStreams, [
      {
        codec: "aac",
        sampleRate: 44100,
        channels: 2,
        bitRateBps: 128000
      }
    ]);
    assert.equal(result.referenceVideo.canExtractFrame, true);
    assert.equal(result.referenceVideo.status, "pass");
    assert.deepEqual(result.referenceVideo.issues, []);
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

test("returns workflow state with confirmed decomposition after decompose", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-workflow-state-"));
  try {
    const ctx = context(root);
    const checked = await checkReferenceVideo(ctx, validUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_workflow_state",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: validDecomposition()
    });
    const state = await getReferenceVideoWorkflowState(ctx, checked.referenceVideo.referenceVideoId);
    assert.equal(state.referenceVideo.referenceVideoId, checked.referenceVideo.referenceVideoId);
    assert.equal(state.decompositionConfirmed, true);
    assert.equal(state.decomposition.hook, validDecomposition().hook);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drafts reference video decomposition by calling configured llm", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-"));
  try {
    const ctx = {
      ...context(root),
      extractReferenceFrames: async ({ filePath, timestampsSec }) => {
        assert.match(filePath, /original\.mp4$/);
        assert.deepEqual(timestampsSec, [0, 7.1, 14.2, 21.3, 28.4]);
        return [
          { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,Zmlyc3QtZnJhbWU=" },
          { index: 1, timestampSec: 7.1, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,c2Vjb25kLWZyYW1l" }
        ];
      },
      callWangzhuanLlm: async ({ messages, llmConfig, referenceVideo, visionInputs }) => {
        assert.equal(llmConfig.model, "gpt-5.4");
        assert.equal(llmConfig.timeoutMs, 180000);
        assert.match(referenceVideo.storageUrl, /^https:\/\//);
        assert.equal(visionInputs.frames.length, 2);
        const userContent = messages.find((item) => item.role === "user").content;
        assert.equal(Array.isArray(userContent), true);
        assert.equal(userContent.some((part) => part.type === "file" && part.file?.file_url?.startsWith("https://")), true);
        assert.equal(userContent.filter((part) => part.type === "image_url").length, 2);
        const textPrompt = userContent.map((part) => part.text || "").join("\n");
        assert.match(textPrompt, /Cash Demo\.mp4/);
        assert.match(textPrompt, /Seedance decomposition dimensions/);
        assert.match(textPrompt, /actionReference/);
        assert.match(textPrompt, /cameraReference/);
        assert.match(textPrompt, /textElements/);
        assert.match(textPrompt, /effectReference/);
        assert.match(textPrompt, /doNotCopyElements/);
        assert.match(textPrompt, /动作参考/);
        assert.match(textPrompt, /运镜参考/);
        assert.match(textPrompt, /文字生成/);
        assert.match(textPrompt, /特效参考/);
        return JSON.stringify(validDecomposition({
          scene: "Generated from model",
          subject: "Model subject"
        }));
      }
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      knowledgeNotes: "Avoid competitor similarity",
      llmConfig: { provider: "skylink", model: "GPT-5.4", endpoint: "https://skylink-gateway.com/api/v1", temperature: 0.2 }
    });

    assert.equal(result.decomposition.scene, "Generated from model");
    assert.equal(result.decomposition.subject, "Model subject");
    assert.deepEqual(result.decomposition.missingFields, []);
    assert.equal(result.draft.source, "llm");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition honors configured llm timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-timeout-"));
  try {
    const ctx = {
      ...context(root),
      config: {
        wangzhuan: {
          llm: {
            provider: "skylink",
            model: "GPT-5.4",
            endpoint: "https://skylink-gateway.com/api/v1",
            timeoutMs: 240000
          }
        }
      },
      callWangzhuanLlm: async ({ llmConfig }) => {
        assert.equal(llmConfig.timeoutMs, 240000);
        return JSON.stringify(validDecomposition({ scene: "Timeout configured" }));
      }
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId
    });

    assert.equal(result.decomposition.scene, "Timeout configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition sends S3 video URL and sampled frames to the model gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gateway-video-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        output_text: JSON.stringify(validDecomposition({
          scene: "Gateway saw video input",
          subject: "Gateway subject"
        }))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,ZnJhbWUtMQ==" }
      ]
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const s3VideoUrl = "https://cdn.example.com/uploads/reference/ref_20260618_001/original.mp4";
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageKey: "uploads/reference/ref_20260618_001/original.mp4",
      storageUrl: s3VideoUrl
    });

    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "GPT-5.4",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-key"
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1/chat/completions");
    const content = calls[0].body.messages.find((item) => item.role === "user").content;
    assert.equal(content.some((part) => part.type === "file" && part.file?.file_url === s3VideoUrl), true);
    assert.equal(content.some((part) => part.type === "file" && part.file?.file_data?.startsWith("data:video/mp4;base64,")), false);
    assert.equal(content.some((part) => part.type === "image_url" && part.image_url?.url === "data:image/jpeg;base64,ZnJhbWUtMQ=="), true);
    assert.equal(result.decomposition.scene, "Gateway saw video input");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition sends Gemini-compatible contents when model is gemini", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gemini-contents-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body, headers: options.headers });
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              text: JSON.stringify(validDecomposition({
                scene: "Gemini saw frames",
                subject: "Gemini subject"
              }))
            }]
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,Z2VtaW5pLWZyYW1l" }
      ]
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "gemini-3.5-flash",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-key"
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1beta/models/gemini-3.5-flash:generateContent");
    assert.equal(calls[0].headers["x-goog-api-key"], "test-key");
    assert.equal(Array.isArray(calls[0].body.contents), true);
    const userParts = calls[0].body.contents.find((item) => item.role === "user").parts;
    assert.equal(userParts.some((part) => typeof part.text === "string" && part.text.includes("Seedance decomposition dimensions")), true);
    assert.equal(userParts.some((part) => part.inlineData?.mimeType === "video/mp4" || part.fileData?.mimeType === "video/mp4"), true);
    assert.equal(userParts.some((part) => part.inlineData?.mimeType === "image/jpeg"), true);
    assert.equal(result.decomposition.scene, "Gemini saw frames");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition converts relative proxy storage URL into a direct S3 URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gateway-s3-direct-"));
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    S3_BUCKET: process.env.S3_BUCKET,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE
  };
  const calls = [];
  try {
    process.env.S3_BUCKET = "aigc-assets";
    process.env.AWS_REGION = "ap-southeast-1";
    process.env.S3_ENDPOINT = "https://s3.ap-southeast-1.amazonaws.com";
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.S3_PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.S3_FORCE_PATH_STYLE;

    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        output_text: JSON.stringify(validDecomposition({
          scene: "Gateway saw direct S3 URL",
          subject: "Direct S3 subject"
        }))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => []
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const storageKey = "uploads/PROJECT_ROOT_P/users/admin/批处理记录/网赚管线/reference-videos/ref_20260618_017/original.mp4";
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageKey,
      storageUrl: `/api/public/assets/${encodeURIComponent(storageKey)}`
    });

    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "GPT-5.4",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-key"
      }
    });

    const content = calls[0].body.messages.find((item) => item.role === "user").content;
    assert.equal(
      content.some((part) => part.type === "file"
        && part.file?.file_url === "https://aigc-assets.s3.ap-southeast-1.amazonaws.com/uploads/PROJECT_ROOT_P/users/admin/%E6%89%B9%E5%A4%84%E7%90%86%E8%AE%B0%E5%BD%95/%E7%BD%91%E8%B5%9A%E7%AE%A1%E7%BA%BF/reference-videos/ref_20260618_017/original.mp4"),
      true
    );
    assert.equal(content.some((part) => part.type === "file" && part.file?.file_data?.startsWith("data:video/mp4;base64,")), false);
    assert.equal(result.decomposition.scene, "Gateway saw direct S3 URL");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition exposes S3 video URL to custom llm callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-s3-context-"));
  try {
    const s3VideoUrl = "https://cdn.example.com/uploads/reference/custom/original.mp4";
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [],
      callWangzhuanLlm: async ({ messages, referenceVideo, visionInputs }) => {
        assert.equal(referenceVideo.fileUrl, s3VideoUrl);
        assert.equal(referenceVideo.fileDataUrl, undefined);
        assert.equal(visionInputs.fileUrl, s3VideoUrl);
        assert.equal(visionInputs.fileDataUrl, undefined);
        const userContent = messages.find((item) => item.role === "user").content;
        assert.equal(userContent.some((part) => part.type === "file" && part.file?.file_url === s3VideoUrl), true);
        assert.equal(userContent.some((part) => part.type === "file" && part.file?.file_data?.startsWith("data:video/mp4;base64,")), false);
        return JSON.stringify(validDecomposition({
          scene: "Custom caller saw S3 URL",
          subject: "Custom caller subject"
        }));
      }
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageKey: "uploads/reference/custom/original.mp4",
      storageUrl: s3VideoUrl
    });

    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: { provider: "skylink", model: "GPT-5.4", endpoint: "https://skylink-gateway.com/api/v1" }
    });

    assert.equal(result.decomposition.scene, "Custom caller saw S3 URL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition dumps the redacted model request by request id", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-dump-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    const s3VideoUrl = "https://cdn.example.com/uploads/reference/debug/original.mp4";
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        output_text: JSON.stringify(validDecomposition({
          scene: "Dumped request scene",
          subject: "Dumped request subject"
        }))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,ZHVtcC1mcmFtZQ==" }
      ]
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageKey: "uploads/reference/debug/original.mp4",
      storageUrl: s3VideoUrl
    });

    await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "GPT-5.4",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-secret-key",
        apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
      }
    }, {
      requestId: "req_20260618120219_6afd"
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1/chat/completions");
    const dumpPath = join(ctx.userProjectRoot, dirname(checked.referenceVideo.storedPath), "llm-request-req_20260618120219_6afd.json");
    const dump = JSON.parse(await readFile(dumpPath, "utf8"));
    assert.equal(dump.requestId, "req_20260618120219_6afd");
    assert.equal(dump.inputMode, "file_url");
    assert.equal(dump.request.method, "POST");
    assert.equal(dump.request.url, "https://skylink-gateway.com/api/v1/chat/completions");
    assert.equal(dump.request.headers.Authorization, "Bearer <REDACTED:WANGZHUAN_LLM_API_KEY>");
    assert.equal(JSON.stringify(dump).includes("test-secret-key"), false);
    const content = dump.request.body.messages.find((item) => item.role === "user").content;
    assert.equal(content.some((part) => part.type === "file" && part.file?.file_url === s3VideoUrl), true);
    assert.equal(content.some((part) => part.type === "image_url" && part.image_url?.url === "data:image/jpeg;base64,ZHVtcC1mcmFtZQ=="), true);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition dumps Gemini request bodies with redacted api key header", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gemini-dump-"));
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          role: "model",
          parts: [{ text: JSON.stringify(validDecomposition({ scene: "Gemini dump scene" })) }]
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => []
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "gemini-3.5-flash",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "gemini-secret-key",
        apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
      }
    }, {
      requestId: "req_20260625150000_abcd"
    });

    const dumpPath = join(ctx.userProjectRoot, dirname(checked.referenceVideo.storedPath), "llm-request-req_20260625150000_abcd.json");
    const dump = JSON.parse(await readFile(dumpPath, "utf8"));
    assert.equal(dump.inputMode, "gemini_contents");
    assert.equal(dump.request.url, "https://skylink-gateway.com/api/v1beta/models/gemini-3.5-flash:generateContent");
    assert.equal(dump.request.headers["x-goog-api-key"], "<REDACTED:WANGZHUAN_LLM_API_KEY>");
    assert.equal(JSON.stringify(dump).includes("gemini-secret-key"), false);
    assert.equal(Array.isArray(dump.request.body.contents), true);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition uses chat completions directly when external file_url is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gateway-fallback-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    const s3VideoUrl = "https://cdn.example.com/uploads/reference/fallback/original.mp4";
    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(validDecomposition({
              scene: "Chat kept video and frames",
              subject: "Chat subject"
            }))
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,ZnJhbWUtMg==" }
      ]
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageKey: "uploads/reference/fallback/original.mp4",
      storageUrl: s3VideoUrl
    });
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "GPT-5.4",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-key"
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1/chat/completions");
    const chatContent = calls[0].body.messages.find((item) => item.role === "user").content;
    assert.equal(chatContent.some((part) => part.type === "file" && part.file?.file_url === s3VideoUrl), true);
    assert.equal(chatContent.some((part) => part.type === "image_url" && part.image_url.url === "data:image/jpeg;base64,ZnJhbWUtMg=="), true);
    assert.equal(result.decomposition.scene, "Chat kept video and frames");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition falls back to chat with inline video when responses returns 5xx", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-gateway-fallback-5xx-"));
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    S3_BUCKET: process.env.S3_BUCKET,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL
  };
  const calls = [];
  try {
    delete process.env.S3_BUCKET;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_PUBLIC_BASE_URL;

    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/responses")) {
        return new Response(JSON.stringify({ error: { message: "Upstream request failed" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(validDecomposition({
              scene: "Fallback recovered from upstream failure",
              subject: "Recovered subject"
            }))
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const ctx = {
      ...context(root),
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,NXh4LWZyYW1l" }
      ]
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    await persistPatchedProbe(ctx, checked.referenceVideo, {
      storageUrl: "",
      storageKey: ""
    });
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: {
        provider: "skylink",
        model: "GPT-5.4",
        endpoint: "https://skylink-gateway.com/api/v1",
        apiKey: "test-key"
      }
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1/responses");
    assert.equal(calls[1].url, "https://skylink-gateway.com/api/v1/chat/completions");
    const chatContent = calls[1].body.messages.find((item) => item.role === "user").content;
    assert.equal(chatContent.some((part) => part.type === "file" && (part.file?.file_url || part.file?.file_data)), true);
    assert.equal(chatContent.some((part) => part.type === "image_url" && part.image_url.url === "data:image/jpeg;base64,NXh4LWZyYW1l"), true);
    assert.equal(result.decomposition.scene, "Fallback recovered from upstream failure");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition accepts nested llm JSON payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-nested-"));
  try {
    const ctx = {
      ...context(root),
      callWangzhuanLlm: async () => JSON.stringify({
        decomposition: validDecomposition({
          scene: "Nested model scene",
          subject: "Nested model subject"
        })
      })
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: { provider: "skylink", model: "GPT-5.4", endpoint: "https://skylink-gateway.com/api/v1", temperature: 0.2 }
    });

    assert.equal(result.decomposition.scene, "Nested model scene");
    assert.equal(result.decomposition.subject, "Nested model subject");
    assert.deepEqual(result.decomposition.missingFields, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition maps Chinese llm field names to contract fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-cn-"));
  try {
    const ctx = {
      ...context(root),
      callWangzhuanLlm: async () => JSON.stringify({
        场景: "手机奖励 App 页面",
        主体: "手持手机的人",
        动作: "点击奖励按钮并展示金币反馈",
        镜头: "竖屏近景，轻微推进",
        光线: "明亮室内光",
        风格: "UGC App 演示",
        画质: "高清",
        钩子: "前三秒展示可领取奖励"
      })
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: { provider: "skylink", model: "GPT-5.4", endpoint: "https://skylink-gateway.com/api/v1", temperature: 0.2 }
    });

    assert.equal(result.decomposition.scene, "手机奖励 App 页面");
    assert.equal(result.decomposition.camera, "竖屏近景，轻微推进");
    assert.equal(result.decomposition.hook, "前三秒展示可领取奖励");
    assert.deepEqual(result.decomposition.missingFields, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition flattens object values returned for contract fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-object-values-"));
  try {
    const ctx = {
      ...context(root),
      callWangzhuanLlm: async () => JSON.stringify({
        scene: { environment: "short-form vertical ad scene", durationSec: 13 },
        subject: { role: "product demonstrator", props: ["phone", "reward cue"] },
        action: { mainAction: "tap reward button" },
        camera: { framing: "close-up vertical shot" },
        lighting: { mood: "bright indoor lighting" },
        style: { format: "UGC app demo" },
        quality: { resolution: "HD" },
        hook: { firstSeconds: "show reward immediately" }
      })
    };
    const checked = await checkReferenceVideo(ctx, validUpload());
    const result = await draftReferenceVideoDecomposition(ctx, {
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      llmConfig: { provider: "skylink", model: "GPT-5.4", endpoint: "https://skylink-gateway.com/api/v1", temperature: 0.2 }
    });

    assert.match(result.decomposition.scene, /short-form vertical ad scene/);
    assert.match(result.decomposition.subject, /reward cue/);
    assert.match(result.decomposition.hook, /show reward immediately/);
    assert.doesNotMatch(result.decomposition.scene, /^[\[{]/);
    assert.doesNotMatch(result.decomposition.subject, /^[\[{]/);
    assert.deepEqual(result.decomposition.missingFields, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft decomposition requires llm api key when no mock caller is provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-ref-draft-key-"));
  const previousEnv = {
    WANGZHUAN_LLM_API_KEY: process.env.WANGZHUAN_LLM_API_KEY,
    VIDEO_AIGC_API_KEY: process.env.VIDEO_AIGC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_KEY: process.env.OPENAI_KEY,
    REVERSE_PROMPT_API_KEY: process.env.REVERSE_PROMPT_API_KEY
  };
  try {
    for (const key of Object.keys(previousEnv)) delete process.env[key];
    const checked = await checkReferenceVideo(context(root), validUpload());
    await assert.rejects(
      () => draftReferenceVideoDecomposition(context(root), {
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        llmConfig: {
          provider: "skylink",
          model: "GPT-5.4",
          endpoint: "https://skylink-gateway.com/api/v1",
          apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
        }
      }),
      {
        code: "model_failed",
        data: {
          provider: "skylink",
          model: "gpt-5.4",
          apiKeyEnv: "WANGZHUAN_LLM_API_KEY",
          upstreamMessage: "未配置模型 API Key，请在环境变量 WANGZHUAN_LLM_API_KEY 中配置后重启服务"
        }
      }
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
