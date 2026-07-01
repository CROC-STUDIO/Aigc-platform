import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planDraftSignature, resetBackgroundJobsForTest } from "../../server/wangzhuan/background-jobs.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = "";
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body += body;
    this.emit("finish");
  }
}

async function contextFor(body) {
  const root = await mkdtemp(join(tmpdir(), "wz-router-jobs-"));
  return {
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userId: "tester",
    userProjectRoot: root,
    sharedProjectRoot: root,
    config: {},
    readJson: async () => body,
    readMultipart: async () => ({
      fields: { fileName: "reference.mp4", mimeType: "video/mp4" },
      files: {
        file: {
          fileName: "reference.mp4",
          mimeType: "video/mp4",
          buffer: Buffer.from("video-bytes")
        }
      }
    }),
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    currentProjectRoot: () => root,
    currentBaseProjectRoot: () => root,
    checkReferenceVideo: async (_scoped, request) => ({
      referenceVideo: {
        referenceVideoId: "ref_20260630_001",
        fileName: request.fileName,
        mimeType: request.mimeType,
        contentPrefix: String(request.content || "").slice(0, 22)
      }
    }),
    draftReferenceVideoDecomposition: async (_scoped, request) => ({
      referenceVideoId: request.referenceVideoId,
      decomposition: { scene: "office", subject: "phone", action: "tap" }
    }),
    prepareBatchPlanFromEstimate: async (_scoped, request) => ({
      batch: {
        batchId: request.batchId || "wzb_20260629000000_abcd",
        status: "preview_required",
        plans: [{ hook: "Open" }]
      }
    }),
    confirmBatchPlan: async () => ({ batch: { batchId: "wzb_20260629000000_abcd", status: "queued" } })
  };
}

async function call(method, pathname, body, providedContext = null) {
  const req = { method };
  const res = new TestResponse();
  const context = providedContext || await contextFor(body);
  await handleWangzhuanRequest(
    req,
    res,
    new URL(`http://127.0.0.1${pathname}`),
    context
  );
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

function waitForStatus(pathname, status) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const polled = await call("GET", pathname, {});
      if (polled.payload.data.status === status) {
        clearInterval(timer);
        resolve(polled);
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${status}`));
      }
    }, 5);
  });
}

test.beforeEach(() => {
  resetBackgroundJobsForTest();
});

test("creates and polls decomposition job", async () => {
  const created = await call("POST", "/api/wangzhuan/reference-videos/decomposition-jobs", {
    referenceVideoId: "ref_20260629_001",
    knowledgeNotes: "keep hook",
    llmConfig: { model: "gpt-5.4" }
  });

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.code, "ok");
  assert.equal(created.payload.data.status, "queued");
  assert.match(created.payload.data.decompositionJobId, /^decompjob_/);

  const polled = await waitForStatus(
    `/api/wangzhuan/reference-videos/decomposition-jobs/${created.payload.data.decompositionJobId}`,
    "succeeded"
  );

  assert.equal(polled.payload.data.status, "succeeded");
  assert.equal(polled.payload.data.decomposition.scene, "office");
});

test("decomposition job records model retry events", async () => {
  const body = {
    referenceVideoId: "ref_20260629_001",
    knowledgeNotes: "keep hook",
    llmConfig: { model: "gpt-5.4", maxRetries: 1 }
  };
  const baseContext = await contextFor(body);
  const context = {
    ...baseContext,
    draftReferenceVideoDecomposition: async (_scoped, request, options = {}) => {
      options.streamHandlers?.onRetry?.({
        attempt: 1,
        maxRetries: request.llmConfig?.maxRetries || 1,
        reason: "timeout",
        upstreamMessage: "Request timed out after 180s",
        code: "model_failed",
        status: 504
      });
      return {
        referenceVideoId: request.referenceVideoId,
        decomposition: { scene: "office", subject: "phone", action: "tap" }
      };
    }
  };
  const req = { method: "POST" };
  const res = new TestResponse();
  await handleWangzhuanRequest(
    req,
    res,
    new URL("http://127.0.0.1/api/wangzhuan/reference-videos/decomposition-jobs"),
    context
  );
  const created = JSON.parse(res.body);

  const polled = await waitForStatus(
    `/api/wangzhuan/reference-videos/decomposition-jobs/${created.data.decompositionJobId}`,
    "succeeded"
  );

  assert.ok(polled.payload.data.events.some((event) => event.message === "拆解模型重试 1/1"));
  assert.deepEqual(
    polled.payload.data.events.find((event) => event.message === "拆解模型重试 1/1")?.data,
    {
      reason: "timeout",
      upstreamMessage: "Request timed out after 180s",
      code: "model_failed",
      status: 504
    }
  );
});

test("returns not found for unknown decomposition job", async () => {
  const response = await call("GET", "/api/wangzhuan/reference-videos/decomposition-jobs/missing", {});

  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.code, "job_not_found");
});

test("persisted decomposition job remains queryable after in-memory reset", async () => {
  const sharedContext = await contextFor({});
  const created = await call("POST", "/api/wangzhuan/reference-videos/decomposition-jobs", {
    referenceVideoId: "ref_20260629_001",
    knowledgeNotes: "keep hook",
    llmConfig: { model: "gpt-5.4" }
  }, sharedContext);
  const jobId = created.payload.data.decompositionJobId;
  const startedAt = Date.now();
  let polled = null;
  while (Date.now() - startedAt < 1000) {
    polled = await call("GET", `/api/wangzhuan/reference-videos/decomposition-jobs/${jobId}`, {}, sharedContext);
    if (polled.payload.data.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(polled?.payload.data.status, "succeeded");
  const persistedStartedAt = Date.now();
  while (Date.now() - persistedStartedAt < 1000) {
    const persisted = await call("GET", `/api/wangzhuan/reference-videos/decomposition-jobs/${jobId}`, {}, sharedContext);
    if (persisted.payload.data.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  resetBackgroundJobsForTest();
  const resumed = await call("GET", `/api/wangzhuan/reference-videos/decomposition-jobs/${jobId}`, {}, sharedContext);
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.payload.data.status, "succeeded");
});

test("reference video check accepts multipart upload payloads", async () => {
  const context = await contextFor({});
  const req = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" } };
  const res = new TestResponse();
  await handleWangzhuanRequest(
    req,
    res,
    new URL("http://127.0.0.1/api/wangzhuan/reference-videos/check"),
    context
  );
  const payload = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.code, "ok");
  assert.equal(payload.data.referenceVideo.fileName, "reference.mp4");
  assert.equal(payload.data.referenceVideo.mimeType, "video/mp4");
  assert.equal(payload.data.referenceVideo.contentPrefix, "data:video/mp4;base64,");
});

test("creates and polls Seedance plan job with draft signature", async () => {
  const created = await call("POST", "/api/wangzhuan/batches/plan-jobs", {
    batchId: "wzb_20260629000000_abcd",
    estimateId: "est_20260629_001",
    idempotencyKey: "idem-1",
    draftSignatureInput: { productName: "Cash App", targetRegion: "US", language: "en-US" }
  });

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.code, "ok");
  assert.match(created.payload.data.planJobId, /^planjob_/);
  assert.match(created.payload.data.draftSignature, /^plansig_/);

  const polled = await waitForStatus(
    `/api/wangzhuan/batches/plan-jobs/${created.payload.data.planJobId}`,
    "succeeded"
  );

  assert.equal(polled.payload.data.status, "succeeded");
  assert.equal(polled.payload.data.batch.status, "preview_required");
  assert.deepEqual(polled.payload.data.plans, [{ hook: "Open" }]);
});

test("confirm plan rejects stale v2 draft signature before generation submit", async () => {
  const original = { productName: "Cash App", targetRegion: "US", language: "en-US" };
  const stale = { productName: "Other App", targetRegion: "US", language: "en-US" };
  const response = await call("POST", "/api/wangzhuan/batches/wzb_20260629000000_abcd/confirm-plan", {
    idempotencyKey: "confirm-1",
    draftSignature: planDraftSignature(original),
    draftSignatureInput: stale
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "validation_error");
  assert.equal(response.payload.data.reason, "stale_seedance_plan");
});
