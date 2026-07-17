import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as scheduler from "../../server/wangzhuan/scheduler.mjs";

test("scheduler synchronization preserves every running lease", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const taskStart = source.indexOf("async function syncSchedulerJobs");
  const upstreamStart = source.indexOf("async function syncUpstreamPollJob");
  const end = source.indexOf("function schedulerWorkerId", upstreamStart);
  const taskBody = source.slice(taskStart, upstreamStart);
  const upstreamBody = source.slice(upstreamStart, end);

  assert.ok(taskStart >= 0);
  assert.ok(upstreamStart > taskStart);
  assert.ok(end > upstreamStart);
  for (const body of [taskBody, upstreamBody]) {
    assert.match(body, /run_after\s*=\s*IF\(status = 'running', run_after, VALUES\(run_after\)\)/);
    assert.match(body, /status\s*=\s*IF\(status = 'running', status, VALUES\(status\)\)/);
    assert.ok(body.indexOf("run_after = IF") < body.indexOf("status = IF"));
  }
});

test("scheduler claim can atomically recover an expired lease from another worker", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function claimSchedulerJob");
  const end = source.indexOf("export async function completeSchedulerJob", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(body, /sj\.status = 'running'\s+AND sj\.lock_expires_at <= UTC_TIMESTAMP\(3\)/s);
  assert.match(body, /status = 'running' AND lock_expires_at <= UTC_TIMESTAMP\(3\)/);
  assert.doesNotMatch(body, /sj\.locked_by = \?/);
});

test("production scheduler worker id includes the container hostname", async () => {
  const source = await readFile(new URL("../../server.mjs", import.meta.url), "utf8");

  assert.match(source, /workerId: `aigc-platform:\$\{hostname\(\)\}:\$\{process\.pid\}`/);
});

test("server ignores broken stdout pipes before logging uncaught exceptions", async () => {
  const source = await readFile(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /process\.on\("uncaughtException", \(error\) => \{\s*if \(error\?\.code === "EPIPE"\) return;/
  );
});

test("15s multi-slice or post-process batches keep upstream polling until stitched outputs exist", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function shouldScheduleUpstreamPoll");
  const end = source.indexOf("async function syncUpstreamPollJob", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(body, /schedulerBatchNeedsStitch\(batch\)/);
  assert.match(body, /!outputs\.some\(\(output\) => output\.kind === "stitched_video"\)/);
  assert.match(body, /schedulerRequiresPostProcess/);
  assert.match(body, /schedulerBatchHasMultiSliceGroups/);
});

test("terminal partial batches keep their upstream poll job while a task is waiting", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function shouldScheduleUpstreamPoll");
  const end = source.indexOf("async function syncUpstreamPollJob", start);
  const body = source.slice(start, end);

  assert.match(body, /if \(tasks\.some\(\(task\) => task\.status === "waiting_upstream"\)\) return true;/);
  assert.ok(body.indexOf('task.status === "waiting_upstream"') < body.indexOf('["qc", "partial_failed"]'));
});

test("scheduler workers renew long-running job leases until the handler settles", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/scheduler.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function runDueSchedulerJob");
  const end = source.indexOf("export async function runDueSchedulerJobs", start);
  const body = source.slice(start, end);

  assert.match(source, /renewSchedulerJobLease/);
  assert.match(body, /setInterval\(/);
  assert.match(body, /clearInterval\(/);
});

test("completing a poll job atomically keeps it pending when a retry added new work", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function completeSchedulerJob");
  const end = source.indexOf("export async function rescheduleSchedulerJob", start);
  const body = source.slice(start, end);

  assert.match(body, /wt\.status IN \('pending', 'waiting_upstream'\)/);
  assert.match(body, /nextStatus === "pending"/);
  assert.match(body, /FOR UPDATE/);
  assert.ok(
    body.indexOf("FROM workflow_tasks wt") < body.indexOf("UPDATE ${schedulerJobsTableName}"),
    "poll completion must keep the workflow_tasks -> scheduler_jobs lock order"
  );
});

test("legacy asset review retry jobs complete without invoking task resubmission", async () => {
  assert.equal(typeof scheduler.runTaskRetryJob, "function");
  let retryCalls = 0;
  const job = {
    runUid: "wzb_20260717000000_abcd",
    taskUid: "gen_test_001",
    payload: {
      batchId: "wzb_20260717000000_abcd",
      taskUid: "gen_test_001",
      errorCode: "asset_review_pending"
    }
  };
  const result = await scheduler.runTaskRetryJob({}, job, {
    async retryFailedGenerationTask() {
      retryCalls += 1;
      throw new Error("must not retry local asset review failures");
    }
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: "asset_review_pending",
    batchId: "wzb_20260717000000_abcd",
    taskUid: "gen_test_001"
  });
  assert.equal(retryCalls, 0);
});
