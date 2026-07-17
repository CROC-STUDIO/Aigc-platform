import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  retryFailedGenerationTasksForUser,
  retryGenerationTaskForUser,
  uploadSegmentReplacement
} from "../../server/wangzhuan/pipeline.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import {
  listStateTransitionRules,
  safeIdempotencyResponseSummary
} from "../../server/wangzhuan/mysql-facts.mjs";

const BATCH_ID = "wzb_20260717051112_be06";

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

function buildBatch() {
  return {
    batchId: BATCH_ID,
    userId: "tester",
    status: "partial_failed",
    tasks: [
      {
        generationTaskId: "gen_be06_retryable",
        branchId: "branch_1",
        branchVariantIndex: 1,
        segmentIndex: 1,
        status: "failed",
        attempts: 1,
        maxAttempts: 2,
        errorCode: "upstream_failed",
        responseSummary: { retryable: true }
      },
      {
        generationTaskId: "gen_be06_repair",
        branchId: "branch_1",
        branchVariantIndex: 1,
        segmentIndex: 2,
        status: "failed",
        attempts: 0,
        maxAttempts: 2,
        errorCode: "asset_review_pending"
      },
      {
        generationTaskId: "gen_be06_exhausted",
        branchId: "branch_1",
        branchVariantIndex: 1,
        segmentIndex: 3,
        status: "failed",
        attempts: 2,
        maxAttempts: 2,
        errorCode: "upstream_failed",
        responseSummary: { retryable: true }
      },
      {
        generationTaskId: "gen_be06_running",
        branchId: "branch_1",
        branchVariantIndex: 2,
        segmentIndex: 1,
        status: "waiting_upstream",
        attempts: 1,
        maxAttempts: 2
      }
    ],
    outputs: []
  };
}

function serviceContext() {
  let batch = buildBatch();
  const retryCalls = [];
  const idempotency = new Map();
  return {
    userId: "tester",
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    readBatchForTest: async () => batch,
    runIdempotentOperation: async (_context, endpoint, key, hash, operation) => {
      const cacheKey = `${endpoint}:${key}:${hash}`;
      if (idempotency.has(cacheKey)) return idempotency.get(cacheKey);
      const response = await operation();
      idempotency.set(cacheKey, response);
      return response;
    },
    retryFailedGenerationTaskForTest: async (_context, batchId, taskId, options) => {
      retryCalls.push({ batchId, taskId, options });
      batch = {
        ...batch,
        tasks: batch.tasks.map((task) => task.generationTaskId === taskId
          ? {
              ...task,
              status: "waiting_upstream",
              attempts: task.attempts + 1,
              retryInfo: { automatic: options.automatic, attempt: task.attempts + 1 }
            }
          : task)
      };
      return {
        batch,
        retriedCount: 1,
        submittedCount: 1
      };
    },
    get retryCalls() {
      return retryCalls;
    }
  };
}

function routerContext(body, overrides = {}) {
  return {
    userId: "tester",
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    currentProjectRoot: () => "/tmp/project-a",
    currentBaseProjectRoot: () => "/tmp/project-a",
    readJson: async () => body,
    ...overrides
  };
}

async function call(method, pathname, body, context = routerContext(body)) {
  const req = { method, headers: {} };
  const res = new TestResponse();
  await handleWangzhuanRequest(req, res, new URL(`http://127.0.0.1${pathname}`), context);
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

test("single user retry is idempotent and marks the retry as manual", async () => {
  const context = serviceContext();
  const request = { idempotencyKey: "retry-one-1" };

  const first = await retryGenerationTaskForUser(context, BATCH_ID, "gen_be06_retryable", request);
  const replay = await retryGenerationTaskForUser(context, BATCH_ID, "gen_be06_retryable", request);

  assert.equal(first.retriedCount, 1);
  assert.equal(first.task.retryInfo.automatic, false);
  assert.deepEqual(replay, first);
  assert.equal(context.retryCalls.length, 1);
  assert.equal(context.retryCalls[0].options.automatic, false);
});

test("single user retry rejects repair-required tasks and missing idempotency keys", async () => {
  const context = serviceContext();

  await assert.rejects(
    retryGenerationTaskForUser(context, BATCH_ID, "gen_be06_repair", { idempotencyKey: "repair-1" }),
    (error) => error?.code === "repair_required"
  );
  await assert.rejects(
    retryGenerationTaskForUser(context, BATCH_ID, "gen_be06_retryable", {}),
    (error) => error?.code === "validation_error"
  );
  assert.equal(context.retryCalls.length, 0);
});

test("bulk user retry submits only eligible failures and returns category totals", async () => {
  const context = serviceContext();

  const result = await retryFailedGenerationTasksForUser(context, BATCH_ID, {
    idempotencyKey: "retry-all-1"
  });

  assert.deepEqual(result.summary, {
    submitted: 1,
    repairRequired: 1,
    exhausted: 1,
    inProgress: 1,
    unavailable: 0
  });
  assert.deepEqual(context.retryCalls.map((item) => item.taskId), ["gen_be06_retryable"]);
  assert.equal(result.results.length, 4);
});

test("single and bulk retry routes use distinct additive endpoints", async () => {
  const singleCalls = [];
  const bulkCalls = [];
  const context = routerContext({ idempotencyKey: "route-key" }, {
    retryGenerationTaskForUser: async (_scoped, batchId, taskId, request) => {
      singleCalls.push({ batchId, taskId, request });
      return {
        retriedCount: 1,
        task: { generationTaskId: taskId, retryInfo: { automatic: false } }
      };
    },
    retryFailedGenerationTasksForUser: async (_scoped, batchId, request) => {
      bulkCalls.push({ batchId, request });
      return {
        summary: { submitted: 1, repairRequired: 1, exhausted: 1, inProgress: 1, unavailable: 0 },
        results: []
      };
    }
  });

  const single = await call(
    "POST",
    `/api/wangzhuan/batches/${BATCH_ID}/tasks/gen_be06_retryable/retry`,
    { idempotencyKey: "route-key" },
    context
  );
  const bulk = await call(
    "POST",
    `/api/wangzhuan/batches/${BATCH_ID}/tasks/retry-failed`,
    { idempotencyKey: "route-key" },
    context
  );

  assert.equal(single.statusCode, 200);
  assert.equal(single.payload.data.retriedCount, 1);
  assert.equal(single.payload.data.task.retryInfo.automatic, false);
  assert.equal(bulk.statusCode, 200);
  assert.equal(bulk.payload.data.summary.submitted, 1);
  assert.deepEqual(singleCalls.map((item) => item.taskId), ["gen_be06_retryable"]);
  assert.equal(bulkCalls.length, 1);
});

test("retry routes retain wangzhuan permission checks", async () => {
  const context = routerContext({ idempotencyKey: "route-key" }, {
    user: { username: "tester", permissions: { "template:admin": true } },
    currentUser: () => ({ username: "tester", permissions: { "template:admin": true } })
  });

  const response = await call(
    "POST",
    `/api/wangzhuan/batches/${BATCH_ID}/tasks/gen_be06_retryable/retry`,
    { idempotencyKey: "route-key" },
    context
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "permission_denied");
});

test("manual retry idempotency replay keeps task results and summary", () => {
  assert.deepEqual(safeIdempotencyResponseSummary({
    retriedCount: 1,
    task: { generationTaskId: "gen_be06_retryable", retryInfo: { automatic: false } },
    summary: { submitted: 1, repairRequired: 0 },
    results: [{ taskId: "gen_be06_retryable", status: "submitted" }]
  }), {
    retriedCount: 1,
    task: { generationTaskId: "gen_be06_retryable", retryInfo: { automatic: false } },
    summary: { submitted: 1, repairRequired: 0 },
    results: [{ taskId: "gen_be06_retryable", status: "submitted" }]
  });
});

test("state transition rules allow explicit user retry writes", () => {
  const rules = listStateTransitionRules();
  assert.ok(rules.some((rule) => rule.entityType === "workflow_task"
    && rule.fromStatus === "failed"
    && rule.toStatus === "pending"
    && rule.triggerName === "user_retry"));
  assert.ok(rules.some((rule) => rule.entityType === "workflow_run"
    && rule.fromStatus === "partial_failed"
    && rule.toStatus === "partial_failed"
    && rule.triggerName === "user_replacement"));
});

async function replacementContext() {
  const root = await mkdtemp(join(tmpdir(), "wz-segment-replacement-"));
  let batch = buildBatch();
  const writes = [];
  return {
    root,
    userId: "tester",
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userProjectRoot: root,
    sharedProjectRoot: root,
    readBatchForTest: async () => batch,
    writeBatchForTest: async (next, triggerName) => {
      batch = next;
      writes.push({ batch: structuredClone(next), triggerName });
      return next;
    },
    assertDecodableVideoForTest: async () => {},
    probeVideoStreamHealthForTest: async () => ({
      codecName: "h264",
      profile: "High",
      pixFmt: "yuv420p",
      width: 720,
      height: 1280,
      durationSec: 10,
      size: 4096
    }),
    syncWangzhuanAsset: async ({ fullPath }) => ({
      storageKey: `segments/${fullPath.split("/").pop()}`,
      storageUrl: `https://cdn.example.test/${fullPath.split("/").pop()}`
    }),
    get batch() {
      return batch;
    },
    get writes() {
      return writes;
    }
  };
}

test("replacement upload appends a validated segment output and keeps older replacements", async () => {
  const context = await replacementContext();
  try {
    const first = await uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
      fileName: "replacement.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(4096, 1)
    });
    const second = await uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
      fileName: "replacement-v2.webm",
      mimeType: "video/webm",
      buffer: Buffer.alloc(4096, 2)
    });

    assert.equal(first.output.kind, "segment_video");
    assert.equal(first.output.fulfillmentSource, "user_replacement");
    assert.equal(first.output.durationSec, 10);
    assert.equal(second.output.fulfillmentSource, "user_replacement");
    assert.notEqual(second.output.outputId, first.output.outputId);
    assert.equal(context.batch.outputs.filter((output) => output.fulfillmentSource === "user_replacement").length, 2);
    assert.equal(
      context.batch.tasks.find((task) => task.generationTaskId === "gen_be06_repair").currentOutputId,
      second.output.outputId
    );
    assert.equal(context.writes.at(-1).triggerName, "user_replacement");
    assert.equal((await readFile(join(context.root, second.output.filePath))).length, 4096);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("replacement upload validates state, extension, mime and size", async () => {
  const context = await replacementContext();
  try {
    await assert.rejects(
      uploadSegmentReplacement(context, BATCH_ID, "gen_missing", {
        fileName: "replacement.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.alloc(4096)
      }),
      (error) => error?.code === "task_not_found"
    );
    await assert.rejects(
      uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
        fileName: "replacement.avi",
        mimeType: "video/x-msvideo",
        buffer: Buffer.alloc(4096)
      }),
      (error) => error?.code === "invalid_material"
    );
    await assert.rejects(
      uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
        fileName: "replacement.mp4",
        mimeType: "video/webm",
        buffer: Buffer.alloc(4096)
      }),
      (error) => error?.code === "invalid_material"
    );
    await assert.rejects(
      uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
        fileName: "replacement.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.allocUnsafe((100 * 1024 * 1024) + 1)
      }),
      (error) => error?.code === "file_too_large"
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("failed replacement probe leaves no output or temporary file", async () => {
  const context = await replacementContext();
  context.assertDecodableVideoForTest = async () => {
    throw Object.assign(new Error("decode failed"), { code: "stitch_failed" });
  };
  try {
    await assert.rejects(
      uploadSegmentReplacement(context, BATCH_ID, "gen_be06_repair", {
        fileName: "broken.mov",
        mimeType: "video/quicktime",
        buffer: Buffer.alloc(4096)
      }),
      (error) => error?.code === "invalid_video"
    );

    assert.equal(context.batch.outputs.length, 0);
    const segmentDir = join(context.root, "批处理记录", "网赚管线", "batches", BATCH_ID, "segments");
    assert.deepEqual(await readdir(segmentDir).catch(() => []), []);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("replacement route reads bounded multipart data and forwards the file", async () => {
  const multipartCalls = [];
  const uploadCalls = [];
  const context = routerContext({}, {
    readMultipart: async (_req, options) => {
      multipartCalls.push(options);
      return {
        fields: {},
        files: {
          file: {
            fileName: "replacement.mp4",
            mimeType: "video/mp4",
            buffer: Buffer.alloc(4096)
          }
        }
      };
    },
    uploadSegmentReplacement: async (_scoped, batchId, taskId, request) => {
      uploadCalls.push({ batchId, taskId, request });
      return {
        output: {
          outputId: "out_be06_001",
          kind: "segment_video",
          fulfillmentSource: "user_replacement"
        }
      };
    }
  });
  const response = await call(
    "POST",
    `/api/wangzhuan/batches/${BATCH_ID}/tasks/gen_be06_repair/replacement`,
    {},
    context
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.output.fulfillmentSource, "user_replacement");
  assert.equal(multipartCalls[0].maxBytes, (100 * 1024 * 1024) + (1024 * 1024));
  assert.equal(uploadCalls[0].request.buffer.length, 4096);
});

test("server multipart reader enforces a byte limit", async () => {
  const source = await readFile(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.match(source, /async function readRequestBuffer\(req, options = \{\}\)/);
  assert.match(source, /size > maxBytes/);
  assert.match(source, /file_too_large/);
  assert.match(source, /readRequestBuffer\(req, options\)/);
});
