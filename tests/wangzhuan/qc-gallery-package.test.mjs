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
    capabilities: { stitcher: { status: "available", provider: "mock_stitch", version: "test" } },
    ...overrides
  };
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
  await submitPendingGenerationTasks(ctx, started.batch.batchId);
  const stitched = await stitchBatchSegments(ctx, started.batch.batchId);
  return { ctx, started, stitched };
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
      if (output.kind === "stitched_video") {
        assert.ok(report.checks.some((check) => check.checkId === "stitch_report_presence"));
      }
    }
  } finally {
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

    const eligibleOnly = await getGallery(alice.ctx, { downloadEligibleOnly: "true" });
    assert.equal(eligibleOnly.items.length, 1);
    assert.equal(eligibleOnly.items[0].kind, "stitched_video");
  } finally {
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
    assert.doesNotMatch(textPayload, /"remoteUrl"\s*:|"remote_url"\s*:|https?:\/\//);
  } finally {
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
      new URL("http://localhost/api/wangzhuan/gallery?downloadEligibleOnly=true"),
      routerContext(ctx)
    );
    assert.equal(galleryRes.statusCode, 200);
    const galleryPayload = JSON.parse(galleryRes.body.toString("utf8"));
    assert.equal(galleryPayload.code, "ok");
    assert.equal(galleryPayload.data.items.length, 1);

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
    await rm(root, { recursive: true, force: true });
  }
});
