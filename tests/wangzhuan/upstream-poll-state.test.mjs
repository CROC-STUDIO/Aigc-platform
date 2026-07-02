import assert from "node:assert/strict";
import test from "node:test";

import { statusAfterTaskWrite } from "../../server/wangzhuan/upstream-poll.mjs";
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
