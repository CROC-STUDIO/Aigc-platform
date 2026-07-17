import assert from "node:assert/strict";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";

function context() {
  return {
    userId: "admin",
    user: { username: "admin", role: "admin", isAdmin: true },
    currentUserId: () => "admin",
    currentProjectRoot: () => "/data/project-a",
    currentBaseProjectRoot: () => "/data/project-a"
  };
}

function writebackFactsPool() {
  const state = {
    attempts: 0,
    status: "pending",
    runStatus: "queued",
    leaseOwner: "submit-owner-a",
    requestSummary: {},
    responseSummary: {},
    seedanceTaskId: null,
    errorCode: null,
    attemptRows: [],
    providerAttemptWrites: 0,
    stateEvents: 0,
    pollJobCreated: false
  };

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      return this.execute(sql, params);
    },
    async execute(sql, params = []) {
      const text = String(sql);
      if (text.includes("SELECT id FROM app_users")) return [[{ id: 11 }]];
      if (text.includes("SELECT id FROM projects WHERE project_key")) return [[{ id: 22 }]];
      if (text.includes("INSERT INTO project_members")) return [{ affectedRows: 1 }];
      if (text.includes("SELECT project_id") && text.includes("FROM project_members")) return [[{ project_id: 22 }]];

      if (text.includes("SELECT wt.task_uid") && text.includes("submissionPhase")) {
        return [[state.status === "pending" && state.requestSummary.submissionPhase === "sent"
          ? { task_uid: "gen_abcd_001" }
          : undefined].filter(Boolean)];
      }
      if (text.includes("UPDATE workflow_tasks wt") && text.includes("submission_unknown")) {
        if (state.status === "pending" && state.requestSummary.submissionPhase === "sent") {
          state.status = "failed";
          state.errorCode = "submission_unknown";
          state.responseSummary = { status: "submission_unknown", submissionPhase: "unknown" };
          state.leaseOwner = null;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }
      if (text.includes("UPDATE task_attempts ta") && text.includes("submission_unknown")) {
        const current = state.attemptRows.at(-1);
        if (current) current.status = "failed";
        return [{ affectedRows: current ? 1 : 0 }];
      }
      if (text.includes("COUNT(*) AS active_count")) {
        return [[{ active_count: 0, batch_active_count: 0 }]];
      }
      if (text.includes("FOR UPDATE SKIP LOCKED")) return [[]];

      if (text.includes("SELECT wt.id, wt.attempts, wt.max_attempts")) {
        return [[state.status === "pending" && state.leaseOwner === params.at(-1)
          ? { id: 101, attempts: state.attempts, max_attempts: 2 }
          : undefined].filter(Boolean)];
      }
      if (text.includes("UPDATE workflow_tasks") && text.includes("SET attempts = ?")) {
        state.attempts = Number(params[0]);
        state.requestSummary = JSON.parse(params[2]);
        return [{ affectedRows: 1 }];
      }
      if (text.includes("INSERT INTO task_attempts") && text.includes("VALUES (?, ?, 'running'")) {
        state.providerAttemptWrites += 1;
        state.attemptRows.push({ attemptNo: Number(params[1]), status: "running", upstreamTaskId: null });
        return [{ affectedRows: 1 }];
      }

      if (text.includes("wr.id AS run_id") && text.includes("wt.id AS task_id")) {
        return [[state.status === "pending" && state.leaseOwner === params.at(-1)
          ? {
              run_id: 201,
              run_status: state.runStatus,
              task_id: 101,
              task_status: state.status,
              attempts: state.attempts,
              max_attempts: 2
            }
          : undefined].filter(Boolean)];
      }
      if (text.includes("UPDATE workflow_tasks") && text.includes("SET status = ?")) {
        state.status = params[0];
        state.seedanceTaskId = params[3];
        state.attempts = Number(params[5]);
        state.requestSummary = JSON.parse(params[10]);
        state.responseSummary = JSON.parse(params[11]);
        state.leaseOwner = null;
        return [{ affectedRows: 1 }];
      }
      if (text.includes("FROM state_transition_rules")) return [[{ id: 1 }]];
      if (text.includes("INSERT INTO state_transition_events")) {
        state.stateEvents += 1;
        return [{ affectedRows: 1 }];
      }
      if (text.includes("INSERT INTO task_attempts")) {
        state.providerAttemptWrites += 1;
        const current = state.attemptRows.find((item) => item.attemptNo === Number(params[1]));
        if (current) {
          current.status = params[2];
          current.upstreamTaskId = params[4];
        } else {
          state.attemptRows.push({ attemptNo: Number(params[1]), status: params[2], upstreamTaskId: params[4] });
        }
        return [{ affectedRows: 1 }];
      }
      if (text.includes("UPDATE workflow_runs") && text.includes("status = 'running'")) {
        state.runStatus = "running";
        return [{ affectedRows: 1 }];
      }
      if (text.includes("INSERT INTO scheduler_jobs") && text.includes("'upstream_poll'")) {
        state.pollJobCreated = true;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    }
  };

  return { state, pool: { async getConnection() { return connection; } } };
}

test.afterEach(async () => {
  await mysqlFacts.closeWangzhuanFactsPool();
});

test("Seedance task id is written through its lease before the batch-level writeback", async () => {
  const fake = writebackFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const batchId = "wzb_20260717000000_abcd";
  const taskUid = "gen_abcd_001";

  const sent = await mysqlFacts.markSeedanceTaskSubmissionSent(context(), {
    batchId,
    taskUid,
    leaseOwner: "submit-owner-a",
    provider: "seedance",
    attemptNo: 1,
    sentAt: "2026-07-17T03:00:00.000Z",
    requestSummary: { model: "seedance", duration: 4 }
  });
  assert.equal(sent.attemptNo, 1);
  assert.equal(fake.state.requestSummary.submissionPhase, "sent");

  const persisted = await mysqlFacts.persistSeedanceSubmissionResult(context(), {
    batchId,
    taskUid,
    leaseOwner: "submit-owner-a",
    task: {
      generationTaskId: taskUid,
      status: "waiting_upstream",
      provider: "seedance",
      seedanceTaskId: "aigc_remote_001",
      providerJobId: "aigc_remote_001",
      attempts: 1,
      startedAt: "2026-07-17T03:00:00.000Z",
      requestSummary: { model: "seedance", duration: 4 },
      responseSummary: { status: "queued", taskId: "aigc_remote_001" }
    }
  });

  assert.equal(persisted.status, "waiting_upstream");
  assert.equal(fake.state.status, "waiting_upstream");
  assert.equal(fake.state.seedanceTaskId, "aigc_remote_001");
  assert.equal(fake.state.leaseOwner, null);
  assert.equal(fake.state.requestSummary.submissionPhase, "accepted");
  assert.equal(fake.state.responseSummary.submissionPhase, "accepted");
  assert.deepEqual(fake.state.attemptRows, [{ attemptNo: 1, status: "running", upstreamTaskId: "aigc_remote_001" }]);
  assert.equal(fake.state.runStatus, "running");
  assert.equal(fake.state.stateEvents, 2);
  assert.equal(fake.state.pollJobCreated, true);
});

test("an expired sent claim becomes submission_unknown instead of being claimed again", async () => {
  const fake = writebackFactsPool();
  fake.state.attempts = 1;
  fake.state.requestSummary = { submissionPhase: "sent" };
  fake.state.attemptRows = [{ attemptNo: 1, status: "running", upstreamTaskId: null }];
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);

  const claim = await mysqlFacts.claimPendingSeedanceTasks(context(), {
    batchId: "wzb_20260717000000_abcd",
    candidateTaskUids: ["gen_abcd_001"],
    requestedLimit: 1,
    concurrencyLimit: 1,
    leaseOwner: "submit-owner-b"
  });

  assert.deepEqual(claim.taskUids, []);
  assert.equal(fake.state.status, "failed");
  assert.equal(fake.state.errorCode, "submission_unknown");
  assert.equal(fake.state.attemptRows[0].status, "failed");
  assert.equal(fake.state.leaseOwner, null);
});

test("local asset review preflight failure keeps zero attempts and creates no provider attempt", async () => {
  const fake = writebackFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);

  const persisted = await mysqlFacts.persistSeedanceSubmissionResult(context(), {
    batchId: "wzb_20260717000000_abcd",
    taskUid: "gen_abcd_001",
    leaseOwner: "submit-owner-a",
    task: {
      generationTaskId: "gen_abcd_001",
      status: "failed",
      provider: "seedance",
      attempts: 0,
      errorCode: "asset_review_pending",
      errorMessage: "local material review is not ready",
      requestSummary: {},
      responseSummary: { status: "failed" }
    }
  });

  assert.equal(persisted.attemptNo, 0);
  assert.equal(fake.state.status, "failed");
  assert.equal(fake.state.attempts, 0);
  assert.equal(fake.state.providerAttemptWrites, 0);
  assert.deepEqual(fake.state.attemptRows, []);
  assert.equal(fake.state.pollJobCreated, false);
});
