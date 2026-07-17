import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";
import * as pipeline from "../../server/wangzhuan/pipeline.mjs";
import { statusForCode } from "../../server/wangzhuan/http.mjs";

function context() {
  return {
    userId: "admin",
    user: { username: "admin", role: "admin", isAdmin: true },
    currentUserId: () => "admin",
    currentProjectRoot: () => "/data/project-a",
    currentBaseProjectRoot: () => "/data/project-a"
  };
}

function fakeFactsPool(options = {}) {
  const idempotency = new Map();
  const failurePayloads = [];
  let queryCalls = 0;
  const tasks = [
    { id: 1, batchId: "wzb_20260717000000_aaaa", taskUid: "gen_aaaa_001", status: "pending", leaseOwner: null, leaseActive: false },
    { id: 2, batchId: "wzb_20260717000000_bbbb", taskUid: "gen_bbbb_001", status: "pending", leaseOwner: null, leaseActive: false },
    { id: 3, batchId: "wzb_20260717000000_bbbb", taskUid: "gen_bbbb_002", status: "pending", leaseOwner: null, leaseActive: false }
  ];

  const connection = () => ({
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      queryCalls += 1;
      return this.execute(sql, params);
    },
    async execute(sql, params = []) {
      const text = String(sql);
      if (text.includes("SELECT id FROM app_users")) return [[{ id: 11 }]];
      if (text.includes("SELECT id FROM projects WHERE project_key")) return [[{ id: 22 }]];
      if (text.includes("INSERT INTO project_members")) return [{ affectedRows: 1 }];

      if (text.includes("DELETE FROM idempotency_keys")) return [{ affectedRows: 0 }];
      if (text.includes("INSERT IGNORE INTO idempotency_keys")) {
        const key = `${params[0]}:${params[1]}:${params[2]}:${Buffer.from(params[3]).toString("hex")}`;
        if (idempotency.has(key)) return [{ affectedRows: 0 }];
        idempotency.set(key, {
          id: idempotency.size + 1,
          requestHash: params[4],
          status: "processing",
          response: null
        });
        return [{ affectedRows: 1 }];
      }
      if (text.includes("FROM idempotency_keys") && text.includes("FOR UPDATE")) {
        const key = `${params[0]}:${params[1]}:${params[2]}:${Buffer.from(params[3]).toString("hex")}`;
        const row = idempotency.get(key);
        return [[row ? {
          id: row.id,
          request_hash: row.requestHash,
          status: row.status,
          response_json: row.response && JSON.stringify(row.response)
        } : undefined].filter(Boolean)];
      }
      if (text.includes("UPDATE idempotency_keys") && text.includes("SET resource_type") && text.includes("status = 'succeeded'")) {
        if (options.failCompleteOnce) {
          options.failCompleteOnce = false;
          throw Object.assign(new Error("database unavailable"), { code: "database_unavailable" });
        }
        const key = `${params[4]}:${params[5]}:${params[6]}:${Buffer.from(params[7]).toString("hex")}`;
        const row = idempotency.get(key);
        if (!row || row.requestHash !== params[8] || row.status !== "processing") return [{ affectedRows: 0 }];
        row.status = "succeeded";
        row.response = JSON.parse(params[2]);
        return [{ affectedRows: 1 }];
      }
      if (text.includes("UPDATE idempotency_keys") && text.includes("SET status = 'processing'")) {
        const row = [...idempotency.values()].find((item) => params.includes(item.id));
        const requestHash = params.find((value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
        if (!row || row.requestHash !== requestHash || row.status !== "failed") return [{ affectedRows: 0 }];
        row.status = "processing";
        row.response = null;
        return [{ affectedRows: 1 }];
      }
      if (text.includes("UPDATE idempotency_keys") && text.includes("SET status = 'failed'")) {
        failurePayloads.push(params[0]);
        const key = `${params[1]}:${params[2]}:${params[3]}:${Buffer.from(params[4]).toString("hex")}`;
        const row = idempotency.get(key);
        if (row && row.requestHash === params[5]) row.status = "failed";
        return [{ affectedRows: row ? 1 : 0 }];
      }

      if (text.includes("FROM project_members") && text.includes("FOR UPDATE")) return [[{ project_id: 22 }]];
      if (text.includes("COUNT(*) AS active_count")) {
        const activeCount = tasks.filter((task) => task.status === "waiting_upstream" || task.leaseActive).length;
        const batchActiveCount = tasks.filter((task) => task.batchId === params[0] && (task.status === "waiting_upstream" || task.leaseActive)).length;
        return [[{ active_count: activeCount, batch_active_count: batchActiveCount }]];
      }
      if (text.includes("SELECT wt.task_uid") && text.includes("submissionPhase")) return [[]];
      if (text.includes("FROM workflow_tasks wt") && text.includes("FOR UPDATE SKIP LOCKED")) {
        const batchId = params[2];
        const maxClaims = Number(params.at(-1));
        const candidates = new Set(params.slice(3, -1));
        return [tasks
          .filter((task) => task.batchId === batchId && candidates.has(task.taskUid) && task.status === "pending" && !task.leaseActive)
          .slice(0, maxClaims)
          .map((task) => ({ id: task.id, task_uid: task.taskUid }))];
      }
      if (text.includes("UPDATE workflow_tasks wt") && text.includes("submission_unknown")) {
        return [{ affectedRows: 0 }];
      }
      if (text.includes("UPDATE task_attempts ta") && text.includes("submission_unknown")) {
        return [{ affectedRows: 0 }];
      }
      if (text.includes("UPDATE workflow_tasks") && text.includes("lease_owner = NULL")) {
        const owner = params[3];
        const taskUids = new Set(params.slice(4));
        let affectedRows = 0;
        for (const task of tasks) {
          if (task.batchId === params[2] && taskUids.has(task.taskUid) && task.leaseOwner === owner) {
            task.leaseOwner = null;
            task.leaseActive = false;
            affectedRows += 1;
          }
        }
        return [{ affectedRows }];
      }
      if (text.includes("UPDATE workflow_tasks") && text.includes("lease_owner = ?")) {
        const owner = params[0];
        const ids = new Set(params.slice(2));
        for (const task of tasks) {
          if (ids.has(task.id) && task.status === "pending" && !task.leaseActive) {
            task.leaseOwner = owner;
            task.leaseActive = true;
          }
        }
        return [{ affectedRows: ids.size }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    }
  });

  return {
    failurePayloads,
    queryCalls: () => queryCalls,
    tasks,
    pool: { async getConnection() { return connection(); } }
  };
}

test.afterEach(async () => {
  await mysqlFacts.closeWangzhuanFactsPool();
});

test("same idempotency key has one owner and executes one side effect", async () => {
  assert.equal(typeof mysqlFacts.runIdempotentOperation, "function");
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  let sideEffects = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = () => mysqlFacts.runIdempotentOperation(
    context(),
    "remix_start",
    "same-key",
    "a".repeat(64),
    async () => {
      sideEffects += 1;
      await gate;
      return { remixId: "rmx_1" };
    },
    { resourceType: "remix" }
  );

  const owner = operation();
  await assert.rejects(operation(), (error) => error?.code === "idempotency_in_progress");
  release();
  assert.deepEqual(await owner, { remixId: "rmx_1" });
  assert.equal(sideEffects, 1);
  assert.deepEqual(await operation(), { remixId: "rmx_1" });
  assert.equal(sideEffects, 1);
});

test("same idempotency key rejects a different request hash", async () => {
  assert.equal(typeof mysqlFacts.claimIdempotencyFact, "function");
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  await mysqlFacts.claimIdempotencyFact(context(), "remix_start", "same-key", "a".repeat(64));
  await assert.rejects(
    mysqlFacts.claimIdempotencyFact(context(), "remix_start", "same-key", "b".repeat(64)),
    (error) => error?.code === "idempotency_conflict"
  );
});

test("failed idempotency owner releases the same request for retry", async () => {
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  let attempts = 0;
  const operation = () => mysqlFacts.runIdempotentOperation(
    context(),
    "remix_start",
    "retry-key",
    "c".repeat(64),
    async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("temporary"), { code: "temporary" });
      return { remixId: "rmx_retry" };
    },
    { resourceType: "remix" }
  );

  await assert.rejects(operation(), (error) => error?.code === "temporary");
  assert.deepEqual(await operation(), { remixId: "rmx_retry" });
  assert.equal(attempts, 2);
});

test("successful side effect retries completion persistence without running twice", async () => {
  const fake = fakeFactsPool({ failCompleteOnce: true });
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  let sideEffects = 0;
  const operation = () => mysqlFacts.runIdempotentOperation(
    context(),
    "remix_start",
    "persist-failure-key",
    "d".repeat(64),
    async () => {
      sideEffects += 1;
      return { remixId: "rmx_persisted_later" };
    },
    { resourceType: "remix" }
  );

  assert.deepEqual(await operation(), { remixId: "rmx_persisted_later" });
  assert.deepEqual(await operation(), { remixId: "rmx_persisted_later" });
  assert.equal(sideEffects, 1);
});

test("failed idempotency record does not persist upstream error text", async () => {
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  await assert.rejects(mysqlFacts.runIdempotentOperation(
    context(),
    "remix_start",
    "secret-error-key",
    "e".repeat(64),
    async () => {
      throw Object.assign(new Error("https://signed.example/video?token=secret"), { code: "upstream_failed" });
    }
  ));

  assert.deepEqual(JSON.parse(fake.failurePayloads[0]), { code: "upstream_failed" });
});

test("pending Seedance task lease prevents a second submit claim", async () => {
  assert.equal(typeof mysqlFacts.claimPendingSeedanceTasks, "function");
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const options = {
    batchId: "wzb_20260717000000_aaaa",
    candidateTaskUids: ["gen_aaaa_001"],
    requestedLimit: 1,
    concurrencyLimit: 2,
    leaseOwner: "submitter-a"
  };

  const first = await mysqlFacts.claimPendingSeedanceTasks(context(), options);
  const second = await mysqlFacts.claimPendingSeedanceTasks(context(), { ...options, leaseOwner: "submitter-b" });
  assert.deepEqual(first.taskUids, ["gen_aaaa_001"]);
  assert.deepEqual(second.taskUids, []);
  assert.equal(fake.queryCalls(), 1, "claim SELECT must use mysql2 query mode instead of prepared LIMIT binding");
});

test("two batches share the project user concurrency quota and released slots can be claimed", async () => {
  assert.equal(typeof mysqlFacts.claimPendingSeedanceTasks, "function");
  assert.equal(typeof mysqlFacts.releasePendingSeedanceTaskClaims, "function");
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);

  const first = await mysqlFacts.claimPendingSeedanceTasks(context(), {
    batchId: "wzb_20260717000000_aaaa",
    candidateTaskUids: ["gen_aaaa_001"],
    requestedLimit: 1,
    concurrencyLimit: 1,
    leaseOwner: "submitter-a"
  });
  const blocked = await mysqlFacts.claimPendingSeedanceTasks(context(), {
    batchId: "wzb_20260717000000_bbbb",
    candidateTaskUids: ["gen_bbbb_001", "gen_bbbb_002"],
    requestedLimit: 2,
    concurrencyLimit: 1,
    leaseOwner: "submitter-b"
  });
  assert.deepEqual(first.taskUids, ["gen_aaaa_001"]);
  assert.deepEqual(blocked.taskUids, []);

  await mysqlFacts.releasePendingSeedanceTaskClaims(context(), {
    batchId: "wzb_20260717000000_aaaa",
    taskUids: first.taskUids,
    leaseOwner: "submitter-a"
  });
  fake.tasks[0].status = "downloaded";
  const resumed = await mysqlFacts.claimPendingSeedanceTasks(context(), {
    batchId: "wzb_20260717000000_bbbb",
    candidateTaskUids: ["gen_bbbb_001", "gen_bbbb_002"],
    requestedLimit: 2,
    concurrencyLimit: 1,
    leaseOwner: "submitter-b"
  });
  assert.deepEqual(resumed.taskUids, ["gen_bbbb_001"]);
});

test("requested concurrency is an active per-batch limit across submitters", async () => {
  const fake = fakeFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const options = {
    batchId: "wzb_20260717000000_bbbb",
    candidateTaskUids: ["gen_bbbb_001", "gen_bbbb_002"],
    requestedLimit: 1,
    concurrencyLimit: 4
  };

  const first = await mysqlFacts.claimPendingSeedanceTasks(context(), { ...options, leaseOwner: "submitter-a" });
  const second = await mysqlFacts.claimPendingSeedanceTasks(context(), { ...options, leaseOwner: "submitter-b" });
  assert.deepEqual(first.taskUids, ["gen_bbbb_001"]);
  assert.equal(first.batchAvailableSlots, 1);
  assert.deepEqual(second.taskUids, []);
  assert.equal(second.batchAvailableSlots, 0);
});

test("pipeline claims pending tasks before provider submission and releases persisted claims", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function submitPendingGenerationTasks");
  const end = source.indexOf("export async function retryFailedGenerationTask", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /claimPendingSeedanceTasks/);
  assert.match(body, /claimedTaskUids\.has/);
  assert.match(body, /releasePendingSeedanceTaskClaims/);
  assert.ok(body.indexOf("claimPendingSeedanceTasks") < body.indexOf("submitTaskToSeedance"));
  assert.ok(body.indexOf("writeBatch(context") < body.indexOf("releasePendingSeedanceTaskClaims"));
});

test("retry resets failed work to pending and uses the quota-aware submit path", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function retryFailedGenerationTask");
  const end = source.indexOf("function currentPlanIds", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /status: "pending"/);
  assert.match(body, /submitPendingGenerationTasks\(context, batchId\)/);
  assert.doesNotMatch(body, /submitTaskToSeedance/);
  assert.ok(body.indexOf('status: "pending"') < body.indexOf("submitPendingGenerationTasks"));
});

test("retry submission preserves retryInfo from persisted response summaries", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function submitTaskToSeedance");
  const end = source.indexOf("function taskSegmentKey", start);
  const body = source.slice(start, end);
  assert.match(body, /task\.retryInfo \|\| task\.responseSummary\?\.retryInfo/);
});

test("partial failed batch with quota-deferred pending work keeps its upstream poll job", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function shouldScheduleUpstreamPoll");
  const end = source.indexOf("async function syncUpstreamPollJob", start);
  const body = source.slice(start, end);
  const pendingCheck = body.indexOf('task.status === "pending"');
  const partialTerminalCheck = body.indexOf('["qc", "partial_failed"]');

  assert.ok(pendingCheck >= 0);
  assert.ok(partialTerminalCheck >= 0);
  assert.ok(pendingCheck < partialTerminalCheck);
});

test("confirm plan runs behind the atomic idempotency owner claim", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function confirmBatchPlan");
  const end = source.indexOf("export async function confirmBatchAssets", start);
  const body = source.slice(start, end);

  assert.match(body, /runIdempotentOperation/);
  assert.match(body, /"batch_plan_confirm"/);
  assert.match(source, /async function confirmBatchPlanOnce/);
  assert.doesNotMatch(body, /readBatch\(context, batchId\)/);
});

test("idempotency contention is reported as HTTP conflict", () => {
  assert.equal(statusForCode("idempotency_conflict"), 409);
  assert.equal(statusForCode("idempotency_in_progress"), 409);
});

test("retry submission preserves qc and partial delivery batch states", () => {
  assert.equal(typeof pipeline.batchStatusAfterSeedanceSubmission, "function");
  assert.equal(pipeline.batchStatusAfterSeedanceSubmission("partial_failed", { submittedCount: 1 }), "partial_failed");
  assert.equal(pipeline.batchStatusAfterSeedanceSubmission("qc", { submittedCount: 1 }), "qc");
  assert.equal(pipeline.batchStatusAfterSeedanceSubmission("queued", { submittedCount: 1 }), "running");
});

test("Seedance global concurrency reads limits before legacy capabilities", () => {
  assert.equal(typeof pipeline.resolveSeedanceConcurrencyLimit, "function");
  assert.equal(pipeline.resolveSeedanceConcurrencyLimit({ config: { wangzhuan: { limits: { maxConcurrency: 2 }, capabilities: { maxConcurrency: 4 } } } }), 2);
  assert.equal(pipeline.resolveSeedanceConcurrencyLimit({ config: { wangzhuan: { capabilities: { maxConcurrency: 3 } } } }), 3);
  assert.equal(pipeline.resolveSeedanceConcurrencyLimit({}), 4);
});

test("Seedance submission lease covers provider timeout with writeback buffer", () => {
  assert.equal(typeof pipeline.resolveSeedanceSubmissionLeaseSeconds, "function");
  assert.equal(pipeline.resolveSeedanceSubmissionLeaseSeconds({ config: { timeoutMs: 600_000 } }), 660);
  assert.equal(pipeline.resolveSeedanceSubmissionLeaseSeconds({}), 660);
  assert.equal(pipeline.resolveSeedanceSubmissionLeaseSeconds({ config: { timeoutMs: 30_000 } }), 300);
  assert.equal(pipeline.resolveSeedanceSubmissionLeaseSeconds({ config: { timeoutMs: 7_200_000 } }), 3600);
});

test("pipeline passes timeout-derived lease seconds into the atomic task claim", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function submitPendingGenerationTasks");
  const end = source.indexOf("export async function retryFailedGenerationTask", start);
  const body = source.slice(start, end);
  assert.match(body, /const leaseSeconds = resolveSeedanceSubmissionLeaseSeconds\(provider\)/);
  assert.match(body, /claimPendingSeedanceTasks[\s\S]*leaseOwner,[\s\S]*leaseSeconds/);
});
