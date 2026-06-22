import assert from "node:assert/strict";
import test from "node:test";

import { listTasks } from "../../server/wangzhuan/tasks.mjs";
import {
  closeWangzhuanFactsPool,
  setWangzhuanFactsPoolForTest,
  syncBatchFacts
} from "../../server/wangzhuan/mysql-facts.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

function scopedContext(userId = "alice") {
  return {
    user: { username: userId, role: "user" },
    userId,
    projectName: "current_project"
  };
}

test.after(() => {
  closeWangzhuanFactsPool();
});

test("listTasks returns workflow summaries for the current user", async () => {
  ensureFactsPool();
  const context = scopedContext("alice");
  await syncBatchFacts(context, {
    batchId: "wzb_20260622090403_e393",
    status: "preview_required",
    userId: "alice",
    estimate: { estimateId: "est_1", scriptCount: 3 },
    plans: [{ planId: "plan_1", status: "drafted" }],
    tasks: []
  }, "batch_created");

  const active = await listTasks(context, { scope: "active" });
  assert.equal(active.items.length, 1);
  assert.equal(active.items[0].batchId, "wzb_20260622090403_e393");
  assert.equal(active.items[0].status, "preview_required");
  assert.equal(active.items[0].isActive, true);

  const all = await listTasks(context, { scope: "all" });
  assert.ok(all.items.some((item) => item.batchId === "wzb_20260622090403_e393"));
});
