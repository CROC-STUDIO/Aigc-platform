import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { estimateBatch, startBatchFromEstimate } from "../../server/wangzhuan/estimates.mjs";
import { getGallery } from "../../server/wangzhuan/gallery.mjs";
import {
  closeWangzhuanFactsPool,
  loadRemixSourceFromMysql,
  setWangzhuanFactsPoolForTest
} from "../../server/wangzhuan/mysql-facts.mjs";
import { buildDownloadPackage } from "../../server/wangzhuan/package.mjs";
import { checkReferenceVideo, decomposeReferenceVideo } from "../../server/wangzhuan/reference-videos.mjs";
import {
  confirmRemixPreview,
  estimateRemix,
  getRemixDetail,
  startDirectMaskEdit,
  startRemix,
  stopRemix,
  uploadRemixSource
} from "../../server/wangzhuan/remix.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import { wangzhuanPaths } from "../../server/wangzhuan/storage.mjs";
import { saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";

const baseDraft = {
  displayName: "Cash Reward US EN",
  productName: "Lucky Cash",
  cta: "Download now",
  ending: "Claim your bonus today",
  currencySymbol: "$",
  language: "en-US",
  regions: ["US"],
  targetChannels: ["tiktok_ads"],
  defaultOutputRatio: "9:16",
  defaultDurationSec: 15,
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
    ...overrides
  };
}

function objectStorageContext(root, userId = "alice", overrides = {}) {
  const objectStore = new Map();
  const ctx = context(root, userId, {
    ...overrides,
    async syncWangzhuanAsset({ fullPath, assetKind }) {
      const relativePath = fullPath
        .slice(ctx.userProjectRoot.length)
        .replace(/^[\\/]+/, "")
        .replace(/\\/g, "/");
      const safeRelativePath = Buffer.from(relativePath, "utf8").toString("hex").slice(0, 64);
      const safeName = basename(fullPath).replace(/[^a-zA-Z0-9._-]+/g, "_") || "asset";
      const storageKey = `uploads/test/${userId}/${assetKind}/${safeRelativePath}_${safeName}`;
      objectStore.set(storageKey, await readFile(fullPath));
      return {
        storageKey,
        storageUrl: `https://cdn.test/${encodeURIComponent(storageKey)}`
      };
    },
    async openWangzhuanObjectStream(storageKey) {
      const buffer = objectStore.get(storageKey);
      if (!buffer) throw new Error(`missing object ${storageKey}`);
      return { body: Readable.from([buffer]) };
    }
  });
  return { ctx, objectStore };
}

function attachMysqlFacts() {
  const pool = fakePool();
  setWangzhuanFactsPoolForTest(pool);
  return pool;
}

let currentPool = null;

async function detachMysqlFacts() {
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

test.beforeEach(() => {
  currentPool = attachMysqlFacts();
});

test.afterEach(async () => {
  currentPool = null;
  await detachMysqlFacts();
});

function sourceUpload(fileName = "competitor.mp4", mimeType = "video/mp4") {
  return {
    fileName,
    mimeType,
    content: `data:${mimeType};base64,${Buffer.from("source material").toString("base64")}`,
    durationSec: 15,
    width: 720,
    height: 1280
  };
}

function referenceUpload() {
  return {
    fileName: "reference.mp4",
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${Buffer.from("reference video").toString("base64")}`,
    durationSec: 15,
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
    hook: "Earn rewards with daily tasks"
  };
}

function region(label = "watermark") {
  return {
    regionId: `reg_${label}`,
    type: "bbox",
    label,
    bbox: { x: 0.62, y: 0.84, width: 0.24, height: 0.08 }
  };
}

async function templateFixture(ctx) {
  const saved = await saveTemplate(ctx, { mode: "create", draft: baseDraft });
  return saved.template;
}

async function activeBatchFixture(ctx, idSuffix = "lock") {
  const template = await templateFixture(ctx);
  const checked = await checkReferenceVideo(ctx, referenceUpload());
  await decomposeReferenceVideo(ctx, {
    idempotencyKey: `idem_decompose_${idSuffix}`,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition: decomposition()
  });
  const estimated = await estimateBatch(ctx, {
    templateId: template.templateId,
    versionId: template.versionId,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetChannel: "tiktok_ads",
    targetRegion: "US",
    language: "en-US",
    promiseLevel: "strong_conversion",
    durationSec: 15,
    variantCount: 1,
    requestedConcurrency: 1,
    outputRatio: "9:16"
  });
  return startBatchFromEstimate(ctx, {
    idempotencyKey: `idem_start_batch_${idSuffix}`,
    estimateId: estimated.estimate.estimateId
  });
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
    ...ctx,
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

test("remix upload stores source material and rejects invalid file types", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-upload-"));
  try {
    const ctx = context(root);
    const uploaded = await uploadRemixSource(ctx, sourceUpload("competitor.mp4"));

    assert.match(uploaded.sourceId, /^rsrc_\d{8}_\d{3}$/);
    assert.equal(uploaded.probe.sourceId, uploaded.sourceId);
    assert.equal(uploaded.probe.mimeType, "video/mp4");
    assert.match(uploaded.previewUrl, /^\/file\?path=/);
    assert.equal(uploaded.previewUrl.includes(root), false);
    assert.equal(existsSync(join(ctx.userProjectRoot, uploaded.probe.storedPath)), true);
    const sourceFact = await loadRemixSourceFromMysql(ctx, uploaded.sourceId);
    assert.equal(sourceFact.sourceId, uploaded.sourceId);
    assert.equal(sourceFact.storedPath, uploaded.probe.storedPath);

    await assert.rejects(
      () => uploadRemixSource(ctx, sourceUpload("notes.txt", "text/plain")),
      (error) => {
        assert.equal(error.code, "invalid_material");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix upload probes real video metadata instead of trusting request defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-probe-"));
  try {
    const ctx = context(root, "alice", {
      probeRemixSource: async () => ({
        durationSec: 4.2,
        width: 720,
        height: 1280,
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        bitRateBps: 2250000,
        videoCodec: "h264",
        fps: 30,
        colorSpace: "bt709",
        pixelFormat: "yuv420p",
        audioStreams: [{ codec: "aac", sampleRate: 48000, channels: 2, bitRateBps: 128000 }],
        canExtractFrame: true
      })
    });

    const uploaded = await uploadRemixSource(ctx, {
      ...sourceUpload("four-second.mp4"),
      durationSec: 15,
      width: 720,
      height: 1280
    });

    assert.equal(uploaded.probe.durationSec, 4.2);
    assert.equal(uploaded.probe.ratio, "9:16");
    assert.equal(uploaded.probe.videoCodec, "h264");
    assert.equal(uploaded.probe.fps, 30);
    assert.equal(uploaded.probe.audioStreamCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix estimate enforces capability and region preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-estimate-"));
  try {
    const unsupportedCtx = context(root, "unsupported");
    const unsupportedTemplate = await templateFixture(unsupportedCtx);
    const unsupportedSource = await uploadRemixSource(unsupportedCtx, sourceUpload());

    await assert.rejects(
      () => estimateRemix(unsupportedCtx, {
        sourceId: unsupportedSource.sourceId,
        templateId: unsupportedTemplate.templateId,
        versionId: unsupportedTemplate.versionId,
        operationType: "watermark_cover",
        regions: [region()],
        targetChannel: "tiktok_ads"
      }),
      (error) => {
        assert.equal(error.code, "unsupported_capability");
        assert.equal(error.data.capability.status, "unsupported");
        return true;
      }
    );

    const ctx = context(root, "supported", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover", "text_cta_ending_replace"]
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());

    await assert.rejects(
      () => estimateRemix(ctx, {
        sourceId: source.sourceId,
        templateId: template.templateId,
        versionId: template.versionId,
        operationType: "watermark_cover",
        regions: [],
        targetChannel: "tiktok_ads"
      }),
      (error) => {
        assert.equal(error.code, "region_required");
        return true;
      }
    );

    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });

    assert.match(estimated.estimateId, /^rme_\d{8}_\d{3}$/);
    assert.equal(estimated.capability.provider, "function_k");
    assert.equal(estimated.capability.status, "supported");
    assert.equal(estimated.confirmationRequired, false);
    assert.deepEqual(estimated.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix direct mask-edit route submits one generated mask image to ai_remove manual mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-direct-mask-"));
  try {
    const providerCalls = [];
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover", "mask_edit"]
        }
      },
      probeRemixSource: async () => ({
        durationSec: 4.2,
        width: 720,
        height: 1280,
        canExtractFrame: true
      }),
      remixProviderClient: {
        async createJob(payload) {
          providerCalls.push(payload);
          return {
            job_id: "job_direct_mask_001",
            job_type: payload.job_type,
            status: "queued"
          };
        }
      }
    });
    const routeCtx = routerContext(ctx);
    const uploaded = await uploadRemixSource(ctx, sourceUpload());
    const maskDataUrl = `data:image/png;base64,${Buffer.from("single combined mask").toString("base64")}`;

    const startRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        idempotencyKey: "idem_s7_direct_mask_start",
        sourceId: uploaded.sourceId,
        regions: [region("logo"), region("watermark")],
        maskDataUrl
      }),
      startRes,
      new URL("http://localhost/api/wangzhuan/remix/mask-edit"),
      routeCtx
    );

    assert.equal(startRes.statusCode, 200);
    const started = JSON.parse(startRes.body.toString("utf8"));
    assert.equal(started.code, "ok");
    assert.equal(started.data.remix.status, "queued");
    assert.equal(started.data.remix.operationType, "watermark_cover");
    assert.equal(started.data.remix.regions.length, 2);
    assert.equal(started.data.remix.maskSource.sourceType, "base64_data_url");
    assert.match(started.data.remix.maskSource.storedPath, /mask\.png$/);

    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].job_type, "ai_remove");
    assert.equal(providerCalls[0].params.mode, "manual");
    assert.equal(providerCalls[0].params.mask_source_type, "base64_data_url");
    assert.equal(providerCalls[0].params.mask_source, maskDataUrl);
    assert.equal(providerCalls[0].params.mask_threshold, 1);
    assert.deepEqual(providerCalls[0].params.time_ranges, [{ start_ms: 0, end_ms: 4200 }]);
    assert.equal(providerCalls[0].params.operation_type, undefined);
    assert.equal(providerCalls[0].params.regions, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix start creates preview-required output and preview confirm makes it downloadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-confirm-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover", "logo_icon_cover_or_replace", "text_cta_ending_replace"]
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });

    const started = await startRemix(ctx, {
      idempotencyKey: "idem_s7_remix_start",
      estimateId: estimated.estimateId
    });
    const replay = await startRemix(ctx, {
      idempotencyKey: "idem_s7_remix_start",
      estimateId: estimated.estimateId
    });
    assert.equal(replay.remix.remixId, started.remix.remixId);
    assert.equal(started.remix.status, "preview_required");
    assert.equal(started.remix.outputs.length, 1);
    assert.equal(started.remix.outputs[0].sourceType, "remix");
    assert.equal(started.remix.outputs[0].qcStatus, "manual_required");
    assert.equal(started.remix.outputs[0].downloadEligible, false);
    assert.equal(started.downloadSummary.packageReady, false);

    await assert.rejects(
      () => buildDownloadPackage(ctx, { remixIds: [started.remix.remixId] }),
      (error) => {
        assert.equal(error.code, "empty_download_set");
        return true;
      }
    );

    const detail = await getRemixDetail(ctx, started.remix.remixId);
    assert.equal(detail.remix.remixId, started.remix.remixId);
    assert.equal(detail.downloadSummary.downloadEligibleCount, 0);

    const confirmed = await confirmRemixPreview(ctx, started.remix.remixId, {
      idempotencyKey: "idem_s7_preview_confirm",
      outputId: started.remix.outputs[0].outputId
    });
    const confirmReplay = await confirmRemixPreview(ctx, started.remix.remixId, {
      idempotencyKey: "idem_s7_preview_confirm",
      outputId: started.remix.outputs[0].outputId
    });
    assert.equal(confirmReplay.remix.status, "succeeded");
    assert.equal(confirmed.remix.status, "succeeded");
    assert.equal(confirmed.remix.previewConfirmedBy, "alice");
    assert.equal(confirmed.remix.outputs[0].qcStatus, "pass");
    assert.equal(confirmed.remix.outputs[0].previewConfirmed, true);
    assert.equal(confirmed.remix.outputs[0].downloadEligible, true);
    assert.equal(confirmed.downloadSummary.packageReady, true);

    const reportPath = join(wangzhuanPaths(ctx).remixDir, started.remix.remixId, "qc", `${started.remix.outputs[0].outputId}.json`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.sourceType, "remix");
    assert.equal(report.previewConfirmed, true);
    assert.equal(report.qcStatus, "pass");

    const gallery = await getGallery(ctx, { downloadEligibleOnly: "true" });
    assert.equal(gallery.items.some((item) => item.remixId === started.remix.remixId), true);

    const packaged = await buildDownloadPackage(ctx, { remixIds: [started.remix.remixId] });
    const entries = zipEntries(packaged.zip);
    const remixRoot = `remix/${started.remix.remixId}`;
    assert.equal(packaged.manifest.items.length, 1);
    assert.equal(entries.has("package-manifest.json"), true);
    assert.equal(entries.has(`${remixRoot}/source/original.mp4`), true);
    assert.equal(entries.has(`${remixRoot}/source/source-probe.json`), false);
    assert.equal(entries.has(`${remixRoot}/regions/regions.json`), true);
    assert.equal(entries.has(`${remixRoot}/prompts/${started.remix.tasks[0].generationTaskId}_remix.txt`), true);
    assert.equal(entries.has(`${remixRoot}/qc/${started.remix.outputs[0].outputId}.json`), true);
    assert.equal(entries.has(`${remixRoot}/task-map/task-id-map.csv`), true);
    assert.equal(entries.has(`${remixRoot}/task-map/task-id-map.json`), true);
    assert.equal(entries.has(`${remixRoot}/outputs/${started.remix.outputs[0].outputId}.mp4`), true);
    assert.equal(entries.has(`${remixRoot}/remix.json`), false);
    assert.equal(entries.has(`${remixRoot}/preview-confirmation.json`), true);

    const textPayload = Buffer.concat([...entries.values()]).toString("utf8");
    assert.doesNotMatch(textPayload, /"remoteUrl"\s*:|"remote_url"\s*:|https?:\/\//);
    assert.ok([...entries.keys()].some((name) => name.endsWith(`${basename(started.remix.outputs[0].filePath)}`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix package is driven by mysql asset storage keys when local cache files are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-s3-package-"));
  try {
    const { ctx, objectStore } = objectStorageContext(root, "alice", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover"]
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });
    const started = await startRemix(ctx, {
      idempotencyKey: "idem_s7_s3_remix_start",
      estimateId: estimated.estimateId
    });
    const confirmed = await confirmRemixPreview(ctx, started.remix.remixId, {
      idempotencyKey: "idem_s7_s3_preview_confirm",
      outputId: started.remix.outputs[0].outputId,
      notes: "object storage backed"
    });

    const detail = await getRemixDetail(ctx, confirmed.remix.remixId);
    const task = detail.remix.tasks[0];
    const output = detail.remix.outputs[0];
    assert.ok(detail.remix.source.storageKey);
    assert.ok(task.promptStorageKey);
    assert.ok(output.storageKey);
    assert.ok(output.qcReportStorageKey);

    assert.equal(currentPool.state.assets.get(detail.remix.source.sourceId).storageKey, detail.remix.source.storageKey);
    assert.equal(currentPool.state.assets.get(`asset_prompt_${task.generationTaskId}`).storageKey, task.promptStorageKey);
    assert.equal(currentPool.state.assets.get(`asset_${output.outputId}`).storageKey, output.storageKey);
    assert.equal(currentPool.state.assets.get(`asset_qc_${output.outputId}`).storageKey, output.qcReportStorageKey);

    await rm(join(ctx.userProjectRoot, detail.remix.source.storedPath), { force: true });
    await rm(join(ctx.userProjectRoot, task.promptPath), { force: true });
    await rm(join(ctx.userProjectRoot, output.filePath), { force: true });
    await rm(join(ctx.userProjectRoot, output.qcReportPath), { force: true });
    await rm(join(wangzhuanPaths(ctx).remixDir, confirmed.remix.remixId, "preview-confirmation.json"), { force: true });

    const packaged = await buildDownloadPackage(ctx, { remixIds: [confirmed.remix.remixId] });
    const entries = zipEntries(packaged.zip);
    const remixRoot = `remix/${confirmed.remix.remixId}`;
    assert.equal(packaged.manifest.missingFiles.length, 0);
    assert.equal(entries.get(`${remixRoot}/source/original.mp4`).toString("utf8"), "source material");
    assert.equal(entries.get(`${remixRoot}/outputs/${output.outputId}.mp4`).toString("utf8"), objectStore.get(output.storageKey).toString("utf8"));
    assert.match(entries.get(`${remixRoot}/prompts/${task.generationTaskId}_remix.txt`).toString("utf8"), /Operation: watermark_cover/);
    assert.match(entries.get(`${remixRoot}/qc/${output.outputId}.json`).toString("utf8"), /"qcStatus": "pass"/);
    assert.match(entries.get(`${remixRoot}/preview-confirmation.json`).toString("utf8"), /object storage backed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix start submits configured video platform job for mask editing", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-provider-"));
  try {
    const providerCalls = [];
    const { ctx } = objectStorageContext(root, "alice", {
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover", "logo_icon_cover_or_replace", "text_cta_ending_replace"]
        }
      },
      remixProviderClient: {
        async createJob(payload) {
          providerCalls.push(payload);
          return {
            job_id: "job_mask_001",
            job_type: payload.job_type,
            status: "queued",
            created_at: "2026-06-01T10:00:00Z",
            updated_at: "2026-06-01T10:00:00Z"
          };
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    await rm(join(ctx.userProjectRoot, source.probe.storedPath), { force: true });
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });

    const started = await startRemix(ctx, {
      idempotencyKey: "idem_s7_provider_start",
      estimateId: estimated.estimateId
    });

    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].job_type, "mask_edit");
    assert.equal(providerCalls[0].input.source_type, "base64_data_url");
    assert.match(providerCalls[0].input.source, /^data:video\/mp4;base64,/);
    assert.equal(providerCalls[0].params.operation_type, "watermark_cover");
    assert.deepEqual(providerCalls[0].params.regions, [region()]);
    assert.equal(providerCalls[0].params.mask_source.mode, "manual");
    assert.equal(providerCalls[0].params.mask_source.regions[0].label, "watermark");
    assert.equal(providerCalls[0].callback_url, null);
    assert.equal(providerCalls[0].options.priority, 0);

    const task = started.remix.tasks[0];
    assert.equal(task.providerJobId, "job_mask_001");
    assert.equal(task.seedanceTaskId, "job_mask_001");
    assert.equal(task.modelVideo, "video_aigc");
    assert.equal(task.status, "queued");
    assert.equal(task.remoteUrlStored, false);
    assert.equal(started.remix.providerJob.jobId, "job_mask_001");
    assert.equal(started.remix.providerJob.status, "queued");
    assert.equal(started.remix.status, "queued");
    assert.equal(started.remix.outputs.length, 0);
    assert.equal(started.downloadSummary.packageReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix detail polls video platform job and materializes succeeded output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-provider-detail-"));
  try {
    const providerCalls = [];
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover"]
        }
      },
      remixProviderClient: {
        async createJob(payload) {
          providerCalls.push(["create", payload]);
          return {
            job_id: "job_mask_done",
            job_type: "mask_edit",
            status: "queued"
          };
        },
        async getJob(jobId) {
          providerCalls.push(["detail", jobId]);
          return {
            job_id: jobId,
            job_type: "mask_edit",
            status: "succeeded",
            finished_at: "2026-06-01T10:03:00Z"
          };
        },
        async downloadJob(jobId) {
          providerCalls.push(["download", jobId]);
          return Buffer.from("remote processed video");
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });
    const started = await startRemix(ctx, {
      idempotencyKey: "idem_s7_provider_detail_start",
      estimateId: estimated.estimateId
    });

    const detail = await getRemixDetail(ctx, started.remix.remixId);

    assert.deepEqual(providerCalls.map((item) => item[0]), ["create", "detail", "download"]);
    assert.equal(detail.remix.status, "preview_required");
    assert.equal(detail.remix.providerJob.jobId, "job_mask_done");
    assert.equal(detail.remix.providerJob.status, "succeeded");
    assert.equal(detail.remix.outputs.length, 1);
    assert.equal(detail.remix.outputs[0].qcStatus, "manual_required");
    assert.equal(detail.remix.outputs[0].downloadEligible, false);
    assert.equal(detail.remix.tasks[0].status, "qc");
    assert.equal(detail.remix.tasks[0].providerJobId, "job_mask_done");
    assert.equal(existsSync(join(ctx.userProjectRoot, detail.remix.outputs[0].filePath)), true);
    assert.equal(await readFile(join(ctx.userProjectRoot, detail.remix.outputs[0].filePath), "utf8"), "remote processed video");
    assert.equal(existsSync(join(wangzhuanPaths(ctx).remixDir, started.remix.remixId, "qc", `${detail.remix.outputs[0].outputId}.json`)), true);
    assert.equal(detail.downloadSummary.packageReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix detail keeps polling pending jobs and materializes review-required output", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-provider-review-"));
  try {
    const providerCalls = [];
    let detailCount = 0;
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover"]
        }
      },
      remixProviderClient: {
        async createJob(payload) {
          providerCalls.push(["create", payload]);
          return {
            job_id: "job_review_required",
            job_type: "ai_remove",
            status: "pending"
          };
        },
        async getJob(jobId) {
          providerCalls.push(["detail", jobId]);
          detailCount += 1;
          return {
            job_id: jobId,
            job_type: "ai_remove",
            status: detailCount === 1 ? "pending" : "review_required",
            updated_at: "2026-06-01T10:02:00Z"
          };
        },
        async downloadJob(jobId) {
          providerCalls.push(["download", jobId]);
          return Buffer.from("review required video");
        }
      }
    });
    const uploaded = await uploadRemixSource(ctx, sourceUpload());
    const startRes = await startDirectMaskEdit(ctx, {
      idempotencyKey: "idem_s7_review_required_start",
      sourceId: uploaded.sourceId,
      regions: [region("watermark")],
      maskDataUrl: `data:image/png;base64,${Buffer.from("mask").toString("base64")}`
    });

    const pending = await getRemixDetail(ctx, startRes.remix.remixId);
    const review = await getRemixDetail(ctx, startRes.remix.remixId);

    assert.equal(pending.remix.status, "queued");
    assert.equal(pending.remix.providerJob.status, "pending");
    assert.equal(review.remix.status, "preview_required");
    assert.equal(review.remix.providerJob.status, "review_required");
    assert.equal(review.remix.outputs.length, 1);
    assert.equal(review.remix.outputs[0].qcStatus, "manual_required");
    assert.deepEqual(providerCalls.map((item) => item[0]), ["create", "detail", "detail", "download"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop remix marks active provider job stopped and releases pipeline start lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-stop-remix-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "video_aigc",
          status: "supported",
          endpoint: "https://video-aigc.skylink-gateway.com/api/v1",
          supportedOperations: ["watermark_cover"]
        }
      },
      remixProviderClient: {
        async createJob() {
          return {
            job_id: "job_stop_me",
            job_type: "mask_edit",
            status: "running"
          };
        }
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const estimatedRemix = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });
    const startedRemix = await startRemix(ctx, {
      idempotencyKey: "idem_s7_stop_remix_start",
      estimateId: estimatedRemix.estimateId
    });
    assert.equal(startedRemix.remix.status, "running");

    const checked = await checkReferenceVideo(ctx, referenceUpload());
    await decomposeReferenceVideo(ctx, {
      idempotencyKey: "idem_s7_stop_remix_decompose",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: decomposition()
    });
    const estimatedBatch = await estimateBatch(ctx, {
      templateId: template.templateId,
      versionId: template.versionId,
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      targetChannel: "tiktok_ads",
      targetRegion: "US",
      language: "en-US",
      promiseLevel: "strong_conversion",
      durationSec: 15,
      variantCount: 1,
      requestedConcurrency: 1,
      outputRatio: "9:16"
    });
    await assert.rejects(
      () => startBatchFromEstimate(ctx, {
        idempotencyKey: "idem_s7_stop_remix_locked_batch",
        estimateId: estimatedBatch.estimate.estimateId
      }),
      { code: "batch_already_running" }
    );

    const stopped = await stopRemix(ctx, startedRemix.remix.remixId, { reason: "user_cancelled" });
    assert.equal(stopped.remix.status, "stopped");
    assert.equal(stopped.remix.stopReason, "user_cancelled");
    assert.equal(stopped.remix.tasks.every((task) => task.status === "stopped"), true);
    assert.equal(stopped.remix.tasks[0].errorCode, "user_cancelled");
    assert.equal(stopped.downloadSummary.packageReady, false);

    const detail = await getRemixDetail(ctx, startedRemix.remix.remixId);
    assert.equal(detail.remix.status, "stopped");

    const startedBatch = await startBatchFromEstimate(ctx, {
      idempotencyKey: "idem_s7_stop_remix_unlocked_batch",
      estimateId: estimatedBatch.estimate.estimateId
    });
    assert.equal(startedBatch.batch.status, "queued");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline and remix start enforce the same user project run lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-lock-"));
  try {
    const batchCtx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover"]
        }
      }
    });
    await activeBatchFixture(batchCtx, "active_batch");
    const remixTemplate = await templateFixture(batchCtx);
    const remixSource = await uploadRemixSource(batchCtx, sourceUpload());
    const remixEstimate = await estimateRemix(batchCtx, {
      sourceId: remixSource.sourceId,
      templateId: remixTemplate.templateId,
      versionId: remixTemplate.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });

    await assert.rejects(
      () => startRemix(batchCtx, {
        idempotencyKey: "idem_s7_lock_remix_start",
        estimateId: remixEstimate.estimateId
      }),
      (error) => {
        assert.equal(error.code, "batch_already_running");
        assert.equal(error.data.runningResource, "pipeline_batch");
        return true;
      }
    );

    const remixCtx = context(root, "bob", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover"]
        }
      }
    });
    const template = await templateFixture(remixCtx);
    const source = await uploadRemixSource(remixCtx, sourceUpload());
    const estimatedRemix = await estimateRemix(remixCtx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });
    const startedRemix = await startRemix(remixCtx, {
      idempotencyKey: "idem_s7_lock_start_remix_first",
      estimateId: estimatedRemix.estimateId
    });

    const checked = await checkReferenceVideo(remixCtx, referenceUpload());
    await decomposeReferenceVideo(remixCtx, {
      idempotencyKey: "idem_decompose_after_remix_lock",
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      decomposition: decomposition()
    });
    const estimatedBatch = await estimateBatch(remixCtx, {
      templateId: template.templateId,
      versionId: template.versionId,
      referenceVideoId: checked.referenceVideo.referenceVideoId,
      targetChannel: "tiktok_ads",
      targetRegion: "US",
      language: "en-US",
      promiseLevel: "strong_conversion",
      durationSec: 15,
      variantCount: 1,
      requestedConcurrency: 1,
      outputRatio: "9:16"
    });

    await assert.rejects(
      () => startBatchFromEstimate(remixCtx, {
        idempotencyKey: "idem_s7_lock_batch_start",
        estimateId: estimatedBatch.estimate.estimateId
      }),
      (error) => {
        assert.equal(error.code, "batch_already_running");
        assert.equal(error.data.runningResource, "remix");
        assert.equal(error.data.remixId, startedRemix.remix.remixId);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remix router endpoints return envelopes for upload, estimate, start, detail, confirm, and zip", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-router-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: {
        remix: {
          provider: "function_k",
          status: "supported",
          supportedOperations: ["watermark_cover"]
        }
      }
    });
    const template = await templateFixture(ctx);
    const routeCtx = routerContext(ctx);

    const uploadRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", sourceUpload()),
      uploadRes,
      new URL("http://localhost/api/wangzhuan/remix/upload"),
      routeCtx
    );
    assert.equal(uploadRes.statusCode, 200);
    const uploaded = JSON.parse(uploadRes.body.toString("utf8"));
    assert.equal(uploaded.code, "ok");

    const estimateRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        sourceId: uploaded.data.sourceId,
        templateId: template.templateId,
        versionId: template.versionId,
        operationType: "watermark_cover",
        regions: [region()],
        targetChannel: "tiktok_ads"
      }),
      estimateRes,
      new URL("http://localhost/api/wangzhuan/remix/estimate"),
      routeCtx
    );
    assert.equal(estimateRes.statusCode, 200);
    const estimated = JSON.parse(estimateRes.body.toString("utf8"));
    assert.equal(estimated.code, "ok");

    const startRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { idempotencyKey: "idem_s7_router_start", estimateId: estimated.data.estimateId }),
      startRes,
      new URL("http://localhost/api/wangzhuan/remix/start"),
      routeCtx
    );
    assert.equal(startRes.statusCode, 200);
    const started = JSON.parse(startRes.body.toString("utf8"));
    assert.equal(started.code, "ok");
    assert.equal(started.data.remix.status, "preview_required");

    const detailRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("GET"),
      detailRes,
      new URL(`http://localhost/api/wangzhuan/remix/${started.data.remix.remixId}`),
      routeCtx
    );
    assert.equal(detailRes.statusCode, 200);
    const detail = JSON.parse(detailRes.body.toString("utf8"));
    assert.equal(detail.code, "ok");
    assert.equal(detail.data.downloadSummary.packageReady, false);

    const confirmRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", {
        idempotencyKey: "idem_s7_router_confirm",
        outputId: started.data.remix.outputs[0].outputId
      }),
      confirmRes,
      new URL(`http://localhost/api/wangzhuan/remix/${started.data.remix.remixId}/preview-confirm`),
      routeCtx
    );
    assert.equal(confirmRes.statusCode, 200);
    const confirmed = JSON.parse(confirmRes.body.toString("utf8"));
    assert.equal(confirmed.code, "ok");
    assert.equal(confirmed.data.remix.status, "succeeded");

    const downloadRes = captureRes();
    await handleWangzhuanRequest(
      jsonReq("POST", { remixIds: [started.data.remix.remixId] }),
      downloadRes,
      new URL("http://localhost/api/wangzhuan/download"),
      routeCtx
    );
    assert.equal(downloadRes.statusCode, 200);
    assert.equal(downloadRes.headers["Content-Type"], "application/zip");
    assert.equal(zipEntries(downloadRes.body).has("package-manifest.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
