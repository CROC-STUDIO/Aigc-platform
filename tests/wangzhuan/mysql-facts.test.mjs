import assert from "node:assert/strict";
import test from "node:test";

import {
  claimSchedulerJob,
  closeWangzhuanFactsPool,
  completeSchedulerJob,
  failSchedulerJob,
  findActiveResourceLock,
  loadActivePipelineRunFromMysql,
  loadBatchDetailFromMysql,
  loadActiveRemixFromMysql,
  loadChannelRuleStoreFromMysql,
  loadEstimateFromMysql,
  loadGalleryItemsFromMysql,
  loadIdempotencyFactFromMysql,
  loadReferenceVideoProbeFromMysql,
  loadRemixDetailFromMysql,
  loadRemixSourceFromMysql,
  loadTemplateStoreFromMysql,
  loadVideoDecompositionFromMysql,
  recordIdempotencyFact,
  recordMysqlTelemetryEvent,
  setWangzhuanFactsPoolForTest,
  syncDownloadPackageFact,
  syncEstimateFact,
  syncRemixFacts,
  syncRemixSourceFact,
  syncReferenceVideoFact,
  syncChannelRuleStoreFacts,
  syncBatchFacts,
  syncTemplateStoreFacts,
  syncVideoDecompositionFact
} from "../../server/wangzhuan/mysql-facts.mjs";

import { context, fakePool } from "./mysql-facts-fixture.mjs";
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
          modelVideo: "doubao-seedance-2-0-260128",
          seedanceTaskId: "mock_seedance_001",
          promptPath: "批处理记录/网赚管线/batches/x/prompts/a.txt",
          promptStorageKey: "uploads/project/users/alice/batches/x/prompts/a.txt",
          promptStorageUrl: "https://cdn.example.com/prompts/a.txt",
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
          storageKey: "uploads/project/users/alice/batches/x/segments/out_abcd_001.mp4",
          storageUrl: "https://cdn.example.com/segments/out_abcd_001.mp4",
          qcStatus: "pass",
          downloadEligible: true,
          qcReportPath: "批处理记录/网赚管线/batches/x/qc/out_abcd_001.json",
          qcReportStorageKey: "uploads/project/users/alice/batches/x/qc/out_abcd_001.json",
          qcReportStorageUrl: "https://cdn.example.com/qc/out_abcd_001.json"
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
    const idempotent = await loadIdempotencyFactFromMysql(context(), "batches_start", "idem-key", "a".repeat(64));
    assert.equal(idempotent.batchId, batch.batchId);

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

    const taskInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO workflow_tasks") && call.params[4] === "waiting_upstream");
    assert.equal(taskInsert.params[0], batch.tasks[0].generationTaskId);
    assert.equal(taskInsert.params[4], "waiting_upstream");
    assert.equal(JSON.parse(taskInsert.params[19]).scriptId, "scr_001");
    assert.equal(JSON.parse(taskInsert.params[19]).promptStorageKey, batch.tasks[0].promptStorageKey);
    assert.equal(JSON.parse(taskInsert.params[20]).outputStorageKey, batch.outputs[0].storageKey);
    assert.equal(pool.state.assets.get(`asset_prompt_${batch.tasks[0].generationTaskId}`).storageKey, batch.tasks[0].promptStorageKey);
    assert.equal(pool.state.assets.get(`asset_${batch.outputs[0].outputId}`).storageKey, batch.outputs[0].storageKey);
    assert.equal(pool.state.assets.get(`asset_qc_${batch.outputs[0].outputId}`).storageKey, batch.outputs[0].qcReportStorageKey);

    const activeLock = await findActiveResourceLock(context());
    assert.equal(activeLock.runId, batch.batchId);
    assert.equal(activeLock.runType, "pipeline");
    const activePipeline = await loadActivePipelineRunFromMysql(context());
    assert.equal(activePipeline.batchId, batch.batchId);
    assert.equal(activePipeline.status, "running");
    assert.ok(pool.calls.some((call) => call.sql.includes("run_type = 'pipeline'")));

    const detail = await loadBatchDetailFromMysql(context(), batch.batchId);
    assert.equal(detail.batch.batchId, batch.batchId);
    assert.equal(detail.batch.status, "running");
    assert.equal(detail.batch.tasks.length, 2);
    assert.equal(detail.batch.tasks[0].generationTaskId, batch.tasks[0].generationTaskId);
    assert.equal(detail.batch.tasks[0].promptStorageKey, batch.tasks[0].promptStorageKey);
    assert.equal(detail.batch.outputs.length, 1);
    assert.equal(detail.batch.outputs[0].outputId, batch.outputs[0].outputId);
    assert.equal(detail.batch.outputs[0].storageKey, batch.outputs[0].storageKey);
    assert.equal(detail.batch.outputs[0].qcReportStorageUrl, batch.outputs[0].qcReportStorageUrl);
    assert.equal(detail.downloadSummary.packageReady, true);
    assert.ok(detail.events.some((event) => event.entityUid === batch.batchId && event.toStatus === "running"));

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

test("mysql facts drive remix source, active detail, and gallery from stored S3 metadata", async () => {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  try {
    const ctx = context();
    const source = {
      sourceId: "rsrc_20260618_001",
      fileName: "competitor.mp4",
      mimeType: "video/mp4",
      sizeBytes: 12345,
      durationSec: 15,
      width: 720,
      height: 1280,
      ratio: "9:16",
      kind: "video",
      status: "pass",
      issues: [],
      storedPath: "批处理记录/网赚管线/remix-sources/rsrc_20260618_001/original.mp4",
      storageKey: "uploads/project/users/alice/remix-sources/rsrc_20260618_001/original.mp4",
      storageUrl: "https://cdn.example.com/remix/source.mp4",
      userId: "alice",
      createdAt: "2026-06-18T00:00:00.000Z"
    };

    assert.equal((await syncRemixSourceFact(ctx, source)).skipped, false);
    const loadedSource = await loadRemixSourceFromMysql(ctx, source.sourceId);
    assert.equal(loadedSource.sourceId, source.sourceId);
    assert.equal(loadedSource.storageKey, source.storageKey);
    assert.equal(loadedSource.storageUrl, source.storageUrl);

    const remix = {
      remixId: "rmx_20260618000000_abcd",
      type: "remix",
      status: "preview_required",
      userId: "alice",
      sourceId: source.sourceId,
      source,
      request: {
        sourceId: source.sourceId,
        operationType: "watermark_cover",
        targetChannel: "tiktok_ads",
        regions: [{
          regionId: "reg_001",
          type: "bbox",
          label: "watermark",
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
        }]
      },
      operationType: "watermark_cover",
      targetChannel: "tiktok_ads",
      regions: [{
        regionId: "reg_001",
        type: "bbox",
        label: "watermark",
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
      }],
      templateSnapshot: {
        templateId: "tpl_cash_reward_us_en_001",
        versionId: "tplv_cash_reward_us_en_001_0001",
        versionNumber: 1,
        status: "active",
        draft: { productName: "Lucky Cash", targetChannels: ["tiktok_ads"] }
      },
      capability: { provider: "video_aigc", status: "supported" },
      providerJob: { jobId: "job_remix_001", status: "succeeded", provider: "video_aigc" },
      tasks: [{
        generationTaskId: "gen_abcd_001",
        status: "qc",
        modelImage: "not_required",
        modelVideo: "video_aigc",
        providerJobId: "job_remix_001",
        seedanceTaskId: "job_remix_001",
        promptPath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/prompts/gen_abcd_001_remix.txt",
        attempts: 1
      }],
      outputs: [{
        outputId: "out_abcd_001",
        sourceType: "remix",
        remixId: "rmx_20260618000000_abcd",
        generationTaskIds: ["gen_abcd_001"],
        durationSec: 15,
        kind: "remix_video",
        filePath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/outputs/out_abcd_001.mp4",
        storageKey: "uploads/project/users/alice/remix/rmx_20260618000000_abcd/out_abcd_001.mp4",
        storageUrl: "https://cdn.example.com/remix/out.mp4",
        previewUrl: "https://cdn.example.com/remix/out.mp4",
        promptPath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/prompts/gen_abcd_001_remix.txt",
        qcStatus: "manual_required",
        visualPreviewRequired: true,
        previewConfirmed: false,
        downloadEligible: false,
        qcReportPath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/qc/out_abcd_001.json"
      }, {
        outputId: "out_abcd_002",
        sourceType: "remix",
        remixId: "rmx_20260618000000_abcd",
        generationTaskIds: ["gen_abcd_001"],
        durationSec: 15,
        kind: "remix_video",
        filePath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/outputs/out_abcd_002.mp4",
        storageKey: "uploads/project/users/alice/remix/rmx_20260618000000_abcd/out_abcd_002.mp4",
        storageUrl: "https://cdn.example.com/remix/out-2.mp4",
        previewUrl: "https://cdn.example.com/remix/out-2.mp4",
        promptPath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/prompts/gen_abcd_001_remix.txt",
        qcStatus: "pass",
        visualPreviewRequired: false,
        previewConfirmed: true,
        downloadEligible: true,
        qcReportPath: "批处理记录/网赚管线/remix/rmx_20260618000000_abcd/qc/out_abcd_002.json"
      }],
      qcSummary: { total: 2, passed: 1, failed: 1 },
      createdAt: "2026-06-18T00:01:00.000Z",
      updatedAt: "2026-06-18T00:02:00.000Z"
    };

    assert.equal((await syncRemixFacts(ctx, remix, "remix_write")).skipped, false);

    const detail = await loadRemixDetailFromMysql(ctx, remix.remixId);
    assert.equal(detail.remix.remixId, remix.remixId);
    assert.equal(detail.remix.source.storageUrl, source.storageUrl);
    assert.equal(detail.remix.providerJob.jobId, "job_remix_001");
    assert.equal(detail.remix.outputs[0].storageUrl, "https://cdn.example.com/remix/out.mp4");
    assert.equal(detail.downloadSummary.packageReady, true);

    const active = await loadActiveRemixFromMysql(ctx);
    assert.equal(active.remix.remixId, remix.remixId);

    const gallery = await loadGalleryItemsFromMysql(ctx, { remixId: remix.remixId, page: "1", pageSize: "1" });
    assert.equal(gallery.items.length, 1);
    assert.equal(gallery.items[0].previewUrl, "https://cdn.example.com/remix/out-2.mp4");
    assert.equal(gallery.items[0].remixStatus, "preview_required");
    assert.equal(gallery.counts.total, 2);
    assert.equal(gallery.counts.downloadEligible, 1);
    assert.equal(gallery.counts.byQcStatus.pass, 1);
    assert.deepEqual(gallery.pagination, {
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      hasPrev: false,
      hasNext: true
    });
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
  }
});
