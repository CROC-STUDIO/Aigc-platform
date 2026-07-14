import assert from "node:assert/strict";
import test from "node:test";

import { closeWangzhuanFactsPool, loadWorkflowTasksFromMysql, setWangzhuanFactsPoolForTest } from "../../server/wangzhuan/mysql-facts.mjs";

function contextForProject(projectRoot) {
  return {
    userId: "admin",
    user: { username: "admin", role: "admin", isAdmin: true },
    currentUserId: () => "admin",
    currentUser: () => ({ username: "admin", role: "admin", isAdmin: true }),
    currentProjectRoot: () => projectRoot,
    currentBaseProjectRoot: () => projectRoot
  };
}

test.afterEach(async () => {
  await closeWangzhuanFactsPool();
});

test("loadWorkflowTasksFromMysql scopes task list to current user across projects", async () => {
  const executed = [];
  const fakeConn = {
    async execute(sql, params) {
      executed.push({ sql: String(sql), params: Array.from(params || []) });
      if (String(sql).includes("SELECT id FROM app_users")) return [[{ id: 11 }]];
      if (String(sql).includes("COUNT(*) AS total")) return [[{ total: 1 }]];
      if (String(sql).includes("FROM workflow_runs wr")) {
        return [[{
          run_uid: "wzb_20260706145003_fd25",
          run_type: "pipeline",
          status: "failed",
          operation_type: "",
          target_channel: "meta_ads",
          stop_reason: "",
          template_snapshot_json: JSON.stringify({ draft: { productName: "0706", targetChannels: ["meta_ads"] } }),
          started_at: null,
          finished_at: null,
          created_at: "2026-07-06 14:50:03.714",
          updated_at: "2026-07-06 15:46:03.456",
          project_key: "root:project-a"
        }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {}
  };
  const fakePool = {
    async getConnection() {
      return fakeConn;
    }
  };
  setWangzhuanFactsPoolForTest(fakePool);

  const result = await loadWorkflowTasksFromMysql(contextForProject("/data/project-a"), {
    scope: "all",
    page: 1,
    pageSize: 10
  });

  assert.equal(result.items.length, 1);
  const taskQuery = executed.find((entry) => entry.sql.includes("FROM workflow_runs wr") && entry.sql.includes("LIMIT"));
  assert.ok(taskQuery);
  assert.doesNotMatch(taskQuery.sql, /wr\.project_id = \?/);
  assert.match(taskQuery.sql, /wr\.user_id = \?/);
  assert.equal(taskQuery.params[0], 11);
  assert.equal(executed.some((entry) => entry.sql.includes("SELECT id FROM projects WHERE project_key")), false);
});
