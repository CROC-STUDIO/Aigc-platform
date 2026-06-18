import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import { startDirectMaskEdit, uploadRemixSource } from "../../server/wangzhuan/remix.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { stitchBatchSegments } from "../../server/wangzhuan/stitch.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";

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

function tempContext(root, role = "user") {
  return {
    ...context(role),
    currentProjectRoot: () => `${root}/user`,
    currentBaseProjectRoot: () => `${root}/shared`,
    mockReferenceProbe: true
  };
}

function anonymousContext() {
  return {
    ...context("user"),
    currentUser: () => null
  };
}

async function startedBatchFixture(root) {
  const { join } = await import("node:path");
  const moduleContext = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "user",
    user: { userId: "user", username: "user", role: "user", isAdmin: false },
    mockReferenceProbe: true
  };
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
  const { join } = await import("node:path");
  const moduleContext = {
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    userId: "user",
    user: { userId: "user", username: "user", role: "user", isAdmin: false },
    mockReferenceProbe: true,
    capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } }
  };
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
      promiseLevel: "strong_conversion"
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
    outputRatio: "9:16"
  });
  const started = await startBatchFromEstimate(moduleContext, {
    idempotencyKey: "idem_start_router_retry",
    estimateId: estimated.estimate.estimateId
  });
  await submitPendingGenerationTasks(moduleContext, started.batch.batchId);
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
    hasApiKey: true
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
  try {
    const ctx = {
      userProjectRoot: join(root, "user"),
      sharedProjectRoot: join(root, "shared"),
      userId: "user",
      user: { userId: "user", username: "user", role: "user", isAdmin: false },
      mockReferenceProbe: true,
      readJson: context("user").readJson,
      currentUser: () => ({ userId: "user", username: "user", role: "user", isAdmin: false }),
      currentUserId: () => "user",
      currentProjectRoot: () => join(root, "user"),
      currentBaseProjectRoot: () => join(root, "shared")
    };
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
    await rm(root, { recursive: true, force: true });
  }
});

test("reference video draft endpoint calls llm and returns a decomposition draft", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-draft-"));
  try {
    const moduleContext = {
      userProjectRoot: join(root, "user"),
      sharedProjectRoot: join(root, "shared"),
      userId: "user",
      user: { userId: "user", username: "user", role: "user", isAdmin: false },
      mockReferenceProbe: true,
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
    };
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
    await rm(root, { recursive: true, force: true });
  }
});

test("batch estimate endpoint returns a contract success envelope", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-est-"));
  try {
    const ctx = {
      userProjectRoot: `${root}/user`,
      sharedProjectRoot: `${root}/shared`,
      userId: "user",
      user: { userId: "user", username: "user", role: "user", isAdmin: false },
      mockReferenceProbe: true
    };
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
    await rm(root, { recursive: true, force: true });
  }
});

test("remix stop endpoint returns a contract envelope", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wz-router-remix-stop-"));
  try {
    const moduleContext = {
      userProjectRoot: join(root, "user"),
      sharedProjectRoot: join(root, "shared"),
      userId: "user",
      user: { userId: "user", username: "user", role: "user", isAdmin: false },
      mockReferenceProbe: true,
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
    };
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
    await rm(root, { recursive: true, force: true });
  }
});
