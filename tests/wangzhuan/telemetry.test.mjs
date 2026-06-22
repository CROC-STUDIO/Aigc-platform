import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { buildDownloadPackage } from "../../server/wangzhuan/package.mjs";
import { closeWangzhuanFactsPool, setWangzhuanFactsPoolForTest, syncTemplateStoreFacts } from "../../server/wangzhuan/mysql-facts.mjs";
import { stopBatch, submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { runBatchQc } from "../../server/wangzhuan/qc.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import {
  confirmRemixPreview,
  estimateRemix,
  startRemix,
  uploadRemixSource
} from "../../server/wangzhuan/remix.mjs";
import { stitchBatchSegments } from "../../server/wangzhuan/stitch.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { adminTemplateAction, saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { recordTelemetryEvent } from "../../server/wangzhuan/telemetry.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";

const baseDraft = {
  displayName: "Cash Reward US EN",
  productName: "Lucky Cash",
  cta: "Download now",
  ending: "Claim your bonus today",
  currencySymbol: "$",
  language: "en-US",
  regions: ["US"],
  targetChannels: ["meta_ads"],
  defaultOutputRatio: "9:16",
  defaultDurationSec: 30,
  promiseLevel: "strong_conversion"
};

function context(root, userId = "alice", overrides = {}) {
  return {
    userProjectRoot: join(root, userId, "project"),
    sharedProjectRoot: join(root, "shared"),
    userId,
    user: { userId, username: userId, role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
    capabilities: {
      stitcher: { status: "available", provider: "mock_stitch", version: "test" },
      remix: {
        provider: "function_k",
        status: "supported",
        supportedOperations: ["watermark_cover", "logo_icon_cover_or_replace", "text_cta_ending_replace"]
      }
    },
    ...overrides
  };
}

function adminContext(root) {
  return context(root, "admin", {
    user: { userId: "admin", username: "admin", role: "admin", isAdmin: true }
  });
}

function referenceUpload() {
  return {
    fileName: "reference.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("reference video").toString("base64")}`,
    durationSec: 30,
    width: 720,
    height: 1280,
    canExtractFrame: true
  };
}

function sourceUpload() {
  return {
    fileName: "competitor.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("source material").toString("base64")}`,
    durationSec: 15,
    width: 720,
    height: 1280
  };
}

function decomposition() {
  return {
    scene: "Phone app reward screen",
    subject: "Hand holding phone",
    action: "User taps a reward task",
    camera: "Close-up vertical shot",
    lighting: "Bright indoor lighting",
    style: "Clean app demo",
    quality: "HD",
    hook: "Earn rewards with daily tasks",
    rewardFeedback: "Coins appear after task completion",
    cta: "Install today"
  };
}

function region() {
  return {
    regionId: "reg_watermark",
    type: "bbox",
    label: "watermark",
    bbox: { x: 0.62, y: 0.84, width: 0.24, height: 0.08 }
  };
}

async function readJsonl(target) {
  const text = await readFile(target, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertNoSensitiveTelemetryText(text, root) {
  assert.equal(text.includes(root), false);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /Bearer\s+/i);
  assert.doesNotMatch(text, /sk-test/i);
  assert.doesNotMatch(text, /remoteUrl|remote_url/);
  assert.doesNotMatch(text, /write a secret prompt|Script body:|Product:/);
}

async function pipelineFixture(ctx, template, referenceVideoId, durationSec = 30, variantCount = 1, suffix = "main") {
  const estimated = await estimateBatch(ctx, {
    templateId: template.templateId,
    versionId: template.versionId,
    referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: template.draft.promiseLevel,
    durationSec,
    variantCount,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  return startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_s8_${suffix}`,
    estimateId: estimated.estimate.estimateId,
    confirmationToken: estimated.estimate.confirmationToken
  });
}

test("telemetry writer produces common envelopes for telemetry and audit with redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s8-redact-"));
  try {
    const ctx = context(root);
    const emitted = await recordTelemetryEvent(
      ctx,
      "generation_batch_started",
      {
        batchId: "wzb_20260617000000_abcd",
        estimateId: "est_20260617_001",
        promptText: "write a secret prompt",
        remoteUrl: "https://signed.example/video.mp4?token=abc",
        remote_url: "https://signed.example/legacy.mp4",
        apiKey: "sk-test",
        authorization: "Bearer hidden",
        localPath: join(root, "alice", "project", "secret.txt"),
        confirmationToken: "confirm_keep_for_audit",
        nested: {
          bearerToken: "Bearer nested",
          relativePath: "批处理记录/网赚管线/batches/example/batch.json"
        }
      },
      { requestId: "req_20260617000000_abcd", audit: true }
    );

    assert.match(emitted.telemetry.eventId, /^evt_\d{14}_[a-f0-9]{4}$/);
    assert.equal(emitted.telemetry.event, "generation_batch_started");
    assert.equal(emitted.telemetry.requestId, "req_20260617000000_abcd");
    assert.equal(emitted.telemetry.userId, "alice");
    assert.equal(emitted.telemetry.role, "user");
    assert.match(emitted.telemetry.projectRootHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(emitted.telemetry.payload.confirmationToken, "confirm_keep_for_audit");
    assert.equal("remoteUrl" in emitted.telemetry.payload, false);
    assert.equal("remote_url" in emitted.telemetry.payload, false);
    assert.equal(emitted.telemetry.payload.promptText, "[redacted]");

    const paths = wangzhuanPaths(ctx);
    const telemetry = await readJsonl(paths.telemetryPath);
    const audit = await readJsonl(paths.auditPath);
    assert.equal(telemetry.length, 1);
    assert.equal(audit.length, 1);
    assert.deepEqual(telemetry[0], emitted.telemetry);
    assert.deepEqual(audit[0], emitted.audit);
    assertNoSensitiveTelemetryText(JSON.stringify({ telemetry, audit }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline, QC, package, remix, and admin flows write parseable telemetry and audit events", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s8-flow-"));
  try {
    const ctx = context(root);
    const saved = await saveTemplate(ctx, { mode: "create", draft: baseDraft });
    const checked = await checkReferenceVideo(ctx, referenceUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_s8_decompose",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: decomposition()
    });

    const confirmedStart = await pipelineFixture(ctx, saved.template, checked.referenceVideo.referenceVideoId, 15, 11, "confirmed");
    await stopBatch(ctx, confirmedStart.batch.batchId, { reason: "cost_guard_smoke" });

    const started = await pipelineFixture(ctx, saved.template, checked.referenceVideo.referenceVideoId, 30, 1, "deliverable");
    await submitPendingGenerationTasks(ctx, started.batch.batchId);
    const stitched = await stitchBatchSegments(ctx, started.batch.batchId);
    const qc = await runBatchQc(ctx, stitched.batch.batchId);
    const packaged = await buildDownloadPackage(ctx, { batchIds: [qc.batch.batchId] });

    setWangzhuanFactsPoolForTest(fakePool());
    await syncTemplateStoreFacts(ctx, {
      schemaVersion: "templates.v1",
      defaultTemplateId: saved.template.templateId,
      nextTemplateSeq: 2,
      templates: [saved.template]
    });
    const source = await uploadRemixSource(ctx, sourceUpload());
    const remixEstimate = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: saved.template.templateId,
      versionId: saved.template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "meta_ads"
    });
    const remix = await startRemix(ctx, {
      idempotencyKey: "idem_s8_remix_start",
      estimateId: remixEstimate.estimateId
    });
    await confirmRemixPreview(ctx, remix.remix.remixId, {
      idempotencyKey: "idem_s8_remix_confirm",
      outputId: remix.remix.outputs[0].outputId
    });

    await adminTemplateAction(adminContext(root), {
      action: "archive",
      templateId: saved.template.templateId
    });

    const paths = wangzhuanPaths(ctx);
    const telemetry = await readJsonl(paths.telemetryPath);
    const audit = await readJsonl(paths.auditPath);
    const telemetryEvents = new Set(telemetry.map((item) => item.event));
    const auditEvents = new Set(audit.map((item) => item.event));

    for (const event of [
      "product_template_saved",
      "reference_video_checked",
      "script_decomposition_completed",
      "generation_limit_confirmed",
      "generation_batch_started",
      "batch_stopped",
      "generation_task_submitted",
      "stitch_completed",
      "qc_completed",
      "batch_downloaded",
      "competitor_material_uploaded",
      "competitor_preview_confirmed"
    ]) {
      assert.equal(telemetryEvents.has(event), true, `missing telemetry event ${event}`);
    }

    for (const event of [
      "product_template_saved",
      "product_template_admin_changed",
      "generation_limit_confirmed",
      "generation_batch_started",
      "generation_task_submitted",
      "batch_downloaded",
      "competitor_preview_confirmed"
    ]) {
      assert.equal(auditEvents.has(event), true, `missing audit event ${event}`);
    }

    const startedEvent = telemetry.find((item) => item.event === "generation_batch_started" && item.payload.batchId === qc.batch.batchId);
    assert.equal(startedEvent.payload.durationSec, 30);
    assert.equal(startedEvent.payload.variantCount, 1);
    assert.deepEqual(startedEvent.payload.models, ["gpt-image-2", "doubao-seedance-2-0-260128"]);

    const submitted = telemetry.filter((item) => item.event === "generation_task_submitted" && item.payload.batchId === qc.batch.batchId);
    assert.equal(submitted.length, 2);
    assert.ok(submitted.every((item) => item.payload.seedanceTaskId?.startsWith("mock_seedance_")));

    const downloaded = telemetry.find((item) => item.event === "batch_downloaded" && item.payload.packageId === packaged.manifest.packageId);
    assert.equal(downloaded.payload.itemCount, 1);
    assert.deepEqual(downloaded.payload.batchIds, [qc.batch.batchId]);

    assertNoSensitiveTelemetryText(JSON.stringify({ telemetry, audit }), root);
    assert.equal(existsSync(paths.telemetryPath), true);
    assert.equal(existsSync(paths.auditPath), true);
  } finally {
    setWangzhuanFactsPoolForTest(null);
    await closeWangzhuanFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed stitch attempts are observable without leaking paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s8-stitch-fail-"));
  try {
    const ctx = context(root);
    const saved = await saveTemplate(ctx, { mode: "create", draft: baseDraft });
    const checked = await checkReferenceVideo(ctx, referenceUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_s8_fail_decompose",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: decomposition()
    });
    const started = await pipelineFixture(ctx, saved.template, checked.referenceVideo.referenceVideoId, 30, 1, "stitch_fail");
    await submitPendingGenerationTasks(ctx, started.batch.batchId);
    await stitchBatchSegments(ctx, started.batch.batchId, { forceFail: true });

    const telemetry = await readJsonl(wangzhuanPaths(ctx).telemetryPath);
    const failed = telemetry.find((item) => item.event === "stitch_completed" && item.payload.status === "failed");
    assert.ok(failed);
    assert.equal(failed.payload.batchId, started.batch.batchId);
    assert.equal(failed.payload.errorCode, "stitch_failed");
    assertNoSensitiveTelemetryText(JSON.stringify(telemetry), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
