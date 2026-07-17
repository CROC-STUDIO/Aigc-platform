import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listStateTransitionRules } from "../../server/wangzhuan/mysql-facts.mjs";

const root = new URL("../../", import.meta.url);

const requiredRules = [
  ["queued", "qc", "generation_completed"],
  ["queued", "partial_failed", "generation_partial_failed"],
  ["running", "partial_failed", "generation_partial_failed"]
];

test("segment finalization transitions are available to the MySQL state machine", () => {
  const rules = listStateTransitionRules();

  for (const [fromStatus, toStatus, triggerName] of requiredRules) {
    assert.ok(
      rules.some((rule) =>
        rule.entityType === "workflow_run"
        && rule.fromStatus === fromStatus
        && rule.toStatus === toStatus
        && rule.triggerName === triggerName
      ),
      `missing workflow_run ${fromStatus} -> ${toStatus} by ${triggerName}`
    );
  }
});

test("segment finalization state-rule migration has verify and rollback coverage", async () => {
  const [migration, verify, down] = await Promise.all([
    readFile(new URL("database/migrations/0018_generation_finalize_state_rules.sql", root), "utf8").catch(() => ""),
    readFile(new URL("database/migrations/0018_generation_finalize_state_rules.verify.sql", root), "utf8").catch(() => ""),
    readFile(new URL("database/migrations/0018_generation_finalize_state_rules.down.sql", root), "utf8").catch(() => "")
  ]);

  for (const [fromStatus, toStatus, triggerName] of requiredRules) {
    const tuple = new RegExp(
      `\\('workflow_run',\\s*'${fromStatus}',\\s*'${toStatus}',\\s*'${triggerName}'`,
      "i"
    );
    assert.match(migration, tuple);
    assert.match(verify, tuple);
  }
  assert.match(migration, /0018_generation_finalize_state_rules/);
  assert.match(verify, /required_rule_count/i);
  assert.match(down, /generation_partial_failed/i);
  assert.match(down, /generation_completed/i);
  assert.match(down, /DELETE FROM app_schema_migrations/i);
});
