import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
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
    currentBaseProjectRoot: () => `${root}/shared`
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
    user: { userId: "user", username: "user", role: "user", isAdmin: false }
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
      user: { userId: "user", username: "user", role: "user", isAdmin: false }
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
