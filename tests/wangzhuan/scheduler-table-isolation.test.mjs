import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";

test("scheduler table selection keeps formal and candidate queues isolated", () => {
  assert.equal(typeof mysqlFacts.resolveSchedulerJobsTableName, "function");
  assert.equal(mysqlFacts.resolveSchedulerJobsTableName({}), "scheduler_jobs");
  assert.equal(
    mysqlFacts.resolveSchedulerJobsTableName({ AIGC_SCHEDULER_TABLE: "scheduler_jobs_candidate" }),
    "scheduler_jobs_candidate"
  );
  assert.throws(
    () => mysqlFacts.resolveSchedulerJobsTableName({ AIGC_SCHEDULER_TABLE: "scheduler_jobs; DROP TABLE workflow_runs" }),
    /AIGC_SCHEDULER_TABLE/
  );
});

test("all scheduler job SQL uses the selected queue table", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const hardcodedSqlReferences = source.match(/\b(?:FROM|INTO|UPDATE|JOIN|DELETE FROM) scheduler_jobs\b/g) || [];

  assert.deepEqual(hardcodedSqlReferences, []);
  assert.match(source, /\$\{schedulerJobsTableName\}/);
});
