import { createHash, randomBytes } from "node:crypto";

import { effectiveLimits } from "./config.mjs";
import { branchSummaries, normalizeBranchDrafts } from "./branches.mjs";
import {
  PROMISE_LEVELS,
  REQUIRED_STRONG_TRUTH_FIELDS,
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
  findActiveResourceLock,
  hasWangzhuanFactsStore,
  loadActivePipelineRunFromMysql,
  loadBatchDetailFromMysql,
  loadActiveRemixFromMysql,
  loadEstimateFromMysql,
  loadIdempotencyFactFromMysql,
  loadTemplateStoreFromMysql,
  loadVideoDecompositionFromMysql,
  nextPipelineEstimateIdFromMysql,
  recordIdempotencyFact,
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

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
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
  const missingFields = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !isNonEmptyString(template.draft?.truthRules?.[field]));
  if (missingFields.length) {
    throw new WangzhuanError("strong_rule_missing", "强承诺需要补齐真实收益规则", { missingFields });
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

export async function estimateBatch(context, request = {}) {
  const requestHash = hashPayload(request);
  const replay = await loadIdempotencyFactFromMysql(context, "batches_estimate", request.idempotencyKey, requestHash);
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
      position: String(request.disclaimerOverlay.position || "bottom_center"),
      fontSize: Number(request.disclaimerOverlay.fontSize || 22),
      boxHeight: Number(request.disclaimerOverlay.boxHeight || 88),
      bottomMargin: Number(request.disclaimerOverlay.bottomMargin || 64),
      horizontalMargin: Number(request.disclaimerOverlay.horizontalMargin || 50)
    }
    : {
      enabled: true,
      position: "bottom_center",
      fontSize: 22,
      boxHeight: 88,
      bottomMargin: 64,
      horizontalMargin: 50
    };
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
      confirmationToken,
      scriptCount: estimate.scriptCount,
      seedanceSegmentCount: estimate.seedanceSegmentCount,
      stitchTaskCount: estimate.stitchTaskCount,
      thresholdKeys: Object.keys(confirmedLimits)
    }, { audit: true });
  }

  const result = { estimate, limits, capabilities };
  if (request.idempotencyKey) {
    await recordIdempotencyFact(context, "batches_estimate", request.idempotencyKey, requestHash, {
      type: "estimate",
      response: result
    });
  }
  return result;
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

async function findActiveBatch(context) {
  const active = await loadActivePipelineRunFromMysql(context);
  return active?.batchId ? active : null;
}

async function loadDraftBatch(context, batchId) {
  if (!batchId) return null;
  const detail = await loadBatchDetailFromMysql(context, batchId);
  return detail?.batch || null;
}

function sameEditableDraft(active, request = {}) {
  const activeId = active?.batchId || active?.runId || "";
  const activeStatus = active?.status || active?.runStatus || "";
  if (!activeId || !request?.batchId) return false;
  if (activeId !== request.batchId) return false;
  return ["draft", "checking"].includes(String(activeStatus || ""));
}

async function findActiveRemix(context) {
  const detail = await loadActiveRemixFromMysql(context);
  return detail?.remix || null;
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
  const lockRunId = activeMysqlLock?.runId || activeMysqlLock?.batchId || "";
  const lockStatus = String(activeMysqlLock?.runStatus || activeMysqlLock?.status || "");
  const reusingSameEditableDraft = Boolean(
    request?.batchId
      && lockRunId === request.batchId
      && ["draft", "checking"].includes(lockStatus)
  );
  if (activeMysqlLock && !reusingSameEditableDraft) {
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
  const requestHash = hashPayload(request);
  const replay = await loadIdempotencyFactFromMysql(context, "batches_start", request.idempotencyKey, requestHash);
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
  if (active && !sameEditableDraft(active, request)) {
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

  const draftBatch = await loadDraftBatch(context, request.batchId);
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
  await recordIdempotencyFact(context, "batches_start", request.idempotencyKey, requestHash, {
    type: "batch",
    response: result
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

export async function prepareBatchPlanFromEstimate(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload(request);
  const replay = await loadIdempotencyFactFromMysql(context, "batches_plan", request.idempotencyKey, requestHash);
  if (replay) return replay;

  const record = await loadEstimate(context, request.estimateId);
  await assertCanStartFromEstimate(context, record, request);
  const branchDrafts = record.request?.branches || record.templateSnapshot?.draft?.branches || [];
  if (record.estimate.durationSec === 30 && preflightStitcher(context).status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", {
      estimateId: record.estimate.estimateId,
      capability: "stitcher"
    });
  }
  const active = await findActiveBatch(context);
  if (active && !sameEditableDraft(active, request)) {
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

  const draftBatch = await loadDraftBatch(context, request.batchId);
  const now = new Date().toISOString();
  const batch = {
    batchId: draftBatch?.batchId || makeBatchId(),
    userBatchName: record.request.batchName || draftBatch?.userBatchName || "",
    displayBatchName: record.request.batchName || draftBatch?.displayBatchName || "",
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
  assertSeedanceReferenceAssetLimits(branchDrafts);
  await saveBatch(context, batch);
  const preparedBatch = await prepareBatchForPipeline(context, batch, {
    useLlmPlans: true,
    llmConfig: request.llmConfig || {},
    knowledgeNotes: request.knowledgeNotes || ""
  });
  const result = {
    batch: preparedBatch,
    plans: preparedBatch.plans || []
  };
  await recordIdempotencyFact(context, "batches_plan", request.idempotencyKey, requestHash, {
    type: "batch_plan",
    response: result
  });
  await recordTelemetryEvent(context, "seedance_plan_generated", {
    batchId: preparedBatch.batchId,
    estimateId: record.estimate.estimateId,
    idempotencyKey: request.idempotencyKey,
    planCount: preparedBatch.plans?.length || 0,
    previewType: preparedBatch.previewType
  }, { audit: true });
  return result;
}
