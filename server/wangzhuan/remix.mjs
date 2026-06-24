import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "node:path";

import { effectiveLimits } from "./config.mjs";
import { TARGET_CHANNELS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { buildRemixPlan } from "./remix-plan.mjs";
import { evaluateRemixQc } from "./remix-qc.mjs";
import { createRemixProviderClient, hasRemoteRemixProvider } from "./remix-provider.mjs";
import { ffprobeMediaFile } from "./reference-videos.mjs";
import {
  makeGenerationTaskId,
  makeRemixId,
  makeOutputId
} from "./ids.mjs";
import {
  openWangzhuanObjectStream,
  syncWangzhuanAsset,
  toProjectRelative,
  wangzhuanPaths,
  writeAtomicJson
} from "./storage.mjs";
import {
  findActiveResourceLock,
  loadActivePipelineRunFromMysql,
  loadActiveRemixFromMysql,
  loadBlockingRemixForSourceFromMysql,
  loadEstimateFromMysql,
  loadIdempotencyFactFromMysql,
  loadRemixDetailFromMysql,
  loadRemixSourceFromMysql,
  loadTemplateStoreFromMysql,
  nextRemixEstimateIdFromMysql,
  nextRemixSourceIdFromMysql,
  recordIdempotencyFact,
  syncEstimateFact,
  syncRemixFacts,
  syncRemixSourceFact
} from "./mysql-facts.mjs";
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
const AUTO_DETECT_CAPABILITY_KEYS = new Set(["product_name", "cta", "subtitle", "ending"]);
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
  const runningResource = activeMysqlLock.runType === "pipeline"
    ? "pipeline_batch"
    : activeMysqlLock.runType === "remix"
      ? "remix"
      : activeMysqlLock.runType || "mysql_resource_lock";
  throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
    runningResource,
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
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
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

async function nextSourceSeq(context) {
  const sourceId = await nextRemixSourceIdFromMysql(context);
  if (!sourceId) throw new WangzhuanError("database_unavailable", "MySQL 未就绪，无法创建素材记录", {});
  return sourceId;
}

async function nextEstimateSeq(context) {
  const estimateId = await nextRemixEstimateIdFromMysql(context);
  if (!estimateId) throw new WangzhuanError("database_unavailable", "MySQL 未就绪，无法创建估算记录", {});
  return estimateId;
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
  const store = await loadTemplateStoreFromMysql(context);
  if (!store) {
    throw new WangzhuanError("database_unavailable", "MySQL 未就绪，无法读取模板配置", { templateId, versionId });
  }
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
  const probe = await loadRemixSourceFromMysql(context, sourceId);
  if (!probe) {
    throw new WangzhuanError("invalid_material", "素材不符合要求，请上传图片或视频", { sourceId });
  }
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
  validateRemixId(remixId);
  const detail = await loadRemixDetailFromMysql(context, remixId);
  const remix = detail?.remix;
  if (!remix) {
    throw new WangzhuanError("remix_not_found", "改造任务不存在或无权限", { remixId });
  }
  if (remix.userId !== currentUserId(context) && !isAdmin(context)) {
    throw new WangzhuanError("permission_denied", "当前账号无权执行该操作", { remixId });
  }
  return remix;
}

async function writeRemix(context, remix, triggerName = "remix_write") {
  const now = new Date().toISOString();
  const next = { ...remix, updatedAt: now };
  const synced = await syncRemixFacts(context, next, triggerName);
  if (synced.skipped) {
    throw new WangzhuanError("database_unavailable", "MySQL 写入失败，改造任务未保存", { remixId: next.remixId });
  }
  return (await loadRemixDetailFromMysql(context, next.remixId))?.remix || next;
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
      return {
        regionId,
        type,
        label,
        ...(item.capabilityKey ? { capabilityKey: String(item.capabilityKey) } : {}),
        ...(item.keyframe ? { keyframe: validateKeyframeRequest(item.keyframe) } : {}),
        bbox: { x: Number(bbox.x), y: Number(bbox.y), width: Number(bbox.width), height: Number(bbox.height) }
      };
    }
    const description = String(item.description || "").trim();
    if (!description) {
      throw new WangzhuanError("validation_error", "描述区域不能为空", { field: `regions[${index}].description` });
    }
    return {
      regionId,
      type,
      label,
      ...(item.capabilityKey ? { capabilityKey: String(item.capabilityKey) } : {}),
      ...(item.keyframe ? { keyframe: validateKeyframeRequest(item.keyframe) } : {}),
      description
    };
  });
}

function validateKeyframeRequest(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const frameIndex = Number(input.frameIndex);
  const frameTimeSec = Number(input.frameTimeSec);
  const fps = Number(input.fps);
  return {
    frameIndex: Number.isFinite(frameIndex) && frameIndex >= 0 ? Math.round(frameIndex) : 0,
    frameTimeSec: Number.isFinite(frameTimeSec) && frameTimeSec >= 0 ? Math.round(frameTimeSec * 100) / 100 : 0,
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 30,
    actionMode: input.actionMode === "replace_cover" ? "replace_cover" : "remove",
    maskSource: input.maskSource === "uploaded_mask" ? "uploaded_mask" : "generated_mask",
    uploadedMaskName: input.uploadedMaskName ? String(input.uploadedMaskName).slice(0, 160) : ""
  };
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
    regions: request.autoDetect ? [] : validateRegions(request, limits),
    maskDataUrl: String(request.maskDataUrl || ""),
    autoDetect: Boolean(request.autoDetect),
    capabilityKey: String(request.capabilityKey || ""),
    jobType: String(request.jobType || ""),
    keyframe: validateKeyframeRequest(request.keyframe)
  };
}

function validateEstimateRequest(request, limits) {
  for (const field of ["sourceId", "operationType", "targetChannel"]) {
    if (!request[field]) throw new WangzhuanError("validation_error", `${field} 必填`, { field });
  }
  if (!REMIX_OPERATIONS.has(request.operationType)) {
    throw new WangzhuanError("validation_error", "operationType 不在合同枚举内", { field: "operationType" });
  }
  if (!TARGET_CHANNELS.includes(request.targetChannel)) {
    throw new WangzhuanError("validation_error", "targetChannel 不在合同枚举内", { field: "targetChannel" });
  }
  const autoDetect = Boolean(request.autoDetect);
  const capabilityKey = String(request.capabilityKey || "");
  const allowEmptyRegions = autoDetect && AUTO_DETECT_CAPABILITY_KEYS.has(capabilityKey);
  return {
    sourceId: String(request.sourceId),
    templateId: request.templateId ? String(request.templateId) : "",
    versionId: request.versionId ? String(request.versionId) : "",
    operationType: request.operationType,
    targetChannel: request.targetChannel,
    regions: allowEmptyRegions ? [] : validateRegions(request, limits),
    autoDetect,
    capabilityKey,
    jobType: String(request.jobType || ""),
    maskDataUrl: String(request.maskDataUrl || ""),
    keyframe: validateKeyframeRequest(request.keyframe)
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

async function syncRelativeAsset(context, fullPath, assetKind) {
  const storage = await syncWangzhuanAsset(context, fullPath, assetKind, { required: true });
  return {
    storedPath: toProjectRelative(context.userProjectRoot, fullPath),
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl
  };
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
    `Capability: ${record.request.capabilityKey || "region_mask"}`,
    `Job type: ${record.request.jobType || "mask_edit"}`,
    `Auto detect: ${record.request.autoDetect ? "yes" : "no"}`,
    `Key frame: ${record.request.keyframe?.frameIndex ?? 0} @ ${record.request.keyframe?.frameTimeSec ?? 0}s`,
    `Frame action: ${record.request.keyframe?.actionMode || "remove"}`,
    `Product: ${draft.productName || "Product"}`,
    `CTA: ${draft.cta || ""}`,
    `Ending: ${draft.ending || ""}`,
    `Channel: ${record.request.targetChannel}`,
    "Seedance-style video edit instruction:",
    "删除元素：删除指定区域的竞品元素，视频其他内容保持不变。",
    "修改元素：将指定区域替换为我方产品、CTA、logo 或下载引导，动作和运镜不变。",
    "增加元素：在指定时间/空间位置增加我方元素，不遮挡主体、不破坏原画面节奏。",
    "Preserve motion, camera, timing, background, and layout.",
    "Replace or cover only the requested competitor areas.",
    "Do not copy competitor branding, watermark, UI details, original subtitles, voiceover copy, or unique character identity.",
    regionText
  ].join("\n");
}

async function sourceDataUrl(context, source) {
  let buffer = null;
  if (source.storageKey) {
    try {
      const object = await openWangzhuanObjectStream(context, source.storageKey);
      const chunks = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
      buffer = Buffer.concat(chunks);
    } catch {
      buffer = null;
    }
  }
  if (!buffer) {
    buffer = await readFile(resolveUserPath(context, source.storedPath));
  }
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
    finishedAt: job?.finished_at || job?.finishedAt || null,
    downloadUrl: job?.download_url || job?.downloadUrl || job?.output_url || job?.outputUrl || job?.result_url || job?.resultUrl || ""
  };
}

function remixStatusFromProvider(status) {
  if (status === "failed") return "failed";
  if (status === "canceled") return "stopped";
  if (status === "review_required") return "preview_required";
  if (status === "running") return "running";
  return "queued";
}

function remixFailureFromError(error) {
  return error instanceof WangzhuanError && error.code === "upstream_failed"
    ? {
        code: error.code,
        message: error.message,
        ...error.data
      }
    : {
        code: "upstream_failed",
        message: "视频处理平台下载失败"
      };
}

function providerPayload(record, source) {
  const draft = record.templateSnapshot?.draft || {};
  const autoDetect = Boolean(record.request.autoDetect);
  return {
    job_type: autoDetect ? (record.request.jobType || "auto_detect") : "mask_edit",
    input: {
      source_type: "base64_data_url",
      source
    },
    callback_url: null,
    options: {
      priority: 0
    },
    params: {
      mode: autoDetect ? "auto_detect" : "manual",
      operation_type: record.request.operationType,
      target_channel: record.request.targetChannel,
      capability_key: record.request.capabilityKey || undefined,
      keyframe: record.request.keyframe || undefined,
      frame_index: record.request.keyframe?.frameIndex,
      frame_time_sec: record.request.keyframe?.frameTimeSec,
      action_mode: record.request.keyframe?.actionMode,
      regions: record.request.regions,
      ...(!autoDetect ? { mask_source: {
        mode: "manual",
        regions: record.request.regions
      } } : {}),
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
      keyframe: record.request.keyframe || undefined,
      frame_index: record.request.keyframe?.frameIndex,
      frame_time_sec: record.request.keyframe?.frameTimeSec,
      action_mode: record.request.keyframe?.actionMode,
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
  await writeText(promptTarget, `${promptText(record)}\n`);
  const promptAsset = await syncRelativeAsset(context, promptTarget, "remix_prompt");
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
      promptPath: promptAsset.storedPath,
      promptStorageKey: promptAsset.storageKey || "",
      promptStorageUrl: promptAsset.storageUrl || "",
      remoteUrlStored: false,
      attempts: 1,
      startedAt: now,
      finishedAt: null
    }]
  };
}

function assertRemoteRemixProvider(context, capability) {
  if (!hasRemoteRemixProvider(context, capability)) {
    throw new WangzhuanError("unsupported_capability", "竞品改造接口未配置，无法创建视频处理任务", {
      capability: {
        ...capability,
        status: "unsupported",
        unsupportedReason: "missing video processing endpoint"
      }
    });
  }
}

async function writeQcReport(context, remix, output, qcStatus) {
  const autoQc = output.autoQc || null;
  const report = {
    schemaVersion: "qc_report.v1",
    outputId: output.outputId,
    sourceType: "remix",
    remixId: remix.remixId,
    qcStatus,
    visualPreviewRequired: Boolean(output.visualPreviewRequired),
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
        status: output.previewConfirmed ? "pass" : (output.visualPreviewRequired ? "manual_required" : "pass"),
        severity: output.previewConfirmed || !output.visualPreviewRequired ? "info" : "manual_required",
        message: output.previewConfirmed
          ? "人工预览已确认"
          : output.visualPreviewRequired
            ? "remix 需要人工预览确认"
            : "自动质检路径无需人工预览"
      }
    ],
    ...(autoQc ? { autoQc } : {}),
    summary: autoQc?.summary || (output.previewConfirmed ? "Preview confirmed" : output.visualPreviewRequired ? "Preview confirmation required" : "Automatic QC passed"),
    createdAt: new Date().toISOString()
  };
  const target = join(remixDir(context, remix.remixId), "qc", `${output.outputId}.json`);
  await writeAtomicJson(target, report);
  const storage = await syncRelativeAsset(context, target, "remix_qc_report");
  return {
    qcReportPath: storage.storedPath,
    qcReportStorageKey: storage.storageKey,
    qcReportStorageUrl: storage.storageUrl
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
  const storage = await syncWangzhuanAsset(context, outputTarget, "remix_output_video", { required: true });
  const output = {
    outputId,
    sourceType: "remix",
    remixId: remix.remixId,
    generationTaskIds: [taskId],
    durationSec: Number(remix.source?.durationSec || 15),
    kind: "remix_video",
    filePath,
    previewUrl: storage.storageUrl,
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl,
    promptPath: task?.promptPath || "",
    promptStorageKey: task?.promptStorageKey || "",
    promptStorageUrl: task?.promptStorageUrl || "",
    qcStatus: "qc_running",
    downloadEligible: false,
    visualPreviewRequired: false,
    previewConfirmed: false
  };
  const nextTask = {
    ...task,
    status: "qc",
    providerJobId: jobSnapshot.jobId,
    seedanceTaskId: jobSnapshot.jobId,
    outputPath: filePath,
    outputStorageKey: storage?.storageKey || "",
    outputStorageUrl: storage?.storageUrl || "",
    finishedAt: new Date().toISOString()
  };
  const qc = await evaluateRemixQc({
    output,
    executionPlan: remix.executionPlan || { steps: [] },
    mockSignals: context.mockRemixQcSignals || {}
  });
  const qcPassed = qc.qcStatus === "pass";
  const pendingOutput = {
    ...output,
    qcStatus: qcPassed ? "manual_required" : "fail",
    downloadEligible: false,
    visualPreviewRequired: true,
    previewConfirmed: false,
    autoQc: qc
  };
  const pendingRemix = {
    ...remix,
    status: "preview_required",
    providerJob: jobSnapshot,
    tasks: [nextTask],
    outputs: [pendingOutput],
    qcSummary: {
      total: 1,
      passed: qcPassed ? 1 : 0,
      failed: qcPassed ? 0 : 1,
      warnings: qcPassed ? [] : [{ outputId, qcStatus: "fail", summary: qc.summary }]
    }
  };
  if (!qcPassed) {
    const qcReportPath = await writeQcReport(context, pendingRemix, pendingOutput, qc.qcStatus);
    return writeRemix(context, {
      ...pendingRemix,
      outputs: [{ ...pendingOutput, ...qcReportPath }]
    }, "remix_write");
  }

  const autoConfirmedAt = new Date().toISOString();
  const savedPending = await writeRemix(context, pendingRemix, "remix_write");
  const confirmedOutput = {
    ...(savedPending.outputs?.[0] || pendingOutput),
    qcStatus: "pass",
    downloadEligible: true,
    visualPreviewRequired: false,
    previewConfirmed: true,
    autoQc: qc
  };
  const confirmedRemix = {
    ...savedPending,
    status: "succeeded",
    outputs: [confirmedOutput],
    previewConfirmedBy: "system_auto_qc",
    previewConfirmedAt: autoConfirmedAt,
    qcSummary: {
      total: 1,
      passed: 1,
      failed: 0,
      warnings: []
    }
  };
  const qcReportPath = await writeQcReport(context, confirmedRemix, confirmedOutput, "pass");
  return writeRemix(context, {
    ...confirmedRemix,
    outputs: [{ ...confirmedOutput, ...qcReportPath }]
  }, "preview_confirm");
}

async function findActiveRemix(context) {
  const detail = await loadActiveRemixFromMysql(context);
  return detail?.remix || null;
}

async function findActiveBatch(context) {
  return loadActivePipelineRunFromMysql(context);
}

async function assertSourceSubmitUnlocked(context, sourceId) {
  const blocking = await loadBlockingRemixForSourceFromMysql(context, sourceId);
  if (!blocking?.remix) return;
  throw new WangzhuanError("batch_already_running", "该素材已提交改造，请勿重复提交", {
    remixId: blocking.remix.remixId,
    status: blocking.remix.status,
    sourceId
  });
}

export async function uploadRemixSource(context, request = {}) {
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

  const sourceId = await nextSourceSeq(context);
  const sourceRoot = sourceDir(context, sourceId);
  await mkdir(sourceRoot, { recursive: true });
  const originalPath = join(sourceRoot, `original${ext}`);
  await writeFile(originalPath, buffer);
  const storage = await syncWangzhuanAsset(context, originalPath, "remix_source", { required: true });
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
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl,
    userId: currentUserId(context),
    createdAt: new Date().toISOString()
  };
  const synced = await syncRemixSourceFact(context, probe);
  if (synced.skipped) {
    throw new WangzhuanError("database_unavailable", "MySQL 写入失败，源素材未保存", { sourceId });
  }
  await recordTelemetryEvent(context, "competitor_material_uploaded", {
    remixSourceId: sourceId,
    mimeType: probe.mimeType,
    sizeBytes: probe.sizeBytes
  });
  return {
    sourceId,
    probe,
    previewUrl: storage.storageUrl
  };
}

export async function startDirectMaskEdit(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload(request);
  const replay = await loadIdempotencyFactFromMysql(context, "remix_mask_edit_start", request.idempotencyKey, requestHash);
  if (replay) return replay;
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
  await assertSourceSubmitUnlocked(context, source.sourceId);
  const capability = preflightRemixProvider(context, normalized.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }
  const remixId = makeRemixId();
  const now = new Date().toISOString();
  let maskSource = null;
  if (!normalized.autoDetect) {
    const maskBuffer = parseMaskDataUrl(normalized.maskDataUrl);
    const targetDir = remixDir(context, remixId);
    const maskTarget = join(targetDir, "regions", "mask.png");
    await mkdir(dirname(maskTarget), { recursive: true });
    await writeFile(maskTarget, maskBuffer);
    const maskAsset = await syncRelativeAsset(context, maskTarget, "remix_mask");
    maskSource = {
      sourceType: "base64_data_url",
      mimeType: "image/png",
      storedPath: maskAsset.storedPath,
      storageKey: maskAsset.storageKey,
      storageUrl: maskAsset.storageUrl
    };
  }
  const record = {
    schemaVersion: "remix-direct-mask-edit.v1",
    request: {
      sourceId: normalized.sourceId,
      operationType: normalized.operationType,
      targetChannel: normalized.targetChannel,
      regions: normalized.regions,
      autoDetect: normalized.autoDetect,
      capabilityKey: normalized.capabilityKey,
      jobType: normalized.jobType,
      keyframe: normalized.keyframe,
      executionPlan: buildRemixPlan({
        sourceId: normalized.sourceId,
        operationType: normalized.operationType,
        capabilityKey: normalized.capabilityKey,
        regions: normalized.regions
      })
    },
    source,
    templateSnapshot: directTemplateSnapshot(),
    capability,
    userId: currentUserId(context),
    createdAt: now
  };
  assertRemoteRemixProvider(context, capability);
  const materialized = await materializeProviderSubmission(context, record, remixId, capability, { maskDataUrl: normalized.autoDetect ? "" : normalized.maskDataUrl });
  let remix = {
    remixId,
    type: "remix",
    status: remixStatusFromProvider(materialized.providerJob.status),
    userId: currentUserId(context),
    sourceId: source.sourceId,
    source,
    operationType: normalized.operationType,
    regions: normalized.regions,
    autoDetect: normalized.autoDetect,
    capabilityKey: normalized.capabilityKey,
    jobType: normalized.jobType,
    keyframe: normalized.keyframe,
    executionPlan: record.request.executionPlan,
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
  };
  remix = await writeRemix(context, remix);
  const result = { remix, downloadSummary: downloadSummary(remix) };
  await recordIdempotencyFact(context, "remix_mask_edit_start", request.idempotencyKey, requestHash, {
    type: "remix",
    response: result
  });
  return result;
}

export async function estimateRemix(context, request = {}) {
  const limits = effectiveLimits(context.config || {});
  const normalized = validateEstimateRequest(request, limits);
  const source = await loadSourceProbe(context, normalized.sourceId);
  const templateSnapshot = normalized.templateId && normalized.versionId
    ? await loadTemplateVersion(context, normalized.templateId, normalized.versionId)
    : directTemplateSnapshot();
  const capability = preflightRemixProvider(context, normalized.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }

  const estimateId = await nextEstimateSeq(context);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: "remix-estimate.v1",
    estimate: { estimateId },
    request: normalized,
    estimateHash: hashPayload(normalized),
    source,
    templateSnapshot,
    capability,
    limits,
    userId: currentUserId(context),
    createdAt: now
  };
  const synced = await syncEstimateFact(context, record);
  if (synced.skipped) {
    throw new WangzhuanError("database_unavailable", "MySQL 写入失败，估算未保存", { estimateId });
  }
  return {
    estimateId,
    capability,
    confirmationRequired: false,
    warnings: []
  };
}

export async function loadRemixEstimate(context, estimateId) {
  validateEstimateId(estimateId);
  const record = await loadEstimateFromMysql(context, estimateId);
  if (!record || record.schemaVersion !== "remix-estimate.v1") {
    throw new WangzhuanError("validation_error", "estimate 不存在，请重新估算", { estimateId });
  }
  return record;
}

export async function startRemix(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload(request);
  const replay = await loadIdempotencyFactFromMysql(context, "remix_start", request.idempotencyKey, requestHash);
  if (replay) return replay;
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
  await assertSourceSubmitUnlocked(context, record.source?.sourceId || record.request?.sourceId);
  const capability = preflightRemixProvider(context, record.request.operationType);
  if (capability.status !== "supported" && capability.status !== "degraded") {
    throw new WangzhuanError("unsupported_capability", "当前处理能力不支持该改造类型", { capability });
  }

  const remixId = makeRemixId();
  const now = new Date().toISOString();
  const executionPlan = buildRemixPlan({
    sourceId: record.source.sourceId,
    operationType: record.request.operationType,
    capabilityKey: record.request.capabilityKey,
    regions: record.request.regions
  });
  assertRemoteRemixProvider(context, capability);
  const materialized = await materializeProviderSubmission(context, {
    ...record,
    capability,
    request: {
      ...record.request,
      executionPlan
    }
  }, remixId, capability, { maskDataUrl: record.request.maskDataUrl || "" });
  let remix = {
    remixId,
    type: "remix",
    status: remixStatusFromProvider(materialized.providerJob.status),
    userId: currentUserId(context),
    sourceId: record.source.sourceId,
    source: record.source,
    operationType: record.request.operationType,
    regions: record.request.regions,
    autoDetect: Boolean(record.request.autoDetect),
    capabilityKey: record.request.capabilityKey || "",
    jobType: record.request.jobType || "",
    keyframe: record.request.keyframe || validateKeyframeRequest(),
    executionPlan,
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
  };
  remix = await writeRemix(context, remix);
  const result = { remix, downloadSummary: downloadSummary(remix) };
  await recordIdempotencyFact(context, "remix_start", request.idempotencyKey, requestHash, {
    type: "remix",
    response: result
  });
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
        try {
          const outputBuffer = jobSnapshot.downloadUrl && client.downloadUrl
            ? await client.downloadUrl(jobSnapshot.downloadUrl)
            : await client.downloadJob(jobSnapshot.jobId);
          const saved = await materializeProviderOutput(context, nextRemix, jobSnapshot, outputBuffer);
          return {
            remix: saved,
            downloadSummary: downloadSummary(saved)
          };
        } catch (error) {
          const failure = remixFailureFromError(error);
          nextRemix = {
            ...nextRemix,
            status: "failed",
            providerJob: {
              ...jobSnapshot,
              status: "failed"
            },
            tasks: (nextRemix.tasks || []).map((task) => ({
              ...task,
              status: "failed",
              errorCode: failure.code,
              errorMessage: failure.message,
              responseSummary: failure,
              finishedAt: new Date().toISOString()
            })),
            qcSummary: {
              total: 0,
              passed: 0,
              failed: 1,
              warnings: [{ providerJobId: jobSnapshot.jobId, qcStatus: "fail", ...failure }]
            }
          };
        }
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

export async function getActiveRemix(context) {
  const detail = await loadActiveRemixFromMysql(context);
  return detail || { remix: null, downloadSummary: downloadSummary({ outputs: [] }) };
}

export async function getRemixQcReport(context, remixId) {
  const remix = await readRemix(context, remixId);
  const output = Array.isArray(remix.outputs) ? remix.outputs[0] : null;
  if (!output?.qcReportPath) return null;
  return JSON.parse(await readFile(resolveUserPath(context, output.qcReportPath), "utf8"));
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

export async function confirmRemixPreview(context, remixId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload({ remixId, ...request });
  const replay = await loadIdempotencyFactFromMysql(context, "remix_preview_confirm", request.idempotencyKey, requestHash);
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
    previewConfirmationNotes: String(request.notes || ""),
    qcSummary: {
      total: remix.outputs.length,
      passed: 1,
      failed: 0,
      warnings: []
    }
  };
  const qcReportPath = await writeQcReport(context, nextRemix, nextOutput, "pass");
  const saved = await writeRemix(context, {
    ...nextRemix,
    outputs: nextRemix.outputs.map((item) => item.outputId === outputId ? { ...nextOutput, ...qcReportPath } : item)
  }, "preview_confirm");
  await recordTelemetryEvent(context, "competitor_preview_confirmed", {
    remixId: saved.remixId,
    outputId,
    confirmed: true,
    confirmedBy: saved.previewConfirmedBy
  }, { audit: true });
  const result = { remix: saved, downloadSummary: downloadSummary(saved) };
  await recordIdempotencyFact(context, "remix_preview_confirm", request.idempotencyKey, requestHash, {
    type: "remix",
    response: result
  });
  return result;
}
