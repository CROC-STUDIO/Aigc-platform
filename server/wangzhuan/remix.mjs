import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "node:path";

import { effectiveLimits } from "./config.mjs";
import { TARGET_CHANNELS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { createRemixProviderClient, hasRemoteRemixProvider } from "./remix-provider.mjs";
import { ffprobeMediaFile } from "./reference-videos.mjs";
import {
  makeGenerationTaskId,
  makeRemixEstimateId,
  makeRemixId,
  makeRemixSourceId,
  makeOutputId
} from "./ids.mjs";
import {
  previewUrlForWangzhuanAsset,
  readJsonOrDefault,
  syncWangzhuanAsset,
  toProjectRelative,
  wangzhuanPaths,
  writeAtomicJson
} from "./storage.mjs";
import { findActiveResourceLock, syncRemixFacts } from "./mysql-facts.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const MATERIAL_EXTS = new Set([".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg"]);
const MATERIAL_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mov",
  "image/png",
  "image/jpeg",
  "image/jpg"
]);
const REMIX_OPERATIONS = new Set(["text_cta_ending_replace", "logo_icon_cover_or_replace", "watermark_cover"]);
const ACTIVE_REMIX_STATUSES = new Set(["queued", "running", "qc", "preview_required"]);
const STOPPABLE_REMIX_STATUSES = new Set(["queued", "running", "qc", "preview_required"]);
const REMIX_MODEL_VIDEO = "function_k";
const DEFAULT_DIRECT_OPERATION = "watermark_cover";
const DEFAULT_DIRECT_CHANNEL = "generic";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function isAdmin(context) {
  return context.user?.role === "admin" || context.user?.isAdmin;
}

async function assertNoMysqlResourceLock(context) {
  const activeMysqlLock = await findActiveResourceLock(context);
  if (!activeMysqlLock) return;
  throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
    runningResource: activeMysqlLock.runType || "mysql_resource_lock",
    batchId: activeMysqlLock.runType === "pipeline" ? activeMysqlLock.runId : undefined,
    remixId: activeMysqlLock.runType === "remix" ? activeMysqlLock.runId : undefined,
    status: activeMysqlLock.runStatus || activeMysqlLock.status
  });
}

function safeFileName(name, fallback = "source.mp4") {
  const parsed = parse(basename(name || fallback));
  const safeBase = parsed.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || parse(fallback).name;
  const safeExt = parsed.ext.toLowerCase() || parse(fallback).ext;
  return `${safeBase}${safeExt}`;
}

function parseUploadContent(content) {
  if (typeof content !== "string" || !content.includes(",")) {
    throw new WangzhuanError("validation_error", "上传素材读取失败，请重新选择素材", { field: "content" });
  }
  const buffer = Buffer.from(content.split(",").pop() || "", "base64");
  if (!buffer.length) {
    throw new WangzhuanError("invalid_material", "素材文件为空", { field: "content" });
  }
  return buffer;
}

function ratioFor(width, height) {
  if (!width || !height) return "";
  const value = width / height;
  if (Math.abs(value - 9 / 16) < 0.03) return "9:16";
  if (Math.abs(value - 16 / 9) < 0.03) return "16:9";
  if (Math.abs(value - 1) < 0.03) return "1:1";
  return `${width}:${height}`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeAudioStream(stream = {}) {
  return {
    codec: String(stream.codec || stream.codec_name || ""),
    sampleRate: numberOrZero(stream.sampleRate ?? stream.sample_rate),
    channels: numberOrZero(stream.channels),
    bitRateBps: numberOrZero(stream.bitRateBps ?? stream.bit_rate)
  };
}

function normalizeRemixProbe(raw = {}) {
  const durationSec = numberOrZero(raw.durationSec);
  const width = numberOrZero(raw.width);
  const height = numberOrZero(raw.height);
  const audioStreams = Array.isArray(raw.audioStreams) ? raw.audioStreams.map(normalizeAudioStream) : [];
  return {
    durationSec,
    width,
    height,
    ratio: ratioFor(width, height),
    formatName: String(raw.formatName || ""),
    bitRateBps: numberOrZero(raw.bitRateBps),
    videoCodec: String(raw.videoCodec || ""),
    fps: numberOrZero(raw.fps),
    colorSpace: String(raw.colorSpace || ""),
    pixelFormat: String(raw.pixelFormat || ""),
    audioStreams,
    audioStreamCount: audioStreams.length,
    canExtractFrame: raw.canExtractFrame !== false && Boolean(width && height)
  };
}

function requestMetadataProbe(request = {}) {
  return normalizeRemixProbe({
    durationSec: request.durationSec,
    width: request.width,
    height: request.height,
    canExtractFrame: true
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function parseMaskDataUrl(maskDataUrl) {
  if (typeof maskDataUrl !== "string" || !maskDataUrl.startsWith("data:image/png;base64,") || !maskDataUrl.includes(",")) {
    throw new WangzhuanError("validation_error", "请先生成 mask 预览图", { field: "maskDataUrl" });
  }
  const buffer = Buffer.from(maskDataUrl.split(",").pop() || "", "base64");
  if (!buffer.length) {
    throw new WangzhuanError("validation_error", "mask 预览图为空", { field: "maskDataUrl" });
  }
  return buffer;
}

function idempotencyFile(paths, endpoint, idempotencyKey, resourceId = "") {
  const safeEndpoint = endpoint.replace(/[^a-z0-9_-]+/gi, "_");
  const digest = createHash("sha256").update(`${resourceId}:${String(idempotencyKey)}`).digest("hex").slice(0, 24);
  return join(paths.idempotencyDir, `${safeEndpoint}_${digest}.json`);
}

async function readIdempotentResult(paths, endpoint, idempotencyKey, resourceId = "") {
  if (!idempotencyKey) return null;
  const target = idempotencyFile(paths, endpoint, idempotencyKey, resourceId);
  if (!existsSync(target)) return null;
  return JSON.parse(await readFile(target, "utf8")).result;
}

async function writeIdempotentResult(paths, endpoint, idempotencyKey, result, resourceId = "") {
  if (!idempotencyKey) return;
  await writeAtomicJson(idempotencyFile(paths, endpoint, idempotencyKey, resourceId), {
    endpoint,
    resourceId,
    result,
    createdAt: new Date().toISOString()
  });
}

async function nextSourceSeq(paths) {
  const indexPath = join(paths.remixSourcesDir, "index.json");
  const index = await readJsonOrDefault(indexPath, { schemaVersion: "remix-sources.v1", nextSeq: 1, items: [] });
  const sourceId = makeRemixSourceId(index.nextSeq || 1);
  index.nextSeq = (index.nextSeq || 1) + 1;
  index.items = Array.isArray(index.items) ? index.items : [];
  return { sourceId, indexPath, index };
}

async function nextEstimateSeq(paths) {
  const indexPath = join(paths.remixEstimatesDir, "index.json");
  const index = await readJsonOrDefault(indexPath, { schemaVersion: "remix-estimates.v1", nextSeq: 1, items: [] });
  const estimateId = makeRemixEstimateId(index.nextSeq || 1);
  index.nextSeq = (index.nextSeq || 1) + 1;
  index.items = Array.isArray(index.items) ? index.items : [];
  return { estimateId, indexPath, index };
}

function validateSourceId(sourceId) {
  if (!/^rsrc_\d{8}_\d{3}$/.test(String(sourceId || ""))) {
    throw new WangzhuanError("invalid_material", "素材不符合要求，请上传图片或视频", { sourceId });
  }
}

function validateEstimateId(estimateId) {
  if (!/^rme_\d{8}_\d{3}$/.test(String(estimateId || ""))) {
    throw new WangzhuanError("validation_error", "estimateId 不合法", { field: "estimateId" });
  }
}

function validateRemixId(remixId) {
  if (!/^rmx_\d{14}_[a-f0-9]{4}$/.test(String(remixId || ""))) {
    throw new WangzhuanError("remix_not_found", "改造任务不存在或无权限", { remixId });
  }
}

function sourceDir(context, sourceId) {
  validateSourceId(sourceId);
  return join(wangzhuanPaths(context).remixSourcesDir, sourceId);
}

function remixDir(context, remixId) {
  validateRemixId(remixId);
  return join(wangzhuanPaths(context).remixDir, remixId);
}

function remixPath(context, remixId) {
  return join(remixDir(context, remixId), "remix.json");
}

function resolveUserPath(context, relativePath) {
  if (!relativePath || String(relativePath).match(/^[A-Za-z]:[\\/]|^\//)) {
    throw new WangzhuanError("validation_error", "文件路径不合法", { path: relativePath });
  }
  const root = resolve(context.userProjectRoot);
  const target = resolve(root, String(relativePath));
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new WangzhuanError("validation_error", "文件路径越界", { path: relativePath });
  }
  return target;
}

async function loadTemplateVersion(context, templateId, versionId) {
  const store = await readJsonOrDefault(wangzhuanPaths(context).templatesPath, { templates: [] });
  const template = (Array.isArray(store.templates) ? store.templates : []).find((item) => {
    return item.templateId === templateId && item.versionId === versionId && item.status !== "deleted";
  });
  if (!template) {
    throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { templateId, versionId });
  }
  return template;
}

async function loadSourceProbe(context, sourceId) {
  validateSourceId(sourceId);
  const target = join(sourceDir(context, sourceId), "source-probe.json");
  if (!existsSync(target)) {
    throw new WangzhuanError("invalid_material", "素材不符合要求，请上传图片或视频", { sourceId });
  }
  const probe = JSON.parse(await readFile(target, "utf8"));
  if (probe.userId !== currentUserId(context) && !isAdmin(context)) {
    throw new WangzhuanError("permission_denied", "当前账号无权执行该操作", { sourceId });
  }
  return probe;
}

async function probeRemixSource(context, filePath, request, mimeType) {
  if (typeof context.probeRemixSource === "function") {
    return normalizeRemixProbe(await context.probeRemixSource({ filePath, request }));
  }
  if (context.mockReferenceProbe) {
    return requestMetadataProbe(request);
  }
  if (mimeType.startsWith("video/")) {
    const timeoutMs = numberOrZero(context.config?.wangzhuan?.ffprobe?.timeoutMs) || 15000;
    return normalizeRemixProbe(await ffprobeMediaFile(filePath, { timeoutMs, mediaLabel: "竞品素材" }));
  }
  return requestMetadataProbe(request);
}

async function readRemix(context, remixId) {
  const target = remixPath(context, remixId);
  if (!existsSync(target)) {
    throw new WangzhuanError("remix_not_found", "改造任务不存在或无权限", { remixId });
  }
  const remix = JSON.parse(await readFile(target, "utf8"));
  if (remix.userId !== currentUserId(context) && !isAdmin(context)) {
    throw new WangzhuanError("permission_denied", "当前账号无权执行该操作", { remixId });
  }
  return remix;
}

async function writeRemix(context, remix) {
  const now = new Date().toISOString();
  const next = { ...remix, updatedAt: now };
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.remixDir, next.remixId, "remix.json"), next);
  const indexPath = join(paths.remixDir, "index.json");
  const index = await readJsonOrDefault(indexPath, { schemaVersion: "remix.v1", items: [] });
  index.items = Array.isArray(index.items) ? index.items : [];
  const existing = index.items.find((item) => item.remixId === next.remixId);
  if (existing) {
    existing.status = next.status;
    existing.updatedAt = now;
  } else {
    index.items.push({
      remixId: next.remixId,
      status: next.status,
      sourceId: next.sourceId,
      createdBy: next.userId,
      createdAt: next.createdAt,
      updatedAt: now
    });
  }
  await writeAtomicJson(indexPath, index);
  await syncRemixFacts(context, next, "remix_write");
  return next;
}

function normalizeCapability(raw, operationType) {
  const checkedAt = new Date().toISOString();
  if (!raw) {
    return {
      provider: "unknown",
      status: "unsupported",
      supportedOperations: [],
      unsupportedReason: "remix provider is not configured",
      preflightCheckedAt: checkedAt
    };
  }
  const status = raw.status === "available" ? "supported" : raw.status || (raw.available ? "supported" : "unsupported");
  const supportedOperations = Array.isArray(raw.supportedOperations) ? raw.supportedOperations : [];
  const operationSupported = supportedOperations.includes(operationType);
  return {
    provider: raw.provider || "unknown",
    status: status === "supported" || status === "degraded"
      ? operationSupported ? status : "unsupported"
      : "unsupported",
    supportedOperations,
    ...(raw.endpoint ? { endpoint: raw.endpoint } : {}),
    endpointConfigured: Boolean(raw.endpoint),
    ...(operationSupported ? {} : { unsupportedReason: raw.unsupportedReason || "operation is not supported by current remix provider" }),
    preflightCheckedAt: checkedAt
  };
}

export function preflightRemixProvider(context = {}, operationType) {
  const configProvider = context.config?.wangzhuan?.remixProvider;
  const configCapability = context.config?.wangzhuan?.capabilities?.remix;
  const raw = context.capabilities?.remix ?? {
    ...(configCapability && typeof configCapability === "object" ? configCapability : {}),
    ...(configProvider && typeof configProvider === "object" ? configProvider : {})
  };
  return normalizeCapability(raw, operationType);
}

function validateRegions(request, limits) {
  if (!Array.isArray(request.regions) || !request.regions.length) {
    throw new WangzhuanError("region_required", "请圈选或描述需要处理的区域", { field: "regions" });
  }
  if (request.regions.length > limits.maxRemixRegions) {
    throw new WangzhuanError("validation_error", "圈选区域数量超过上限", {
      field: "regions",
      maxRemixRegions: limits.maxRemixRegions
    });
  }
  return request.regions.map((item, index) => {
    const regionId = String(item.regionId || `region_${index + 1}`);
    const type = item.type === "description" ? "description" : "bbox";
    const label = String(item.label || "region").trim();
    if (!label) throw new WangzhuanError("validation_error", "区域 label 必填", { field: `regions[${index}].label` });
    if (type === "bbox") {
      const bbox = item.bbox || {};
      for (const field of ["x", "y", "width", "height"]) {
        const value = Number(bbox[field]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new WangzhuanError("validation_error", "bbox 必须为 0-1 归一化坐标", { field: `regions[${index}].bbox.${field}` });
        }
      }
      return { regionId, type, label, bbox: { x: Number(bbox.x), y: Number(bbox.y), width: Number(bbox.width), height: Number(bbox.height) } };
    }
    const description = String(item.description || "").trim();
    if (!description) {
      throw new WangzhuanError("validation_error", "描述区域不能为空", { field: `regions[${index}].description` });
    }
    return { regionId, type, label, description };
  });
}

function directTemplateSnapshot() {
  return {
    templateId: "direct_mask_edit",
    versionId: "direct_mask_edit_v1",
    versionNumber: 1,
    status: "active",
    draft: {
      displayName: "Direct mask edit",
      productName: "",
      cta: "",
      ending: "",
      language: "",
      regions: [],
      targetChannels: [DEFAULT_DIRECT_CHANNEL]
    }
  };
}

function validateDirectMaskEditRequest(request, limits) {
  if (!request.sourceId) {
    throw new WangzhuanError("validation_error", "sourceId 必填", { field: "sourceId" });
  }
  const operationType = request.operationType || DEFAULT_DIRECT_OPERATION;
  const targetChannel = request.targetChannel || DEFAULT_DIRECT_CHANNEL;
  if (!REMIX_OPERATIONS.has(operationType)) {
    throw new WangzhuanError("validation_error", "operationType 不在合同枚举内", { field: "operationType" });
  }
  if (!TARGET_CHANNELS.includes(targetChannel)) {
    throw new WangzhuanError("validation_error", "targetChannel 不在合同枚举内", { field: "targetChannel" });
  }
  return {
    sourceId: String(request.sourceId),
    operationType,
    targetChannel,
    regions: validateRegions(request, limits),
    maskDataUrl: String(request.maskDataUrl || "")
  };
}

function validateEstimateRequest(request, limits) {
  for (const field of ["sourceId", "templateId", "versionId", "operationType", "targetChannel"]) {
    if (!request[field]) throw new WangzhuanError("validation_error", `${field} 必填`, { field });
  }
  if (!REMIX_OPERATIONS.has(request.operationType)) {
    throw new WangzhuanError("validation_error", "operationType 不在合同枚举内", { field: "operationType" });
  }
  if (!TARGET_CHANNELS.includes(request.targetChannel)) {
    throw new WangzhuanError("validation_error", "targetChannel 不在合同枚举内", { field: "targetChannel" });
  }
  return {
    sourceId: String(request.sourceId),
    templateId: String(request.templateId),
    versionId: String(request.versionId),
    operationType: request.operationType,
    targetChannel: request.targetChannel,
    regions: validateRegions(request, limits)
  };
}

function downloadSummary(remix) {
  const outputs = Array.isArray(remix.outputs) ? remix.outputs : [];
  return {
    outputsTotal: outputs.length,
    downloadEligibleCount: outputs.filter((item) => item.downloadEligible).length,
    packageReady: outputs.some((item) => item.downloadEligible),
    missingFiles: []
  };
}

async function writeText(target, text) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

function remixShortId(remixId) {
  return String(remixId || "").split("_").pop();
}

function makeRemixTaskId(remixId) {
  return makeGenerationTaskId(`wzb_19700101000000_${remixShortId(remixId)}`, 1);
}

function makeRemixOutputId(remixId) {
  return makeOutputId(`wzb_19700101000000_${remixShortId(remixId)}`, 1);
}

function promptText(record) {
  const draft = record.templateSnapshot?.draft || {};
  const regionText = record.request.regions.map((item) => {
    if (item.type === "description") return `${item.label}: ${item.description}`;
    return `${item.label}: bbox(${item.bbox.x},${item.bbox.y},${item.bbox.width},${item.bbox.height})`;
  }).join("\n");
  return [
    `Provider: ${record.capability.provider}`,
    `Operation: ${record.request.operationType}`,
    `Product: ${draft.productName || "Product"}`,
    `CTA: ${draft.cta || ""}`,
    `Ending: ${draft.ending || ""}`,
    `Channel: ${record.request.targetChannel}`,
    "Replace or cover only the requested competitor areas. Preserve pacing and layout, but do not copy competitor branding.",
    regionText
  ].join("\n");
}

async function sourceDataUrl(context, source) {
  const buffer = await readFile(resolveUserPath(context, source.storedPath));
  return `data:${source.mimeType || "application/octet-stream"};base64,${buffer.toString("base64")}`;
}

function providerJobId(job) {
  return String(job?.job_id || job?.jobId || job?.id || "");
}

function providerStatus(job) {
  return String(job?.status || "queued");
}

function providerJobSnapshot(job, capability) {
  return {
    jobId: providerJobId(job),
    jobType: job?.job_type || job?.jobType || "mask_edit",
    status: providerStatus(job),
    provider: capability.provider || "video_aigc",
    createdAt: job?.created_at || job?.createdAt || null,
    updatedAt: job?.updated_at || job?.updatedAt || null,
    startedAt: job?.started_at || job?.startedAt || null,
    finishedAt: job?.finished_at || job?.finishedAt || null
  };
}

function remixStatusFromProvider(status) {
  if (status === "failed") return "failed";
  if (status === "canceled") return "stopped";
  if (status === "review_required") return "preview_required";
  if (status === "running") return "running";
  return "queued";
}

function providerPayload(record, source) {
  const draft = record.templateSnapshot?.draft || {};
  return {
    job_type: "mask_edit",
    input: {
      source_type: "base64_data_url",
      source
    },
    callback_url: null,
    options: {
      priority: 0
    },
    params: {
      mode: "manual",
      operation_type: record.request.operationType,
      target_channel: record.request.targetChannel,
      regions: record.request.regions,
      mask_source: {
        mode: "manual",
        regions: record.request.regions
      },
      product_context: {
        product_name: draft.productName || "",
        cta: draft.cta || "",
        ending: draft.ending || "",
        language: draft.language || "",
        regions: draft.regions || []
      }
    }
  };
}

function fullSourceTimeRange(source = {}) {
  const durationMs = Math.round(Number(source.durationSec || 0) * 1000);
  return [{
    start_ms: 0,
    end_ms: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1
  }];
}

function providerPayloadWithMask(record, source, maskDataUrl) {
  const payload = providerPayload(record, source);
  return {
    ...payload,
    job_type: "ai_remove",
    params: {
      mode: "manual",
      mask_source_type: "base64_data_url",
      mask_source: maskDataUrl,
      time_ranges: fullSourceTimeRange(record.source),
      mask_threshold: 1
    }
  };
}

async function materializeProviderSubmission(context, record, remixId, capability, options = {}) {
  const client = createRemixProviderClient(context, capability);
  if (!client) {
    throw new WangzhuanError("unsupported_capability", "竞品改造接口未配置，无法创建视频处理任务", {
      capability: {
        ...capability,
        status: "unsupported",
        unsupportedReason: "missing video processing endpoint"
      }
    });
  }
  const taskId = makeRemixTaskId(remixId);
  const promptTarget = join(remixDir(context, remixId), "prompts", `${taskId}_remix.txt`);
  const promptPath = toProjectRelative(context.userProjectRoot, promptTarget);
  await writeText(promptTarget, `${promptText(record)}\n`);
  const source = await sourceDataUrl(context, record.source);
  const payload = options.maskDataUrl
    ? providerPayloadWithMask(record, source, options.maskDataUrl)
    : providerPayload(record, source);
  const job = await client.createJob(payload);
  const jobSnapshot = providerJobSnapshot(job, capability);
  if (!jobSnapshot.jobId) {
    throw new WangzhuanError("upstream_failed", "视频处理平台未返回 job_id", {
      provider: capability.provider || "video_aigc"
    });
  }
  const now = new Date().toISOString();
  return {
    providerJob: jobSnapshot,
    tasks: [{
      generationTaskId: taskId,
      remixId,
      status: remixStatusFromProvider(jobSnapshot.status),
      modelImage: "not_required",
      modelVideo: capability.provider || client.provider || REMIX_MODEL_VIDEO,
      providerJobId: jobSnapshot.jobId,
      seedanceTaskId: jobSnapshot.jobId,
      promptPath,
      remoteUrlStored: false,
      attempts: 1,
      startedAt: now,
      finishedAt: null
    }]
  };
}

async function writeTaskMap(context, remix) {
  const targetDir = join(remixDir(context, remix.remixId), "task-map");
  const jsonPath = join(targetDir, "task-id-map.json");
  await writeAtomicJson(jsonPath, remix.tasks);
  const output = remix.outputs[0];
  const task = remix.tasks[0];
  const headers = [
    "source_type",
    "remix_id",
    "script_id",
    "generation_task_id",
    "image_task_id",
    "seedance_task_id",
    "model_image",
    "model_video",
    "output_id",
    "output_file",
    "qc_status",
    "error_code"
  ];
  const row = [
    "remix",
    remix.remixId,
    "",
    task.generationTaskId,
    task.imageTaskId || "",
    task.seedanceTaskId || "",
    task.modelImage,
    task.modelVideo,
    output?.outputId || "",
    output?.filePath || "",
    output?.qcStatus || "",
    task.errorCode || ""
  ];
  const csv = [headers, row].map((values) => values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  await writeText(join(targetDir, "task-id-map.csv"), `${csv}\n`);
}

async function writeQcReport(context, remix, output, qcStatus) {
  const report = {
    schemaVersion: "qc_report.v1",
    outputId: output.outputId,
    sourceType: "remix",
    remixId: remix.remixId,
    qcStatus,
    visualPreviewRequired: true,
    previewConfirmed: Boolean(output.previewConfirmed),
    checks: [
      {
        checkId: "template_snapshot",
        status: remix.templateSnapshot?.templateId && remix.templateSnapshot?.versionId ? "pass" : "fail",
        severity: remix.templateSnapshot?.templateId && remix.templateSnapshot?.versionId ? "info" : "fail",
        message: "模板快照检查"
      },
      {
        checkId: "prompt_schema",
        status: output.promptPath && existsSync(resolveUserPath(context, output.promptPath)) ? "pass" : "fail",
        severity: output.promptPath && existsSync(resolveUserPath(context, output.promptPath)) ? "info" : "fail",
        message: "remix prompt 文件检查"
      },
      {
        checkId: "task_id_presence",
        status: remix.tasks?.[0]?.seedanceTaskId ? "pass" : "fail",
        severity: remix.tasks?.[0]?.seedanceTaskId ? "info" : "fail",
        message: "remix provider task_id 检查"
      },
      {
        checkId: "visual_preview_gate",
        status: output.previewConfirmed ? "pass" : "manual_required",
        severity: output.previewConfirmed ? "info" : "manual_required",
        message: output.previewConfirmed ? "人工预览已确认" : "remix 需要人工预览确认"
      }
    ],
    summary: output.previewConfirmed ? "Preview confirmed" : "Preview confirmation required",
    createdAt: new Date().toISOString()
  };
  const target = join(remixDir(context, remix.remixId), "qc", `${output.outputId}.json`);
  await writeAtomicJson(target, report);
  return toProjectRelative(context.userProjectRoot, target);
}

async function materializeMockRemix(context, record, remixId) {
  const taskId = makeRemixTaskId(remixId);
  const outputId = makeRemixOutputId(remixId);
  const promptTarget = join(remixDir(context, remixId), "prompts", `${taskId}_remix.txt`);
  const outputTarget = join(remixDir(context, remixId), "outputs", `${outputId}.mp4`);
  const promptPath = toProjectRelative(context.userProjectRoot, promptTarget);
  const filePath = toProjectRelative(context.userProjectRoot, outputTarget);
  await writeText(promptTarget, `${promptText(record)}\n`);
  await writeText(outputTarget, [
    "mock remix video",
    `remix=${remixId}`,
    `operation=${record.request.operationType}`,
    `provider=${record.capability.provider}`
  ].join("\n"));
  const storage = await syncWangzhuanAsset(context, outputTarget, "remix_output_video");
  return {
    tasks: [{
      generationTaskId: taskId,
      remixId,
      status: "qc",
      modelImage: "not_required",
      modelVideo: record.capability.provider || REMIX_MODEL_VIDEO,
      seedanceTaskId: `mock_remix_${taskId}`,
      promptPath,
      outputPath: filePath,
      remoteUrlStored: false,
      attempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    }],
    output: {
      outputId,
      sourceType: "remix",
      remixId,
      generationTaskIds: [taskId],
      durationSec: Number(record.source?.durationSec || 15),
      kind: "remix_video",
      filePath,
      previewUrl: storage?.storageUrl || await previewUrlForWangzhuanAsset(context, filePath),
      ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl } : {}),
      promptPath,
      qcStatus: "manual_required",
      downloadEligible: false,
      visualPreviewRequired: true,
      previewConfirmed: false
    }
  };
}

async function materializeProviderOutput(context, remix, jobSnapshot, outputBuffer) {
  const task = remix.tasks?.[0];
  const taskId = task?.generationTaskId || makeRemixTaskId(remix.remixId);
  const outputId = makeRemixOutputId(remix.remixId);
  const outputTarget = join(remixDir(context, remix.remixId), "outputs", `${outputId}.mp4`);
  const filePath = toProjectRelative(context.userProjectRoot, outputTarget);
  await mkdir(dirname(outputTarget), { recursive: true });
  await writeFile(outputTarget, outputBuffer);
  const storage = await syncWangzhuanAsset(context, outputTarget, "remix_output_video");
  const output = {
    outputId,
    sourceType: "remix",
    remixId: remix.remixId,
    generationTaskIds: [taskId],
    durationSec: Number(remix.source?.durationSec || 15),
    kind: "remix_video",
    filePath,
    previewUrl: storage?.storageUrl || await previewUrlForWangzhuanAsset(context, filePath),
    ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl } : {}),
    promptPath: task?.promptPath || "",
    qcStatus: "manual_required",
    downloadEligible: false,
    visualPreviewRequired: true,
    previewConfirmed: false
  };
  const nextTask = {
    ...task,
    status: "qc",
    providerJobId: jobSnapshot.jobId,
    seedanceTaskId: jobSnapshot.jobId,
    outputPath: filePath,
    finishedAt: new Date().toISOString()
  };
  const nextRemix = {
    ...remix,
    status: "preview_required",
    providerJob: jobSnapshot,
    tasks: [nextTask],
    outputs: [output],
    qcSummary: {
      total: 1,
      passed: 0,
      failed: 1,
      warnings: [{ outputId, qcStatus: "manual_required" }]
    }
  };
  const qcReportPath = await writeQcReport(context, nextRemix, output, "manual_required");
  return {
    ...nextRemix,
    outputs: [{ ...output, qcReportPath }]
  };
}

async function findActiveRemix(context) {
  const index = await readJsonOrDefault(join(wangzhuanPaths(context).remixDir, "index.json"), {
    schemaVersion: "remix.v1",
    items: []
  });
  for (const item of Array.isArray(index.items) ? index.items : []) {
    const target = remixPath(context, item.remixId);
    if (!existsSync(target)) continue;
    const remix = JSON.parse(await readFile(target, "utf8"));
    if (ACTIVE_REMIX_STATUSES.has(remix.status)) return remix;
  }
  return null;
}

async function findActiveBatch(context) {
  const index = await readJsonOrDefault(join(wangzhuanPaths(context).batchesDir, "index.json"), {
    schemaVersion: "batches.v1",
    items: []
  });
  for (const item of Array.isArray(index.items) ? index.items : []) {
    const target = join(wangzhuanPaths(context).batchesDir, item.batchId, "batch.json");
    if (!existsSync(target)) continue;
    const batch = JSON.parse(await readFile(target, "utf8"));
    if (["checking", "queued", "running", "stitching", "qc"].includes(batch.status)) return batch;
  }
  return null;
}

export async function uploadRemixSource(context, request = {}) {
  const paths = wangzhuanPaths(context);
  const limits = effectiveLimits(context.config || {});
  const fileName = safeFileName(request.fileName || request.name);
  const ext = extname(fileName).toLowerCase();
  const mimeType = String(request.mimeType || "").toLowerCase();
  if (!MATERIAL_EXTS.has(ext) || (mimeType && !MATERIAL_MIME_TYPES.has(mimeType))) {
    throw new WangzhuanError("invalid_material", "素材不符合要求，请上传图片或视频", { field: "fileName", allowedExts: [...MATERIAL_EXTS] });
  }
  const buffer = parseUploadContent(request.content);
  if (buffer.length > limits.maxUploadVideoBytes) {
    throw new WangzhuanError("file_too_large", "文件超过大小上限", {
      sizeBytes: buffer.length,
      maxUploadVideoBytes: limits.maxUploadVideoBytes
    });
  }

  const { sourceId, indexPath, index } = await nextSourceSeq(paths);
  const sourceRoot = sourceDir(context, sourceId);
  await mkdir(sourceRoot, { recursive: true });
  const originalPath = join(sourceRoot, `original${ext}`);
  await writeFile(originalPath, buffer);
  const storage = await syncWangzhuanAsset(context, originalPath, "remix_source");
  const mediaProbe = await probeRemixSource(context, originalPath, request, mimeType);
  const width = mediaProbe.width;
  const height = mediaProbe.height;
  const probe = {
    sourceId,
    fileName,
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: buffer.length,
    durationSec: mediaProbe.durationSec,
    width,
    height,
    ratio: mediaProbe.ratio,
    formatName: mediaProbe.formatName,
    bitRateBps: mediaProbe.bitRateBps,
    videoCodec: mediaProbe.videoCodec,
    fps: mediaProbe.fps,
    colorSpace: mediaProbe.colorSpace,
    pixelFormat: mediaProbe.pixelFormat,
    audioStreamCount: mediaProbe.audioStreamCount,
    audioStreams: mediaProbe.audioStreams,
    canExtractFrame: mediaProbe.canExtractFrame,
    kind: mimeType.startsWith("image/") ? "image" : "video",
    status: "pass",
    issues: [],
    storedPath: toProjectRelative(context.userProjectRoot, originalPath),
    ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl } : {}),
    userId: currentUserId(context),
    createdAt: new Date().toISOString()
  };
  await writeAtomicJson(join(sourceRoot, "source-probe.json"), probe);
  index.items.push({
    sourceId,
    createdBy: currentUserId(context),
    createdAt: probe.createdAt
  });
  await writeAtomicJson(indexPath, index);
  await recordTelemetryEvent(context, "competitor_material_uploaded", {
    remixSourceId: sourceId,
    mimeType: probe.mimeType,
    sizeBytes: probe.sizeBytes
  });
  return {
    sourceId,
    probe,
    previewUrl: storage?.storageUrl || await previewUrlForWangzhuanAsset(context, probe.storedPath)
  };
}

export async function startDirectMaskEdit(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const paths = wangzhuanPaths(context);
  const replay = await readIdempotentResult(paths, "remix_mask_edit_start", request.idempotencyKey);
  if (replay) return replay;
  if (context.getLegacyRunState?.()?.running) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "existing_ad_batch"
    });
  }
  await assertNoMysqlResourceLock(context);
  const activeBatch = await findActiveBatch(context);
  if (activeBatch) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "pipeline_batch",
      batchId: activeBatch.batchId,
      status: activeBatch.status
    });
  }
  const active = await findActiveRemix(context);
  if (active) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      remixId: active.remixId,
      status: active.status
    });
  }

  const normalized = validateDirectMaskEditRequest(request, effectiveLimits(context.config || {}));
  const source = await loadSourceProbe(context, normalized.sourceId);
  const capability = preflightRemixProvider(context, normalized.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }
  const maskBuffer = parseMaskDataUrl(normalized.maskDataUrl);
  const remixId = makeRemixId();
  const now = new Date().toISOString();
  const targetDir = remixDir(context, remixId);
  const maskTarget = join(targetDir, "regions", "mask.png");
  await mkdir(dirname(maskTarget), { recursive: true });
  await writeFile(maskTarget, maskBuffer);
  const maskSource = {
    sourceType: "base64_data_url",
    mimeType: "image/png",
    storedPath: toProjectRelative(context.userProjectRoot, maskTarget)
  };
  const record = {
    schemaVersion: "remix-direct-mask-edit.v1",
    request: {
      sourceId: normalized.sourceId,
      operationType: normalized.operationType,
      targetChannel: normalized.targetChannel,
      regions: normalized.regions
    },
    source,
    templateSnapshot: directTemplateSnapshot(),
    capability,
    userId: currentUserId(context),
    createdAt: now
  };
  const materialized = hasRemoteRemixProvider(context, capability)
    ? await materializeProviderSubmission(context, record, remixId, capability, { maskDataUrl: normalized.maskDataUrl })
    : await materializeMockRemix(context, record, remixId);
  let remix = hasRemoteRemixProvider(context, capability) ? {
    remixId,
    type: "remix",
    status: remixStatusFromProvider(materialized.providerJob.status),
    userId: currentUserId(context),
    sourceId: source.sourceId,
    source,
    operationType: normalized.operationType,
    regions: normalized.regions,
    targetChannel: normalized.targetChannel,
    templateSnapshot: record.templateSnapshot,
    capability,
    maskSource,
    providerJob: materialized.providerJob,
    tasks: materialized.tasks,
    outputs: [],
    qcSummary: {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: []
    },
    createdAt: now,
    updatedAt: now
  } : {
    remixId,
    type: "remix",
    status: "preview_required",
    userId: currentUserId(context),
    sourceId: source.sourceId,
    source,
    operationType: normalized.operationType,
    regions: normalized.regions,
    targetChannel: normalized.targetChannel,
    templateSnapshot: record.templateSnapshot,
    capability,
    maskSource,
    tasks: materialized.tasks,
    outputs: [materialized.output],
    qcSummary: {
      total: 1,
      passed: 0,
      failed: 1,
      warnings: [{ outputId: materialized.output.outputId, qcStatus: "manual_required" }]
    },
    createdAt: now,
    updatedAt: now
  };
  if (!hasRemoteRemixProvider(context, capability)) {
    const qcReportPath = await writeQcReport(context, remix, materialized.output, "manual_required");
    remix.outputs[0] = { ...materialized.output, qcReportPath };
  }
  await writeAtomicJson(join(targetDir, "regions", "regions.json"), remix.regions);
  remix = await writeRemix(context, remix);
  await writeTaskMap(context, remix);
  const result = { remix, downloadSummary: downloadSummary(remix) };
  await writeIdempotentResult(paths, "remix_mask_edit_start", request.idempotencyKey, result);
  return result;
}

export async function estimateRemix(context, request = {}) {
  const paths = wangzhuanPaths(context);
  const limits = effectiveLimits(context.config || {});
  const normalized = validateEstimateRequest(request, limits);
  const source = await loadSourceProbe(context, normalized.sourceId);
  const templateSnapshot = await loadTemplateVersion(context, normalized.templateId, normalized.versionId);
  const capability = preflightRemixProvider(context, normalized.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }

  const { estimateId, indexPath, index } = await nextEstimateSeq(paths);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: "remix-estimate.v1",
    estimateId,
    request: normalized,
    estimateHash: hashPayload(normalized),
    source,
    templateSnapshot,
    capability,
    limits,
    userId: currentUserId(context),
    createdAt: now
  };
  await writeAtomicJson(join(paths.remixEstimatesDir, estimateId, "estimate.json"), record);
  index.items.push({ estimateId, createdBy: currentUserId(context), createdAt: now });
  await writeAtomicJson(indexPath, index);
  return {
    estimateId,
    capability,
    confirmationRequired: false,
    warnings: []
  };
}

export async function loadRemixEstimate(context, estimateId) {
  validateEstimateId(estimateId);
  const target = join(wangzhuanPaths(context).remixEstimatesDir, estimateId, "estimate.json");
  if (!existsSync(target)) {
    throw new WangzhuanError("validation_error", "estimate 不存在，请重新估算", { estimateId });
  }
  return JSON.parse(await readFile(target, "utf8"));
}

export async function startRemix(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const paths = wangzhuanPaths(context);
  const replay = await readIdempotentResult(paths, "remix_start", request.idempotencyKey);
  if (replay) return replay;
  if (context.getLegacyRunState?.()?.running) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "existing_ad_batch"
    });
  }
  await assertNoMysqlResourceLock(context);
  const activeBatch = await findActiveBatch(context);
  if (activeBatch) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "pipeline_batch",
      batchId: activeBatch.batchId,
      status: activeBatch.status
    });
  }
  const active = await findActiveRemix(context);
  if (active) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      remixId: active.remixId,
      status: active.status
    });
  }

  const record = await loadRemixEstimate(context, request.estimateId);
  if (record.estimateHash !== hashPayload(record.request)) {
    throw new WangzhuanError("validation_error", "estimate 已失效，请重新估算", { estimateId: request.estimateId });
  }
  const capability = preflightRemixProvider(context, record.request.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }

  const remixId = makeRemixId();
  const now = new Date().toISOString();
  const remoteEnabled = hasRemoteRemixProvider(context, capability);
  const materialized = remoteEnabled
    ? await materializeProviderSubmission(context, { ...record, capability }, remixId, capability)
    : await materializeMockRemix(context, { ...record, capability }, remixId);
  let remix = remoteEnabled ? {
    remixId,
    type: "remix",
    status: remixStatusFromProvider(materialized.providerJob.status),
    userId: currentUserId(context),
    sourceId: record.source.sourceId,
    source: record.source,
    operationType: record.request.operationType,
    regions: record.request.regions,
    targetChannel: record.request.targetChannel,
    templateSnapshot: record.templateSnapshot,
    capability,
    providerJob: materialized.providerJob,
    tasks: materialized.tasks,
    outputs: [],
    qcSummary: {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: []
    },
    createdAt: now,
    updatedAt: now
  } : {
    remixId,
    type: "remix",
    status: "preview_required",
    userId: currentUserId(context),
    sourceId: record.source.sourceId,
    source: record.source,
    operationType: record.request.operationType,
    regions: record.request.regions,
    targetChannel: record.request.targetChannel,
    templateSnapshot: record.templateSnapshot,
    capability,
    tasks: materialized.tasks,
    outputs: [materialized.output],
    qcSummary: {
      total: 1,
      passed: 0,
      failed: 1,
      warnings: [{ outputId: materialized.output.outputId, qcStatus: "manual_required" }]
    },
    createdAt: now,
    updatedAt: now
  };
  if (!remoteEnabled) {
    const qcReportPath = await writeQcReport(context, remix, materialized.output, "manual_required");
    remix.outputs[0] = { ...materialized.output, qcReportPath };
  }
  await writeAtomicJson(join(remixDir(context, remixId), "regions", "regions.json"), remix.regions);
  remix = await writeRemix(context, remix);
  await writeTaskMap(context, remix);
  const result = { remix, downloadSummary: downloadSummary(remix) };
  await writeIdempotentResult(paths, "remix_start", request.idempotencyKey, result);
  return result;
}

export async function getRemixDetail(context, remixId) {
  const remix = await readRemix(context, remixId);
  if (remix.providerJob?.jobId && ["queued", "running"].includes(remix.status)) {
    const client = createRemixProviderClient(context, remix.capability || {});
    if (client) {
      const job = await client.getJob(remix.providerJob.jobId);
      const jobSnapshot = providerJobSnapshot(job, remix.capability || {});
      let nextRemix = {
        ...remix,
        status: remixStatusFromProvider(jobSnapshot.status),
        providerJob: jobSnapshot,
        tasks: (remix.tasks || []).map((task) => ({
          ...task,
          status: remixStatusFromProvider(jobSnapshot.status),
          providerJobId: jobSnapshot.jobId,
          seedanceTaskId: jobSnapshot.jobId
        }))
      };
      if (jobSnapshot.status === "succeeded" || jobSnapshot.status === "review_required") {
        nextRemix = await materializeProviderOutput(context, nextRemix, jobSnapshot, await client.downloadJob(jobSnapshot.jobId));
      }
      if (jobSnapshot.status === "failed") {
        nextRemix = {
          ...nextRemix,
          status: "failed",
          qcSummary: {
            total: 0,
            passed: 0,
            failed: 1,
            warnings: [{ providerJobId: jobSnapshot.jobId, qcStatus: "fail" }]
          }
        };
      }
      const saved = await writeRemix(context, nextRemix);
      await writeTaskMap(context, saved);
      return {
        remix: saved,
        downloadSummary: downloadSummary(saved)
      };
    }
  }
  return {
    remix,
    downloadSummary: downloadSummary(remix)
  };
}

export async function stopRemix(context, remixId, request = {}) {
  const remix = await readRemix(context, remixId);
  if (!STOPPABLE_REMIX_STATUSES.has(remix.status)) {
    throw new WangzhuanError("not_running", "改造任务当前状态不可停止", { remixId, status: remix.status });
  }
  const now = new Date().toISOString();
  const reason = String(request.reason || "user_stopped").trim() || "user_stopped";
  const nextRemix = {
    ...remix,
    status: "stopped",
    stoppedAt: now,
    stopReason: reason,
    providerJob: remix.providerJob
      ? {
          ...remix.providerJob,
          status: remix.providerJob.status === "succeeded" ? remix.providerJob.status : "canceled",
          finishedAt: remix.providerJob.finishedAt || now
        }
      : remix.providerJob,
    tasks: (Array.isArray(remix.tasks) ? remix.tasks : []).map((task) => ({
      ...task,
      status: "stopped",
      errorCode: reason,
      finishedAt: task.finishedAt || now
    })),
    qcSummary: {
      total: remix.qcSummary?.total || 0,
      passed: remix.qcSummary?.passed || 0,
      failed: remix.qcSummary?.failed || 0,
      warnings: [
        ...(Array.isArray(remix.qcSummary?.warnings) ? remix.qcSummary.warnings : []),
        { remixId, qcStatus: "stopped", reason }
      ]
    }
  };
  const saved = await writeRemix(context, nextRemix);
  await writeTaskMap(context, saved);
  await recordTelemetryEvent(context, "competitor_remix_stopped", {
    remixId: saved.remixId,
    providerJobId: saved.providerJob?.jobId || "",
    reason
  }, { audit: true });
  return {
    remix: saved,
    downloadSummary: downloadSummary(saved)
  };
}

async function writePreviewConfirmation(context, remix, output, request) {
  const confirmation = {
    schemaVersion: "preview_confirmation.v1",
    remixId: remix.remixId,
    outputId: output.outputId,
    confirmedBy: currentUserId(context),
    confirmedAt: remix.previewConfirmedAt,
    notes: String(request.notes || "")
  };
  await writeAtomicJson(join(remixDir(context, remix.remixId), "preview-confirmation.json"), confirmation);
  return confirmation;
}

export async function confirmRemixPreview(context, remixId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const paths = wangzhuanPaths(context);
  const replay = await readIdempotentResult(paths, "remix_preview_confirm", request.idempotencyKey, remixId);
  if (replay) return replay;
  const remix = await readRemix(context, remixId);
  const outputId = request.outputId || remix.outputs?.[0]?.outputId;
  const output = (Array.isArray(remix.outputs) ? remix.outputs : []).find((item) => item.outputId === outputId);
  if (!output) {
    throw new WangzhuanError("output_not_found", "输出文件不存在", { remixId, outputId });
  }
  const now = new Date().toISOString();
  const nextOutput = {
    ...output,
    qcStatus: "pass",
    downloadEligible: true,
    visualPreviewRequired: true,
    previewConfirmed: true
  };
  const nextRemix = {
    ...remix,
    status: "succeeded",
    outputs: remix.outputs.map((item) => item.outputId === outputId ? nextOutput : item),
    previewConfirmedBy: currentUserId(context),
    previewConfirmedAt: now,
    qcSummary: {
      total: remix.outputs.length,
      passed: 1,
      failed: 0,
      warnings: []
    }
  };
  await writePreviewConfirmation(context, nextRemix, nextOutput, request);
  const qcReportPath = await writeQcReport(context, nextRemix, nextOutput, "pass");
  const saved = await writeRemix(context, {
    ...nextRemix,
    outputs: nextRemix.outputs.map((item) => item.outputId === outputId ? { ...nextOutput, qcReportPath } : item)
  });
  await writeTaskMap(context, saved);
  await recordTelemetryEvent(context, "competitor_preview_confirmed", {
    remixId: saved.remixId,
    outputId,
    confirmed: true,
    confirmedBy: saved.previewConfirmedBy
  }, { audit: true });
  const result = { remix: saved, downloadSummary: downloadSummary(saved) };
  await writeIdempotentResult(paths, "remix_preview_confirm", request.idempotencyKey, result, remixId);
  return result;
}
