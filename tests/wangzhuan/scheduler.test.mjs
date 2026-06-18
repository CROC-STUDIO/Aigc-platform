import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeWangzhuanFactsPool,
  setWangzhuanFactsPoolForTest,
  syncBatchFacts
} from "../../server/wangzhuan/mysql-facts.mjs";
import { runDueSchedulerJob } from "../../server/wangzhuan/scheduler.mjs";
import { wangzhuanPaths, writeAtomicJson } from "../../server/wangzhuan/storage.mjs";
import { context as mysqlContext, fakePool } from "./mysql-facts.test.mjs";

function schedulerContext(root) {
  return {
    ...mysqlContext(),
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared")
  };
}

test("scheduler worker claims task_retry jobs and resubmits failed generation tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-scheduler-"));
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const ctx = schedulerContext(root);
    const paths = wangzhuanPaths(ctx);
    const batch = {
      batchId: "wzb_20260618000300_abcd",
      type: "pipeline",
      status: "queued",
      userId: ctx.userId,
      tasks: [
        {
          generationTaskId: "gen_20260618000300_abcd_001",
          scriptId: "scr_001",
          status: "pending",
          attempts: 0,
          maxAttempts: 2,
          modelImage: "gpt-image-2",
          modelVideo: "dreamina-seedance-2-0-260128",
          promptPath: "批处理记录/网赚管线/batches/wzb_20260618000300_abcd/prompts/a.txt"
        }
      ],
      scripts: [],
      outputs: [],
      createdAt: "2026-06-18T00:03:00.000Z",
      updatedAt: "2026-06-18T00:03:00.000Z"
    };
    await writeAtomicJson(join(paths.batchesDir, batch.batchId, "batch.json"), batch);
    await writeAtomicJson(join(paths.batchesDir, "index.json"), {
      schemaVersion: "batches.v1",
      items: [{ batchId: batch.batchId, status: "queued", createdAt: batch.createdAt }]
    });
    assert.equal((await syncBatchFacts(ctx, batch, "batch_created")).skipped, false);
    const failedBatch = {
      ...batch,
      status: "running",
      tasks: [{
        ...batch.tasks[0],
        status: "failed",
        attempts: 1,
        errorCode: "upstream_timeout",
        nextAttemptAt: "2026-06-18T00:03:00.000Z"
      }]
    };
    await writeAtomicJson(join(paths.batchesDir, batch.batchId, "batch.json"), failedBatch);
    assert.equal((await syncBatchFacts(ctx, failedBatch, "batch_write")).skipped, false);

    const result = await runDueSchedulerJob(ctx, { workerId: "scheduler_test_worker", lockSeconds: 30 });

    assert.equal(result.claimed, true);
    assert.equal(result.error, undefined);
    assert.equal(result.job.jobType, "task_retry");
    assert.equal(pool.state.schedulerJobs.get(result.job.jobUid).status, "succeeded");
    const saved = await readFile(join(paths.batchesDir, batch.batchId, "batch.json"), "utf8");
    const parsed = JSON.parse(saved);
    assert.equal(parsed.tasks[0].status, "waiting_upstream");
    assert.equal(parsed.tasks[0].attempts, 2);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
