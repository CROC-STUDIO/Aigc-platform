import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  retryFailedGenerationTasksForUser,
  retryGenerationTaskForUser
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
});
