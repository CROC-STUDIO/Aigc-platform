import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "node:path";

import { effectiveLimits } from "./config.mjs";
import { TARGET_CHANNELS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import {
  makeGenerationTaskId,
  makeRemixEstimateId,
  makeRemixId,
  makeRemixSourceId,
  makeOutputId
} from "./ids.mjs";
import {
  readJsonOrDefault,
  toProjectRelative,
  wangzhuanPaths,
  writeAtomicJson
} from "./storage.mjs";
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
const REMIX_MODEL_VIDEO = "function_k";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function isAdmin(context) {
  return context.user?.role === "admin" || context.user?.isAdmin;
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

function previewUrl(relativePath) {
  return `/file?path=${encodeURIComponent(relativePath)}`;
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
    ...(operationSupported ? {} : { unsupportedReason: raw.unsupportedReason || "operation is not supported by current remix provider" }),
    preflightCheckedAt: checkedAt
  };
}

export function preflightRemixProvider(context = {}, operationType) {
  const raw = context.capabilities?.remix ?? context.config?.wangzhuan?.capabilities?.remix;
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
      durationSec: 15,
      kind: "remix_video",
      filePath,
      previewUrl: previewUrl(filePath),
      promptPath,
      qcStatus: "manual_required",
      downloadEligible: false,
      visualPreviewRequired: true,
      previewConfirmed: false
    }
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
  const width = Number(request.width || 0);
  const height = Number(request.height || 0);
  const probe = {
    sourceId,
    fileName,
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: buffer.length,
    durationSec: Number(request.durationSec || 0),
    width,
    height,
    ratio: ratioFor(width, height),
    kind: mimeType.startsWith("image/") ? "image" : "video",
    status: "pass",
    issues: [],
    storedPath: toProjectRelative(context.userProjectRoot, originalPath),
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
    previewUrl: previewUrl(probe.storedPath)
  };
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
  const materialized = await materializeMockRemix(context, { ...record, capability }, remixId);
  let remix = {
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
  const qcReportPath = await writeQcReport(context, remix, materialized.output, "manual_required");
  remix.outputs[0] = { ...materialized.output, qcReportPath };
  await writeAtomicJson(join(remixDir(context, remixId), "regions", "regions.json"), remix.regions);
  remix = await writeRemix(context, remix);
  await writeTaskMap(context, remix);
  const result = { remix, downloadSummary: downloadSummary(remix) };
  await writeIdempotentResult(paths, "remix_start", request.idempotencyKey, result);
  return result;
}

export async function getRemixDetail(context, remixId) {
  const remix = await readRemix(context, remixId);
  return {
    remix,
    downloadSummary: downloadSummary(remix)
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
