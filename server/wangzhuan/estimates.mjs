import { createHash, randomBytes } from "node:crypto";

import { effectiveLimits } from "./config.mjs";
import { branchSummaries, normalizeBranchDrafts } from "./branches.mjs";
import {
  hasAnyStrongTruthRule,
  PROMISE_LEVELS,
  TARGET_CHANNELS
} from "./constants.mjs";
import {
  buildEffectiveDisclaimerByLanguage,
  resolveDisclaimerPreset,
  resolveEffectiveDisclaimer
} from "./disclaimers.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeBatchId } from "./ids.mjs";
import {
  hasWangzhuanFactsStore,
  loadBatchDetailFromMysql,
  loadEstimateFromMysql,
  loadTemplateStoreFromMysql,
  loadVideoDecompositionFromMysql,
  nextPipelineEstimateIdFromMysql,
  runIdempotentOperation,
  syncBatchFacts,
  syncEstimateFact,
  verifyEstimateConfirmationTokenFromMysql
} from "./mysql-facts.mjs";
import { prepareBatchForPipeline } from "./pipeline.mjs";
import { loadReferenceVideoProbe } from "./reference-videos.mjs";
import { assertSeedanceReferenceAssetLimits } from "./seedance-provider.mjs";
import { DEFAULT_SEEDANCE_MODEL, resolveSeedanceModel } from "./seedance-provider.mjs";
import { preflightStitcher } from "./stitch.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import { normalizeBatchPostProcess } from "./postprocess.mjs";
import { writeSseDelta, writeSseDone, writeSseError, writeSseLog, writeSseReset } from "./sse.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
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

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const list = source.map((item) => String(item || "").trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : fallback;
}

function issue(code, field, message, severity = "error") {
  return { code, field, message, severity };
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

function replayResourceId(summary = {}, resourceKey, idKey) {
  return summary?.[resourceKey]?.[idKey] || summary?.[idKey] || "";
}

async function replayEstimateResponse(context, summary = {}) {
  const estimateId = replayResourceId(summary, "estimate", "estimateId");
  const record = await loadEstimate(context, estimateId);
  return {
    estimate: record.estimate || record,
    limits: record.limits || effectiveLimits(context.config || {}),
    capabilities: record.capabilities || capabilitySnapshot(context, record.estimate?.durationSec)
  };
}

async function replayBatchResponse(context, summary = {}, { includePlans = false } = {}) {
  const batchId = replayResourceId(summary, "batch", "batchId");
  const detail = await loadBatchDetailFromMysql(context, batchId);
  if (!detail?.batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  return includePlans
    ? { batch: detail.batch, plans: detail.batch.plans || [] }
    : { batch: detail.batch };
}

function hashPayload(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function makeConfirmationToken() {
  return `confirm_${randomBytes(8).toString("hex")}`;
}

async function loadTemplateVersion(context, templateId, versionId) {
  const store = await loadTemplateStoreFromMysql(context);
  if (!store) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取模板状态");
  }
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
  throw new WangzhuanError("schema_invalid", "拆解结果不完整，请重试或手动补充", {
    referenceVideoId,
    missingFields: ["decomposition"]
  });
}

function validateTemplateForPromise(template, promiseLevel) {
  if (promiseLevel !== "strong_commitment") return;
  if (!hasAnyStrongTruthRule(template.draft?.truthRules)) {
    throw new WangzhuanError("strong_rule_missing", "强承诺至少需要填写一条真实收益规则", {
      field: "truthRules"
    });
  }
}

function validateEstimateRequest(request, limits) {
  const hasSavedTemplate = Boolean(request.templateId && request.versionId);
  const hasInlineDraft = Boolean(request.templateSnapshot?.draft);
  if (!hasSavedTemplate && !hasInlineDraft) {
    throw new WangzhuanError("validation_error", "templateSnapshot.draft 必填", { field: "templateSnapshot.draft" });
  }
  if (request.templateId || request.versionId) {
    requireField(request, "templateId");
    requireField(request, "versionId");
  }
  const required = [
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
  const supportedRatios = ["9:16", "1:1", "16:9"];
  if (!supportedRatios.includes(request.outputRatio)) {
    throw new WangzhuanError("validation_error", "outputRatio 不在支持范围内", { field: "outputRatio", supportedRatios });
  }
  const targetRegions = normalizeStringList(request.targetRegions, normalizeStringList(request.targetRegion, ["US"]));
  const languages = normalizeStringList(request.languages, normalizeStringList(request.language, ["en-US"]));
  return { durationSec, variantCount, requestedConcurrency, targetRegions, languages };
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
  const estimateId = await nextPipelineEstimateIdFromMysql(context);
  if (!estimateId) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法生成估算编号");
  }
  return estimateId;
}

async function estimateBatchOnce(context, request = {}) {
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

  const template = request.templateId && request.versionId
    ? await loadTemplateVersion(context, request.templateId, request.versionId)
    : {
        schemaVersion: "template-inline-draft.v1",
        templateId: undefined,
        versionId: undefined,
        versionNumber: 0,
        status: "inline_draft",
        draft: request.templateSnapshot.draft
      };
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
  const seedanceModel = resolveSeedanceModel({ templateSnapshot: template, estimate: { request: request } });
  const disclaimerPresetId = String(request.disclaimerPresetId || request.disclaimerPreset || "auto").trim() || "auto";
  const disclaimerLanguage = String(
    request.disclaimerLanguage || resolveDisclaimerPreset(normalized.languages[0], disclaimerPresetId)
  );
  const disclaimer = String(resolveEffectiveDisclaimer({
    language: normalized.languages[0],
    preset: disclaimerPresetId,
    targetChannel: request.targetChannel,
    promiseLevel: request.promiseLevel,
    customText: request.disclaimer
  }));
  const disclaimerByLanguage = request.disclaimerByLanguage && typeof request.disclaimerByLanguage === "object"
    ? request.disclaimerByLanguage
    : buildEffectiveDisclaimerByLanguage(normalized.languages, {
      preset: disclaimerPresetId,
      targetChannel: request.targetChannel,
      promiseLevel: request.promiseLevel,
      customText: request.disclaimer
    });
  const disclaimerOverlay = request.disclaimerOverlay && typeof request.disclaimerOverlay === "object"
    ? {
      enabled: request.disclaimerOverlay.enabled !== false,
      templateId: String(request.disclaimerOverlay.templateId || disclaimerPresetId || "auto"),
      imageFileName: String(request.disclaimerOverlay.imageFileName || ""),
      imageStoredPath: String(request.disclaimerOverlay.imageStoredPath || ""),
      imageStorageKey: String(request.disclaimerOverlay.imageStorageKey || ""),
      imageStorageUrl: String(request.disclaimerOverlay.imageStorageUrl || ""),
      position: String(request.disclaimerOverlay.position || "bottom_center"),
      boxHeight: Number(request.disclaimerOverlay.boxHeight || 88),
      bottomMargin: Number(request.disclaimerOverlay.bottomMargin || 3),
      horizontalMargin: Number(request.disclaimerOverlay.horizontalMargin || 50)
    }
    : {
      enabled: true,
      templateId: disclaimerPresetId,
      imageFileName: "",
      imageStoredPath: "",
      imageStorageKey: "",
      imageStorageUrl: "",
      position: "bottom_center",
      boxHeight: 88,
      bottomMargin: 3,
      horizontalMargin: 50
    };
  const postProcess = normalizeBatchPostProcess(request.postProcess);
  const normalizedRequest = {
    templateId: request.templateId,
    versionId: request.versionId,
    referenceVideoId: request.referenceVideoId,
    targetChannel: request.targetChannel,
    targetRegion: normalized.targetRegions[0] || String(request.targetRegion),
    targetRegions: normalized.targetRegions,
    language: normalized.languages[0] || String(request.language),
    languages: normalized.languages,
    promiseLevel: request.promiseLevel,
    durationSec: normalized.durationSec,
    variantCount: normalized.variantCount,
    requestedConcurrency: normalized.requestedConcurrency,
    outputRatio: request.outputRatio,
    disclaimer,
    disclaimerEnabled: request.disclaimerEnabled !== false && disclaimerOverlay.enabled !== false,
    disclaimerPresetId,
    disclaimerPreset: disclaimerPresetId,
    disclaimerLanguage,
    disclaimerByLanguage,
    disclaimerOverlay,
    postProcess,
    seedanceModel,
    branches,
    ...(request.templateSnapshot ? { templateSnapshot: request.templateSnapshot } : {})
  };
  const estimateHash = hashPayload(normalizedRequest);
  const estimateId = await nextEstimateId(context);
  const now = new Date().toISOString();
  const estimate = {
    estimateId,
    durationSec: normalized.durationSec,
    variantCount: normalized.variantCount,
    branchCount,
    branchSummaries: branchSummaries(branches),
    ...counts,
    models: [MODEL_IMAGE, seedanceModel],
    targetRegions: normalized.targetRegions,
    languages: normalized.languages,
    outputRatio: request.outputRatio,
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
  const syncedEstimate = await syncEstimateFact(context, record, confirmationToken);
  if (syncedEstimate?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存估算结果");
  }
  if (confirmationRequired) {
    await recordTelemetryEvent(context, "generation_limit_confirmed", {
      estimateId,
      confirmationRequired: true,
      scriptCount: estimate.scriptCount,
      seedanceSegmentCount: estimate.seedanceSegmentCount,
      stitchTaskCount: estimate.stitchTaskCount,
      thresholdKeys: Object.keys(confirmedLimits)
    }, { audit: true });
  }

  return { estimate, limits, capabilities };
}

export async function estimateBatch(context, request = {}) {
  const requestHash = hashPayload(request);
  return runIdempotentOperation(
    context,
    "batches_estimate",
    request.idempotencyKey,
    requestHash,
    () => estimateBatchOnce(context, request),
    { resourceType: "estimate", replayResponse: (summary) => replayEstimateResponse(context, summary) }
  );
}

export async function loadEstimate(context, estimateId) {
  if (!/^est_\d{8}_\d{3}$/.test(String(estimateId || ""))) {
    throw new WangzhuanError("validation_error", "estimateId 不合法", { field: "estimateId" });
  }
  const mysqlEstimate = await loadEstimateFromMysql(context, estimateId);
  if (mysqlEstimate) return mysqlEstimate;
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取估算结果");
  }
  throw new WangzhuanError("validation_error", "estimate 不存在，请重新估算", { estimateId });
}

async function loadDraftBatch(context, batchId) {
  if (!batchId) return null;
  const detail = await loadBatchDetailFromMysql(context, batchId);
  return detail?.batch || null;
}

export function canReuseActivePipelineDraft(active, request = {}, options = {}) {
  const activeId = active?.batchId || active?.runId || "";
  const activeStatus = active?.status || active?.runStatus || "";
  if (!activeId || !request?.batchId) return false;
  if (activeId !== request.batchId) return false;
  const editableStatuses = options.allowPreviewRequired
    ? ["draft", "checking", "preview_required"]
    : ["draft", "checking"];
  return editableStatuses.includes(String(activeStatus || ""));
}

function reusableDraftBatch(draftBatch, options = {}) {
  if (!draftBatch?.batchId) return null;
  if (!draftBatch.status) return draftBatch;
  return canReuseActivePipelineDraft(
    { batchId: draftBatch.batchId, status: draftBatch.status },
    { batchId: draftBatch.batchId },
    options
  )
    ? draftBatch
    : null;
}

async function saveBatch(context, batch) {
  const synced = await syncBatchFacts(context, batch, "batch_created");
  if (synced?.skipped) {
    const detail = synced.error?.message || synced.error?.code || null;
    if (!await hasWangzhuanFactsStore()) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存批次状态");
    }
    throw new WangzhuanError("database_unavailable", detail
      ? `批次状态保存失败：${String(detail).slice(0, 300)}`
      : "批次状态保存失败，请确认数据库迁移已执行到最新版本（含 pending_preview 任务状态）", {
      batchId: batch.batchId,
      cause: detail
    });
  }
}

export function enrichPlanGenerationError(error, batchId) {
  if (!batchId) return error;
  if (!(error instanceof WangzhuanError)) {
    return new WangzhuanError("internal_error", error?.message || "系统错误", { batchId });
  }
  return new WangzhuanError(error.code, error.message, { ...error.data, batchId }, error.status);
}

export function buildPlanPreviewBatch(context, record, draftBatch, branchDrafts) {
  const now = new Date().toISOString();
  const reusableDraft = reusableDraftBatch(draftBatch, { allowPreviewRequired: true });
  return {
    batchId: reusableDraft?.batchId || makeBatchId(),
    userBatchName: record.request.batchName || reusableDraft?.userBatchName || "",
    displayBatchName: record.request.batchName || reusableDraft?.displayBatchName || "",
    type: "pipeline",
    status: "preview_required",
    previewType: "seedance_plan",
    userId: currentUserId(context),
    projectRoot: context.projectName || "current_project",
    templateSnapshot: record.templateSnapshot,
    referenceVideo: record.referenceVideo,
    decomposition: record.decomposition,
    estimate: record.estimate,
    request: {
      ...record.request,
      branches: branchDrafts
    },
    branchDrafts,
    scripts: [],
    tasks: [],
    plans: [],
    outputs: reusableDraft?.outputs || [],
    qcSummary: reusableDraft?.qcSummary || {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: []
    },
    createdAt: reusableDraft?.createdAt || now,
    updatedAt: now
  };
}

async function assertPlanGenerationAllowed(context, record) {
  if (record.estimate.durationSec === 30 && preflightStitcher(context).status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", {
      estimateId: record.estimate.estimateId,
      capability: "stitcher"
    });
  }
}

async function assertCanStartFromEstimate(context, record, request, options = {}) {
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
}

async function startBatchFromEstimateOnce(context, request = {}) {
  const record = await loadEstimate(context, request.estimateId);
  await assertCanStartFromEstimate(context, record, request);
  if (record.estimate.durationSec === 30 && preflightStitcher(context).status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", {
      estimateId: record.estimate.estimateId,
      capability: "stitcher"
    });
  }
  const draftBatch = reusableDraftBatch(await loadDraftBatch(context, request.batchId));
  const now = new Date().toISOString();
  const batch = {
    batchId: draftBatch?.batchId || makeBatchId(),
    userBatchName: record.request.batchName || draftBatch?.userBatchName || "",
    displayBatchName: record.request.batchName || draftBatch?.displayBatchName || "",
    type: "pipeline",
    status: "queued",
    userId: currentUserId(context),
    projectRoot: context.projectName || "current_project",
    templateSnapshot: record.templateSnapshot,
    referenceVideo: record.referenceVideo,
    decomposition: record.decomposition,
    estimate: record.estimate,
    request: record.request,
    scripts: [],
    tasks: [],
    outputs: draftBatch?.outputs || [],
    qcSummary: draftBatch?.qcSummary || {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: []
    },
    createdAt: draftBatch?.createdAt || now,
    updatedAt: now
  };
  await saveBatch(context, batch);
  const preparedBatch = await prepareBatchForPipeline(context, batch);
  const result = { batch: preparedBatch };
  await recordTelemetryEvent(context, "generation_batch_started", {
    batchId: preparedBatch.batchId,
    estimateId: record.estimate.estimateId,
    idempotencyKeyPresent: true,
    durationSec: record.estimate.durationSec,
    variantCount: record.estimate.variantCount,
    models: record.estimate.models,
    scriptCount: record.estimate.scriptCount,
    seedanceSegmentCount: record.estimate.seedanceSegmentCount,
    stitchTaskCount: record.estimate.stitchTaskCount
  }, { audit: true });
  return result;
}

export async function startBatchFromEstimate(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload(request);
  return runIdempotentOperation(
    context,
    "batches_start",
    request.idempotencyKey,
    requestHash,
    () => startBatchFromEstimateOnce(context, request),
    { resourceType: "batch", replayResponse: (summary) => replayBatchResponse(context, summary) }
  );
}

async function prepareBatchPlanFromEstimateOnce(context, request = {}) {
  const record = await loadEstimate(context, request.estimateId);
  await assertCanStartFromEstimate(context, record, request, { allowPreviewRequired: true });
  const branchDrafts = normalizeBranchDrafts(
    record.templateSnapshot?.draft || {},
    record.request?.branches || record.templateSnapshot?.draft?.branches || []
  );
  await assertPlanGenerationAllowed(context, record);

  const draftBatch = reusableDraftBatch(await loadDraftBatch(context, request.batchId), { allowPreviewRequired: true });
  const batch = buildPlanPreviewBatch(context, record, draftBatch, branchDrafts);
  let planBatchId = null;
  try {
    assertSeedanceReferenceAssetLimits(branchDrafts);
    await saveBatch(context, batch);
    planBatchId = batch.batchId;
    const preparedBatch = await prepareBatchForPipeline(context, batch, {
      useLlmPlans: true,
      llmConfig: request.llmConfig || {},
      knowledgeNotes: request.knowledgeNotes || ""
    });
    const result = {
      batch: preparedBatch,
      plans: preparedBatch.plans || []
    };
    await recordTelemetryEvent(context, "seedance_plan_generated", {
      batchId: preparedBatch.batchId,
      estimateId: record.estimate.estimateId,
      idempotencyKeyPresent: true,
      planCount: preparedBatch.plans?.length || 0,
      previewType: preparedBatch.previewType
    }, { audit: true });
    return result;
  } catch (error) {
    throw enrichPlanGenerationError(error, planBatchId);
  }
}

export async function prepareBatchPlanFromEstimate(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload(request);
  return runIdempotentOperation(
    context,
    "batches_plan",
    request.idempotencyKey,
    requestHash,
    () => prepareBatchPlanFromEstimateOnce(context, request),
    { resourceType: "batch_plan", replayResponse: (summary) => replayBatchResponse(context, summary, { includePlans: true }) }
  );
}

export async function prepareBatchPlanFromEstimateStream(context, request = {}, res, options = {}) {
  const requestId = options.requestId;
  let planBatchId = null;
  try {
    writeSseLog(res, `[${new Date().toISOString()}] init batch-plan stream`);
    if (!request.idempotencyKey) {
      throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
    }
    const requestHash = hashPayload(request);
    let operationRan = false;
    const result = await runIdempotentOperation(
      context,
      "batches_plan",
      request.idempotencyKey,
      requestHash,
      async () => {
        operationRan = true;
        const record = await loadEstimate(context, request.estimateId);
        await assertCanStartFromEstimate(context, record, request, { allowPreviewRequired: true });
        const branchDrafts = normalizeBranchDrafts(
          record.templateSnapshot?.draft || {},
          record.request?.branches || record.templateSnapshot?.draft?.branches || []
        );
        await assertPlanGenerationAllowed(context, record);

        const draftBatch = reusableDraftBatch(await loadDraftBatch(context, request.batchId), { allowPreviewRequired: true });
        const batch = buildPlanPreviewBatch(context, record, draftBatch, branchDrafts);
        assertSeedanceReferenceAssetLimits(branchDrafts);
        await saveBatch(context, batch);
        planBatchId = batch.batchId;

        const llmConfig = request.llmConfig || {};
        writeSseLog(res, `model=${llmConfig.model || "(default)"} provider=${llmConfig.provider || "(default)"}`);
        const streamContext = {
          ...context,
          llmStreamHandlers: {
            onRequest: ({ mode }) => writeSseLog(res, `upstream: ${mode}`),
            onDelta: (delta) => writeSseDelta(res, delta)
          }
        };
        const preparedBatch = await prepareBatchForPipeline(streamContext, batch, {
          useLlmPlans: true,
          llmConfig,
          knowledgeNotes: request.knowledgeNotes || "",
          onPlanProgress: ({ index, total, branchLabel, branchVariantIndex, segmentIndex }) => {
            writeSseReset(res);
            writeSseLog(res, `[plan ${index}/${total}] ${branchLabel} variant=${branchVariantIndex} segment=${segmentIndex}`);
            writeSseLog(res, "POST upstream stream=true …");
          }
        });
        const operationResult = {
          batch: preparedBatch,
          plans: preparedBatch.plans || []
        };
        await recordTelemetryEvent(context, "seedance_plan_generated", {
          batchId: preparedBatch.batchId,
          estimateId: record.estimate.estimateId,
          idempotencyKeyPresent: true,
          planCount: preparedBatch.plans?.length || 0,
          previewType: preparedBatch.previewType
        }, { audit: true });
        return operationResult;
      },
      { resourceType: "batch_plan", replayResponse: (summary) => replayBatchResponse(context, summary, { includePlans: true }) }
    );
    if (!operationRan) {
      writeSseLog(res, "idempotency replay — skip upstream");
    }
    writeSseLog(res, "");
    writeSseLog(res, "[DONE] all plans ready — saving batch");
    writeSseDone(res, result, requestId);
  } catch (error) {
    writeSseError(res, enrichPlanGenerationError(error, planBatchId), requestId);
  }
}
