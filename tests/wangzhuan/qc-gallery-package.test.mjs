import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { getGallery } from "../../server/wangzhuan/gallery.mjs";
import { buildDownloadPackage } from "../../server/wangzhuan/package.mjs";
import { submitPendingGenerationTasks } from "../../server/wangzhuan/pipeline.mjs";
import { runBatchQc } from "../../server/wangzhuan/qc.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import { stitchBatchSegments } from "../../server/wangzhuan/stitch.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import {
  closeWangzhuanFactsPool,
  loadBatchDetailFromMysql,
  setWangzhuanFactsPoolForTest,
  syncBatchFacts,
  syncRemixFacts
} from "../../server/wangzhuan/mysql-facts.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";
import { attachMockObjectStorage } from "./object-storage-fixture.mjs";
import { prepareDownloadedSegmentsWithoutStitch, testGeneratedVideoProbe, testSeedanceProviderClient } from "./test-providers.mjs";

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

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

function context(root, userId = "alice", overrides = {}) {
  const ctx = {
    userProjectRoot: join(root, userId, "project"),
    sharedProjectRoot: join(root, "shared"),
    userId,
    user: { userId, username: userId, role: "user", isAdmin: false },
    mockReferenceProbe: true,
    config: {},
    seedanceProviderClient: testSeedanceProviderClient(),
    probeGeneratedVideo: testGeneratedVideoProbe,
    capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } },
    ...overrides
  };
  attachMockObjectStorage(ctx);
  return ctx;
}

function validUpload(durationSec = 30) {
  return {
    fileName: "demo.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("video").toString("base64")}`,
    durationSec,
    width: 720,
    height: 1280,
    canExtractFrame: true
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

async function thirtySecondStitchedFixture(root, userId = "alice") {
  ensureFactsPool();
  const ctx = context(root, userId);
  const saved = await saveTemplate(ctx, { mode: "create", draft: baseDraft });
  const checked = await checkReferenceVideo(ctx, validUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: `idem_decompose_s6_${userId}`,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: decomposition()
  });
  const estimated = await estimateBatch(ctx, {
    templateId: saved.template.templateId,
    versionId: saved.template.versionId,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: saved.template.draft.promiseLevel,
    durationSec: 30,
    variantCount: 1,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  const started = await startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_s6_${userId}`,
    estimateId: estimated.estimate.estimateId
  });
  await prepareDownloadedSegmentsWithoutStitch(ctx, started.batch.batchId);
  const stitched = await stitchBatchSegments(ctx, started.batch.batchId);
  return { ctx, started, stitched };
}

async function resetFactsPool() {
  activePool = null;
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

function zipEntries(zip) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

function jsonReq(method, body = {}) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = {};
  return stream;
}

function captureRes() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    }
  };
}

function routerContext(ctx) {
  return {
    readJson: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
    currentUser: () => ctx.user,
    currentUserId: () => ctx.userId,
    currentProjectRoot: () => ctx.userProjectRoot,
    currentBaseProjectRoot: () => ctx.sharedProjectRoot,
    capabilities: ctx.capabilities
  };
}

test("QC writes one report per output and makes only stitched 30s output download eligible", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-qc-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root);
    const result = await runBatchQc(ctx, stitched.batch.batchId);
    const batch = result.batch;

    assert.equal(batch.status, "succeeded");
    assert.equal(batch.outputs.length, 3);
    assert.deepEqual(batch.qcSummary, {
      total: 3,
      passed: 3,
      failed: 0,
      warnings: []
    });

    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const segmentOutputs = batch.outputs.filter((output) => output.kind === "segment_video");
    assert.equal(stitchedOutput.qcStatus, "pass");
    assert.equal(stitchedOutput.downloadEligible, true);
    assert.equal(segmentOutputs.every((output) => output.qcStatus === "pass"), true);
    assert.equal(segmentOutputs.every((output) => output.downloadEligible === false), true);

    for (const output of batch.outputs) {
      const reportPath = join(wangzhuanPaths(ctx).batchesDir, batch.batchId, "qc", `${output.outputId}.json`);
      assert.equal(existsSync(reportPath), true);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.schemaVersion, "qc_report.v1");
      assert.equal(report.outputId, output.outputId);
      assert.equal(report.sourceType, "pipeline");
      assert.equal(report.qcStatus, "pass");
      assert.ok(report.checks.some((check) => check.checkId === "script_schema"));
      assert.ok(report.checks.some((check) => check.checkId === "prompt_schema"));
      assert.ok(report.checks.some((check) => check.checkId === "task_id_presence"));
      assert.ok(report.checks.some((check) => check.checkId === "ffprobe_readable"));
      assert.ok(report.checks.some((check) => check.checkId === "resolution_spec"));
      assert.ok(report.checks.some((check) => check.checkId === "duration_tolerance"));
      assert.ok(report.checks.some((check) => check.checkId === "download_status"));
      assert.ok(report.checks.some((check) => check.checkId === "competitor_residue_ocr"));
      assert.ok(report.checks.some((check) => check.checkId === "cta_product_presence"));
      assert.ok(batch.outputs.find((item) => item.outputId === output.outputId).qcChecks.some((check) => check.checkId === "ffprobe_readable"));
      if (output.kind === "stitched_video") {
        assert.ok(report.checks.some((check) => check.checkId === "stitch_report_presence"));
      }
    }
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("QC calls the model via /responses with generated video S3 URL and blocks failed visual review", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-model-qc-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root, "modelqc");
    const batch = (await loadBatchDetailFromMysql(ctx, stitched.batch.batchId)).batch;
    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const s3VideoUrl = "https://cdn.example.com/wangzhuan/generated/stitched-output.mp4";
    const patchedBatch = {
      ...batch,
      outputs: batch.outputs.map((output) => output.outputId === stitchedOutput.outputId
      ? {
        ...output,
        storageKey: "uploads/wangzhuan/generated/stitched-output.mp4",
        storageUrl: s3VideoUrl,
        previewUrl: s3VideoUrl
      }
      : output)
    };
    assert.equal((await syncBatchFacts(ctx, patchedBatch, "batch_write")).skipped, false);

    const modelCalls = [];
    const qc = await runBatchQc({
      ...ctx,
      callWangzhuanLlm: async ({ messages, llmConfig, generatedVideo, visionInputs, output, tasks, scripts }) => {
        modelCalls.push({ messages, llmConfig, generatedVideo, visionInputs, output, tasks, scripts });
        assert.equal(llmConfig.model, "doubao-seed-2-0-lite-260428");
        assert.equal(output.outputId, stitchedOutput.outputId);
        assert.equal(generatedVideo.fileUrl, s3VideoUrl);
        assert.equal(generatedVideo.fileDataUrl, undefined);
        assert.equal(visionInputs.fileUrl, s3VideoUrl);
        assert.equal(visionInputs.fileDataUrl, undefined);
        assert.equal(tasks.length, 2);
        assert.equal(scripts.length, 2);
        const userContent = messages.find((item) => item.role === "user").content;
        const text = userContent.map((part) => part.text || "").join("\n");
        assert.equal(userContent.some((part) => part.type === "file" && part.file?.file_url === s3VideoUrl), true);
        assert.equal(userContent.some((part) => part.type === "file" && part.file?.file_data?.startsWith("data:video/mp4;base64,")), false);
        assert.match(text, /Phone app reward screen/);
        assert.match(text, /Lucky Cash/);
        assert.match(text, /Seedance/);
        assert.match(text, /Seedance prompt execution checks/);
        assert.match(text, /字幕\/画面文字/);
        assert.match(text, /CTA\/Ending/);
        assert.match(text, /免责声明只应作为后处理底部贴片/);
        assert.match(text, /不得复刻竞品品牌、水印、UI、原文案/);
        return JSON.stringify({
          passed: false,
          score: 0.42,
          summary: "生成视频没有明显展示奖励反馈和 App 任务界面。",
          issues: [
            {
              code: "missing_reward_feedback",
              severity: "major",
              message: "画面缺少脚本要求的奖励反馈。"
            }
          ],
          matched: ["camera", "lighting"],
          recommendedAction: "regenerate"
        });
      }
    }, stitched.batch.batchId);

    assert.equal(modelCalls.length, 1);
    assert.equal(qc.batch.status, "partial_failed");
    assert.deepEqual(qc.batch.qcSummary, {
      total: 3,
      passed: 2,
      failed: 1,
      warnings: []
    });
    const reviewedOutput = qc.batch.outputs.find((output) => output.outputId === stitchedOutput.outputId);
    assert.equal(reviewedOutput.qcStatus, "fail");
    assert.equal(reviewedOutput.downloadEligible, false);
    assert.equal(reviewedOutput.modelQcSummary.passed, false);
    assert.equal(reviewedOutput.modelQcSummary.score, 0.42);

    const reportPath = join(wangzhuanPaths(ctx).batchesDir, qc.batch.batchId, "qc", `${stitchedOutput.outputId}.json`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.modelReview.provider, "skylink");
    assert.equal(report.modelReview.model, "doubao-seed-2-0-lite-260428");
    assert.equal(report.modelReview.passed, false);
    assert.equal(report.modelReview.score, 0.42);
    assert.deepEqual(report.modelReview.issues.map((issue) => issue.code), ["missing_reward_feedback"]);
    assert.equal(report.checks.some((check) => check.checkId === "model_video_qc" && check.status === "fail"), true);
    assert.doesNotMatch(JSON.stringify(report), /https:\/\/cdn\.example\.com/);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("QC falls back to inline local video when frame extract fails and URL input is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-model-qc-inline-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root, "modelqc-inline");
    const batch = (await loadBatchDetailFromMysql(ctx, stitched.batch.batchId)).batch;
    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const s3VideoUrl = "https://cdn.example.com/wangzhuan/generated/stitched-output-inline.mp4";
    const patchedBatch = {
      ...batch,
      outputs: batch.outputs.map((output) => output.outputId === stitchedOutput.outputId
        ? {
          ...output,
          storageKey: "uploads/wangzhuan/generated/stitched-output-inline.mp4",
          storageUrl: s3VideoUrl,
          previewUrl: s3VideoUrl
        }
        : output)
    };
    assert.equal((await syncBatchFacts(ctx, patchedBatch, "batch_write")).skipped, false);

    const modelCalls = [];
    await runBatchQc({
      ...ctx,
      config: {
        wangzhuan: {
          qcLlm: {
            provider: "skylink",
            endpoint: "https://skylink-gateway.com/api/v1",
            model: "gpt-5.4",
            preferVideoUrl: false
          }
        }
      },
      extractGeneratedVideoFrames: async () => {
        throw new Error("generated frame samples missing");
      },
      callWangzhuanLlm: async ({ generatedVideo, visionInputs }) => {
        modelCalls.push({ generatedVideo, visionInputs });
        assert.equal(generatedVideo.fileUrl, undefined);
        assert.match(generatedVideo.fileDataUrl, /^data:video\/mp4;base64,/);
        assert.equal(visionInputs.fileUrl, undefined);
        assert.match(visionInputs.fileDataUrl, /^data:video\/mp4;base64,/);
        assert.equal(visionInputs.frames.length, 0);
        assert.equal(
          visionInputs.warnings.some((warning) => warning.code === "generated_frame_extract_failed"),
          true
        );
        assert.equal(
          visionInputs.warnings.some((warning) => warning.code === "generated_video_inline_fallback"),
          true
        );
        return JSON.stringify({
          passed: true,
          score: 0.91,
          summary: "生成视频符合脚本要求。",
          issues: [],
          matched: ["camera", "cta"],
          recommendedAction: "approve"
        });
      }
    }, stitched.batch.batchId);

    assert.equal(modelCalls.length, 1);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("QC prefers remote video URL for doubao seed when frame extract fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-model-qc-url-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root, "modelqc-url");
    const batch = (await loadBatchDetailFromMysql(ctx, stitched.batch.batchId)).batch;
    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const s3VideoUrl = "https://cdn.example.com/wangzhuan/generated/stitched-output-url.mp4";
    const patchedBatch = {
      ...batch,
      outputs: batch.outputs.map((output) => output.outputId === stitchedOutput.outputId
        ? {
          ...output,
          storageKey: "uploads/wangzhuan/generated/stitched-output-url.mp4",
          storageUrl: s3VideoUrl,
          previewUrl: s3VideoUrl
        }
        : output)
    };
    assert.equal((await syncBatchFacts(ctx, patchedBatch, "batch_write")).skipped, false);

    const modelCalls = [];
    await runBatchQc({
      ...ctx,
      extractGeneratedVideoFrames: async () => {
        throw new Error("generated frame samples missing");
      },
      callWangzhuanLlm: async ({ generatedVideo, visionInputs, llmConfig }) => {
        modelCalls.push({ generatedVideo, visionInputs, llmConfig });
        assert.equal(llmConfig.model, "doubao-seed-2-0-lite-260428");
        assert.equal(generatedVideo.fileUrl, s3VideoUrl);
        assert.equal(generatedVideo.fileDataUrl, undefined);
        assert.equal(visionInputs.fileUrl, s3VideoUrl);
        assert.equal(visionInputs.fileDataUrl, undefined);
        assert.equal(
          visionInputs.warnings.some((warning) => warning.code === "generated_video_url_primary"),
          true
        );
        return JSON.stringify({
          passed: true,
          score: 0.88,
          summary: "生成视频符合脚本要求。",
          issues: [],
          matched: ["camera"],
          recommendedAction: "approve"
        });
      }
    }, stitched.batch.batchId);

    assert.equal(modelCalls.length, 1);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("QC posts /responses input_file payload when calling Skylink without mock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-model-qc-responses-"));
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root, "modelqc-responses");
    const qcCtx = {
      ...ctx,
      config: {
        wangzhuan: {
          qcLlm: {
            provider: "skylink",
            endpoint: "https://skylink-gateway.com/api/v1",
            model: "doubao-seed-2-0-lite-260428",
            apiKey: "test-key"
          }
        }
      }
    };
    const batch = (await loadBatchDetailFromMysql(ctx, stitched.batch.batchId)).batch;
    const stitchedOutput = batch.outputs.find((output) => output.kind === "stitched_video");
    const s3VideoUrl = "https://cdn.example.com/wangzhuan/generated/stitched-output-responses.mp4";
    const patchedBatch = {
      ...batch,
      outputs: batch.outputs.map((output) => output.outputId === stitchedOutput.outputId
        ? {
          ...output,
          storageKey: "uploads/wangzhuan/generated/stitched-output-responses.mp4",
          storageUrl: s3VideoUrl,
          previewUrl: s3VideoUrl
        }
        : output)
    };
    assert.equal((await syncBatchFacts(qcCtx, patchedBatch, "batch_write")).skipped, false);

    globalThis.fetch = async (url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              passed: true,
              score: 0.9,
              summary: "生成视频符合脚本要求。",
              issues: [],
              matched: ["camera"],
              recommendedAction: "approve"
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    await runBatchQc(qcCtx, stitched.batch.batchId);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://skylink-gateway.com/api/v1/responses");
    assert.equal(calls[0].body.model, "doubao-seed-2-0-lite-260428");
    const userContent = calls[0].body.input.find((item) => item.role === "user").content;
    assert.equal(userContent.some((part) => part.type === "input_file" && part.file_url === s3VideoUrl && part.filename), true);
    assert.equal(userContent.some((part) => part.type === "input_file" && part.file), false);
  } finally {
    globalThis.fetch = previousFetch;
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("download package refuses to stream an incomplete package when a required file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-missing-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root);
    const qc = await runBatchQc(ctx, stitched.batch.batchId);
    const stitchedOutput = qc.batch.outputs.find((output) => output.kind === "stitched_video");
    await rm(join(ctx.userProjectRoot, stitchedOutput.filePath), { force: true });

    await assert.rejects(
      () => buildDownloadPackage(ctx, { batchIds: [qc.batch.batchId] }),
      (error) => {
        assert.equal(error.code, "missing_required_file");
        assert.ok(error.data.missingFiles.some((item) => item.includes(basename(stitchedOutput.filePath))));
        return true;
      }
    );
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("gallery is manifest-driven and only returns current user project outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-gallery-"));
  try {
    const alice = await thirtySecondStitchedFixture(root, "alice");
    const bob = await thirtySecondStitchedFixture(root, "bob");
    await runBatchQc(alice.ctx, alice.stitched.batch.batchId);
    await runBatchQc(bob.ctx, bob.stitched.batch.batchId);

    const strayDir = join(alice.ctx.userProjectRoot, "效果图");
    await mkdir(strayDir, { recursive: true });
    await writeFile(join(strayDir, "stray.mp4"), "not in manifest", "utf8");

    const gallery = await getGallery(alice.ctx, {});
    assert.equal(gallery.items.length, 3);
    assert.equal(gallery.items.every((item) => item.batchId === alice.stitched.batch.batchId), true);
    assert.equal(gallery.items.some((item) => item.filePath.includes("stray.mp4")), false);
    assert.equal(gallery.counts.total, 3);
    assert.equal(gallery.counts.downloadEligible, 1);
    assert.equal(gallery.counts.byQcStatus.pass, 3);

    const firstPage = await getGallery(alice.ctx, { page: "1", pageSize: "2" });
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.counts.total, 3);
    assert.equal(firstPage.counts.downloadEligible, 1);
    assert.deepEqual(firstPage.pagination, {
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
      hasPrev: false,
      hasNext: true
    });

    const secondPage = await getGallery(alice.ctx, { page: "2", pageSize: "2" });
    assert.equal(secondPage.items.length, 1);
    assert.deepEqual(secondPage.pagination, {
      page: 2,
      pageSize: 2,
      total: 3,
      totalPages: 2,
      hasPrev: true,
      hasNext: false
    });

    const remixId = "rmx_20260622010101_abcd";
    await syncRemixFacts(alice.ctx, {
      remixId,
      type: "remix",
      status: "preview_required",
      userId: "alice",
      sourceId: "rsrc_20260622_001",
      source: {},
      operationType: "watermark_cover",
      targetChannel: "meta_ads",
      regions: [],
      templateSnapshot: { templateId: "tpl_remix", versionId: "tplv_remix", draft: { productName: "Remix Product", targetChannels: ["meta_ads"] } },
      tasks: [],
      outputs: [{
        outputId: "out_remix_001",
        sourceType: "remix",
        kind: "remix_video",
        filePath: "批处理记录/网赚管线/remix/rmx_20260622010101_abcd/outputs/out_remix_001.mp4",
        durationSec: 15,
        qcStatus: "pass",
        downloadEligible: true,
        visualPreviewRequired: true,
        previewConfirmed: true
      }],
      qcSummary: { total: 1, passed: 1, failed: 0, warnings: [] },
      createdAt: "2026-06-22T01:01:01.000Z",
      updatedAt: "2026-06-22T01:01:01.000Z"
    });

    const sharedDefault = await getGallery(alice.ctx, {});
    assert.equal(sharedDefault.items.some((item) => item.remixId === remixId), true);

    const pipelineGallery = await getGallery(alice.ctx, { sourceType: "pipeline" });
    assert.equal(pipelineGallery.filters.sourceType, "pipeline");
    assert.equal(pipelineGallery.items.length, 3);
    assert.equal(pipelineGallery.items.every((item) => item.sourceType === "pipeline"), true);
    assert.equal(pipelineGallery.items.some((item) => item.remixId === remixId), false);
    assert.equal(pipelineGallery.counts.total, 3);

    const remixGallery = await getGallery(alice.ctx, { sourceType: "remix" });
    assert.equal(remixGallery.filters.sourceType, "remix");
    assert.equal(remixGallery.items.length, 1);
    assert.equal(remixGallery.items[0].remixId, remixId);
    assert.equal(remixGallery.items[0].sourceType, "remix");
    assert.equal(remixGallery.counts.total, 1);

    const eligibleOnly = await getGallery(alice.ctx, { sourceType: "pipeline", downloadEligibleOnly: "true" });
    assert.equal(eligibleOnly.items.length, 1);
    assert.equal(eligibleOnly.items[0].kind, "stitched_video");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("gallery requires mysql facts and does not fall back to batch json", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-gallery-no-mysql-"));
  try {
    const { ctx } = await thirtySecondStitchedFixture(root, "alice");
    await resetFactsPool();
    await assert.rejects(
      () => getGallery(ctx, {}),
      (error) => {
        assert.equal(error.code, "database_unavailable");
        return true;
      }
    );
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("download package contains original reference, scripts, prompts, QC, task map, stitch files, and no remote URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-package-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root);
    const qc = await runBatchQc(ctx, stitched.batch.batchId);
    const result = await buildDownloadPackage(ctx, { batchIds: [qc.batch.batchId] });
    const entries = zipEntries(result.zip);
    const batchRoot = `batches/${qc.batch.batchId}`;
    const stitchedOutput = qc.batch.outputs.find((output) => output.kind === "stitched_video");

    assert.equal(result.manifest.schemaVersion, "download_package.v1");
    assert.equal(result.manifest.items.length, 1);
    assert.deepEqual(result.manifest.missingFiles, []);
    assert.equal(entries.has("package-manifest.json"), true);
    assert.equal(entries.has(`${batchRoot}/batch.json`), true);
    assert.equal(entries.has(`${batchRoot}/original-reference/original.mp4`), true);
    assert.equal(entries.has(`${batchRoot}/original-reference/reference-video-probe.json`), true);
    assert.equal(entries.has(`${batchRoot}/scripts/decomposition.json`), true);
    assert.equal(qc.batch.scripts.every((script) => entries.has(`${batchRoot}/scripts/${basename(script.scriptPath)}`)), true);
    assert.equal(qc.batch.tasks.every((task) => entries.has(`${batchRoot}/prompts/${task.generationTaskId}_image.txt`)), true);
    assert.equal(qc.batch.tasks.every((task) => entries.has(`${batchRoot}/prompts/${task.generationTaskId}_seedance.txt`)), true);
    assert.equal(qc.batch.outputs.every((output) => entries.has(`${batchRoot}/qc/${output.outputId}.json`)), true);
    assert.equal(entries.has(`${batchRoot}/task-map/task-id-map.csv`), true);
    assert.equal(entries.has(`${batchRoot}/task-map/task-id-map.json`), true);
    assert.equal(entries.has(`${batchRoot}/stitched/${stitchedOutput.outputId}_30s.mp4`), true);
    assert.equal(entries.has(`${batchRoot}/stitch/${stitchedOutput.outputId}_stitch-report.json`), true);
    assert.ok([...entries.keys()].some((name) => name.startsWith(`${batchRoot}/segments/`)));

    const textPayload = Buffer.concat([...entries.values()]).toString("utf8");
    assert.doesNotMatch(textPayload, /"remoteUrl"\s*:|"remote_url"\s*:/);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("gallery and download routes expose contract envelopes and zip response", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s6-router-"));
  try {
    const { ctx, stitched } = await thirtySecondStitchedFixture(root);
    const qc = await runBatchQc(ctx, stitched.batch.batchId);

    const galleryRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("GET"),
      galleryRes,
      new URL("http://localhost/api/wangzhuan/gallery?downloadEligibleOnly=true&page=1&pageSize=1"),
      routerContext(ctx)
    );
    assert.equal(galleryRes.statusCode, 200);
    const galleryPayload = JSON.parse(galleryRes.body.toString("utf8"));
    assert.equal(galleryPayload.code, "ok");
    assert.equal(galleryPayload.data.items.length, 1);
    assert.deepEqual(galleryPayload.data.pagination, {
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
      hasPrev: false,
      hasNext: false
    });

    const downloadRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { batchIds: [qc.batch.batchId] }),
      downloadRes,
      new URL("http://localhost/api/wangzhuan/download"),
      routerContext(ctx)
    );
    assert.equal(downloadRes.statusCode, 200);
    assert.equal(downloadRes.headers["Content-Type"], "application/zip");
    assert.match(downloadRes.headers["Content-Disposition"], /^attachment; filename="wangzhuan-package-\d+\.zip"$/);
    assert.match(downloadRes.headers["X-Request-Id"], /^req_\d{14}_[a-f0-9]{4}$/);
    assert.equal(zipEntries(downloadRes.body).has("package-manifest.json"), true);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
