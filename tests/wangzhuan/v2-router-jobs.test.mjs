import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
        bufferLength: request.buffer?.length || 0,
        fileHash: request.fileHash || ""
      }
    }),
    findReusableReferenceVideo: async (_scoped, request) => ({
      hit: request.fileHash === "a".repeat(64),
      fileHash: request.fileHash,
      referenceVideo: request.fileHash === "a".repeat(64)
        ? { referenceVideoId: "ref_20260630_009", fileHash: request.fileHash, previewUrl: "/file?path=cached.mp4" }
        : null
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
    generateBaseSeedancePrompt: async ({ context: scopedContext, batchId, requestId }) => {
      const draftsDir = join(
        scopedContext.userProjectRoot,
        "批处理记录",
        "网赚管线",
        "codex",
        "batches",
        batchId,
        "prompt-drafts"
      );
      await mkdir(draftsDir, { recursive: true });
      const contextPath = join(draftsDir, "cpd_test.context.json");
      const resultPath = join(draftsDir, "cpd_test.result.json");
      const payload = {
        promptDraftUid: "cpd_test",
        batchId,
        draftType: "base",
        version: 1,
        status: "ready",
        usesApprovedAssets: false,
        prompt: "base prompt",
        negativePrompt: "no watermark",
        reasoningSummary: "summary",
        complianceChecks: ["check"],
        warnings: [],
        approvedAssetKeysUsed: [],
        contextPath: contextPath.slice(scopedContext.userProjectRoot.length + 1),
        resultPath: resultPath.slice(scopedContext.userProjectRoot.length + 1),
        requestId
      };
      await writeFile(contextPath, JSON.stringify({ batchId }, null, 2));
      await writeFile(resultPath, JSON.stringify(payload, null, 2));
      return payload;
    },
    refineSeedancePromptWithApprovedAssets: async ({ batchId, approvedAssets = [], requestId }) => ({
      promptDraftUid: "cpd_refine",
      batchId,
      draftType: "refine",
      version: 1,
      status: "ready",
      usesApprovedAssets: true,
      prompt: "refined prompt",
      negativePrompt: "no clutter",
      reasoningSummary: "refined summary",
      complianceChecks: ["approved asset only"],
      warnings: [],
      approvedAssetKeysUsed: approvedAssets.map((item) => item.assetKey).filter(Boolean),
      contextPath: "批处理记录/网赚管线/codex/batches/test/prompt-drafts/cpd_refine.context.json",
      resultPath: "批处理记录/网赚管线/codex/batches/test/prompt-drafts/cpd_refine.result.json",
      requestId
    }),
    loadSeedancePromptDraft: async (scopedContext, batchId, promptDraftId) => {
      const resultPath = join(
        scopedContext.userProjectRoot,
        "批处理记录",
        "网赚管线",
        "codex",
        "batches",
        batchId,
        "prompt-drafts",
        `${promptDraftId}.result.json`
      );
      return JSON.parse(await readFile(resultPath, "utf8"));
    },
    parseProductLinkForSeedance: async (_scoped, request) => ({
      parseUid: "plink_test",
      url: request.url,
      store: "google_play",
      productContext: {
        title: "Demo App",
        summary: "Fast hook utility app"
      },
      candidateAssets: [
        {
          candidateAssetId: "plink_test_icon_001",
          assetKey: "productIcon",
          sourceUrl: "https://assets.test/icon.png"
        }
      ],
      warnings: []
    }),
    reviewParsedProductLinkAssets: async (_scoped, request) => ({
      batchId: request.batchId,
      parseUid: request.parseUid,
      branchId: "branch_1",
      items: [
        {
          candidateAssetId: "plink_test_icon_001",
          assetKey: "productIcon",
          status: "approved",
          review: { assetId: "review_productIcon", status: "approved" },
          asset: {
            storedPath: "批处理记录/网赚管线/product-assets/branch_1/productIcon/icon.png",
            storageUrl: "https://cdn.test/icon.png"
          }
        }
      ],
      summary: {
        total: 1,
        approvedCount: 1,
        pendingCount: 0,
        failedCount: 0,
        rejectedCount: 0,
        approvedAssets: [
          {
            candidateAssetId: "plink_test_icon_001",
            assetKey: "productIcon",
            assetId: "review_productIcon",
            reviewStatus: "approved",
            storedPath: "批处理记录/网赚管线/product-assets/branch_1/productIcon/icon.png",
            storageUrl: "https://cdn.test/icon.png"
          }
        ]
      }
    }),
    getParsedProductLinkReviewStatus: async (_scoped, batchId) => ({
      batchId,
      parseUid: "plink_test",
      branchId: "branch_1",
      items: [],
      summary: {
        total: 1,
        approvedCount: 1,
        pendingCount: 0,
        failedCount: 0,
        rejectedCount: 0,
        approvedAssets: [
          {
            assetKey: "productIcon",
            assetId: "review_productIcon",
            reviewStatus: "approved"
          }
        ]
      }
    }),
    generateSeedancePromptFromParsedProductLink: async (_scoped, request, mode) => ({
      promptDraftUid: mode === "refine" ? "cpd_link_refine" : "cpd_link_base",
      batchId: request.batchId,
      draftType: mode,
      version: 1,
      status: "ready",
      usesApprovedAssets: mode === "refine",
      prompt: mode === "refine" ? "link refine prompt" : "link base prompt",
      negativePrompt: "no watermark",
      reasoningSummary: `${mode} summary`,
      complianceChecks: ["check"],
      warnings: [],
      approvedAssetKeysUsed: mode === "refine" ? ["productIcon"] : [],
      requestId: request.requestId
    }),
    autoGenerateSeedancePrompt: async (_scoped, batchId, request) => ({
      batch: {
        batchId,
        status: "checking"
      },
      mode: "refine",
      promptDraft: {
        promptDraftUid: "cpd_auto",
        batchId,
        draftType: "refine",
        version: 1,
        status: "ready",
        usesApprovedAssets: true,
        prompt: "auto prompt",
        negativePrompt: "no clutter",
        reasoningSummary: "auto summary",
        complianceChecks: ["approved only"],
        warnings: [],
        approvedAssetKeysUsed: ["productScreenshot_1"],
        requestId: request.requestId
      },
      approvedAssetCount: 1,
      referencedAssetCount: 1,
      reviewResult: { ok: true, failures: [], assetsByBranch: [] }
    }),
    confirmBatchPlan: async () => ({ batch: { batchId: "wzb_20260629000000_abcd", status: "queued" } })
  };
}

async function call(method, pathname, body, providedContext = null) {
  const req = { method };
  const res = new TestResponse();
  const baseContext = providedContext || await contextFor(body);
  const context = {
    ...baseContext,
    readJson: async () => body
  };
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

function waitForStatusWithContext(pathname, status, context) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const polled = await call("GET", pathname, {}, context);
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
  assert.equal(created.payload.data.subjectType, "reference_video");
  assert.equal(created.payload.data.subjectId, "ref_20260629_001");

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
  assert.ok(polled.payload.data.events.some((event) => event.message === "正在读取视频基础信息、模型、地区和语言配置"));
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

test("decomposition job persists failed decomposition and fails batch on upstream abort", async () => {
  const body = {
    referenceVideoId: "ref_20260629_001",
    batchId: "wzb_20260709000000_abcd",
    llmConfig: { model: "gpt-5.5", maxRetries: 1 }
  };
  const syncVideoDecompositionCalls = [];
  const syncBatchCalls = [];
  const baseContext = await contextFor(body);
  const context = {
    ...baseContext,
    draftReferenceVideoDecomposition: async () => {
      const error = new Error("模型拆解请求超时");
      error.code = "model_failed";
      error.data = {
        reason: "timeout",
        upstreamMessage: "This operation was aborted"
      };
      throw error;
    },
    syncVideoDecompositionFact: async (_scoped, record) => {
      syncVideoDecompositionCalls.push(record);
      return { skipped: false };
    },
    loadBatchDetailFromMysql: async () => ({
      batch: {
        batchId: body.batchId,
        status: "checking",
        referenceVideo: { referenceVideoId: body.referenceVideoId }
      }
    }),
    syncBatchFacts: async (_scoped, batch, triggerName) => {
      syncBatchCalls.push({ batch, triggerName });
      return { skipped: false };
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

  const polled = await waitForStatusWithContext(
    `/api/wangzhuan/reference-videos/decomposition-jobs/${created.data.decompositionJobId}`,
    "failed",
    context
  );

  assert.equal(polled.payload.data.error.message, "模型请求已中断，可重试");
  assert.equal(syncVideoDecompositionCalls.length, 1);
  assert.equal(syncVideoDecompositionCalls[0].status, "failed");
  assert.equal(syncVideoDecompositionCalls[0].errorCode, "model_failed");
  assert.equal(syncVideoDecompositionCalls[0].reason, "timeout");
  assert.equal(syncVideoDecompositionCalls[0].upstreamMessage, "This operation was aborted");
  assert.equal(syncBatchCalls.length, 1);
  assert.equal(syncBatchCalls[0].triggerName, "decomposition_failed");
  assert.equal(syncBatchCalls[0].batch.status, "failed");
  assert.equal(syncBatchCalls[0].batch.stopReason, "timeout");
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
  assert.equal(payload.data.referenceVideo.bufferLength, Buffer.byteLength("video-bytes"));
});

test("reference video check can run as a background job after multipart upload", async () => {
  const context = await contextFor({});
  const req = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" } };
  const res = new TestResponse();
  await handleWangzhuanRequest(
    req,
    res,
    new URL("http://127.0.0.1/api/wangzhuan/reference-videos/check-jobs"),
    context
  );
  const payload = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.code, "ok");
  assert.match(payload.data.referenceVideoCheckJobId, /^refcheckjob_/);

  const polled = await waitForStatusWithContext(
    `/api/wangzhuan/reference-videos/check-jobs/${payload.data.referenceVideoCheckJobId}`,
    "succeeded",
    context
  );

  assert.equal(polled.payload.data.referenceVideo.referenceVideoId, "ref_20260630_001");
  assert.equal(polled.payload.data.referenceVideo.bufferLength, Buffer.byteLength("video-bytes"));
});

test("reference video reuse check returns existing hash match before upload", async () => {
  const response = await call("POST", "/api/wangzhuan/reference-videos/reuse-check", {
    fileHash: "a".repeat(64),
    fileName: "reference.mp4",
    mimeType: "video/mp4",
    sizeBytes: 19001403
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.hit, true);
  assert.equal(response.payload.data.referenceVideo.referenceVideoId, "ref_20260630_009");
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
  assert.equal(created.payload.data.subjectType, "batch");
  assert.equal(created.payload.data.subjectId, "wzb_20260629000000_abcd");

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

test("creates codex base seedance prompt through backend route", async () => {
  const context = await contextFor({});
  const response = await call("POST", "/api/wangzhuan/codex/seedance-prompt", {
    mode: "base",
    batchId: "wzb_20260709000000_abcd",
    decompositionResult: { summary: "hook" },
    productContext: { title: "Demo App" }
  }, context);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.code, "ok");
  assert.equal(response.payload.data.promptDraftUid, "cpd_test");
  assert.equal(response.payload.data.prompt, "base prompt");
});

test("creates codex refine seedance prompt through backend route", async () => {
  const response = await call("POST", "/api/wangzhuan/codex/seedance-prompt", {
    mode: "refine",
    batchId: "wzb_20260709000000_abcd",
    approvedAssets: [{ assetKey: "productScreenshot_1" }]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.draftType, "refine");
  assert.deepEqual(response.payload.data.approvedAssetKeysUsed, ["productScreenshot_1"]);
});

test("loads codex prompt draft from JSON fallback route", async () => {
  const context = await contextFor({});
  await call("POST", "/api/wangzhuan/codex/seedance-prompt", {
    mode: "base",
    batchId: "wzb_20260709000000_abcd"
  }, context);

  const response = await call("GET", "/api/wangzhuan/codex/seedance-prompt?batchId=wzb_20260709000000_abcd&promptDraftId=cpd_test", {}, context);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.promptDraftUid, "cpd_test");
});

test("creates and polls codex seedance prompt job", async () => {
  const context = await contextFor({});
  const created = await call("POST", "/api/wangzhuan/codex/seedance-prompt-jobs", {
    mode: "base",
    batchId: "wzb_20260709000000_abcd",
    decompositionResult: { summary: "hook" },
    productContext: { title: "Demo App" }
  }, context);

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.code, "ok");
  assert.match(created.payload.data.codexPromptJobId, /^codexpromptjob_/);
  assert.equal(created.payload.data.subjectType, "batch");
  assert.equal(created.payload.data.subjectId, "wzb_20260709000000_abcd");

  const polled = await waitForStatusWithContext(
    `/api/wangzhuan/codex/seedance-prompt-jobs/${created.payload.data.codexPromptJobId}`,
    "succeeded",
    context
  );
  assert.equal(polled.statusCode, 200);
  assert.equal(polled.payload.data.promptDraft.promptDraftUid, "cpd_test");
  assert.equal(polled.payload.data.promptDraft.prompt, "base prompt");
});

test("creates and polls auto seedance prompt job for batch", async () => {
  const context = await contextFor({});
  const created = await call("POST", "/api/wangzhuan/batches/wzb_20260709000000_abcd/auto-seedance-prompt-jobs", {}, context);

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.code, "ok");
  assert.match(created.payload.data.autoSeedancePromptJobId, /^autopromptjob_/);
  assert.equal(created.payload.data.subjectType, "batch");
  assert.equal(created.payload.data.subjectId, "wzb_20260709000000_abcd");

  const polled = await waitForStatusWithContext(
    `/api/wangzhuan/batches/wzb_20260709000000_abcd/auto-seedance-prompt-jobs/${created.payload.data.autoSeedancePromptJobId}`,
    "succeeded",
    context
  );
  assert.equal(polled.statusCode, 200);
  assert.equal(polled.payload.data.promptDraft.promptDraftUid, "cpd_auto");
  assert.equal(polled.payload.data.promptDraft.prompt, "auto prompt");

  const latest = await call("GET", "/api/wangzhuan/batches/wzb_20260709000000_abcd/auto-seedance-prompt-jobs", {}, context);
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.payload.data.autoSeedancePromptJobId, created.payload.data.autoSeedancePromptJobId);
});

test("product link parse route returns normalized parse result", async () => {
  const response = await call("POST", "/api/wangzhuan/product-link/parse", {
    url: "https://play.google.com/store/apps/details?id=demo.app"
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.parseUid, "plink_test");
  assert.equal(response.payload.data.productContext.title, "Demo App");
});

test("product link asset review route returns approved asset summary", async () => {
  const response = await call("POST", "/api/wangzhuan/product-link/assets/review", {
    batchId: "wzb_20260709000000_abcd",
    parseUid: "plink_test",
    candidateAssetIds: ["plink_test_icon_001"]
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.summary.approvedCount, 1);
});

test("product link review status route returns persisted summary", async () => {
  const response = await call("GET", "/api/wangzhuan/product-link/assets/review-status?batchId=wzb_20260709000000_abcd", {});
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.summary.approvedAssets[0].assetKey, "productIcon");
});

test("product link codex base and refine routes return prompt drafts", async () => {
  const base = await call("POST", "/api/wangzhuan/product-link/codex/seedance-prompt/base", {
    batchId: "wzb_20260709000000_abcd",
    parseUid: "plink_test",
    decompositionResult: { summary: "hook" }
  });
  assert.equal(base.statusCode, 200);
  assert.equal(base.payload.data.prompt, "link base prompt");

  const refine = await call("POST", "/api/wangzhuan/product-link/codex/seedance-prompt/refine", {
    batchId: "wzb_20260709000000_abcd",
    parseUid: "plink_test",
    decompositionResult: { summary: "hook" }
  });
  assert.equal(refine.statusCode, 200);
  assert.deepEqual(refine.payload.data.approvedAssetKeysUsed, ["productIcon"]);
});
