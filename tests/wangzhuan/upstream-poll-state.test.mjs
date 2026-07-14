import assert from "node:assert/strict";
import test from "node:test";

import { __upstreamPollTestHooks, statusAfterTaskWrite } from "../../server/wangzhuan/upstream-poll.mjs";
import { listStateTransitionRules } from "../../server/wangzhuan/mysql-facts.mjs";

test("statusAfterTaskWrite keeps run non-terminal when downloaded_output sees failed tasks", () => {
  const batch = { status: "running" };
  const tasks = [
    { generationTaskId: "gen_1", status: "failed" },
    { generationTaskId: "gen_2", status: "downloaded" }
  ];

  assert.equal(statusAfterTaskWrite(batch, tasks), "running");
});

test("statusAfterTaskWrite still blocks advancement while pending upstream tasks remain", () => {
  const batch = { status: "running" };
  const tasks = [
    { generationTaskId: "gen_1", status: "failed" },
    { generationTaskId: "gen_2", status: "waiting_upstream" }
  ];

  assert.equal(statusAfterTaskWrite(batch, tasks), "running");
});

test("statusAfterTaskWrite preserves terminal batch states", () => {
  const batch = { status: "partial_failed" };
  const tasks = [
    { generationTaskId: "gen_1", status: "failed" }
  ];

  assert.equal(statusAfterTaskWrite(batch, tasks), "partial_failed");
});

test("state transition rules allow pending continuity task to fail during downloaded_output writeback", () => {
  const rules = listStateTransitionRules();
  assert.ok(
    rules.some((rule) =>
      rule.entityType === "workflow_task"
      && rule.fromStatus === "pending"
      && rule.toStatus === "failed"
      && rule.triggerName === "downloaded_output"
    )
  );
});

test("state transition rules allow waiting upstream task to fail during downloaded_output writeback", () => {
  const rules = listStateTransitionRules();
  assert.ok(
    rules.some((rule) =>
      rule.entityType === "workflow_task"
      && rule.fromStatus === "waiting_upstream"
      && rule.toStatus === "failed"
      && rule.triggerName === "downloaded_output"
    )
  );
});

test("upstream poll worker maps tasks concurrently with configured limit", async () => {
  const { mapWithConcurrency } = __upstreamPollTestHooks;
  let active = 0;
  let maxActive = 0;
  const started = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(item);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return item * 10;
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(started.slice(0, 3).sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("upstream poll concurrency defaults to three and respects config", () => {
  const { resolvePollConcurrency } = __upstreamPollTestHooks;

  assert.equal(resolvePollConcurrency({}), 3);
  assert.equal(resolvePollConcurrency({ config: { wangzhuan: { upstreamPollConcurrency: 5 } } }), 5);
  assert.equal(resolvePollConcurrency({ config: { wangzhuan: { upstreamPollConcurrency: 99 } } }), 10);
});

test("upstream poll single-flight coalesces concurrent work and clears after completion", async () => {
  const { runPollSingleFlight } = __upstreamPollTestHooks;
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const worker = async () => {
    runs += 1;
    await gate;
    return { runs };
  };

  const first = runPollSingleFlight("test:batch", worker);
  const second = runPollSingleFlight("test:batch", worker);
  assert.equal(runs, 0);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ runs: 1 }, { runs: 1 }]);
  assert.equal(runs, 1);

  assert.deepEqual(await runPollSingleFlight("test:batch", worker), { runs: 2 });
});
