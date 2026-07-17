import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";
import * as pipeline from "../../server/wangzhuan/pipeline.mjs";
import { createSeedanceProviderClient } from "../../server/wangzhuan/seedance-provider.mjs";

const pipelineSource = await readFile(
  new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url),
  "utf8"
);
const routerSource = await readFile(
  new URL("../../server/wangzhuan/router.mjs", import.meta.url),
  "utf8"
);
const mysqlFactsSource = await readFile(
  new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url),
  "utf8"
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `${startMarker} is missing`);
  assert.ok(end > start, `${endMarker} is missing after ${startMarker}`);
  return source.slice(start, end);
}

test("each Seedance submit result is persisted before the batch claim is released", () => {
  const body = sourceBetween(
    pipelineSource,
    "export async function submitPendingGenerationTasks",
    "export async function retryFailedGenerationTask"
  );

  assert.match(body, /persistSeedanceSubmissionResult\(/);
  assert.ok(body.indexOf("submitTaskToSeedance") < body.indexOf("persistSeedanceSubmissionResult"));
  assert.ok(body.indexOf("persistSeedanceSubmissionResult") < body.indexOf("releasePendingSeedanceTaskClaims"));
});

test("payload construction failures become persisted failed tasks instead of rejecting the whole submit batch", () => {
  const body = sourceBetween(
    pipelineSource,
    "async function submitTaskToSeedance",
    "function taskSegmentKey"
  );
  const tryIndex = body.indexOf("try {");
  const payloadIndex = body.indexOf("buildSeedanceTaskPayload");

  assert.ok(tryIndex >= 0);
  assert.ok(payloadIndex > tryIndex, "payload construction must run inside the per-task failure boundary");
});

test("plan confirmation idempotency owner covers the paid Seedance submit", () => {
  const body = sourceBetween(
    pipelineSource,
    "export async function confirmBatchPlan",
    "export async function confirmBatchAssets"
  );
  assert.match(body, /runIdempotentOperation\(/);
  assert.match(body, /confirmBatchPlanOnce\(/);
  assert.match(body, /submitPendingGenerationTasks\(/);
  assert.match(body, /replayResponse\s*:/);
  assert.ok(body.indexOf("runIdempotentOperation") < body.indexOf("submitPendingGenerationTasks"));
});

test("confirm route does not submit again outside the idempotent confirmation operation", () => {
  const routeBody = sourceBetween(
    routerSource,
    'if (batch && req.method === "POST" && batch.action === "confirm-plan")',
    'if (batch && req.method === "POST" && batch.action === "confirm-assets")'
  );
  assert.doesNotMatch(routeBody, /submitPendingGenerationTasks\(/);
});

test("confirmation telemetry is best effort after durable confirmation", () => {
  const confirmOnceBody = sourceBetween(
    pipelineSource,
    "async function confirmBatchPlanOnce",
    "export async function confirmBatchPlan"
  );
  const confirmBody = sourceBetween(
    pipelineSource,
    "export async function confirmBatchPlan",
    "export async function confirmBatchAssets"
  );

  assert.doesNotMatch(confirmOnceBody, /recordTelemetryEvent\(/);
  assert.match(confirmBody, /recordTelemetryEvent\([\s\S]*\.catch\(/);
});

test("a durable prior confirmation can resume submission after an interrupted owner", () => {
  const confirmOnceBody = sourceBetween(
    pipelineSource,
    "async function confirmBatchPlanOnce",
    "export async function confirmBatchPlan"
  );
  const resumeCheck = confirmOnceBody.indexOf("previewConfirmedAt");
  const invalidState = confirmOnceBody.indexOf('batch.status !== "preview_required"');

  assert.ok(resumeCheck >= 0, "confirmed batches need an explicit resume path");
  assert.ok(resumeCheck < invalidState, "resume must be checked before rejecting the non-preview state");
});

test("confirmed plan recovery only requeues local asset review failures without an upstream identity", () => {
  assert.equal(typeof pipeline.recoverConfirmedPlanPreSubmitFailures, "function");
  const protectedTasks = [
    {
      generationTaskId: "gen_test_002",
      status: "failed",
      errorCode: "asset_review_pending",
      seedanceTaskId: "aigc_existing",
      attempts: 0,
      maxAttempts: 2
    },
    {
      generationTaskId: "gen_test_003",
      status: "failed",
      errorCode: "asset_review_pending",
      providerJobId: "aigc_provider_existing",
      attempts: 0,
      maxAttempts: 2
    },
    {
      generationTaskId: "gen_test_004",
      status: "failed",
      errorCode: "submission_unknown",
      attempts: 0,
      maxAttempts: 2
    },
    {
      generationTaskId: "gen_test_005",
      status: "failed",
      errorCode: "upstream_failed",
      attempts: 0,
      maxAttempts: 2
    }
  ];

  for (const status of ["partial_failed", "failed"]) {
    const eligible = {
      generationTaskId: "gen_test_001",
      status: "failed",
      errorCode: "asset_review_pending",
      errorMessage: "素材审核状态仍在本地等待",
      finishedAt: "2026-07-17T05:50:00.000Z",
      attempts: 1,
      maxAttempts: 2
    };
    const exhaustedLocalFailure = {
      generationTaskId: "gen_test_006",
      status: "failed",
      errorCode: "asset_review_pending",
      errorMessage: "historical local preflight attempts were counted",
      attempts: 4,
      maxAttempts: 2
    };
    const source = {
      batchId: "wzb_20260717000000_abcd",
      status,
      previewType: "seedance_plan",
      previewConfirmedAt: "2026-07-17T05:49:00.000Z",
      tasks: [eligible, exhaustedLocalFailure, ...protectedTasks]
    };
    const recovered = pipeline.recoverConfirmedPlanPreSubmitFailures(source);

    assert.deepEqual(recovered.recoveredTaskIds, ["gen_test_001", "gen_test_006"]);
    assert.equal(recovered.batch.status, status === "failed" ? "running" : "partial_failed");
    assert.equal(recovered.batch.tasks[0].status, "pending");
    assert.equal(recovered.batch.tasks[0].attempts, 1);
    assert.equal(recovered.batch.tasks[0].errorCode, undefined);
    assert.equal(recovered.batch.tasks[0].errorMessage, undefined);
    assert.equal(recovered.batch.tasks[0].finishedAt, undefined);
    assert.equal(recovered.batch.tasks[1].status, "pending");
    assert.equal(recovered.batch.tasks[1].attempts, 1);
    assert.equal(recovered.batch.tasks[1].errorCode, undefined);
    assert.deepEqual(recovered.batch.tasks.slice(2), protectedTasks);
  }
});

test("confirming an already confirmed batch persists local recovery before Seedance submission", async (t) => {
  t.mock.method(console, "warn", () => {});
  const root = await mkdtemp(join(tmpdir(), "wz-confirm-resume-"));
  const promptPath = "prompts/gen_test_001_seedance.txt";
  await mkdir(join(root, "prompts"), { recursive: true });
  await writeFile(join(root, promptPath), "Create a short vertical product scene.", "utf8");

  const eligibleTask = {
    generationTaskId: "gen_test_001",
    scriptId: "scr_test_001",
    planId: "plan_test_001",
    status: "failed",
    errorCode: "asset_review_pending",
    errorMessage: "local asset review was not ready",
    attempts: 2,
    maxAttempts: 2,
    durationSec: 8,
    promptPath,
    modelImage: "gpt-image-2",
    modelVideo: "doubao-seedance-2-0-260128"
  };
  const protectedTask = {
    generationTaskId: "gen_test_002",
    scriptId: "scr_test_002",
    planId: "plan_test_002",
    status: "failed",
    errorCode: "submission_unknown",
    attempts: 1,
    maxAttempts: 2,
    modelImage: "gpt-image-2",
    modelVideo: "doubao-seedance-2-0-260128"
  };
  let batch = {
    batchId: "wzb_20260717000000_abcd",
    userId: "admin",
    status: "partial_failed",
    previewType: "seedance_plan",
    previewConfirmedAt: "2026-07-17T05:49:00.000Z",
    plans: [
      { planId: "plan_test_001", status: "confirmed" },
      { planId: "plan_test_002", status: "confirmed" }
    ],
    scripts: [
      { scriptId: "scr_test_001", promptPath, branchId: "branch_1" },
      { scriptId: "scr_test_002" }
    ],
    tasks: [{ ...eligibleTask, branchId: "branch_1" }, protectedTask],
    branchDrafts: [{
      branchId: "branch_1",
      assetFileNames: { productScreenshot_2: "shot-2.png" },
      assetStoredPaths: { productScreenshot_2: "product-assets/branch_1/productScreenshot_2/shot-2.png" },
      assetUrls: { productScreenshot_2: "https://assets.test/shot-2.png" },
      assetReviews: {}
    }],
    estimate: { requestedConcurrency: 1 },
    request: { requestedConcurrency: 1 },
    templateSnapshot: { draft: { defaultOutputRatio: "9:16" } }
  };
  const writes = [];
  const providerCalls = [];
  const reviewedKeys = [];
  const context = {
    userId: "admin",
    user: { username: "admin", role: "admin", isAdmin: true },
    userProjectRoot: root,
    sharedProjectRoot: root,
    currentProjectRoot: () => root,
    currentBaseProjectRoot: () => root,
    readBatchForTest: async () => batch,
    writeBatchForTest: async (next, triggerName) => {
      batch = next;
      writes.push({ triggerName, batch: structuredClone(next) });
      return next;
    },
    reviewProductAsset: async (asset) => {
      reviewedKeys.push(asset.assetKey);
      return { assetId: `asset_${asset.assetKey}`, status: "approved" };
    },
    seedanceProviderClient: {
      provider: "seedance-test",
      model: "doubao-seedance-2-0-260128",
      config: {},
      async createTask(payload, metadata) {
        providerCalls.push({
          metadata,
          content: payload.content,
          taskStatusAtSubmit: batch.tasks.find((task) => task.generationTaskId === metadata.generationTaskId)?.status
        });
        return { taskId: "aigc_test_001" };
      }
    }
  };

  try {
    const result = await pipeline.confirmBatchPlan(context, batch.batchId, {
      idempotencyKey: "confirm-resume-local-asset-review",
      confirmedPlanIds: ["plan_test_001", "plan_test_002"]
    });

    assert.equal(writes[0].triggerName, "scheduler_retry");
    assert.equal(writes[0].batch.tasks[0].status, "pending");
    assert.deepEqual(writes[0].batch.tasks[1], protectedTask);
    assert.deepEqual(reviewedKeys, ["productScreenshot_2"]);
    assert.equal(writes[0].batch.branchDrafts[0].assetReviews.productScreenshot_2.assetId, "asset_productScreenshot_2");
    assert.deepEqual(providerCalls, [{
      metadata: {
        batchId: batch.batchId,
        generationTaskId: "gen_test_001",
        scriptId: "scr_test_001",
        branchId: "branch_1",
        branchLabel: ""
      },
      content: [{
        type: "image_asset",
        asset_id: "asset_productScreenshot_2",
        asset_role: "reference",
        metadata: { slot_key: "product_screenshot", slot_index: 3 },
        stored_path: "product-assets/branch_1/productScreenshot_2/shot-2.png"
      }],
      taskStatusAtSubmit: "pending"
    }]);
    assert.equal(result.submittedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local asset review preflight failure preserves attempts without calling Seedance", async () => {
  assert.equal(typeof pipeline.__pipelineTestHooks?.submitTaskToSeedance, "function");
  const root = await mkdtemp(join(tmpdir(), "wz-local-preflight-"));
  const promptPath = "prompts/gen_test_001_seedance.txt";
  await mkdir(join(root, "prompts"), { recursive: true });
  await writeFile(join(root, promptPath), "Create a short vertical product scene.", "utf8");
  const task = {
    generationTaskId: "gen_test_001",
    scriptId: "scr_test_001",
    branchId: "branch_1",
    status: "pending",
    attempts: 1,
    maxAttempts: 2,
    durationSec: 8,
    promptPath
  };
  const batch = {
    batchId: "wzb_20260717000000_abcd",
    branchDrafts: [{
      branchId: "branch_1",
      assetFileNames: { productIcon: "icon.png" },
      assetUrls: { productIcon: "/assets/icon.png" },
      assetReviews: { productIcon: { status: "pending" } }
    }],
    scripts: [{ scriptId: "scr_test_001", branchId: "branch_1", promptPath }],
    tasks: [task],
    templateSnapshot: { draft: { defaultOutputRatio: "9:16" } }
  };
  let providerCalls = 0;
  const provider = {
    provider: "seedance-test",
    model: "doubao-seedance-2-0-260128",
    config: {},
    async createTask() {
      providerCalls += 1;
      return { taskId: "must_not_be_created" };
    }
  };

  try {
    const result = await pipeline.__pipelineTestHooks.submitTaskToSeedance(
      { userProjectRoot: root },
      batch,
      task,
      provider,
      "2026-07-17T05:50:00.000Z",
      "test-lease"
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "asset_review_pending");
    assert.equal(result.attempts, 1);
    assert.equal(providerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local asset review failures are excluded from both automatic retry scheduling paths", () => {
  assert.equal(typeof mysqlFacts.isAutomaticSeedanceRetryEligible, "function");
  assert.equal(mysqlFacts.isAutomaticSeedanceRetryEligible({ errorCode: "asset_review_pending" }), false);
  assert.equal(mysqlFacts.isAutomaticSeedanceRetryEligible({ errorCode: "submission_unknown" }), false);
  assert.equal(mysqlFacts.isAutomaticSeedanceRetryEligible({ errorCode: "upstream_failed" }), true);

  const syncScheduler = sourceBetween(
    mysqlFactsSource,
    "async function syncSchedulerJobs",
    "function shouldScheduleUpstreamPoll"
  );
  const persistSubmission = sourceBetween(
    mysqlFactsSource,
    "export async function persistSeedanceSubmissionResult",
    "export async function releasePendingSeedanceTaskClaims"
  );
  assert.match(syncScheduler, /isAutomaticSeedanceRetryEligible\(task\)/);
  assert.match(persistSubmission, /isAutomaticSeedanceRetryEligible\(task\)/);
});

test("Seedance submit transport failures are ambiguous and must not be auto-retried", async () => {
  const provider = createSeedanceProviderClient({
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://gateway.invalid/api/v1",
          apiKey: "test-key",
          timeoutMs: 50
        }
      }
    },
    fetch: async () => {
      throw new TypeError("socket closed");
    }
  });

  await assert.rejects(
    provider.createTask({ model: "seedance", prompt: "test", duration: 4 }),
    (error) => error?.code === "submission_unknown"
  );
});

test("Seedance submit 5xx and unreadable success responses are ambiguous", async () => {
  const makeProvider = (fetch) => createSeedanceProviderClient({
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://gateway.invalid/api/v1",
          apiKey: "test-key"
        }
      }
    },
    fetch
  });
  const serverFailure = makeProvider(async () => new Response(
    JSON.stringify({ error: "temporary" }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  ));
  const invalidSuccess = makeProvider(async () => new Response("not-json", { status: 200 }));
  const unreadableSuccess = makeProvider(async () => ({
    ok: true,
    status: 200,
    async text() {
      throw new TypeError("response stream closed");
    }
  }));

  for (const provider of [serverFailure, invalidSuccess, unreadableSuccess]) {
    await assert.rejects(
      provider.createTask({ model: "seedance", prompt: "test", duration: 4 }),
      (error) => error?.code === "submission_unknown"
    );
  }
});

test("a deterministic Seedance submit 4xx remains retryable upstream failure", async () => {
  const provider = createSeedanceProviderClient({
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://gateway.invalid/api/v1",
          apiKey: "test-key"
        }
      }
    },
    fetch: async () => new Response(
      JSON.stringify({ code: "invalid_request" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  });

  await assert.rejects(
    provider.createTask({ model: "seedance", prompt: "test", duration: 4 }),
    (error) => error?.code === "upstream_failed"
  );
});

test("generic batch sync preserves the paid-submit journal while a task lease is held", () => {
  const body = sourceBetween(
    mysqlFactsSource,
    "export async function syncBatchFacts",
    "export async function recordMysqlTelemetryEvent"
  );
  const upsert = sourceBetween(
    body,
    "INSERT INTO workflow_tasks",
    "const [nextTaskRows]"
  );

  for (const column of [
    "status",
    "seedance_task_id",
    "provider_job_id",
    "attempts",
    "request_summary_json",
    "response_summary_json"
  ]) {
    assert.match(
      upsert,
      new RegExp(`${column}\\s*=\\s*IF\\(workflow_tasks\\.lease_owner IS NULL`, "i"),
      `${column} must be fenced by the task lease`
    );
  }
});

test("marking a Seedance request sent rechecks that the lease is still live in the update CAS", () => {
  const body = sourceBetween(
    mysqlFactsSource,
    "export async function markSeedanceTaskSubmissionSent",
    "export async function persistSeedanceSubmissionResult"
  );
  const update = body.slice(body.indexOf("UPDATE workflow_tasks"));

  assert.match(update, /AND lease_owner = \?/);
  assert.match(update, /AND lease_expires_at > UTC_TIMESTAMP\(3\)/);
});

test("batch synchronization closes the current provider attempt when a task finishes", () => {
  const body = sourceBetween(
    mysqlFactsSource,
    "export async function syncBatchFacts",
    "export async function recordMysqlTelemetryEvent"
  );

  assert.match(body, /UPDATE task_attempts/);
  assert.match(body, /status = \?/);
  assert.match(body, /finished_at = COALESCE\(finished_at, \?\)/);
  assert.match(body, /attempt_no = \?/);
  assert.match(body, /status = 'running'/);
});

test("each automatic retry attempt gets a distinct scheduler job id", () => {
  const syncScheduler = sourceBetween(
    mysqlFactsSource,
    "async function syncSchedulerJobs",
    "function shouldScheduleUpstreamPoll"
  );
  const persistSubmission = sourceBetween(
    mysqlFactsSource,
    "export async function persistSeedanceSubmissionResult",
    "export async function releasePendingSeedanceTaskClaims"
  );

  assert.match(syncScheduler, /retrySchedulerJobUid\(uidValue,\s*Number\(task\.attempts/);
  assert.match(persistSubmission, /retrySchedulerJobUid\(taskUidValue,\s*attemptNo/);
});

test("retry telemetry cannot turn a successfully submitted retry into a failed scheduler job", () => {
  const retryBody = sourceBetween(
    pipelineSource,
    "export async function retryFailedGenerationTask",
    "function currentPlanIds"
  );
  const telemetry = retryBody.slice(retryBody.indexOf("generation_task_retried"));

  assert.match(telemetry, /\.catch\(/);
});

test("Seedance claim records sent state before invoking the paid provider", () => {
  const submitTaskBody = sourceBetween(
    pipelineSource,
    "async function submitTaskToSeedance",
    "function taskSegmentKey"
  );
  assert.match(submitTaskBody, /markSeedanceTaskSubmissionSent\(/);
  assert.ok(submitTaskBody.indexOf("markSeedanceTaskSubmissionSent") < submitTaskBody.indexOf("provider.createTask"));
  assert.match(submitTaskBody, /errorCode: "submission_unknown"/);
});

test("submission_unknown is excluded from automatic task retry scheduling", async () => {
  const mysqlSource = await readFile(
    new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url),
    "utf8"
  );
  const schedulerBody = sourceBetween(
    mysqlSource,
    "async function syncSchedulerJobs",
    "function shouldScheduleUpstreamPoll"
  );
  const eligibilityBody = sourceBetween(
    mysqlSource,
    "export function isAutomaticSeedanceRetryEligible",
    "async function syncSchedulerJobs"
  );
  assert.match(eligibilityBody, /submission_unknown/);
  assert.match(schedulerBody, /isAutomaticSeedanceRetryEligible\(task\)/);
});
