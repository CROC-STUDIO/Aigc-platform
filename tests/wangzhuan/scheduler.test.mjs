import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeWangzhuanFactsPool,
  loadBatchDetailFromMysql,
  setWangzhuanFactsPoolForTest,
  syncBatchFacts
} from "../../server/wangzhuan/mysql-facts.mjs";
import { runDueSchedulerJob } from "../../server/wangzhuan/scheduler.mjs";
import { context as mysqlContext, fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";
import { testSeedanceProviderClient } from "./test-providers.mjs";

function schedulerContext(root) {
  const ctx = {
    ...mysqlContext(),
    userProjectRoot: join(root, "user"),
    sharedProjectRoot: join(root, "shared"),
    seedanceProviderClient: testSeedanceProviderClient()
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

test("scheduler worker claims task_retry jobs and resubmits failed generation tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-scheduler-"));
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const ctx = schedulerContext(root);
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
          modelVideo: "doubao-seedance-2-0-260128",
          promptPath: "批处理记录/网赚管线/batches/wzb_20260618000300_abcd/prompts/a.txt"
        }
      ],
      scripts: [],
      outputs: [],
      createdAt: "2026-06-18T00:03:00.000Z",
      updatedAt: "2026-06-18T00:03:00.000Z"
    };
    assert.equal((await syncBatchFacts(ctx, batch, "batch_created")).skipped, false);
    const promptPath = join(ctx.userProjectRoot, batch.tasks[0].promptPath);
    await mkdir(join(ctx.userProjectRoot, "批处理记录", "网赚管线", "batches", batch.batchId, "prompts"), { recursive: true });
    await writeFile(promptPath, "prompt for retry test\n", "utf8");
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
    assert.equal((await syncBatchFacts(ctx, failedBatch, "batch_write")).skipped, false);

    const result = await runDueSchedulerJob(ctx, { workerId: "scheduler_test_worker", lockSeconds: 30 });

    assert.equal(result.claimed, true);
    assert.equal(result.error, undefined);
    assert.equal(result.job.jobType, "task_retry");
    assert.equal(pool.state.schedulerJobs.get(result.job.jobUid).status, "succeeded");
    const parsed = (await loadBatchDetailFromMysql(ctx, batch.batchId)).batch;
    assert.equal(parsed.tasks[0].status, "waiting_upstream");
    assert.equal(parsed.tasks[0].attempts, 2);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
