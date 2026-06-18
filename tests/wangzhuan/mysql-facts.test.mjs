import assert from "node:assert/strict";
import test from "node:test";

import {
  claimSchedulerJob,
  closeWangzhuanFactsPool,
  completeSchedulerJob,
  failSchedulerJob,
  findActiveResourceLock,
  loadChannelRuleStoreFromMysql,
  loadEstimateFromMysql,
  loadReferenceVideoProbeFromMysql,
  loadTemplateStoreFromMysql,
  loadVideoDecompositionFromMysql,
  recordIdempotencyFact,
  recordMysqlTelemetryEvent,
  setWangzhuanFactsPoolForTest,
  syncDownloadPackageFact,
  syncEstimateFact,
  syncRemixFacts,
  syncReferenceVideoFact,
  syncChannelRuleStoreFacts,
  syncBatchFacts,
  syncTemplateStoreFacts,
  syncVideoDecompositionFact
} from "../../server/wangzhuan/mysql-facts.mjs";

export function fakePool() {
  const calls = [];
  const state = {
    users: new Map(),
    projects: new Map(),
    roles: new Map([["user", 11], ["admin", 12]]),
    runs: new Map(),
    runStatuses: new Map(),
    tasks: new Map(),
    templates: new Map(),
    templateVersions: new Map(),
    templateRows: [],
    channelRows: [],
    assets: new Map(),
    referenceVideos: new Map(),
    decompositions: new Map(),
    estimates: new Map(),
    scripts: new Map(),
    outputs: new Map(),
    schedulerJobs: new Map(),
    stateTransitionRules: new Set(),
    activeResourceLock: null,
    nextUserId: 101,
    nextProjectId: 201,
    nextRunId: 301,
    nextTaskId: 401,
    nextTemplateId: 501,
    nextTemplateVersionId: 601,
    nextAssetId: 701,
    nextReferenceVideoId: 801,
    nextDecompositionId: 901,
    nextEstimateId: 1001,
    nextScriptId: 1101,
    nextOutputId: 1201,
    nextSchedulerJobId: 1301
  };

  const conn = {
    calls,
    async beginTransaction() {
      calls.push({ sql: "BEGIN", params: [] });
    },
    async commit() {
      calls.push({ sql: "COMMIT", params: [] });
    },
    async rollback() {
      calls.push({ sql: "ROLLBACK", params: [] });
    },
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    },
    async execute(sql, params = []) {
      calls.push({ sql, params });

      if (sql.includes("SELECT id FROM app_users WHERE username")) {
        const id = state.users.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("INSERT INTO app_users")) {
        state.users.set(params[1], state.nextUserId++);
        return [{ insertId: state.users.get(params[1]) }];
      }
      if (sql.includes("SELECT id FROM rbac_roles")) {
        const id = state.roles.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("SELECT id FROM projects WHERE project_key")) {
        const id = state.projects.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("INSERT INTO projects")) {
        state.projects.set(params[1], state.nextProjectId++);
        return [{ insertId: state.projects.get(params[1]) }];
      }
      if (sql.includes("SELECT id FROM workflow_runs") && sql.includes("run_uid")) {
        const id = state.runs.get(params.at(-1));
        return [id ? [{ id }] : []];
      }
      if (sql.includes("SELECT status FROM workflow_runs WHERE id")) {
        return [[{ status: state.runStatuses.get(params[0]) || "queued" }]];
      }
      if (sql.includes("INSERT IGNORE INTO state_transition_rules")) {
        state.stateTransitionRules.add(`${params[0]}|${params[1]}|${params[2]}|${params[3]}`);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM state_transition_rules")) {
        const key = `${params[0]}|${params[1]}|${params[2]}|${params[3]}`;
        return [state.stateTransitionRules.has(key) ? [{ id: 1 }] : []];
      }
      if (sql.includes("FROM scheduler_jobs sj") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        const workerId = params.at(-1);
        const rows = [...state.schedulerJobs.values()]
          .filter((job) => job.status === "pending" || (job.status === "running" && job.lockedBy === workerId))
          .sort((a, b) => (a.priority - b.priority) || (a.id - b.id))
          .slice(0, 1)
          .map((job) => ({
            id: job.id,
            job_uid: job.jobUid,
            job_type: job.jobType,
            status: job.status,
            attempts: job.attempts,
            max_attempts: job.maxAttempts,
            payload_json: JSON.stringify(job.payload),
            run_uid: job.runUid,
            task_uid: job.taskUid,
            username: "alice",
            project_key: "root:test"
          }));
        return [rows];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'succeeded'")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params.at(-2));
        if (job) {
          job.status = "succeeded";
          job.lockedBy = null;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("last_error_code")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params.at(-2));
        if (job) {
          job.status = params[0];
          job.lastErrorCode = params[3];
          job.lastErrorMessage = params[4];
          job.lockedBy = null;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'running'")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params[2]);
        if (job) {
          job.status = "running";
          job.lockedBy = params[0];
          job.attempts += 1;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("INSERT INTO resource_locks")) {
        state.activeResourceLock = {
          lock_key: params[0],
          lock_type: "upstream_generation",
          status: "active",
          run_uid: [...state.runs.entries()].find(([, id]) => id === params[3])?.[0] || "",
          run_type: "pipeline",
          run_status: "running",
          expires_at: "2026-06-18 02:00:00.000"
        };
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE resource_locks")) {
        state.activeResourceLock = null;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM resource_locks rl")) {
        return [state.activeResourceLock ? [state.activeResourceLock] : []];
      }
      if (sql.includes("INSERT INTO workflow_runs")) {
        const existing = state.runs.get(params[0]);
        const id = existing ?? state.nextRunId++;
        state.runs.set(params[0], id);
        state.runStatuses.set(id, params[2]);
        return [{ insertId: state.runs.get(params[0]) }];
      }
      if (sql.includes("SELECT id, status, attempts FROM workflow_tasks")) {
        const task = state.tasks.get(params.at(-1));
        return [task ? [task] : []];
      }
      if (sql.includes("INSERT INTO workflow_tasks")) {
        const existing = state.tasks.get(params[0]);
        state.tasks.set(params[0], { id: existing?.id ?? state.nextTaskId++, status: params[3], attempts: params[9] });
        return [{ insertId: state.tasks.get(params[0]).id }];
      }
      if (sql.includes("SELECT id FROM workflow_tasks") && sql.includes("task_uid")) {
        const task = state.tasks.get(params.at(-1));
        return [task ? [{ id: task.id }] : []];
      }
      if (sql.includes("SELECT id FROM generation_scripts") && sql.includes("script_uid")) {
        const script = state.scripts.get(params.at(-1));
        return [script ? [{ id: script.id }] : []];
      }
      if (sql.includes("INSERT INTO generation_scripts")) {
        const scriptUid = params[0];
        const existing = state.scripts.get(scriptUid);
        state.scripts.set(scriptUid, { id: existing?.id ?? state.nextScriptId++, scriptUid });
        return [{ insertId: state.scripts.get(scriptUid).id }];
      }
      if (sql.includes("SELECT id FROM workflow_outputs") && sql.includes("output_uid")) {
        const output = state.outputs.get(params.at(-1));
        return [output ? [{ id: output.id }] : []];
      }
      if (sql.includes("INSERT INTO workflow_outputs")) {
        const outputUid = params[0];
        const existing = state.outputs.get(outputUid);
        state.outputs.set(outputUid, { id: existing?.id ?? state.nextOutputId++, outputUid });
        return [{ insertId: state.outputs.get(outputUid).id }];
      }
      if (sql.includes("SELECT id FROM product_templates") && sql.includes("template_uid")) {
        const template = state.templates.get(params.at(-1));
        return [template ? [{ id: template.id }] : []];
      }
      if (sql.includes("INSERT INTO product_templates")) {
        const templateId = params[0];
        const existing = state.templates.get(templateId);
        state.templates.set(templateId, {
          id: existing?.id ?? state.nextTemplateId++,
          templateId,
          displayName: params[2],
          status: params[3]
        });
        return [{ insertId: state.templates.get(templateId).id }];
      }
      if (sql.includes("INSERT INTO product_template_versions")) {
        const versionId = params[0];
        const existing = state.templateVersions.get(versionId);
        state.templateVersions.set(versionId, {
          id: existing?.id ?? state.nextTemplateVersionId++,
          versionId,
          templateId: params[1],
          versionNumber: params[2],
          status: params[3]
        });
        return [{ insertId: state.templateVersions.get(versionId).id }];
      }
      if (sql.includes("SELECT id FROM product_template_versions") && sql.includes("template_version_uid")) {
        const version = state.templateVersions.get(params.at(-1));
        return [version ? [{ id: version.id }] : []];
      }
      if (sql.includes("FROM product_templates pt") && sql.includes("product_template_versions pv")) {
        return [state.templateRows];
      }
      if (sql.includes("FROM channel_rules")) {
        return [state.channelRows];
      }
      if (sql.includes("INSERT INTO channel_rules")) {
        state.channelRows.push({
          rule_uid: params[1],
          channel: params[2],
          promise_level: params[3],
          rule_version: params[4],
          cta_strength: params[5],
          forbidden_terms_json: params[6],
          required_disclaimers_json: params[7],
          status: params[8]
        });
        return [{ insertId: state.channelRows.length }];
      }
      if (sql.includes("SELECT id FROM asset_files") && sql.includes("asset_uid")) {
        const asset = state.assets.get(params.at(-1));
        return [asset ? [{ id: asset.id }] : []];
      }
      if (sql.includes("INSERT INTO asset_files")) {
        const assetUid = params[0];
        const existing = state.assets.get(assetUid);
        state.assets.set(assetUid, {
          id: existing?.id ?? state.nextAssetId++,
          assetUid,
          relativePath: params[8],
          storageKey: params[14] ?? null,
          storageUrl: params[15] ?? null
        });
        return [{ insertId: state.assets.get(assetUid).id }];
      }
      if (sql.includes("SELECT id FROM reference_videos") && sql.includes("reference_video_uid")) {
        const reference = state.referenceVideos.get(params.at(-1));
        return [reference ? [{ id: reference.id }] : []];
      }
      if (sql.includes("INSERT INTO reference_videos")) {
        const referenceVideoId = params[0];
        const existing = state.referenceVideos.get(referenceVideoId);
        state.referenceVideos.set(referenceVideoId, {
          id: existing?.id ?? state.nextReferenceVideoId++,
          referenceVideoId,
          status: params[4],
          probe: params[11]
        });
        return [{ insertId: state.referenceVideos.get(referenceVideoId).id }];
      }
      if (sql.includes("FROM reference_videos rv")) {
        const reference = state.referenceVideos.get(params[0]);
        if (!reference) return [[]];
        const asset = state.assets.get(`asset_${reference.referenceVideoId}`) || {};
        return [[{
          reference_video_uid: reference.referenceVideoId,
          status: reference.status,
          duration_sec: 15,
          width: 720,
          height: 1280,
          ratio: "9:16",
          can_extract_frame: 1,
          issues_json: JSON.stringify([]),
          probe_json: reference.probe,
          file_name: "demo.mp4",
          mime_type: "video/mp4",
          size_bytes: 5,
          storage_relative_path: asset.relativePath || "批处理记录/网赚管线/reference-videos/ref_20260618_001/original.mp4",
          storage_key: asset.storageKey,
          storage_url: asset.storageUrl
        }]];
      }
      if (sql.includes("INSERT INTO video_decompositions")) {
        const reference = [...state.referenceVideos.values()].find((item) => item.id === params[0]);
        const referenceVideoId = reference?.referenceVideoId || params[0];
        state.decompositions.set(referenceVideoId, {
          id: state.nextDecompositionId++,
          referenceVideoId,
          schemaVersion: params[1],
          status: params[2],
          decomposition: params[3],
          missingFields: params[4]
        });
        return [{ insertId: state.decompositions.get(referenceVideoId).id }];
      }
      if (sql.includes("FROM video_decompositions vd")) {
        const decomposition = state.decompositions.get(params[0]);
        return [decomposition ? [{
          schema_version: decomposition.schemaVersion,
          status: decomposition.status,
          decomposition_json: decomposition.decomposition,
          missing_fields_json: decomposition.missingFields
        }] : []];
      }
      if (sql.includes("INSERT INTO work_estimates")) {
        const estimateUid = params[0];
        const existing = state.estimates.get(estimateUid);
        state.estimates.set(estimateUid, {
          id: existing?.id ?? state.nextEstimateId++,
          estimateUid,
          estimateType: params[1],
          requestHash: params[7],
          request: params[8],
          estimate: params[9],
          tokenHash: params[10],
          expiresAt: params[11],
          status: params[12]
        });
        return [{ insertId: state.estimates.get(estimateUid).id }];
      }
      if (sql.includes("FROM work_estimates we")) {
        const estimate = state.estimates.get(params[0]);
        return [estimate ? [{
          estimate_uid: estimate.estimateUid,
          estimate_type: estimate.estimateType,
          request_hash: estimate.requestHash,
          request_json: estimate.request,
          estimate_json: estimate.estimate,
          confirmation_expires_at: estimate.expiresAt,
          token_hash_available: Boolean(estimate.tokenHash),
          status: estimate.status,
          template_uid: "tpl_cash_reward_us_en_001",
          template_version_uid: "tplv_cash_reward_us_en_001_0001",
          template_version_number: 1,
          template_status: "active",
          template_draft_json: JSON.stringify({
            displayName: "Cash Reward US EN",
            productName: "Lucky Cash",
            cta: "Install today",
            ending: "Claim your bonus today",
            currencySymbol: "$",
            language: "en-US",
            regions: ["US"],
            targetChannels: ["meta_ads"],
            defaultOutputRatio: "9:16",
            defaultDurationSec: 15,
            promiseLevel: "strong_conversion"
          }),
          reference_video_uid: "ref_20260618_001",
          reference_status: "pass",
          reference_probe_json: JSON.stringify({
            referenceVideoId: "ref_20260618_001",
            status: "pass"
          }),
          decomposition_json: JSON.stringify({
            referenceVideoId: "ref_20260618_001",
            schemaVersion: "video_decomposition.v1",
            scene: "Phone reward app",
            subject: "Phone",
            action: "Tap",
            camera: "Close-up",
            lighting: "Bright",
            style: "UGC",
            quality: "HD",
            hook: "Earn rewards",
            missingFields: []
          })
        }] : []];
      }
      if (sql.includes("SELECT id FROM download_packages") && sql.includes("package_uid")) {
        return [[{ id: 1301 }]];
      }
      if (sql.includes("INSERT INTO scheduler_jobs")) {
        const jobUid = params[0];
        const existing = state.schedulerJobs.get(jobUid);
        state.schedulerJobs.set(jobUid, {
          id: existing?.id ?? state.nextSchedulerJobId++,
          jobUid,
          jobType: "task_retry",
          status: "pending",
          runUid: [...state.runs.entries()].find(([, id]) => id === params[1])?.[0] || "",
          taskUid: [...state.tasks.entries()].find(([, task]) => task.id === params[2])?.[0] || "",
          payload: JSON.parse(params[3]),
          priority: 0,
          attempts: 0,
          maxAttempts: 3,
          lockedBy: null
        });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    }
  };

  return {
    calls,
    state,
    async getConnection() {
      return conn;
    },
    async end() {
      calls.push({ sql: "END", params: [] });
    }
  };
}

export function context() {
  return {
    userProjectRoot: "C:/project/users/alice/current",
    sharedProjectRoot: "C:/project/current",
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false }
  };
}

test("mysql facts sync workflow runs, tasks, telemetry, audit, and idempotency through parameterized queries", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const batch = {
      batchId: "wzb_20260618000000_abcd",
      type: "pipeline",
      status: "running",
      estimate: {
        estimateId: "est_20260618_001",
        durationSec: 15,
        variantCount: 1,
        scriptCount: 1,
        outputRatio: "9:16",
        request: { targetChannel: "meta_ads" }
      },
      tasks: [
        {
          generationTaskId: "gen_20260618000000_abcd_001",
          scriptId: "scr_001",
          status: "waiting_upstream",
          attempts: 1,
          modelImage: "gpt-image-2",
          modelVideo: "dreamina-seedance-2-0-260128",
          seedanceTaskId: "mock_seedance_001",
          promptPath: "批处理记录/网赚管线/batches/x/prompts/a.txt",
          startedAt: "2026-06-18T00:00:00.000Z"
        },
        {
          generationTaskId: "gen_20260618000000_abcd_002",
          scriptId: "scr_002",
          status: "failed",
          attempts: 1,
          maxAttempts: 2,
          errorCode: "upstream_timeout",
          errorMessage: "timeout",
          promptPath: "批处理记录/网赚管线/batches/x/prompts/b.txt",
          startedAt: "2026-06-18T00:00:00.000Z",
          finishedAt: "2026-06-18T00:01:00.000Z"
        }
      ],
      scripts: [
        {
          scriptId: "scr_001",
          variantIndex: 1,
          segmentIndex: 1,
          durationSec: 15,
          hook: "Earn rewards",
          body: "Show product",
          cta: "Install",
          ending: "Try today",
          promptPath: "批处理记录/网赚管线/batches/x/prompts/a.txt"
        }
      ],
      outputs: [
        {
          outputId: "out_abcd_001",
          sourceType: "pipeline",
          batchId: "wzb_20260618000000_abcd",
          scriptId: "scr_001",
          generationTaskIds: ["gen_20260618000000_abcd_001"],
          durationSec: 15,
          kind: "segment_video",
          filePath: "批处理记录/网赚管线/batches/x/segments/out_abcd_001.mp4",
          qcStatus: "pass",
          downloadEligible: true,
          qcReportPath: "批处理记录/网赚管线/batches/x/qc/out_abcd_001.json"
        }
      ],
      stitchReports: [
        {
          outputId: "out_abcd_001",
          status: "succeeded",
          segmentOutputIds: ["out_abcd_001"],
          reportPath: "批处理记录/网赚管线/batches/x/stitch/out_abcd_001_stitch-report.json",
          tool: { provider: "mock" }
        }
      ],
      qcSummary: { total: 0, passed: 0, failed: 0 },
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:01:00.000Z"
    };

    const created = await syncBatchFacts(context(), { ...batch, status: "queued", tasks: batch.tasks.map((task) => ({ ...task, status: "pending", attempts: 0 })) }, "batch_created");
    assert.equal(created.skipped, false);

    const synced = await syncBatchFacts(context(), batch, "batch_write");
    assert.equal(synced.skipped, false);

    await recordMysqlTelemetryEvent(context(), {
      eventId: "evt_20260618000000_abcd",
      event: "generation_batch_started",
      role: "user",
      requestId: "req_1",
      occurredAt: "2026-06-18T00:02:00.000Z",
      payload: { batchId: batch.batchId, targetType: "batch" }
    }, {
      eventId: "evt_20260618000000_abcd",
      event: "generation_batch_started",
      role: "user",
      requestId: "req_1",
      occurredAt: "2026-06-18T00:02:00.000Z",
      payload: { batchId: batch.batchId, targetType: "batch" }
    });

    await recordIdempotencyFact(context(), "batches_start", "idem-key", "a".repeat(64), {
      type: "batch",
      response: { batchId: batch.batchId }
    });

    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO workflow_runs")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO generation_scripts")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO workflow_tasks")));
    assert.ok(pool.calls.some((call) => call.sql.includes("task_attempts")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO workflow_outputs")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO qc_reports")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO stitch_reports")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO scheduler_jobs")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO telemetry_events")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO audit_events")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO idempotency_keys")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT IGNORE INTO state_transition_rules")));
    assert.ok(pool.calls.some((call) => call.sql.includes("FROM state_transition_rules")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO state_transition_events")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO resource_locks")));
    assert.equal(pool.calls.some((call) => call.sql.includes("SELECT *")), false);

    const runInsert = pool.calls.filter((call) => call.sql.includes("INSERT INTO workflow_runs")).at(-1);
    assert.equal(runInsert.params[0], batch.batchId);
    assert.equal(runInsert.params[2], "running");

    const taskInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO workflow_tasks") && call.params[3] === "waiting_upstream");
    assert.equal(taskInsert.params[0], batch.tasks[0].generationTaskId);
    assert.equal(taskInsert.params[3], "waiting_upstream");
    assert.equal(JSON.parse(taskInsert.params[15]).scriptId, "scr_001");

    const activeLock = await findActiveResourceLock(context());
    assert.equal(activeLock.runId, batch.batchId);
    assert.equal(activeLock.runType, "pipeline");

    const stopped = await syncBatchFacts(context(), { ...batch, status: "stopped", stoppedAt: "2026-06-18T00:03:00.000Z" }, "user_stop");
    assert.equal(stopped.skipped, false);
    assert.ok(pool.calls.some((call) => call.sql.includes("UPDATE resource_locks")));
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql scheduler jobs can be claimed with skip locked and finished by a worker", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const batch = {
      batchId: "wzb_20260618000100_abcd",
      type: "pipeline",
      status: "queued",
      tasks: [
        {
          generationTaskId: "gen_20260618000100_abcd_001",
          scriptId: "scr_001",
          status: "pending",
          attempts: 0,
          maxAttempts: 2,
          promptPath: "批处理记录/网赚管线/batches/x/prompts/a.txt"
        }
      ],
      scripts: [],
      outputs: [],
      createdAt: "2026-06-18T00:01:00.000Z",
      updatedAt: "2026-06-18T00:01:00.000Z"
    };
    assert.equal((await syncBatchFacts(context(), batch, "batch_created")).skipped, false);
    assert.equal((await syncBatchFacts(context(), {
      ...batch,
      status: "running",
      tasks: [{
        ...batch.tasks[0],
        status: "failed",
        attempts: 1,
        errorCode: "upstream_timeout",
        nextAttemptAt: "2026-06-18T00:01:00.000Z"
      }]
    }, "batch_write")).skipped, false);

    const claimed = await claimSchedulerJob({ workerId: "worker_a", lockSeconds: 30 });

    assert.equal(claimed.jobType, "task_retry");
    assert.equal(claimed.jobUid, `job_retry_${batch.tasks[0].generationTaskId}`);
    assert.equal(claimed.payload.batchId, batch.batchId);
    assert.equal(claimed.taskUid, batch.tasks[0].generationTaskId);
    assert.ok(pool.calls.some((call) => call.sql.includes("FOR UPDATE SKIP LOCKED")));
    assert.equal(pool.state.schedulerJobs.get(claimed.jobUid).status, "running");
    assert.equal(pool.state.schedulerJobs.get(claimed.jobUid).attempts, 1);

    await completeSchedulerJob(claimed, { workerId: "worker_a" });
    assert.equal(pool.state.schedulerJobs.get(claimed.jobUid).status, "succeeded");

    pool.state.schedulerJobs.get(claimed.jobUid).status = "pending";
    const failedJob = await claimSchedulerJob({ workerId: "worker_a", lockSeconds: 30 });
    await failSchedulerJob(failedJob, new Error("boom"), { workerId: "worker_a", retryDelayMs: 60_000 });
    assert.equal(pool.state.schedulerJobs.get(failedJob.jobUid).status, "pending");
    assert.equal(pool.state.schedulerJobs.get(failedJob.jobUid).lastErrorMessage, "boom");
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql state machine rejects unknown transitions instead of auto-seeding them", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const batch = {
      batchId: "wzb_20260618000200_abcd",
      type: "pipeline",
      status: "queued",
      tasks: [],
      outputs: [],
      createdAt: "2026-06-18T00:02:00.000Z",
      updatedAt: "2026-06-18T00:02:00.000Z"
    };
    assert.equal((await syncBatchFacts(context(), batch, "batch_created")).skipped, false);

    await assert.rejects(
      syncBatchFacts(context(), { ...batch, status: "failed" }, "unknown_trigger"),
      /invalid_state_transition/
    );

    assert.equal(
      pool.state.stateTransitionRules.has("workflow_run|queued|failed|unknown_trigger"),
      false
    );
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql facts sync and load product template stores", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const draft = {
      displayName: "Cash Reward US EN",
      productName: "Lucky Cash",
      cta: "Install today",
      ending: "Claim your bonus today",
      currencySymbol: "$",
      language: "en-US",
      regions: ["US"],
      targetChannels: ["meta_ads"],
      defaultOutputRatio: "9:16",
      defaultDurationSec: 15,
      promiseLevel: "strong_conversion"
    };
    const store = {
      schemaVersion: "templates.v1",
      defaultTemplateId: "tpl_cash_reward_us_en_001",
      nextTemplateSeq: 2,
      templates: [
        {
          templateId: "tpl_cash_reward_us_en_001",
          versionId: "tplv_cash_reward_us_en_001_0001",
          versionNumber: 1,
          status: "active",
          isDefault: true,
          draft,
          createdBy: "alice",
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z"
        }
      ]
    };

    const synced = await syncTemplateStoreFacts(context(), store);
    assert.equal(synced.skipped, false);

    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO product_templates")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO product_template_versions")));
    assert.ok(pool.calls.some((call) => call.sql.includes("project_default_template_versions")));
    assert.equal(pool.calls.some((call) => call.sql.includes("SELECT *")), false);

    const versionInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO product_template_versions"));
    assert.equal(versionInsert.params[0], store.templates[0].versionId);
    assert.equal(versionInsert.params[2], 1);
    assert.equal(JSON.parse(versionInsert.params[15]).displayName, draft.displayName);

    pool.state.templateRows = [
      {
        template_uid: store.templates[0].templateId,
        display_name: draft.displayName,
        template_status: "active",
        template_created_at: "2026-06-18 00:00:00.000",
        template_updated_at: "2026-06-18 00:00:00.000",
        template_version_uid: store.templates[0].versionId,
        version_number: 1,
        version_status: "active",
        draft_json: JSON.stringify(draft),
        created_by_username: "alice",
        version_created_at: "2026-06-18 00:00:00.000",
        is_default: 1
      }
    ];

    const loaded = await loadTemplateStoreFromMysql(context());
    assert.equal(loaded.schemaVersion, "templates.v1");
    assert.equal(loaded.defaultTemplateId, store.defaultTemplateId);
    assert.equal(loaded.nextTemplateSeq, 2);
    assert.equal(loaded.templates[0].templateId, store.templates[0].templateId);
    assert.equal(loaded.templates[0].draft.cta, "Install today");
    assert.equal(loaded.templates[0].isDefault, true);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql facts sync and load channel rule stores", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const store = {
      schemaVersion: "channel-rules.v1",
      rules: [
        {
          ruleId: "rule_meta_ads_stable_v1",
          channel: "meta_ads",
          promiseLevel: "stable",
          version: "2026-06-17",
          ctaStrength: "medium",
          forbiddenTerms: ["guaranteed income"],
          requiredDisclaimers: ["Results vary by user"],
          fallbackUsed: false
        }
      ]
    };

    const synced = await syncChannelRuleStoreFacts(context(), store);
    assert.equal(synced.skipped, false);
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO channel_rules")));
    assert.equal(pool.calls.some((call) => call.sql.includes("SELECT *")), false);

    const ruleInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO channel_rules"));
    assert.equal(ruleInsert.params[1], "rule_meta_ads_stable_v1");
    assert.equal(ruleInsert.params[2], "meta_ads");
    assert.deepEqual(JSON.parse(ruleInsert.params[6]), ["guaranteed income"]);

    pool.state.channelRows = [
      {
        rule_uid: "rule_meta_ads_stable_v1",
        channel: "meta_ads",
        promise_level: "stable",
        rule_version: "2026-06-17",
        cta_strength: "medium",
        forbidden_terms_json: JSON.stringify(["guaranteed income"]),
        required_disclaimers_json: JSON.stringify(["Results vary by user"]),
        status: "active"
      }
    ];

    const loaded = await loadChannelRuleStoreFromMysql(context());
    assert.equal(loaded.schemaVersion, "channel-rules.v1");
    assert.equal(loaded.rules.length, 1);
    assert.deepEqual(loaded.rules[0], store.rules[0]);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql facts sync reference videos, decompositions, and estimates without storing raw confirmation tokens", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const ctx = context();
    const referenceVideo = {
      referenceVideoId: "ref_20260618_001",
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5,
      durationSec: 15,
      width: 720,
      height: 1280,
      ratio: "9:16",
      canExtractFrame: true,
      status: "pass",
      issues: [],
      storedPath: "批处理记录/网赚管线/reference-videos/ref_20260618_001/original.mp4",
      storageKey: "uploads/project/users/alice/reference/original.mp4",
      storageUrl: "https://cdn.example.com/uploads/project/users/alice/reference/original.mp4",
      videoCodec: "h264"
    };
    const decomposition = {
      referenceVideoId: referenceVideo.referenceVideoId,
      schemaVersion: "video_decomposition.v1",
      scene: "Phone reward app",
      subject: "Phone",
      action: "Tap",
      camera: "Close-up",
      lighting: "Bright",
      style: "UGC",
      quality: "HD",
      hook: "Earn rewards",
      missingFields: []
    };

    assert.equal((await syncReferenceVideoFact(ctx, referenceVideo)).skipped, false);
    assert.equal((await syncVideoDecompositionFact(ctx, decomposition)).skipped, false);

    const record = {
      estimate: {
        estimateId: "est_20260618_001",
        confirmationRequired: true,
        confirmationToken: "confirm_secret_should_not_be_stored",
        durationSec: 15,
        variantCount: 11
      },
      request: {
        templateId: "tpl_cash_reward_us_en_001",
        versionId: "tplv_cash_reward_us_en_001_0001",
        referenceVideoId: referenceVideo.referenceVideoId,
        targetChannel: "meta_ads"
      },
      estimateHash: "b".repeat(64),
      confirmation: {
        confirmationToken: "confirm_secret_should_not_be_stored",
        expiresAt: "2026-06-18T00:30:00.000Z"
      },
      templateSnapshot: {
        templateId: "tpl_cash_reward_us_en_001",
        versionId: "tplv_cash_reward_us_en_001_0001",
        versionNumber: 1,
        status: "active",
        isDefault: true,
        draft: {
          displayName: "Cash Reward US EN",
          productName: "Lucky Cash",
          cta: "Install today",
          ending: "Claim your bonus today",
          currencySymbol: "$",
          language: "en-US",
          regions: ["US"],
          targetChannels: ["meta_ads"],
          defaultOutputRatio: "9:16",
          defaultDurationSec: 15,
          promiseLevel: "strong_conversion"
        }
      },
      referenceVideo,
      decomposition,
      createdAt: "2026-06-18T00:00:00.000Z"
    };
    assert.equal((await syncEstimateFact(ctx, record, "confirm_secret_should_not_be_stored")).skipped, false);

    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO asset_files")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO reference_videos")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO video_decompositions")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO work_estimates")));
    assert.equal(pool.calls.some((call) => JSON.stringify(call.params).includes("confirm_secret_should_not_be_stored")), false);

    const loadedReference = await loadReferenceVideoProbeFromMysql(ctx, referenceVideo.referenceVideoId);
    assert.equal(loadedReference.referenceVideoId, referenceVideo.referenceVideoId);
    assert.equal(loadedReference.storedPath.includes("C:/"), false);
    assert.equal(loadedReference.storageKey, referenceVideo.storageKey);
    assert.equal(loadedReference.storageUrl, referenceVideo.storageUrl);

    const loadedDecomposition = await loadVideoDecompositionFromMysql(ctx, referenceVideo.referenceVideoId);
    assert.equal(loadedDecomposition.schemaVersion, "video_decomposition.v1");
    assert.equal(loadedDecomposition.scene, "Phone reward app");

    const loadedEstimate = await loadEstimateFromMysql(ctx, record.estimate.estimateId);
    assert.equal(loadedEstimate.estimate.estimateId, record.estimate.estimateId);
    assert.equal(loadedEstimate.templateSnapshot.versionId, record.templateSnapshot.versionId);
    assert.equal(loadedEstimate.referenceVideo.referenceVideoId, referenceVideo.referenceVideoId);
    assert.equal(loadedEstimate.confirmation.confirmationToken, undefined);
    assert.equal(loadedEstimate.confirmation.tokenHashAvailable, true);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});

test("mysql facts sync remix regions and download packages", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const remix = {
      remixId: "rmx_20260618000000_abcd",
      status: "preview_required",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:01:00.000Z",
      tasks: [
        {
          generationTaskId: "gen_abcd_001",
          status: "succeeded",
          attempts: 1,
          maxAttempts: 2,
          provider: "mock"
        }
      ],
      outputs: [
        {
          outputId: "out_abcd_101",
          sourceType: "remix",
          kind: "remix_video",
          filePath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/outputs/out_abcd_101.mp4",
          durationSec: 15,
          qcStatus: "manual_required",
          visualPreviewRequired: true,
          previewConfirmed: false,
          downloadEligible: false
        }
      ],
      regions: [
        {
          regionId: "reg_001",
          label: "watermark",
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
        }
      ]
    };

    assert.equal((await syncRemixFacts(context(), remix, "remix_write")).skipped, false);
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO workflow_runs")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO remix_regions")));

    const manifest = {
      packageId: "pkg_20260618000000_abcd",
      createdAt: "2026-06-18T00:05:00.000Z",
      filters: { remixIds: [remix.remixId] },
      items: [
        {
          sourceType: "remix",
          remixId: remix.remixId,
          outputId: "out_abcd_101",
          packagePath: "remix/rmx_20260618000000_abcd/outputs/out_abcd_101.mp4",
          diagnostic: false
        }
      ],
      missingFiles: []
    };
    assert.equal((await syncDownloadPackageFact(context(), manifest)).skipped, false);
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO download_packages")));
    assert.ok(pool.calls.some((call) => call.sql.includes("INSERT INTO download_package_items")));
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});
