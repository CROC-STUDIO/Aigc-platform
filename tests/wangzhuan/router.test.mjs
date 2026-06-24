import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { dirname, join } from "node:path";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import {
  closeWangzhuanFactsPool,
  loadBatchDetailFromMysql,
  setWangzhuanFactsPoolForTest,
  syncBatchFacts,
  syncReferenceVideoFact
} from "../../server/wangzhuan/mysql-facts.mjs";
import { submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import { startDirectMaskEdit, uploadRemixSource } from "../../server/wangzhuan/remix.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { stitchBatchSegments } from "../../server/wangzhuan/stitch.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";
import { prepareDownloadedSegmentsWithoutStitch, testGeneratedVideoProbe, testSeedanceProviderClient } from "./test-providers.mjs";

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

function jsonReq(method, body = {}) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = {};
  return stream;
}

function captureRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    }
  };
}

function context(role = "user") {
  return {
    readJson: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
    currentUser: () => ({ userId: role, username: role, role, isAdmin: role === "admin" }),
    currentUserId: () => role,
    currentProjectRoot: () => "C:/tmp/wz/user",
    currentBaseProjectRoot: () => "C:/tmp/wz/shared"
  };
}

function wangzhuanModuleContext(root, overrides = {}) {
  const ctx = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "user",
    user: { userId: "user", username: "user", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    probeGeneratedVideo: testGeneratedVideoProbe,
    ...overrides
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

function tempContext(root, role = "user") {
  const ctx = {
    ...context(role),
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: role,
    mockReferenceProbe: true,
    probeGeneratedVideo: testGeneratedVideoProbe
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

function anonymousContext() {
  return {
    ...context("user"),
    currentUser: () => null
  };
}

async function startedBatchFixture(root) {
  ensureFactsPool();
  const { join } = await import("node:path");
  const moduleContext = wangzhuanModuleContext(root);
  const saved = await saveTemplate(moduleContext, {
    mode: "create",
    draft: {
      displayName: "Cash Reward US EN",
      productName: "Lucky Cash",
      cta: "Download now",
      ending: "Claim your bonus today",
      currencySymbol: "$",
      language: "en-US",
      regions: ["US"],
      targetChannels: ["meta_ads"],
      defaultOutputRatio: "9:16",
      defaultDurationSec: 15,
      promiseLevel: "strong_conversion"
    }
  });
  const checked = await checkReferenceVideo(moduleContext, {
    fileName: "demo.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
    durationSec: 15,
    width: 720,
    height: 1280,
    canExtractFrame: true
  });
  await decomposeReferenceVideo(moduleContext, {
    idempotencyKey: "idem_decompose_router_detail",
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: {
      scene: "Phone app reward screen",
      subject: "Hand holding phone",
      action: "User taps a reward task",
      camera: "Close-up vertical shot",
      lighting: "Bright indoor lighting",
      style: "Clean app demo",
      quality: "HD",
      hook: "Earn rewards with daily tasks"
    }
  });
  const estimated = await estimateBatch(moduleContext, {
    templateId: saved.template.templateId,
    versionId: saved.template.versionId,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: "strong_conversion",
    durationSec: 15,
    variantCount: 2,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  return {
    moduleContext,
    started: await startBatchFromEstimate(moduleContext, {
      idempotencyKey: "idem_start_router_detail",
      estimateId: estimated.estimate.estimateId
    })
  };
}

async function failedThirtySecondStitchFixture(root) {
  ensureFactsPool();
  const { join } = await import("node:path");
  const moduleContext = wangzhuanModuleContext(root, {
    seedanceProviderClient: testSeedanceProviderClient(),
    capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } }
  });
  const saved = await saveTemplate(moduleContext, {
    mode: "create",
    draft: {
      displayName: "Cash Reward US EN",
      productName: "Lucky Cash",
      cta: "Download now",
      ending: "Claim your bonus today",
      currencySymbol: "$",
      language: "en-US",
      regions: ["US"],
      targetChannels: ["meta_ads"],
      defaultOutputRatio: "9:16",
      defaultDurationSec: 30,
      promiseLevel: "strong_conversion",
      disclaimer: "Rewards vary by eligibility",
      disclaimerByLanguage: {
        "en-US": "Rewards vary by eligibility"
      }
    }
  });
  const checked = await checkReferenceVideo(moduleContext, {
    fileName: "demo.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
    durationSec: 30,
    width: 720,
    height: 1280,
    canExtractFrame: true
  });
  await decomposeReferenceVideo(moduleContext, {
    idempotencyKey: "idem_decompose_router_retry",
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: {
      scene: "Phone app reward screen",
      subject: "Hand holding phone",
      action: "User taps a reward task",
      camera: "Close-up vertical shot",
      lighting: "Bright indoor lighting",
      style: "Clean app demo",
      quality: "HD",
      hook: "Earn rewards with daily tasks"
    }
  });
  const estimated = await estimateBatch(moduleContext, {
    templateId: saved.template.templateId,
    versionId: saved.template.versionId,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: "strong_conversion",
    durationSec: 30,
    variantCount: 1,
    requestedConcurrency: 1,
    outputRatio: "9:16",
    disclaimer: "Rewards vary by eligibility",
    disclaimerByLanguage: {
      "en-US": "Rewards vary by eligibility"
    }
  });
  const started = await startBatchFromEstimate(moduleContext, {
    idempotencyKey: "idem_start_router_retry",
    estimateId: estimated.estimate.estimateId
  });
  await submitPendingGenerationTasks(moduleContext, started.batch.batchId);
  await prepareDownloadedSegmentsWithoutStitch(moduleContext, started.batch.batchId);
  await stitchBatchSegments(moduleContext, started.batch.batchId, { forceFail: true });
  return { moduleContext, started };
}

test("unknown wangzhuan routes return the new error envelope", async () => {
  const res = captureRes();
  await handleWangzhuanRequest(jsonReq("GET"), res, new URL("http://localhost/api/wangzhuan/nope"), context());

  assert.equal(res.statusCode, 404);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Unsupported wangzhuan endpoint");
  assert.match(payload.requestId, /^req_\d{14}_[a-f0-9]{4}$/);
});

test("unauthenticated wangzhuan routes return the new error envelope", async () => {
  const res = captureRes();
  await handleWangzhuanRequest(
    jsonReq("GET"),
    res,
    new URL("http://localhost/api/wangzhuan/templates"),
    anonymousContext()
  );

  assert.equal(res.statusCode, 401);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "unauthenticated");
  assert.equal(payload.message, "请先登录");
  assert.match(payload.requestId, /^req_\d{14}_[a-f0-9]{4}$/);
});

test("admin template endpoint enforces admin permission with envelope", async () => {
  const res = captureRes();
  await handleWangzhuanRequest(
    jsonReq("POST", { action: "archive", templateId: "tpl_cash_001" }),
    res,
    new URL("http://localhost/api/wangzhuan/templates/admin"),
    context("user")
  );

  assert.equal(res.statusCode, 403);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "permission_denied");
  assert.equal(payload.data.requestedPermission, "template:admin");
});

test("llm config endpoint returns model defaults without exposing api key", async () => {
  process.env.WANGZHUAN_LLM_API_KEY = "secret-token";
  const res = captureRes();
  try {
    await handleWangzhuanRequest(
      jsonReq("GET"),
      res,
      new URL("http://localhost/api/wangzhuan/llm-config"),
      {
        ...context("user"),
        config: {
          wangzhuan: {
            llm: {
              provider: "skylink",
              endpoint: "https://skylink-gateway.com/api/v1",
              model: "GPT-5.4",
              apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
            }
          }
        }
      }
    );
  } finally {
    delete process.env.WANGZHUAN_LLM_API_KEY;
  }

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "ok");
  assert.deepEqual(payload.data.llmConfig, {
    provider: "skylink",
    endpoint: "https://skylink-gateway.com/api/v1",
    model: "gpt-5.4",
    temperature: 0.2,
    timeoutMs: 180000,
    apiKeyEnv: "WANGZHUAN_LLM_API_KEY",
    hasApiKey: true,
    preferVideoUrl: false
  });
  assert.deepEqual(payload.data.qcLlmConfig, {
    provider: "skylink",
    endpoint: "https://skylink-gateway.com/api/v1",
    model: "doubao-seed-2-0-lite-260428",
    temperature: 0.2,
    timeoutMs: 180000,
    apiKeyEnv: "WANGZHUAN_LLM_API_KEY",
    hasApiKey: true,
    preferVideoUrl: true
  });
  assert.doesNotMatch(res.body, /secret-token/);
  assert.doesNotMatch(res.body, /"apiKey"\s*:/);
});

test("llm config reuses video generation api key when a dedicated key is not set", async () => {
  const previousEnv = {
    WANGZHUAN_LLM_API_KEY: process.env.WANGZHUAN_LLM_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_KEY: process.env.OPENAI_KEY,
    REVERSE_PROMPT_API_KEY: process.env.REVERSE_PROMPT_API_KEY,
    VIDEO_AIGC_API_KEY: process.env.VIDEO_AIGC_API_KEY
  };
  delete process.env.WANGZHUAN_LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_KEY;
  delete process.env.REVERSE_PROMPT_API_KEY;
  process.env.VIDEO_AIGC_API_KEY = "shared-seedance-token";
  const res = captureRes();
  try {
    await handleWangzhuanRequest(
      jsonReq("GET"),
      res,
      new URL("http://localhost/api/wangzhuan/llm-config"),
      context("user")
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "ok");
  assert.equal(payload.data.llmConfig.hasApiKey, true);
  assert.doesNotMatch(res.body, /shared-seedance-token/);
  assert.doesNotMatch(res.body, /"apiKey"\s*:/);
});

test("draft decomposition endpoint reports missing llm api key env to frontend", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const previousEnv = {
    WANGZHUAN_LLM_API_KEY: process.env.WANGZHUAN_LLM_API_KEY,
    VIDEO_AIGC_API_KEY: process.env.VIDEO_AIGC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_KEY: process.env.OPENAI_KEY,
    REVERSE_PROMPT_API_KEY: process.env.REVERSE_PROMPT_API_KEY
  };
  for (const key of Object.keys(previousEnv)) delete process.env[key];
  const root = await mkdtemp(join(tmpdir(), "wz-router-draft-key-"));
  ensureFactsPool();
  try {
    const ctx = wangzhuanModuleContext(root, {
      readJson: context("user").readJson,
      currentUser: () => ({ userId: "user", username: "user", role: "user", isAdmin: false }),
      currentUserId: () => "user",
      currentProjectRoot: () => join(root, "user"),
      currentBaseProjectRoot: () => join(root, "shared")
    });
    const checked = await checkReferenceVideo(ctx, {
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
      durationSec: 15,
      width: 720,
      height: 1280,
      canExtractFrame: true
    });
    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        llmConfig: {
          provider: "skylink",
          endpoint: "https://skylink-gateway.com/api/v1",
          model: "GPT-5.4",
          apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
        }
      }),
      res,
      new URL("http://localhost/api/wangzhuan/reference-videos/draft-decomposition"),
      ctx
    );

    assert.equal(res.statusCode, 502);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "model_failed");
    assert.equal(payload.data.apiKeyEnv, "WANGZHUAN_LLM_API_KEY");
    assert.match(payload.data.upstreamMessage, /WANGZHUAN_LLM_API_KEY/);
    assert.doesNotMatch(res.body, /secret-token/);
  } finally {
    await resetFactsPool();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("reference video check endpoint returns the new success envelope", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-ref-"));
  ensureFactsPool();
  try {
    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        fileName: "demo.mp4",
        mimeType: "video/mp4",
        content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
        durationSec: 15,
        width: 720,
        height: 1280,
        canExtractFrame: true
      }),
      res,
      new URL("http://localhost/api/wangzhuan/reference-videos/check"),
      tempContext(root)
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "ok");
    assert.match(payload.data.referenceVideo.referenceVideoId, /^ref_\d{8}_\d{3}$/);
    assert.equal(payload.data.referenceVideo.status, "pass");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("product asset upload endpoint returns a reusable stored asset link for template drafts", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-product-asset-"));
  try {
    const res = captureRes();
    const ctx = {
      ...tempContext(root),
      reviewProductAsset: async () => ({
        assetId: "asset_seedance_icon_1",
        status: "processing",
        reviewReason: "素材已上传，Seedance 正在审核"
      }),
      async syncWangzhuanAsset({ fullPath, assetKind }) {
        return {
          storageKey: `uploads/test/${assetKind}.png`,
          storageUrl: `https://harpoons3.s3.ap-southeast-1.amazonaws.com/uploads/test/${assetKind}.png`,
          storedPath: fullPath
        };
      }
    };
    await handleWangzhuanRequest(
      jsonReq("POST", {
        branchId: "branch_news",
        assetKey: "productIcon",
        fileName: "news-icon.png",
        mimeType: "image/png",
        content: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
      }),
      res,
      new URL("http://localhost/api/wangzhuan/product-assets/upload"),
      ctx
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "ok");
    assert.equal(payload.data.asset.branchId, "branch_news");
    assert.equal(payload.data.asset.assetKey, "productIcon");
    assert.match(payload.data.asset.storedPath, /product-assets\/branch_news\/productIcon\/news-icon\.png$/);
    assert.match(payload.data.asset.previewUrl, /^https:\/\//);
    assert.match(payload.data.asset.storageUrl, /^https:\/\/harpoons3\.s3\.ap-southeast-1\.amazonaws\.com\//);
    assert.equal(payload.data.asset.previewUrl, payload.data.asset.storageUrl);
    assert.equal(payload.data.asset.review.assetId, "asset_seedance_icon_1");
    assert.equal(payload.data.asset.review.status, "processing");
    assert.match(payload.data.asset.review.reviewReason, /Seedance 正在审核/);
    assert.equal(Object.hasOwn(payload.data.asset, "content"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store page inspect endpoint returns parsed fallback candidates", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-store-page-"));
  try {
    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        url: "https://play.google.com/store/apps/details?id=com.lucky.cash"
      }),
      res,
      new URL("http://localhost/api/wangzhuan/store-page/inspect"),
      tempContext(root)
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "ok");
    assert.equal(payload.data.store, "google_play");
    assert.equal(payload.data.candidates.productName, "cash");
    assert.equal(payload.data.candidates.icon, null);
    assert.deepEqual(payload.data.candidates.screenshots, []);
    assert.match(payload.data.warnings[0], /链接解析兜底信息/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference video draft endpoint calls llm and returns a decomposition draft", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-draft-"));
  ensureFactsPool();
  try {
    const moduleContext = wangzhuanModuleContext(root, {
      readJson: context("user").readJson,
      currentUser: () => ({ userId: "user", username: "user", role: "user", isAdmin: false }),
      currentUserId: () => "user",
      currentProjectRoot: () => join(root, "user"),
      currentBaseProjectRoot: () => join(root, "shared"),
      callWangzhuanLlm: async () => JSON.stringify({
        scene: "Model scene",
        subject: "Model subject",
        action: "Model action",
        camera: "Model camera",
        lighting: "Model lighting",
        style: "Model style",
        quality: "Model quality",
        hook: "Model hook"
      })
    });
    const checked = await checkReferenceVideo(moduleContext, {
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
      durationSec: 15,
      width: 720,
      height: 1280,
      canExtractFrame: true
    });

    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        knowledgeNotes: "Avoid sameness",
        llmConfig: { provider: "skylink", endpoint: "https://skylink-gateway.com/api/v1", model: "GPT-5.4", temperature: 0.2 }
      }),
      res,
      new URL("http://localhost/api/wangzhuan/reference-videos/draft-decomposition"),
      moduleContext
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "ok");
    assert.equal(payload.data.decomposition.scene, "Model scene");
    assert.equal(payload.data.draft.source, "llm");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("reference video draft endpoint writes a redacted model request dump for the response request id", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "wz-router-draft-dump-"));
  const previousFetch = globalThis.fetch;
  ensureFactsPool();
  try {
    const moduleContext = wangzhuanModuleContext(root, {
      extractReferenceFrames: async () => [
        { index: 0, timestampSec: 0, mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,cm91dGVyLWZyYW1l" }
      ],
      readJson: context("user").readJson,
      currentUser: () => ({ userId: "user", username: "user", role: "user", isAdmin: false }),
      currentUserId: () => "user",
      currentProjectRoot: () => join(root, "user"),
      currentBaseProjectRoot: () => join(root, "shared")
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        scene: "Router dump scene",
        subject: "Router dump subject",
        action: "Router dump action",
        camera: "Router dump camera",
        lighting: "Router dump lighting",
        style: "Router dump style",
        quality: "Router dump quality",
        hook: "Router dump hook"
      })
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const checked = await checkReferenceVideo(moduleContext, {
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
      durationSec: 15,
      width: 720,
      height: 1280,
      canExtractFrame: true
    });
    const videoUrl = "https://cdn.example.com/router-dump/original.mp4";
    const patchedProbe = {
      ...checked.referenceVideo,
      storageKey: "uploads/router-dump/original.mp4",
      storageUrl: videoUrl
    };
    const probePath = join(moduleContext.userProjectRoot, dirname(checked.referenceVideo.storedPath), "probe.json");
    await writeFile(probePath, `${JSON.stringify(patchedProbe, null, 2)}\n`, "utf8");
    const synced = await syncReferenceVideoFact(moduleContext, patchedProbe);
    assert.equal(synced.skipped, false);

    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        llmConfig: {
          provider: "skylink",
          endpoint: "https://skylink-gateway.com/api/v1",
          model: "GPT-5.4",
          temperature: 0.2,
          apiKey: "router-secret-key"
        }
      }),
      res,
      new URL("http://localhost/api/wangzhuan/reference-videos/draft-decomposition"),
      moduleContext
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.match(payload.requestId, /^req_\d{14}_[a-f0-9]{4}$/);
    const dumpPath = join(moduleContext.userProjectRoot, dirname(checked.referenceVideo.storedPath), `llm-request-${payload.requestId}.json`);
    const dump = JSON.parse(await readFile(dumpPath, "utf8"));
    assert.equal(dump.requestId, payload.requestId);
    assert.equal(dump.request.headers.Authorization, "Bearer <REDACTED:WANGZHUAN_LLM_API_KEY>");
    assert.equal(JSON.stringify(dump).includes("router-secret-key"), false);
    assert.equal(dump.request.body.input.find((item) => item.role === "user").content.some((part) => part.type === "input_file" && part.file_url === videoUrl), true);
  } finally {
    globalThis.fetch = previousFetch;
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("batch estimate endpoint returns a contract success envelope", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-est-"));
  ensureFactsPool();
  try {
    const ctx = wangzhuanModuleContext(root);
    const saved = await saveTemplate(ctx, {
      mode: "create",
      draft: {
        displayName: "Cash Reward US EN",
        productName: "Lucky Cash",
        cta: "Download now",
        ending: "Claim your bonus today",
        currencySymbol: "$",
        language: "en-US",
        regions: ["US"],
        targetChannels: ["meta_ads"],
        defaultOutputRatio: "9:16",
        defaultDurationSec: 15,
        promiseLevel: "strong_conversion"
      }
    });
    const checked = await checkReferenceVideo(ctx, {
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
      durationSec: 15,
      width: 720,
      height: 1280,
      canExtractFrame: true
    });
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_decompose_router",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: {
        scene: "Phone app reward screen",
        subject: "Hand holding phone",
        action: "User taps a reward task",
        camera: "Close-up vertical shot",
        lighting: "Bright indoor lighting",
        style: "Clean app demo",
        quality: "HD",
        hook: "Earn rewards with daily tasks"
      }
    });

    const res = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        templateId: saved.template.templateId,
        versionId: saved.template.versionId,
        referenceVideoId: checked.referenceVideo.referenceVideoId,
        targetChannel: "meta_ads",
        targetRegion: "US",
        language: "en-US",
        promiseLevel: "strong_conversion",
        durationSec: 15,
        variantCount: 2,
        requestedConcurrency: 1,
        outputRatio: "9:16"
      }),
      res,
      new URL("http://localhost/api/wangzhuan/batches/estimate"),
      tempContext(root)
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.code, "ok");
    assert.match(payload.data.estimate.estimateId, /^est_\d{8}_\d{3}$/);
    assert.equal(payload.data.estimate.seedanceSegmentCount, 2);
    assert.equal(payload.data.capabilities.stitcher.status, "not_required");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("batch detail and stop endpoints return contract envelopes", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-batch-"));
  try {
    const fx = await startedBatchFixture(root);

    const detailRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("GET"),
      detailRes,
      new URL(`http://localhost/api/wangzhuan/batches/${fx.started.batch.batchId}`),
      tempContext(root)
    );
    assert.equal(detailRes.statusCode, 200);
    const detailPayload = JSON.parse(detailRes.body);
    assert.equal(detailPayload.code, "ok");
    assert.equal(detailPayload.data.batch.batchId, fx.started.batch.batchId);
    assert.equal(detailPayload.data.batch.scripts.length, 2);
    assert.equal(detailPayload.data.downloadSummary.packageReady, false);

    const stopRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { reason: "user_cancelled" }),
      stopRes,
      new URL(`http://localhost/api/wangzhuan/batches/${fx.started.batch.batchId}/stop`),
      tempContext(root)
    );
    assert.equal(stopRes.statusCode, 200);
    const stopPayload = JSON.parse(stopRes.body);
    assert.equal(stopPayload.code, "ok");
    assert.equal(stopPayload.data.batch.status, "stopped");
    assert.equal(stopPayload.data.batch.tasks.every((task) => task.status === "stopped"), true);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("remix stop endpoint returns a contract envelope", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-remix-stop-"));
  ensureFactsPool();
  try {
    const moduleContext = wangzhuanModuleContext(root, {
      config: {},
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover"]
        }
      },
      remixProviderClient: {
        async createJob() {
          return {
            job_id: "job_router_stop",
            job_type: "ai_remove",
            status: "running"
          };
        }
      }
    });
    const source = await uploadRemixSource(moduleContext, {
      fileName: "source.mp4",
      mimeType: "video/mp4",
      content: `data:video/mp4;base64,${Buffer.from("source").toString("base64")}`,
      durationSec: 15,
      width: 720,
      height: 1280
    });
    const started = await startDirectMaskEdit(moduleContext, {
      idempotencyKey: "idem_router_stop_remix",
      sourceId: source.sourceId,
      regions: [{
        regionId: "mask_1",
        type: "bbox",
        label: "watermark",
        bbox: { x: 0.6, y: 0.8, width: 0.2, height: 0.1 }
      }],
      maskDataUrl: `data:image/png;base64,${Buffer.from("mask").toString("base64")}`
    });

    const stopRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { reason: "user_cancelled" }),
      stopRes,
      new URL(`http://localhost/api/wangzhuan/remix/${started.remix.remixId}/stop`),
      {
        ...tempContext(root),
        config: moduleContext.config,
        remixProviderClient: moduleContext.remixProviderClient
      }
    );

    assert.equal(stopRes.statusCode, 200);
    const stopPayload = JSON.parse(stopRes.body);
    assert.equal(stopPayload.code, "ok");
    assert.equal(stopPayload.data.remix.status, "stopped");
    assert.equal(stopPayload.data.remix.tasks.every((task) => task.status === "stopped"), true);
    assert.equal(stopPayload.data.downloadSummary.packageReady, false);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("retry-stitch endpoint returns a contract envelope and qc-ready batch", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-retry-stitch-"));
  try {
    const fx = await failedThirtySecondStitchFixture(root);
    const retryContext = {
      ...tempContext(root),
      capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } }
    };

    const retryRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { idempotencyKey: "idem_retry_router_1" }),
      retryRes,
      new URL(`http://localhost/api/wangzhuan/batches/${fx.started.batch.batchId}/retry-stitch`),
      retryContext
    );

    assert.equal(retryRes.statusCode, 200);
    const payload = JSON.parse(retryRes.body);
    assert.equal(payload.code, "ok");
    assert.equal(payload.data.batch.status, "qc");
    assert.equal(payload.data.batch.outputs.some((output) => output.kind === "stitched_video"), true);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("batch qc endpoint runs generated video model review and returns updated download summary", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-model-qc-"));
  try {
    const fx = await failedThirtySecondStitchFixture(root);
    const retryContext = {
      ...tempContext(root),
      capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } }
    };
    const retried = await stitchBatchSegments(wangzhuanModuleContext(root, {
      capabilities: retryContext.capabilities
    }), fx.started.batch.batchId);
    const moduleContext = wangzhuanModuleContext(root);
    const batch = (await loadBatchDetailFromMysql(moduleContext, retried.batch.batchId)).batch;
    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const patchedBatch = {
      ...batch,
      outputs: batch.outputs.map((output) => output.outputId === stitchedOutput.outputId
      ? { ...output, storageUrl: "https://cdn.example.com/generated/qc-pass.mp4", previewUrl: "https://cdn.example.com/generated/qc-pass.mp4" }
      : output)
    };
    assert.equal((await syncBatchFacts(moduleContext, patchedBatch, "batch_write")).skipped, false);

    const qcRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {}),
      qcRes,
      new URL(`http://localhost/api/wangzhuan/batches/${retried.batch.batchId}/qc`),
      {
        ...tempContext(root),
        callWangzhuanLlm: async () => JSON.stringify({
          passed: true,
          score: 0.91,
          summary: "生成视频符合脚本、拆解和 Seedance prompt。",
          matched: ["scene", "cta", "reward_feedback"],
          issues: [],
          recommendedAction: "approve"
        })
      }
    );

    assert.equal(qcRes.statusCode, 200);
    const payload = JSON.parse(qcRes.body);
    assert.equal(payload.code, "ok");
    assert.equal(payload.data.batch.status, "succeeded");
    assert.equal(payload.data.downloadSummary.packageReady, true);
    const reviewedOutput = payload.data.batch.outputs.find((output) => output.outputId === stitchedOutput.outputId);
    assert.equal(reviewedOutput.qcStatus, "pass");
    assert.equal(reviewedOutput.downloadEligible, true);
    assert.equal(reviewedOutput.modelQcSummary.score, 0.91);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
