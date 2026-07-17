import assert from "node:assert/strict";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";
import { getBatchDetail } from "../../server/wangzhuan/pipeline.mjs";

const BATCH_ID = "wzb_20260717051112_be06";

function context() {
  return {
    userId: "tester",
    user: { username: "tester", role: "user" },
    userProjectRoot: "/data/project-a/users/tester",
    sharedProjectRoot: "/data/project-a",
    currentUserId: () => "tester",
    currentProjectRoot: () => "/data/project-a/users/tester",
    currentBaseProjectRoot: () => "/data/project-a",
    readBatchForTest: async () => ({
      batchId: BATCH_ID,
      userId: "tester",
      status: "partial_failed",
      tasks: [{ generationTaskId: "gen_be06_001", status: "failed" }],
      outputs: []
    })
  };
}

function fakeBatchPool() {
  const run = {
    id: 91,
    run_uid: BATCH_ID,
    run_type: "pipeline",
    status: "partial_failed",
    request_json: JSON.stringify({ batchName: "be06 recovery fixture" }),
    capability_json: "{}",
    qc_summary_json: "{}",
    template_snapshot_json: "{}",
    created_at: "2026-07-17 05:11:12.000",
    updated_at: "2026-07-17 05:20:00.000"
  };
  const scriptRows = [{
    script_uid: "scr_be06_001",
    variant_index: 1,
    segment_index: 1,
    duration_sec: 10,
    hook_text: "hook",
    body_text: "body",
    script_probe_json: JSON.stringify({
      branchId: "branch_1",
      branchLabel: "默认分支",
      branchVariantIndex: 1
    })
  }];
  const taskRows = [{
    task_uid: "gen_be06_001",
    task_kind: "seedance_video",
    status: "failed",
    provider: "seedance",
    attempts: 2,
    max_attempts: 3,
    error_code: "upstream_failed",
    error_message: "temporary provider failure",
    request_summary_json: JSON.stringify({
      scriptId: "scr_be06_001",
      branchId: "branch_1",
      branchLabel: "默认分支",
      branchVariantIndex: 1,
      segmentIndex: 1,
      durationSec: 10
    }),
    response_summary_json: JSON.stringify({ retryable: true }),
    script_uid: "scr_be06_001",
    started_at: "2026-07-17 05:12:00.000",
    finished_at: "2026-07-17 05:14:00.000"
  }];
  const attemptRows = [
    {
      task_uid: "gen_be06_001",
      attempt_no: 1,
      status: "failed",
      provider: "seedance",
      upstream_task_id: "seedance_attempt_1",
      started_at: "2026-07-17 05:12:00.000",
      finished_at: "2026-07-17 05:13:00.000",
      error_code: "upstream_timeout",
      error_message: "timeout",
      retryable: 1
    },
    {
      task_uid: "gen_be06_001",
      attempt_no: 2,
      status: "failed",
      provider: "seedance",
      upstream_task_id: "seedance_attempt_2",
      started_at: "2026-07-17 05:13:10.000",
      finished_at: "2026-07-17 05:14:00.000",
      error_code: "upstream_failed",
      error_message: "temporary provider failure",
      retryable: 1
    }
  ];
  const outputRows = [{
    output_uid: "out_manual_001",
    source_type: "pipeline",
    output_kind: "stitched_video",
    duration_sec: 10,
    qc_status: "not_started",
    download_eligible: 1,
    visual_preview_required: 0,
    preview_confirmed: 0,
    storage_relative_path: "stitched/manual-v1.mp4",
    storage_url: "https://cdn.example.test/manual-v1.mp4",
    output_probe_json: JSON.stringify({
      manualStitch: true,
      stitchVersion: 1,
      stitchKind: "partial",
      sourceGroups: ["branch_1:1"],
      segmentOutputIds: ["out_segment_001"],
      createdBy: "tester",
      createdAt: "2026-07-17T05:19:00.000Z",
      fulfillmentSource: "manual_stitch",
      displayFileName: "手动拼接 V1.mp4"
    })
  }];

  const connection = {
    release() {},
    async execute(sql) {
      const text = String(sql);
      if (text.includes("SELECT id FROM app_users")) return [[{ id: 11 }]];
      if (text.includes("SELECT id FROM projects WHERE project_key")) return [[{ id: 22 }]];
      if (text.includes("INSERT INTO project_members")) return [{ affectedRows: 1 }];
      if (text.includes("FROM workflow_runs wr") && text.includes("wr.run_type = 'pipeline'")) return [[run]];
      if (text.includes("FROM generation_scripts gs")) return [scriptRows];
      if (text.includes("FROM task_attempts ta")) return [attemptRows];
      if (text.includes("FROM scheduler_jobs") && text.includes("task_retry")) return [[]];
      if (text.includes("FROM workflow_tasks wt") && text.includes("LEFT JOIN generation_scripts gs")) return [taskRows];
      if (text.includes("FROM workflow_outputs wo") && text.includes("JOIN asset_files af")) return [outputRows];
      if (text.includes("FROM stitch_reports sr")) return [[]];
      if (text.includes("FROM state_transition_events")) return [[]];
      throw new Error(`unexpected SQL: ${text}`);
    }
  };
  return {
    async getConnection() {
      return connection;
    },
    async end() {}
  };
}

test.afterEach(async () => {
  await mysqlFacts.closeWangzhuanFactsPool();
});

test("batch detail hydrates ordered task attempts and manual output metadata", async () => {
  mysqlFacts.setWangzhuanFactsPoolForTest(fakeBatchPool());

  const detail = await mysqlFacts.loadBatchDetailFromMysql(context(), BATCH_ID);

  assert.deepEqual(detail.batch.tasks[0].attemptHistory.map((item) => item.attemptNo), [1, 2]);
  assert.equal(detail.batch.tasks[0].attemptHistory[0].retryable, true);
  assert.equal(detail.batch.tasks[0].attemptHistory[1].upstreamTaskId, "seedance_attempt_2");
  const output = detail.batch.outputs[0];
  assert.deepEqual({
    manualStitch: output.manualStitch,
    stitchVersion: output.stitchVersion,
    stitchKind: output.stitchKind,
    sourceGroups: output.sourceGroups,
    segmentOutputIds: output.segmentOutputIds,
    createdBy: output.createdBy,
    fulfillmentSource: output.fulfillmentSource
  }, {
    manualStitch: true,
    stitchVersion: 1,
    stitchKind: "partial",
    sourceGroups: ["branch_1:1"],
    segmentOutputIds: ["out_segment_001"],
    createdBy: "tester",
    fulfillmentSource: "manual_stitch"
  });
});

test("getBatchDetail exposes recovery eligibility and availability", async () => {
  mysqlFacts.setWangzhuanFactsPoolForTest(fakeBatchPool());

  const detail = await getBatchDetail(context(), BATCH_ID);

  assert.equal(detail.batch.tasks[0].branchVariantIndex, 1);
  assert.equal(detail.batch.tasks[0].segmentIndex, 1);
  assert.equal(detail.batch.tasks[0].retryEligibility.status, "retryable");
  assert.equal(detail.batch.tasks[0].availability, "retryable");
  assert.deepEqual(detail.batch.tasks[0].attemptHistory.map((item) => item.attemptNo), [1, 2]);
});
