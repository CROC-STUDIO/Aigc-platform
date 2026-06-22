import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { effectiveLimits } from "./config.mjs";
import { branchSummaries, normalizeBranchDrafts } from "./branches.mjs";
import {
  PROMISE_LEVELS,
  REQUIRED_STRONG_TRUTH_FIELDS,
  TARGET_CHANNELS
} from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeBatchId, makeEstimateId } from "./ids.mjs";
import {
  findActiveResourceLock,
  loadEstimateFromMysql,
  loadTemplateStoreFromMysql,
  loadVideoDecompositionFromMysql,
  recordIdempotencyFact,
  syncBatchFacts,
  syncEstimateFact,
  verifyEstimateConfirmationTokenFromMysql
} from "./mysql-facts.mjs";
import { prepareBatchForPipeline } from "./pipeline.mjs";
import { loadReferenceVideoProbe } from "./reference-videos.mjs";
import { DEFAULT_SEEDANCE_MODEL } from "./seedance-provider.mjs";
import { preflightStitcher } from "./stitch.mjs";
import { readJsonOrDefault, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
const ESTIMATE_INDEX_DEFAULT = Object.freeze({
  schemaVersion: "estimates.v1",
  nextSeq: 1,
  items: []
});
const ACTIVE_BATCH_STATUSES = new Set(["checking", "queued", "running", "stitching", "qc"]);
const ACTIVE_REMIX_STATUSES = new Set(["queued", "running", "qc", "preview_required"]);

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new WangzhuanError("validation_error", `${field} 不符合范围`, { field, min, max });
  }
  return number;
}

function requireField(request, field) {
  const value = request[field];
  if (value === undefined || value === null || value === "") {
    throw new WangzhuanError("validation_error", `${field} 必填`, { field });
  }
  return value;
}

function issue(code, field, message, severity = "error") {
  return { code, field, message, severity };
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

function makeConfirmationToken() {
  return `confirm_${randomBytes(8).toString("hex")}`;
}

function idempotencyFile(paths, endpoint, idempotencyKey) {
  const safeEndpoint = endpoint.replace(/[^a-z0-9_-]+/gi, "_");
  const digest = createHash("sha256").update(String(idempotencyKey)).digest("hex").slice(0, 24);
  return join(paths.idempotencyDir, `${safeEndpoint}_${digest}.json`);
}

async function readIdempotentResult(paths, endpoint, idempotencyKey) {
  if (!idempotencyKey) return null;
  const target = idempotencyFile(paths, endpoint, idempotencyKey);
  if (!existsSync(target)) return null;
  return JSON.parse(await readFile(target, "utf8")).result;
}

async function writeIdempotentResult(paths, endpoint, idempotencyKey, result) {
  if (!idempotencyKey) return;
  await writeAtomicJson(idempotencyFile(paths, endpoint, idempotencyKey), {
    endpoint,
    result,
    createdAt: new Date().toISOString()
  });
}

async function loadTemplateVersion(context, templateId, versionId) {
  const store = await loadTemplateStoreFromMysql(context)
    ?? await readJsonOrDefault(wangzhuanPaths(context).templatesPath, { templates: [] });
  const template = (Array.isArray(store.templates) ? store.templates : []).find((item) => {
    return item.templateId === templateId && item.versionId === versionId && item.status !== "deleted";
  });
  if (!template) {
    throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { templateId, versionId });
  }
  return template;
}

async function loadReferenceDecomposition(context, referenceVideoId) {
  const mysqlDecomposition = await loadVideoDecompositionFromMysql(context, referenceVideoId);
  if (mysqlDecomposition) return mysqlDecomposition;
  const target = join(wangzhuanPaths(context).referenceVideosDir, referenceVideoId, "decomposition.json");
  if (!existsSync(target)) {
    throw new WangzhuanError("schema_invalid", "拆解结果不完整，请重试或手动补充", {
      referenceVideoId,
      missingFields: ["decomposition"]
    });
  }
  return JSON.parse(await readFile(target, "utf8"));
}

function validateTemplateForPromise(template, promiseLevel) {
  if (promiseLevel !== "strong_commitment") return;
  const missingFields = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !isNonEmptyString(template.draft?.truthRules?.[field]));
  if (missingFields.length) {
    throw new WangzhuanError("strong_rule_missing", "强承诺需要补齐真实收益规则", { missingFields });
  }
}

function validateEstimateRequest(request, limits) {
  const required = [
    "templateId",
    "versionId",
    "referenceVideoId",
    "targetChannel",
    "targetRegion",
    "language",
    "promiseLevel",
    "durationSec",
    "variantCount",
    "outputRatio"
  ];
  for (const field of required) requireField(request, field);
  if (!TARGET_CHANNELS.includes(request.targetChannel)) {
    throw new WangzhuanError("validation_error", "targetChannel 不在合同枚举内", { field: "targetChannel" });
  }
  if (!PROMISE_LEVELS.includes(request.promiseLevel)) {
    throw new WangzhuanError("validation_error", "promiseLevel 不在合同枚举内", { field: "promiseLevel" });
  }
  const durationSec = normalizeInteger(request.durationSec, "durationSec", 15, 30);
  if (![15, 30].includes(durationSec)) {
    throw new WangzhuanError("validation_error", "durationSec 只能是 15 或 30", { field: "durationSec" });
  }
  const variantCount = normalizeInteger(request.variantCount, "variantCount", 1, limits.hardGenerationTasks);
  const requestedConcurrency = request.requestedConcurrency === undefined
    ? 1
    : normalizeInteger(request.requestedConcurrency, "requestedConcurrency", 1, limits.maxConcurrency);
  if (request.outputRatio !== "9:16") {
    throw new WangzhuanError("validation_error", "outputRatio 首期只支持 9:16", { field: "outputRatio" });
  }
  return { durationSec, variantCount, requestedConcurrency };
}

function computeCounts(durationSec, variantCount, branchCount = 1) {
  const multiplier = durationSec === 30 ? 2 : 1;
  const totalVariants = variantCount * Math.max(1, branchCount);
  return {
    scriptCount: totalVariants * multiplier,
    seedanceSegmentCount: totalVariants * multiplier,
    stitchTaskCount: durationSec === 30 ? totalVariants : 0,
    imageTaskCount: totalVariants * multiplier
  };
}

function capabilitySnapshot(context, durationSec) {
  if (durationSec === 15) {
    return {
      stitcher: { status: "not_required", checkedAt: new Date().toISOString() }
    };
  }
  const stitcher = preflightStitcher(context);
  if (stitcher.status === "supported" || stitcher.status === "degraded") {
    return {
      stitcher: {
        status: "available",
        provider: stitcher.provider,
        version: stitcher.version,
        preflightStatus: stitcher.status,
        checkedAt: stitcher.checkedAt
      }
    };
  }
  throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", {
    capability: "stitcher",
    requiredForDurationSec: durationSec
  });
}

async function nextEstimateId(context) {
  const paths = wangzhuanPaths(context);
  const indexPath = join(paths.estimatesDir, "index.json");
  const index = await readJsonOrDefault(indexPath, ESTIMATE_INDEX_DEFAULT);
  const estimateId = makeEstimateId(index.nextSeq || 1);
  index.nextSeq = (index.nextSeq || 1) + 1;
  index.items = Array.isArray(index.items) ? index.items : [];
  return { estimateId, indexPath, index };
}

export async function estimateBatch(context, request = {}) {
  const paths = wangzhuanPaths(context);
  const replay = await readIdempotentResult(paths, "batches_estimate", request.idempotencyKey);
  if (replay) return replay;

  const limits = effectiveLimits(context.config || {});
  let normalized;
  try {
    normalized = validateEstimateRequest(request, limits);
  } catch (error) {
    if (error?.data?.field === "variantCount" && Number(request.variantCount) > limits.hardGenerationTasks) {
      throw new WangzhuanError("hard_limit_exceeded", "任务数超过上限，请降低数量", {
        field: "variantCount",
        variantCount: Number(request.variantCount),
        hardGenerationTasks: limits.hardGenerationTasks
      });
    }
    throw error;
  }

  const template = await loadTemplateVersion(context, request.templateId, request.versionId);
  validateTemplateForPromise(template, request.promiseLevel);
  const referenceVideo = await loadReferenceVideoProbe(context, request.referenceVideoId);
  if (referenceVideo.status === "fail") {
    throw new WangzhuanError("invalid_video", "参考视频检查未通过", { referenceVideoId: referenceVideo.referenceVideoId });
  }
  const decomposition = await loadReferenceDecomposition(context, request.referenceVideoId);
  const branches = normalizeBranchDrafts(template.draft, request.branches);
  const branchCount = Math.max(1, branches.length);
  const capabilities = capabilitySnapshot(context, normalized.durationSec);
  const counts = computeCounts(normalized.durationSec, normalized.variantCount, branchCount);
  if (counts.seedanceSegmentCount > limits.hardGenerationTasks) {
    throw new WangzhuanError("hard_limit_exceeded", "任务数超过上限，请降低数量", {
      field: "variantCount",
      variantCount: normalized.variantCount,
      branchCount,
      seedanceSegmentCount: counts.seedanceSegmentCount,
      hardGenerationTasks: limits.hardGenerationTasks
    });
  }
  const confirmationRequired = normalized.variantCount > limits.confirmGenerationTasks
    || counts.seedanceSegmentCount > limits.confirm30sSegments;
  const confirmationToken = confirmationRequired ? makeConfirmationToken() : undefined;
  const confirmedLimits = confirmationRequired ? {
    confirmGenerationTasks: limits.confirmGenerationTasks,
    confirm30sSegments: limits.confirm30sSegments,
    variantCount: normalized.variantCount,
    branchCount,
    seedanceSegmentCount: counts.seedanceSegmentCount
  } : {};
  const normalizedRequest = {
    templateId: request.templateId,
    versionId: request.versionId,
    referenceVideoId: request.referenceVideoId,
    targetChannel: request.targetChannel,
    targetRegion: String(request.targetRegion),
    language: String(request.language),
    promiseLevel: request.promiseLevel,
    durationSec: normalized.durationSec,
    variantCount: normalized.variantCount,
    requestedConcurrency: normalized.requestedConcurrency,
    outputRatio: request.outputRatio,
    branches
  };
  const estimateHash = hashPayload(normalizedRequest);
  const { estimateId, indexPath, index } = await nextEstimateId(context);
  const now = new Date().toISOString();
  const estimate = {
    estimateId,
    durationSec: normalized.durationSec,
    variantCount: normalized.variantCount,
    branchCount,
    branchSummaries: branchSummaries(branches),
    ...counts,
    models: [MODEL_IMAGE, MODEL_VIDEO],
    maxRetryPerTask: limits.maxRetryPerTask,
    requestedConcurrency: normalized.requestedConcurrency,
    confirmationRequired,
    ...(confirmationToken ? { confirmationToken } : {}),
    hardBlocked: false,
    blockedReasons: [],
    warnings: []
  };
  const record = {
    schemaVersion: "batch-estimate.v1",
    estimate,
    request: normalizedRequest,
    estimateHash,
    confirmation: confirmationRequired ? {
      confirmationToken,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      confirmedLimits
    } : null,
    templateSnapshot: template,
    referenceVideo,
    decomposition,
    limits,
    capabilities,
    userId: currentUserId(context),
    projectRoot: context.userProjectRoot,
    createdAt: now
  };
  await writeAtomicJson(join(paths.estimatesDir, estimateId, "estimate.json"), record);
  await syncEstimateFact(context, record, confirmationToken);
  index.items.push({ estimateId, createdBy: currentUserId(context), createdAt: now });
  await writeAtomicJson(indexPath, index);
  if (confirmationRequired) {
    await recordTelemetryEvent(context, "generation_limit_confirmed", {
      estimateId,
      confirmationToken,
      scriptCount: estimate.scriptCount,
      seedanceSegmentCount: estimate.seedanceSegmentCount,
      stitchTaskCount: estimate.stitchTaskCount,
      thresholdKeys: Object.keys(confirmedLimits)
    }, { audit: true });
  }

  const result = { estimate, limits, capabilities };
  await writeIdempotentResult(paths, "batches_estimate", request.idempotencyKey, result);
  return result;
}

export async function loadEstimate(context, estimateId) {
  if (!/^est_\d{8}_\d{3}$/.test(String(estimateId || ""))) {
    throw new WangzhuanError("validation_error", "estimateId 不合法", { field: "estimateId" });
  }
  const mysqlEstimate = await loadEstimateFromMysql(context, estimateId);
  if (mysqlEstimate) return mysqlEstimate;
  const target = join(wangzhuanPaths(context).estimatesDir, estimateId, "estimate.json");
  if (!existsSync(target)) {
    throw new WangzhuanError("validation_error", "estimate 不存在，请重新估算", { estimateId });
  }
  return JSON.parse(await readFile(target, "utf8"));
}

async function findActiveBatch(context) {
  const index = await readJsonOrDefault(join(wangzhuanPaths(context).batchesDir, "index.json"), {
    schemaVersion: "batches.v1",
    items: []
  });
  for (const item of Array.isArray(index.items) ? index.items : []) {
    const batchPath = join(wangzhuanPaths(context).batchesDir, item.batchId, "batch.json");
    if (!existsSync(batchPath)) continue;
    const batch = JSON.parse(await readFile(batchPath, "utf8"));
    if (ACTIVE_BATCH_STATUSES.has(batch.status)) return batch;
  }
  return null;
}

async function findActiveRemix(context) {
  const index = await readJsonOrDefault(join(wangzhuanPaths(context).remixDir, "index.json"), {
    schemaVersion: "remix.v1",
    items: []
  });
  for (const item of Array.isArray(index.items) ? index.items : []) {
    const remixPath = join(wangzhuanPaths(context).remixDir, item.remixId, "remix.json");
    if (!existsSync(remixPath)) continue;
    const remix = JSON.parse(await readFile(remixPath, "utf8"));
    if (ACTIVE_REMIX_STATUSES.has(remix.status)) return remix;
  }
  return null;
}

async function saveBatch(context, batch) {
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.batchesDir, batch.batchId, "batch.json"), batch);
  const indexPath = join(paths.batchesDir, "index.json");
  const index = await readJsonOrDefault(indexPath, { schemaVersion: "batches.v1", items: [] });
  index.items = Array.isArray(index.items) ? index.items : [];
  if (!index.items.some((item) => item.batchId === batch.batchId)) {
    index.items.push({
      batchId: batch.batchId,
      status: batch.status,
      estimateId: batch.estimate.estimateId,
      createdBy: batch.userId,
      createdAt: batch.createdAt
    });
  }
  await writeAtomicJson(indexPath, index);
  await syncBatchFacts(context, batch, "batch_created");
}

async function assertCanStartFromEstimate(context, record, request) {
  const actualHash = hashPayload(record.request);
  if (actualHash !== record.estimateHash) {
    throw new WangzhuanError("validation_error", "estimate 已失效，请重新估算", { estimateId: record.estimate.estimateId });
  }
  if (record.estimate.confirmationRequired) {
    const tokenMatches = record.confirmation?.confirmationToken
      ? request.confirmationToken === record.confirmation.confirmationToken
      : await verifyEstimateConfirmationTokenFromMysql(context, record.estimate.estimateId, request.confirmationToken);
    if (!request.confirmationToken || !tokenMatches) {
      throw new WangzhuanError("limit_confirmation_required", "本次任务较多，请确认后继续", {
        estimateId: record.estimate.estimateId,
        confirmationRequired: true
      });
    }
    if (record.confirmation?.expiresAt && Date.parse(record.confirmation.expiresAt) < Date.now()) {
      throw new WangzhuanError("limit_confirmation_required", "确认已过期，请重新估算", {
        estimateId: record.estimate.estimateId,
        confirmationRequired: true
      });
    }
  }
  if (context.getLegacyRunState?.()?.running) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "existing_ad_batch"
    });
  }
  const activeMysqlLock = await findActiveResourceLock(context);
  if (activeMysqlLock) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: activeMysqlLock.runType || "mysql_resource_lock",
      batchId: activeMysqlLock.runType === "pipeline" ? activeMysqlLock.runId : undefined,
      remixId: activeMysqlLock.runType === "remix" ? activeMysqlLock.runId : undefined,
      status: activeMysqlLock.runStatus || activeMysqlLock.status
    });
  }
}

export async function startBatchFromEstimate(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const paths = wangzhuanPaths(context);
  const replay = await readIdempotentResult(paths, "batches_start", request.idempotencyKey);
  if (replay) return replay;

  const record = await loadEstimate(context, request.estimateId);
  await assertCanStartFromEstimate(context, record, request);
  if (record.estimate.durationSec === 30 && preflightStitcher(context).status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", {
      estimateId: record.estimate.estimateId,
      capability: "stitcher"
    });
  }
  const active = await findActiveBatch(context);
  if (active) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      batchId: active.batchId,
      status: active.status
    });
  }
  const activeRemix = await findActiveRemix(context);
  if (activeRemix) {
    throw new WangzhuanError("batch_already_running", "当前已有任务运行，请等待或停止后再试", {
      runningResource: "remix",
      remixId: activeRemix.remixId,
      status: activeRemix.status
    });
  }

  const now = new Date().toISOString();
  const batch = {
    batchId: makeBatchId(),
    type: "pipeline",
    status: "queued",
    userId: currentUserId(context),
    projectRoot: context.projectName || "current_project",
    templateSnapshot: record.templateSnapshot,
    referenceVideo: record.referenceVideo,
    decomposition: record.decomposition,
    estimate: record.estimate,
    scripts: [],
    tasks: [],
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
  await saveBatch(context, batch);
  const preparedBatch = await prepareBatchForPipeline(context, batch);
  const result = { batch: preparedBatch };
  await writeIdempotentResult(paths, "batches_start", request.idempotencyKey, result);
  await recordIdempotencyFact(context, "batches_start", request.idempotencyKey, hashPayload(request), {
    type: "batch",
    response: { batchId: preparedBatch.batchId, status: preparedBatch.status }
  });
  await recordTelemetryEvent(context, "generation_batch_started", {
    batchId: preparedBatch.batchId,
    estimateId: record.estimate.estimateId,
    idempotencyKey: request.idempotencyKey,
    durationSec: record.estimate.durationSec,
    variantCount: record.estimate.variantCount,
    models: record.estimate.models,
    scriptCount: record.estimate.scriptCount,
    seedanceSegmentCount: record.estimate.seedanceSegmentCount,
    stitchTaskCount: record.estimate.stitchTaskCount
  }, { audit: true });
  return result;
}
