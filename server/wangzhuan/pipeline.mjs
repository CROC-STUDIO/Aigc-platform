import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeBranchDrafts, normalizeStoredBranchDrafts } from "./branches.mjs";
import { ensureAssetReviewsApproved, validateAssetReviewState } from "./asset-review.mjs";
import { getChannelRules } from "./channel-rules.mjs";
import { deriveSeedanceSlicesForGeneration, normalizeFissionAnalysis } from "./fission-analysis.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeGenerationTaskId, makeScriptId } from "./ids.mjs";
import {
  claimPendingSeedanceTasks,
  hasWangzhuanFactsStore,
  loadActivePipelineRunFromMysql,
  loadBatchDetailFromMysql,
  loadEstimateFromMysql,
  loadLatestBatchEstimateForReferenceVideo,
  markSeedanceTaskSubmissionSent,
  persistSeedanceSubmissionResult,
  releasePendingSeedanceTaskClaims,
  runIdempotentOperation,
  syncBatchFacts
} from "./mysql-facts.mjs";
import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  createSeedanceProviderClient,
  DEFAULT_SEEDANCE_MODEL,
  mergeBranchMediaDraft,
  resolveSeedanceModel,
  summarizeSeedanceRequest,
  summarizeSeedanceResponse
} from "./seedance-provider.mjs";
import { toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import {
  buildGenerationPlanRecord,
  formatProtagonistFissionGuide,
  generateSeedanceBranchPlans,
  generateSeedanceVariantPlans,
  generateThirtySecondSeedancePlans,
  generateSeedancePlan,
  validateBranchTruthRulesForPlan,
  validateSeedancePlan
} from "./plan-preview.mjs";
import { copyrightMusicRestriction, repairFormalPlanContract } from "./plan-repair.mjs";
import { listBackgroundJobs } from "./background-jobs.mjs";
import { normalizeBatchPostProcess } from "./postprocess.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
const STOPPABLE_BATCH_STATUSES = new Set(["draft", "checking", "queued", "running", "stitching", "qc", "preview_required"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "skipped", "stopped"]);
const SLICE_ROLES = ["hook_slice", "proof_slice", "withdrawal_slice", "cta_slice"];
const FISSION_SLICE_METADATA_FIELDS = [
  "storySegmentIndex",
  "seedanceSliceIndex",
  "startSec",
  "endSec",
  "sliceSplitReason",
  "conversionSignals",
  "conversionEffectOpportunities",
  "voiceoverObserved",
  "variableLayers",
  "timelineItems",
  "coreHook",
  "explosivePoint",
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality",
  "subtitleWorkflow",
  "targetSegmentMerge",
  "targetSegmentSplit",
  "mergedSourceSegments",
  "sourceSegmentIndex"
];

function normalizePositiveInteger(value, fallback, { min = 1, max = 10 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function resolvePlanLlmConcurrency(context = {}, options = {}) {
  if (context.llmStreamHandlers) return { branch: 1, variant: 1, total: 1 };
  const configured = options.planConcurrency
    ?? context.config?.wangzhuan?.planLlmConcurrency
    ?? process.env.WANGZHUAN_PLAN_LLM_CONCURRENCY;
  if (configured && typeof configured === "object") {
    const branch = normalizePositiveInteger(configured.branch, 2, { min: 1, max: 5 });
    const variant = normalizePositiveInteger(configured.variant, 3, { min: 1, max: 6 });
    return {
      branch,
      variant,
      total: normalizePositiveInteger(configured.total, branch * variant, { min: 1, max: 10 })
    };
  }
  const branch = normalizePositiveInteger(configured, 2, { min: 1, max: 5 });
  return { branch, variant: 1, total: branch };
}

async function mapWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }));
  return results;
}

function branchPlanCacheKey(branch = {}) {
  return branch.branchId || branch.branchLabel || String(branch.branchIndex || "");
}

function pickBranchBatchPlan(branchPlans = [], branchVariantIndex, segmentIndex) {
  if (!Array.isArray(branchPlans) || !branchPlans.length) return null;
  return branchPlans.find((item) => {
    return Number(item?.branchVariantIndex || 0) === Number(branchVariantIndex)
      && Number(item?.segmentIndex || 0) === Number(segmentIndex);
  })?.planPayload || null;
}

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
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

function validateBatchId(batchId) {
  if (!/^wzb_\d{14}_[a-f0-9]{4}$/.test(String(batchId || ""))) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
}

function batchDir(context, batchId) {
  validateBatchId(batchId);
  return join(wangzhuanPaths(context).batchesDir, batchId);
}

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

async function requireFactsStore() {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取业务状态");
  }
}

async function readBatch(context, batchId) {
  validateBatchId(batchId);
  if (typeof context.readBatchForTest === "function") {
    const batch = await context.readBatchForTest(batchId);
    if (!batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
    return batch;
  }
  await requireFactsStore();
  const detail = await loadBatchDetailFromMysql(context, batchId);
  const batch = detail?.batch;
  if (!batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatchWithTrigger(context, batch, triggerName = "batch_write") {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  if (typeof context.writeBatchForTest === "function") {
    return context.writeBatchForTest(next, triggerName);
  }
  const synced = await syncBatchFacts(context, next, triggerName);
  if (synced?.skipped) {
    const detail = synced.error?.message || synced.error?.code || null;
    if (!await hasWangzhuanFactsStore()) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存业务状态");
    }
    throw new WangzhuanError("database_unavailable", detail
      ? `批次状态保存失败：${String(detail).slice(0, 300)}`
      : "批次状态保存失败，请确认数据库迁移已执行到最新版本（含 pending_preview 任务状态）", {
      batchId: batch.batchId,
      triggerName,
      cause: detail
    });
  }
  return next;
}

export async function writeBatch(context, batch, triggerName = "batch_write") {
  return writeBatchWithTrigger(context, batch, triggerName);
}

function scriptBody(batch, branch, variantIndex, segmentIndex, requiredDisclaimers = [], durationSec = 15) {
  const productName = branch?.productName || batch.templateSnapshot?.draft?.productName || "Product";
  const materialDirection = branch?.materialDirection || batch.templateSnapshot?.draft?.materialDirection;
  const decomposition = batch.decomposition || {};
  const baseAction = decomposition.action || "Show the product benefit in a vertical app demo";
  const rewardFeedback = decomposition.rewardFeedback || "Show believable reward feedback inside the app";
  const languages = Array.isArray(branch?.languages) && branch.languages.length
    ? branch.languages
    : (branch?.language ? [branch.language] : []);
  const regions = Array.isArray(branch?.regions) ? branch.regions : [];
  return [
    `${baseAction}.`,
    `Variant ${variantIndex} focuses on ${productName} with ${batch.referenceVideo?.scene || decomposition.scene || "a reference-inspired scene"}.`,
    materialDirection ? `Creative angle: ${materialDirection}.` : "",
    languages.length ? `Primary spoken language is ${languages[0]}${languages.length > 1 ? `, with locale coverage for ${languages.join(", ")}` : ""}.` : "",
    regions.length ? `Target regions: ${regions.join(", ")}.` : "",
    `Segment ${segmentIndex} keeps pacing within ${durationSec} seconds and includes ${rewardFeedback}.`,
    ...requiredDisclaimers.map((item) => `Disclaimer: ${item}.`)
  ].filter(Boolean).join(" ");
}

function scriptHook(batch, branch, variantIndex) {
  const hook = batch.decomposition?.hook || "See rewards from daily app tasks";
  const branchPrefix = branch?.branchLabel ? `${branch.branchLabel}: ` : "";
  return variantIndex === 1 ? `${branchPrefix}${hook}` : `${branchPrefix}${hook} - angle ${variantIndex}`;
}

function rewardExpression(batch, branch) {
  const rules = branch?.truthRules || batch.templateSnapshot?.draft?.truthRules;
  if (!rules?.rewardAmountRange) return undefined;
  return `${rules.rewardAmountRange} when ${rules.rewardCondition}`;
}

function resolveSliceStrategy(batch = {}) {
  return batch.estimate?.request?.sliceStrategy
    || batch.templateSnapshot?.draft?.sliceStrategy
    || "fixed_15s";
}

function preferredSliceCount(duration, sliceStrategy) {
  if (Number(duration) === 30) return 2;
  if (sliceStrategy === "three_slice") return 3;
  if (sliceStrategy === "two_15s") return 2;
  if (sliceStrategy === "auto_10_15s_multi_slice") return Math.max(1, Math.ceil(duration / 15));
  return 1;
}

function normalizeTargetSegmentCount(value) {
  if (value === "follow_decomposition" || value === "auto" || value == null || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 5 ? count : null;
}

function resolveTargetSegmentCount(batch = {}) {
  return normalizeTargetSegmentCount(
    batch.estimate?.request?.targetSegmentCount
      ?? batch.templateSnapshot?.draft?.targetSegmentCount
  );
}

function feasibleSliceCount(duration, preferredCount) {
  const maxFeasible = Math.max(1, Math.floor(duration / 10));
  const minFeasible = Math.max(1, Math.ceil(duration / 15));
  if (minFeasible > maxFeasible) return maxFeasible;
  const count = Math.max(minFeasible, Math.min(preferredCount, maxFeasible));
  return Math.max(1, count);
}

export function buildSlicePlan({ durationSec = 15, sliceStrategy = "fixed_15s" } = {}) {
  const duration = Math.max(10, Number(durationSec) || 15);
  const count = feasibleSliceCount(duration, preferredSliceCount(duration, sliceStrategy));
  const base = Math.floor(duration / count);
  const remainder = duration % count;
  const slices = [];
  let startSec = 0;
  for (let index = 0; index < count; index += 1) {
    const sliceDuration = base + (index >= count - remainder ? 1 : 0);
    const endSec = startSec + sliceDuration;
    slices.push({
      segmentIndex: index + 1,
      startSec,
      endSec,
      durationSec: sliceDuration,
      segmentRole: SLICE_ROLES[index] || "proof_slice"
    });
    startSec = endSec;
  }
  return slices;
}

function normalizeSliceIndexes(slices = []) {
  return slices.map((slice, index) => ({
    ...slice,
    segmentIndex: index + 1,
    segmentRole: slice.segmentRole || SLICE_ROLES[index] || "proof_slice"
  }));
}

function mergeAdjacentSlices(left = {}, right = {}, index = 0) {
  const startSec = Number(left.startSec || 0);
  const endSec = Number(right.endSec ?? right.startSec ?? startSec);
  const durationSec = Math.max(1, Math.round((endSec - startSec) * 100) / 100);
  return {
    ...left,
    startSec,
    endSec,
    durationSec,
    sliceDurationSec: durationSec,
    segmentRole: left.segmentRole || SLICE_ROLES[index] || "proof_slice",
    targetSegmentMerge: true,
    mergedSourceSegments: [
      ...(Array.isArray(left.mergedSourceSegments) ? left.mergedSourceSegments : [left.segmentIndex || index + 1]),
      ...(Array.isArray(right.mergedSourceSegments) ? right.mergedSourceSegments : [right.segmentIndex || index + 2])
    ],
    conversionEffectOpportunities: [
      ...(Array.isArray(left.conversionEffectOpportunities) ? left.conversionEffectOpportunities : []),
      ...(Array.isArray(right.conversionEffectOpportunities) ? right.conversionEffectOpportunities : [])
    ]
  };
}

function splitOneSlice(slice = {}, index = 0) {
  const startSec = Number(slice.startSec || 0);
  const endSec = Number(slice.endSec ?? startSec + Number(slice.durationSec || 1));
  const durationSec = Math.max(1, Math.round((endSec - startSec) * 100) / 100);
  const firstDuration = Math.max(1, Math.floor(durationSec / 2));
  const splitSec = Math.round((startSec + firstDuration) * 100) / 100;
  const first = {
    ...slice,
    startSec,
    endSec: splitSec,
    durationSec: Math.max(1, Math.round((splitSec - startSec) * 100) / 100),
    sliceDurationSec: Math.max(1, Math.round((splitSec - startSec) * 100) / 100),
    targetSegmentSplit: true,
    sourceSegmentIndex: slice.segmentIndex || index + 1
  };
  const second = {
    ...slice,
    startSec: splitSec,
    endSec,
    durationSec: Math.max(1, Math.round((endSec - splitSec) * 100) / 100),
    sliceDurationSec: Math.max(1, Math.round((endSec - splitSec) * 100) / 100),
    targetSegmentSplit: true,
    sourceSegmentIndex: slice.segmentIndex || index + 1
  };
  return [first, second];
}

function clampSliceDuration(slice = {}, maxDuration = 15) {
  const startSec = Number(slice.startSec || 0);
  const capped = Math.max(1, Number(maxDuration) || 15);
  const endSec = Math.round((startSec + capped) * 100) / 100;
  return {
    ...slice,
    startSec,
    endSec,
    durationSec: capped,
    sliceDurationSec: capped,
    targetSegmentClamped: true
  };
}

export function adjustSlicePlanToTargetCount(slices = [], targetSegmentCount = null, {
  maxSliceSec = 15,
  // Slightly over-budget slices are truncated to maxSliceSec; only longer ones are bisected.
  splitAboveSec = 19
} = {}) {
  const targetCount = normalizeTargetSegmentCount(targetSegmentCount);
  const maxDuration = Math.max(1, Number(maxSliceSec) || 15);
  const splitThreshold = Math.max(maxDuration, Number(splitAboveSec) || 19);
  if (!Array.isArray(slices) || slices.length === 0) {
    return normalizeSliceIndexes(slices);
  }
  let nextSlices = normalizeSliceIndexes(slices);
  // Normalize over-budget slices to Seedance's ceiling:
  // - (max, splitThreshold]: clamp to maxSliceSec
  // - > splitThreshold: keep bisecting until every part is within splitThreshold, then clamp leftovers
  for (let index = 0; index < nextSlices.length; index += 1) {
    while (Number(nextSlices[index]?.durationSec || 0) > splitThreshold) {
      const parts = splitOneSlice(nextSlices[index], index);
      if (parts.every((part) => Number(part.durationSec || 0) >= Number(nextSlices[index]?.durationSec || 0))) {
        break;
      }
      nextSlices.splice(index, 1, ...parts);
      nextSlices = normalizeSliceIndexes(nextSlices);
    }
    if (Number(nextSlices[index]?.durationSec || 0) > maxDuration) {
      nextSlices[index] = clampSliceDuration(nextSlices[index], maxDuration);
    }
  }
  if (!targetCount || nextSlices.length === targetCount) {
    return normalizeSliceIndexes(nextSlices);
  }
  while (nextSlices.length > targetCount) {
    let mergeIndex = -1;
    let smallestDuration = Infinity;
    for (let index = 0; index < nextSlices.length - 1; index += 1) {
      const combined = Number(nextSlices[index]?.durationSec || 0) + Number(nextSlices[index + 1]?.durationSec || 0);
      // Never merge past Seedance's per-request duration ceiling.
      if (combined > maxDuration) continue;
      if (combined < smallestDuration) {
        smallestDuration = combined;
        mergeIndex = index;
      }
    }
    if (mergeIndex < 0) break;
    nextSlices.splice(mergeIndex, 2, mergeAdjacentSlices(nextSlices[mergeIndex], nextSlices[mergeIndex + 1], mergeIndex));
    nextSlices = normalizeSliceIndexes(nextSlices);
  }
  while (nextSlices.length < targetCount) {
    let splitIndex = 0;
    let longestDuration = -1;
    for (let index = 0; index < nextSlices.length; index += 1) {
      const duration = Number(nextSlices[index]?.durationSec || 0);
      if (duration > longestDuration) {
        longestDuration = duration;
        splitIndex = index;
      }
    }
    if (longestDuration <= 1) break;
    nextSlices.splice(splitIndex, 1, ...splitOneSlice(nextSlices[splitIndex], splitIndex));
    nextSlices = normalizeSliceIndexes(nextSlices);
  }
  return normalizeSliceIndexes(nextSlices);
}

function hasFissionAnalysisSource(decomposition = {}) {
  return Array.isArray(decomposition?.seedanceSlices) && decomposition.seedanceSlices.length > 0
    || Array.isArray(decomposition?.storySegments) && decomposition.storySegments.length > 0;
}

function pickSliceMetadata(slice = {}) {
  return Object.fromEntries(
    FISSION_SLICE_METADATA_FIELDS
      .filter((field) => slice[field] !== undefined)
      .map((field) => [field, slice[field]])
  );
}

export function buildSlicePlanFromDecomposition(batch = {}) {
  const durationSec = Number(batch.estimate?.durationSec || batch.templateSnapshot?.draft?.defaultDurationSec || 15);
  const decomposition = batch.decomposition || {};
  const targetSegmentCount = resolveTargetSegmentCount(batch);
  if (hasFissionAnalysisSource(decomposition)) {
    const fissionAnalysis = normalizeFissionAnalysis(decomposition, { durationSec });
    const slices = deriveSeedanceSlicesForGeneration(fissionAnalysis, { durationSec });
    if (slices.length > 0) {
      const slicePlan = slices.map((slice, index) => ({
        ...pickSliceMetadata(slice),
        segmentIndex: index + 1,
        startSec: slice.startSec,
        endSec: slice.endSec,
        durationSec: slice.durationSec,
        sliceDurationSec: slice.sliceDurationSec || slice.durationSec,
        segmentRole: slice.segmentRole || SLICE_ROLES[index] || "proof_slice"
      }));
      return adjustSlicePlanToTargetCount(slicePlan, targetSegmentCount);
    }
  }

  const fallbackPlan = buildSlicePlan({
    durationSec,
    sliceStrategy: resolveSliceStrategy(batch)
  });
  return adjustSlicePlanToTargetCount(fallbackPlan, targetSegmentCount);
}

export function planSegmentMultiplier(batch = {}) {
  return buildSlicePlanFromDecomposition(batch).length;
}

function usesThirtySecondContinuityPlan(batch = {}) {
  return !hasFissionAnalysisSource(batch.decomposition || {})
    && Number(batch.estimate?.durationSec) === 30
    && planSegmentMultiplier(batch) === 2;
}

function promptAssetLines(assetUrls = {}) {
  const labels = [
    ["productIcon", "Product icon"],
    ["productScreenshot", "Product screenshot"],
    ["productRecording", "Product recording"],
    ["personAsset", "Person asset"],
    ["rewardElement", "Reward element"],
    ["ctaAsset", "CTA image for final tail only"],
    ["endingAsset", "Ending image for final tail only"]
  ];
  return labels.map(([key, label]) => assetUrls[key] ? `${label} URL: ${assetUrls[key]}` : "");
}

function finalTailAssetGuide(assetUrls = {}, script = {}) {
  const hasTailImage = assetUrls.ctaAsset || assetUrls.endingAsset;
  if (!hasTailImage) return "";
  const isFinalSlice = script.isFinalSeedanceSlice || script.segmentRole === "cta_slice";
  return isFinalSlice
    ? "CTA/Ending image rule: ctaAsset and endingAsset are still-image references only for the very end of the final Seedance slice; use them as visual style/layout references for the closing tail, do not introduce them in earlier beats, and do not animate them as separate mid-video scenes."
    : "CTA/Ending image rule: ctaAsset and endingAsset are reserved for the final stitched tail and must not appear in this Seedance slice.";
}

function buildPrompt(batch, script, kind) {
  const draft = batch.templateSnapshot?.draft || {};
  const branch = script.branchDraft || draft;
  const decomposition = batch.decomposition || {};
  const assetUrls = branch.assetUrls || {};
  const channel = branch.targetChannels?.[0] || batch.estimate?.request?.targetChannel || batch.templateSnapshot?.draft?.targetChannels?.[0] || "generic";
  const languages = Array.isArray(branch.languages) && branch.languages.length
    ? branch.languages
    : [branch.language || draft.languages?.[0] || draft.language || batch.estimate?.request?.languages?.[0] || batch.estimate?.request?.language || "en-US"];
  const regions = Array.isArray(branch.regions) && branch.regions.length
    ? branch.regions
    : (Array.isArray(branch.targetRegions) && branch.targetRegions.length
      ? branch.targetRegions
      : (Array.isArray(draft.regions) && draft.regions.length
        ? draft.regions
        : (Array.isArray(draft.targetRegions) && draft.targetRegions.length ? draft.targetRegions : [])));
  const lines = [
    script.branchId ? `Branch: ${script.branchLabel || script.branchId} (${script.branchId})` : "",
    `Product: ${branch.productName || draft.productName || "Product"}`,
    branch.productLink ? `Store page: ${branch.productLink}` : "",
    `Primary language: ${languages[0] || "en-US"}`,
    `All languages: ${languages.join(", ")}`,
    `Target regions: ${regions.join(", ") || "US"}`,
    `Currency: ${branch.currencySymbol || draft.currencySymbol || ""}`,
    `Channel: ${channel}`,
    `Revenue promise level: ${branch.promiseLevel || draft.promiseLevel || "stable"}`,
    branch.materialDirection ? `Material direction: ${branch.materialDirection}` : "",
    branch.voiceoverStyle ? `Voiceover style: ${branch.voiceoverStyle}` : "",
    ...promptAssetLines(assetUrls),
    `Scene: ${decomposition.scene || "mobile app reward scene"}`,
    `Subject: ${decomposition.subject || "user with phone"}`,
    decomposition.protagonist ? `Protagonist: ${decomposition.protagonist}` : "",
    decomposition.voiceover ? `Voiceover function: ${decomposition.voiceover}` : "",
    `Camera: ${decomposition.camera || "vertical close-up"}`,
    `Lighting: ${decomposition.lighting || "bright natural lighting"}`,
    `Style: ${decomposition.style || "clean performance ad"}`,
    `Script hook: ${script.hook}`,
    `Script body: ${script.body}`,
    `CTA: ${script.cta}`,
    `Ending: ${script.ending}`,
    finalTailAssetGuide(assetUrls, script),
    branch.variantPrompt ? `Variant instructions: ${branch.variantPrompt}` : "",
    formatProtagonistFissionGuide(decomposition, script.branchVariantIndex || script.variantIndex || 1, branch.variantPrompt),
    branch.customPrompt ? `Additional user prompt: ${branch.customPrompt}` : "",
    branch.negativePrompt ? `User restrictions: ${branch.negativePrompt}` : "",
    `Strict language rule: the generated video must use only the user-specified primary language ${languages[0] || "en-US"} for every visible scene text, app/UI microcopy, subtitles/captions, CTA wording, voiceover, spoken dialogue, and audio direction. Do not show Chinese, English defaults, source-video language, or mixed-language text unless ${languages[0] || "en-US"} explicitly requires it. Multi-language config (${languages.join(", ")}) and target regions (${regions.join(", ") || "US"}) may only influence localization style and scenario choices.`,
    "Protagonist rule: seedancePrompt must name a specific profession/identity and reflect it in clothing, props, scene, and voiceover tone; do not use generic labels like user or young woman.",
    "Do not include competitor names, watermarks, logos, signed URLs, or policy-unsafe income guarantees.",
    kind === "image" ? "Task: create the first-frame image prompt for Seedance." : `Task: create a ${script.durationSec || 15} second 9:16 Seedance image-to-video prompt.`
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

async function writePlainPrompt(target, text) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function writeTaskMaps(context, batch) {
  const dir = join(batchDir(context, batch.batchId), "task-map");
  const jsonPath = join(dir, "task-id-map.json");
  const csvPath = join(dir, "task-id-map.csv");
  await writeAtomicJson(jsonPath, batch.tasks);
  const header = [
    "source_type",
    "batch_id",
    "branch_id",
    "branch_label",
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
  const rows = batch.tasks.map((task) => [
    "pipeline",
    batch.batchId,
    task.branchId || "",
    task.branchLabel || "",
    task.scriptId,
    task.generationTaskId,
    task.imageTaskId || "",
    task.seedanceTaskId || "",
    task.modelImage,
    task.modelVideo,
    "",
    task.outputPath || "",
    "",
    task.errorCode || ""
  ]);
  const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  await writePlainPrompt(csvPath, `${csv}\n`);
}

async function buildSeedanceTaskPayload(context, batch, task, provider) {
  let promptRelPath = task.promptPath;
  if (!promptRelPath) {
    const script = (Array.isArray(batch.scripts) ? batch.scripts : []).find((item) => item.scriptId === task.scriptId);
    promptRelPath = script?.promptPath || "";
  }
  if (!promptRelPath) {
    throw new WangzhuanError("missing_required_file", "Seedance prompt 文件缺失", {
      generationTaskId: task.generationTaskId,
      batchId: batch.batchId,
      scriptId: task.scriptId || ""
    });
  }
  const promptTarget = join(context.userProjectRoot, promptRelPath);
  const prompt = await readFile(promptTarget, "utf8");
  const sourceLanguage = batch.request?.sourceLanguage
    || batch.sourceLanguage
    || batch.templateSnapshot?.sourceLanguage
    || batch.templateSnapshot?.sourceVideoProfile?.language
    || batch.referenceVideo?.language
    || batch.targetLanguage
    || batch.request?.targetLanguage
    || "en-US";
  const safePrompt = /copyrighted music|版权音乐|direitos autorais|derechos de autor|berhak cipta|著作権で保護された音楽|저작권이 있는 음악/i.test(prompt)
    ? prompt
    : `${prompt.trim()}\n${copyrightMusicRestriction(sourceLanguage)}\n`;
  const media = [
    ...collectSeedanceMedia(batch, task),
    ...continuityReferenceMedia(task)
  ];
  return buildSeedanceGenerationPayload({
    model: resolveSeedanceModel(batch, provider, task),
    prompt: safePrompt,
    media,
    mode: media.length ? "omni_reference" : "text_to_video",
    ratio: provider?.config?.ratio || batch.templateSnapshot?.draft?.defaultOutputRatio || "9:16",
    duration: task.durationSec || 15,
    resolution: provider?.config?.resolution || "720p",
    generateAudio: provider?.config?.generateAudio,
    watermark: provider?.config?.watermark ?? false,
    metadata: {
      metadata: {
        batchId: batch.batchId,
        generationTaskId: task.generationTaskId,
        scriptId: task.scriptId,
        branchId: task.branchId || "",
        branchLabel: task.branchLabel || ""
      }
    }
  });
}

async function submitTaskToSeedance(context, batch, task, provider, now, leaseOwner) {
  if (!provider) {
    throw new WangzhuanError("upstream_failed", "Seedance 未配置，无法提交生成任务", {
      generationTaskId: task.generationTaskId,
      requiredConfig: "wangzhuan.seedanceProvider.endpoint",
      requiredEnv: ["WANGZHUAN_SEEDANCE_ENDPOINT", "WANGZHUAN_LLM_API_KEY"]
    });
  }
  const retryInfo = task.retryInfo || task.responseSummary?.retryInfo;
  let payload;
  let result;
  let submissionMarkedSent = false;
  try {
    payload = await buildSeedanceTaskPayload(context, batch, task, provider);
    const requestSummary = summarizeSeedanceRequest(payload, provider);
    try {
      await markSeedanceTaskSubmissionSent(context, {
        batchId: batch.batchId,
        taskUid: task.generationTaskId,
        leaseOwner,
        attemptNo: Number(task.attempts || 0) + 1,
        provider: provider.provider || "seedance",
        sentAt: now,
        requestSummary
      });
      submissionMarkedSent = true;
    } catch (error) {
      if (!error.code) error.code = "database_unavailable";
      error.seedanceSubmissionNotSent = true;
      throw error;
    }
    result = await provider.createTask(payload, {
      batchId: batch.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      branchId: task.branchId || "",
      branchLabel: task.branchLabel || ""
    });
  } catch (error) {
    if (error?.seedanceSubmissionNotSent
      || error?.code === "seedance_submission_claim_lost"
      || error?.code === "database_unavailable") throw error;
    const submissionUnknown = error?.code === "submission_unknown" || error?.data?.submissionUnknown === true;
    const localAssetReviewFailure = error?.code === "asset_review_pending" && !submissionMarkedSent;
    return {
      ...task,
      status: "failed",
      imageTaskId: task.imageTaskId || "",
      seedanceTaskId: task.seedanceTaskId || "",
      provider: provider.provider || "seedance",
      providerJobId: task.providerJobId,
      remoteUrlStored: false,
      attempts: Number(task.attempts || 0) + (localAssetReviewFailure ? 0 : 1),
      startedAt: now,
      finishedAt: now,
      errorCode: submissionUnknown ? "submission_unknown" : error?.code || "upstream_failed",
      errorMessage: submissionUnknown
        ? "Seedance 提交结果未知，已停止自动重试以避免重复扣费"
        : error?.message || "Seedance 上游请求失败",
      requestSummary: summarizeSeedanceRequest(payload, provider),
      responseSummary: {
        status: submissionUnknown ? "submission_unknown" : "failed",
        upstreamCode: error?.data?.upstreamCode || error?.code || "",
        upstreamMessage: error?.data?.upstreamMessage || error?.message || "",
        httpStatus: error?.data?.status,
        ...(retryInfo ? { retryInfo } : {})
      }
    };
  }
  const seedanceTaskId = result.taskId || result.id || result.task_id;
  if (!seedanceTaskId) {
    return {
      ...task,
      status: "failed",
      imageTaskId: task.imageTaskId || "",
      seedanceTaskId: "",
      provider: provider.provider || "seedance",
      remoteUrlStored: false,
      attempts: Number(task.attempts || 0) + 1,
      startedAt: now,
      finishedAt: now,
      errorCode: "submission_unknown",
      errorMessage: "Seedance 上游响应缺少 task id，已停止自动重试以避免重复扣费",
      requestSummary: summarizeSeedanceRequest(payload, provider),
      responseSummary: {
        ...summarizeSeedanceResponse(result),
        ...(retryInfo ? { retryInfo } : {})
      }
    };
  }
  return {
    ...task,
    status: "waiting_upstream",
    imageTaskId: task.imageTaskId || "",
    seedanceTaskId,
    provider: provider.provider || "seedance",
    providerJobId: seedanceTaskId,
    upstreamPollAttempts: 0,
    remoteUrlStored: false,
    attempts: Number(task.attempts || 0) + 1,
    startedAt: now,
    finishedAt: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined,
    requestSummary: summarizeSeedanceRequest(payload, provider),
    responseSummary: {
      ...summarizeSeedanceResponse(result),
      ...(retryInfo ? { retryInfo } : {})
    }
  };
}

function taskSegmentKey(task = {}) {
  return [
    task.branchId || "default",
    String(task.branchVariantIndex || task.variantIndex || 1)
  ].join(":");
}

function hasFissionSliceOrder(task = {}) {
  return Number.isFinite(Number(task.storySegmentIndex))
    && Number.isFinite(Number(task.seedanceSliceIndex))
    && Number(task.seedanceSliceIndex) > 0;
}

export function taskNeedsContinuityReference(batch = {}, task = {}) {
  const segmentIndex = Number(task.segmentIndex || 1);
  if (segmentIndex <= 1) return false;
  if (hasFissionSliceOrder(task)) {
    return Number(task.seedanceSliceIndex || 1) > 1;
  }
  return usesThirtySecondContinuityPlan(batch);
}

export function findContinuitySourceTask(tasks = [], task = {}) {
  if (hasFissionSliceOrder(task)) {
    const storySegmentIndex = Number(task.storySegmentIndex);
    const seedanceSliceIndex = Number(task.seedanceSliceIndex);
    return tasks.find((candidate) => {
      return taskSegmentKey(candidate) === taskSegmentKey(task)
        && Number(candidate.storySegmentIndex || 0) === storySegmentIndex
        && Number(candidate.seedanceSliceIndex || 0) === seedanceSliceIndex - 1
        && candidate.status === "downloaded"
        && Boolean(candidate.outputPath);
    }) || null;
  }
  const segmentIndex = Number(task.segmentIndex || 1);
  if (segmentIndex <= 1) return null;
  return tasks.find((candidate) => {
    return taskSegmentKey(candidate) === taskSegmentKey(task)
      && Number(candidate.segmentIndex || 1) === segmentIndex - 1
      && candidate.status === "downloaded"
      && Boolean(candidate.outputPath);
  }) || null;
}

function isApprovedContinuityReference(reference = {}) {
  const status = String(reference.review?.status || "").toLowerCase();
  return Boolean(reference.review?.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(status));
}

export function isGenerationTaskSubmitReady(batch = {}, task = {}) {
  if (task.status !== "pending") return false;
  if (!taskNeedsContinuityReference(batch, task)) return true;
  if (!findContinuitySourceTask(Array.isArray(batch.tasks) ? batch.tasks : [], task)) return false;
  return isApprovedContinuityReference(task.continuityReference);
}

function isFalseLike(value) {
  return value === false
    || value === 0
    || ["false", "0", "none", "off", "no_post_process"].includes(String(value || "").trim().toLowerCase());
}

function isTrueLike(value) {
  return value === true
    || value === 1
    || ["true", "1", "post_process", "pixel_tech"].includes(String(value || "").trim().toLowerCase());
}

function normalizeSubtitleWorkflowForArtifact(value) {
  if (isFalseLike(value)) {
    return { postSubtitleRequired: false, provider: "pixel_tech", subtitleScript: [] };
  }
  if (isTrueLike(value)) {
    return { postSubtitleRequired: true, provider: "pixel_tech", subtitleScript: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { postSubtitleRequired: false, provider: "pixel_tech", subtitleScript: [] };
  }
  return {
    postSubtitleRequired: !isFalseLike(value.postSubtitleRequired),
    provider: value.provider || "pixel_tech",
    subtitleScript: Array.isArray(value.subtitleScript) ? value.subtitleScript : []
  };
}

function taskMatchesScript(task = {}, script = {}) {
  if (task.scriptId && script.scriptId && task.scriptId === script.scriptId) return true;
  if (task.planId && script.planId && task.planId === script.planId) return true;
  if (!task.scriptId && !task.planId) {
    return (task.branchId || "") === (script.branchId || "")
      && Number(task.segmentIndex || 1) === Number(script.segmentIndex || 1)
      && Number(task.branchVariantIndex || task.variantIndex || 1) === Number(script.branchVariantIndex || script.variantIndex || 1);
  }
  return false;
}

function findGenerationTaskForScript(tasks = [], script = {}) {
  return tasks.find((task) => task.scriptId && script.scriptId && task.scriptId === script.scriptId)
    || tasks.find((task) => task.planId && script.planId && task.planId === script.planId)
    || tasks.find((task) => taskMatchesScript(task, script));
}

export function buildSubtitlePostProcessArtifact(batch = {}) {
  const scripts = Array.isArray(batch.scripts) ? batch.scripts : [];
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  return {
    schemaVersion: "subtitle-postprocess.v1",
    batchId: batch.batchId || "",
    provider: "pixel_tech",
    items: scripts
      .map((script) => ({
        script,
        task: findGenerationTaskForScript(tasks, script),
        workflow: normalizeSubtitleWorkflowForArtifact(script.subtitleWorkflow)
      }))
      .filter(({ workflow }) => workflow.postSubtitleRequired)
      .map(({ script, task, workflow }) => ({
        scriptId: script.scriptId || task?.scriptId || "",
        generationTaskId: task?.generationTaskId || script.generationTaskId || "",
        branchId: script.branchId || task?.branchId || "",
        segmentIndex: Number(script.segmentIndex || task?.segmentIndex || 1),
        durationSec: Number(script.durationSec || task?.durationSec || 15),
        burnedInSubtitles: false,
        provider: workflow.provider || "pixel_tech",
        subtitleScript: workflow.subtitleScript.length
          ? workflow.subtitleScript
          : (Array.isArray(script.subtitles) ? script.subtitles : [])
      }))
  };
}

function continuityReferenceMedia(task = {}) {
  if (!isApprovedContinuityReference(task.continuityReference)) return [];
  return [{
    type: "image_asset",
    assetId: task.continuityReference.review.assetId,
    assetKey: "continuityFrame",
    assetRole: "reference",
    storedPath: task.continuityReference.storedPath || ""
  }];
}

async function ensureEventFile(_context, _batchId) {
  // `batch_prepared` was a legacy trigger name from the pre-preview flow.
  // The current preview-required pipeline already persists the prepared batch
  // via `writeBatch()`, so replaying a state transition here can incorrectly
  // push `preview_required` runs through an unsupported transition.
}

async function writeProcessTraceFiles(context, batch) {
  const root = batchDir(context, batch.batchId);
  const draft = batch.templateSnapshot?.draft || {};
  const assets = draft.assetFileNames || {};
  const assetUrls = draft.assetUrls || {};
  const promptItems = [];
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const seedancePromptTarget = join(context.userProjectRoot, task.promptPath);
    const imagePromptTarget = join(dirname(seedancePromptTarget), `${task.generationTaskId}_image.txt`);
    promptItems.push({
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      branchId: task.branchId || "",
      branchLabel: task.branchLabel || "",
      seedancePromptPath: task.promptPath,
      imagePromptPath: userRelative(context, imagePromptTarget),
      seedancePrompt: await readFile(seedancePromptTarget, "utf8"),
      imagePrompt: await readFile(imagePromptTarget, "utf8")
    });
  }

  await writeAtomicJson(join(root, "00-brief.json"), {
    schemaVersion: "wangzhuan-brief.v1",
    batchId: batch.batchId,
    product: {
      productName: draft.productName || "",
      productLink: draft.productLink || "",
      cta: draft.cta || "",
      ending: draft.ending || "",
      currencySymbol: draft.currencySymbol || "",
      language: draft.language || "",
      regions: Array.isArray(draft.regions) ? draft.regions : [],
      targetChannels: Array.isArray(draft.targetChannels) ? draft.targetChannels : []
    },
    assets,
    assetUrls,
    branches: batch.branchDrafts || normalizeBranchDrafts(draft, batch.estimate?.request?.branches),
    rules: {
      promiseLevel: draft.promiseLevel || "stable",
      truthRules: draft.truthRules || {},
      materialDirection: draft.materialDirection || "",
      voiceoverStyle: draft.voiceoverStyle || "",
      customPrompt: draft.customPrompt || "",
      negativePrompt: draft.negativePrompt || "",
      outputRatio: draft.defaultOutputRatio || batch.estimate?.outputRatio || "9:16",
      durationSec: batch.estimate?.durationSec || draft.defaultDurationSec || 15,
      variantCount: batch.estimate?.variantCount || 0
    },
    systemAssumptions: [
      "15s outputs use one Seedance prompt per variant.",
      "30s outputs use two 15s segments per variant and require stitching.",
      "The system must not invent exact rewards, withdrawal thresholds, or payout timing without truth rules."
    ],
    createdAt: batch.createdAt
  });
  await writeAtomicJson(join(root, "01-reference-breakdown.json"), {
    schemaVersion: "reference-breakdown.v1",
    referenceVideo: batch.referenceVideo,
    decomposition: batch.decomposition
  });
  await writeAtomicJson(join(root, "02-product-script.json"), {
    schemaVersion: "product-script.v1",
    replacementScope: [
      "productName",
      "icon",
      "cta",
      "ending",
      "subtitleProductName",
      "voiceoverProductName",
      "phoneUiDescription",
      "rewardVisualDescription"
    ],
    product: {
      productName: draft.productName || "",
      productLink: draft.productLink || "",
      iconAsset: assets.productIcon || "",
      iconUrl: assetUrls.productIcon || "",
      cta: draft.cta || "",
      ending: draft.ending || ""
    },
    scripts: batch.scripts
  });
  await writeAtomicJson(join(root, "03-localized-variants.json"), {
    schemaVersion: "localized-variants.v1",
    language: draft.language || "",
    regions: Array.isArray(draft.regions) ? draft.regions : [],
    currencySymbol: draft.currencySymbol || "",
    variants: batch.scripts
  });
  await writeAtomicJson(join(root, "04-seedance-prompts.json"), {
    schemaVersion: "seedance-prompts.v1",
    model: MODEL_VIDEO,
    items: promptItems
  });
  await writeAtomicJson(join(root, "04-subtitle-postprocess.json"), buildSubtitlePostProcessArtifact(batch));
  await writeAtomicJson(join(root, "05-video-tasks.json"), {
    schemaVersion: "video-tasks.v1",
    tasks: batch.tasks
  });
}

export async function prepareBatchForPipeline(context, batch, options = {}) {
  if (Array.isArray(batch.scripts) && batch.scripts.length && Array.isArray(batch.tasks) && batch.tasks.length) {
    return batch;
  }

  const useLlmPlans = Boolean(options.useLlmPlans);
  const generatePlan = context.generateSeedancePlanForTest || generateSeedancePlan;
  const scripts = [];
  const tasks = [];
  const plans = [];
  const slicePlan = buildSlicePlanFromDecomposition(batch);
  const segmentMultiplier = slicePlan.length;
  const useThirtySecondContinuityPlan = usesThirtySecondContinuityPlan(batch);
  const branchDrafts = normalizeBranchDrafts(batch.templateSnapshot?.draft, batch.estimate?.request?.branches);
  if (useLlmPlans) {
    validateBranchTruthRulesForPlan(branchDrafts);
  }
  let sequence = 1;
  const variantCount = Number(batch.estimate?.variantCount || 0);
  const totalPlans = useLlmPlans ? branchDrafts.length * variantCount * (useThirtySecondContinuityPlan ? 1 : segmentMultiplier) : 0;
  let planSequence = 0;
  const branchPlanBatches = new Map();
  const branchChannelRules = new Map();
  const planWarnings = [];
  const generateBranchPlans = context.generateSeedanceBranchPlansForTest || generateSeedanceBranchPlans;
  const generateVariantPlans = context.generateSeedanceVariantPlansForTest || generateSeedanceVariantPlans;
  const useBranchBatchPlans = useLlmPlans
    && !useThirtySecondContinuityPlan
    && options.branchBatchPlans === true
    && options.planBatchMode === "branch"
    && segmentMultiplier > 0
    && variantCount > 0;
  const useVariantBatchPlans = useLlmPlans
    && !useThirtySecondContinuityPlan
    && options.variantBatchPlans !== false
    && segmentMultiplier > 0
    && variantCount > 0;

  const loadBranchChannelRules = async (branch) => {
    const key = branchPlanCacheKey(branch);
    if (branchChannelRules.has(key)) return branchChannelRules.get(key);
    const branchChannel = branch.targetChannels?.[0] || batch.estimate?.request?.targetChannel || "generic";
    const branchPromiseLevel = branch.promiseLevel || batch.estimate?.request?.promiseLevel || "stable";
    const channelRules = typeof context.getChannelRulesForTest === "function"
      ? await context.getChannelRulesForTest({ channel: branchChannel, promiseLevel: branchPromiseLevel })
      : await getChannelRules(context, { channel: branchChannel, promiseLevel: branchPromiseLevel });
    branchChannelRules.set(key, channelRules);
    return channelRules;
  };

  if (useBranchBatchPlans) {
    let completedBranchPlanCount = 0;
    await mapWithConcurrency(
      branchDrafts,
      resolvePlanLlmConcurrency(context, options).branch,
      async (branch) => {
        const key = branchPlanCacheKey(branch);
        const channelRules = await loadBranchChannelRules(branch);
        completedBranchPlanCount += 1;
        options.onPlanProgress?.({
          index: completedBranchPlanCount,
          total: branchDrafts.length,
          branchLabel: branch.branchLabel || branch.branchId,
          branchVariantIndex: `1-${variantCount}`,
          segmentIndex: `1-${segmentMultiplier}`,
          mode: "branch_batch"
        });
        try {
          const branchPlans = await generateBranchPlans(context, {
            batch,
            branch,
            decomposition: batch.decomposition,
            channelRules,
            variantCount,
            slicePlan,
            knowledgeNotes: options.knowledgeNotes,
            llmConfig: options.llmConfig || {}
          });
          branchPlanBatches.set(key, branchPlans);
        } catch (error) {
          branchPlanBatches.set(key, { error });
          const errorMessage = String(error?.message || error || "branch_batch_plan_failed").slice(0, 500);
          console.warn(`[wangzhuan] branch batch plan fallback for ${batch.batchId}/${key}: ${errorMessage}`);
          batch.warnings = [
            ...(Array.isArray(batch.warnings) ? batch.warnings : []),
            {
              code: "plan_batch_fallback",
              branchId: branch.branchId || "",
              branchLabel: branch.branchLabel || "",
              message: errorMessage
            }
          ];
          planWarnings.push(batch.warnings[batch.warnings.length - 1]);
          const recordEvent = typeof context.recordTelemetryEvent === "function"
            ? context.recordTelemetryEvent
            : (eventName, payload) => recordTelemetryEvent(context, eventName, payload);
          await recordEvent("plan_batch_fallback", {
            batchId: batch.batchId,
            branchId: branch.branchId || "",
            branchLabel: branch.branchLabel || "",
            errorMessage
          }).catch(() => {});
        }
      }
    );
  }

  for (const branch of branchDrafts) {
    const branchKey = branchPlanCacheKey(branch);
    const channelRules = await loadBranchChannelRules(branch);
    const requiredDisclaimers = [...new Set(channelRules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
    const planConcurrency = resolvePlanLlmConcurrency(context, options);
    const variantResults = await mapWithConcurrency(
      Array.from({ length: Number(batch.estimate?.variantCount || 0) }, (_, index) => index + 1),
      planConcurrency.variant,
      async (branchVariantIndex) => {
        const localScripts = [];
        const localTasks = [];
        const localPlans = [];
        let variantBatchPlans = null;
        let thirtySecondPlanPayloads = null;
        if (useLlmPlans && useThirtySecondContinuityPlan) {
          planSequence += 1;
          options.onPlanProgress?.({
            index: planSequence,
            total: totalPlans,
            branchLabel: branch.branchLabel || branch.branchId,
            branchVariantIndex,
            segmentIndex: "1-2"
          });
          thirtySecondPlanPayloads = await generateThirtySecondSeedancePlans(context, {
            batch,
            branch,
            decomposition: batch.decomposition,
            channelRules,
            branchVariantIndex,
            knowledgeNotes: options.knowledgeNotes,
            llmConfig: options.llmConfig || {}
          });
        }
        if (useLlmPlans && useVariantBatchPlans && !useThirtySecondContinuityPlan) {
          const branchPlans = branchPlanBatches.get(branchKey);
          const hasBranchBatchPlans = Boolean(pickBranchBatchPlan(branchPlans, branchVariantIndex, 1));
          if (!hasBranchBatchPlans) {
            planSequence += 1;
            options.onPlanProgress?.({
              index: planSequence,
              total: totalPlans,
              branchLabel: branch.branchLabel || branch.branchId,
              branchVariantIndex,
              segmentIndex: `1-${segmentMultiplier}`,
              mode: "variant_batch"
            });
            try {
              variantBatchPlans = await generateVariantPlans(context, {
                batch,
                branch,
                decomposition: batch.decomposition,
                channelRules,
                branchVariantIndex,
                slicePlan,
                knowledgeNotes: options.knowledgeNotes,
                llmConfig: options.llmConfig || {}
              });
            } catch (error) {
              variantBatchPlans = null;
              const errorMessage = String(error?.message || error || "variant_batch_plan_failed").slice(0, 500);
              console.warn(`[wangzhuan] variant batch plan fallback for ${batch.batchId}/${branchKey}/v${branchVariantIndex}: ${errorMessage}`);
              batch.warnings = [
                ...(Array.isArray(batch.warnings) ? batch.warnings : []),
                {
                  code: "plan_variant_batch_fallback",
                  branchId: branch.branchId || "",
                  branchLabel: branch.branchLabel || "",
                  branchVariantIndex,
                  message: errorMessage
                }
              ];
              planWarnings.push(batch.warnings[batch.warnings.length - 1]);
              const recordEvent = typeof context.recordTelemetryEvent === "function"
                ? context.recordTelemetryEvent
                : (eventName, payload) => recordTelemetryEvent(context, eventName, payload);
              await recordEvent("plan_variant_batch_fallback", {
                batchId: batch.batchId,
                branchId: branch.branchId || "",
                branchLabel: branch.branchLabel || "",
                branchVariantIndex,
                errorMessage
              }).catch(() => {});
            }
          }
        }
        for (let segmentIndex = 1; segmentIndex <= segmentMultiplier; segmentIndex += 1) {
          const localSequence = sequence + ((branchVariantIndex - 1) * segmentMultiplier) + (segmentIndex - 1);
          const slice = slicePlan[segmentIndex - 1] || { segmentIndex, durationSec: 15, segmentRole: "proof_slice" };
          const scriptId = makeScriptId(batch.batchId, localSequence);
          const generationTaskId = makeGenerationTaskId(batch.batchId, localSequence);
          const segmentSuffix = segmentMultiplier > 1 ? `_segment${segmentIndex}` : "";
          const scriptTarget = join(batchDir(context, batch.batchId), "scripts", `${scriptId}${segmentSuffix}.json`);
          const promptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_seedance.txt`);
          const imagePromptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_image.txt`);
          let hook = scriptHook(batch, branch, branchVariantIndex);
          let body = scriptBody(batch, branch, branchVariantIndex, segmentIndex, requiredDisclaimers, slice.durationSec);
          let cta = branch.cta || batch.decomposition?.cta || "Install now";
          let ending = branch.ending || "Try it today";
          let seedancePrompt = "";
          let imagePrompt = "";
          let negativePrompt = branch.negativePrompt || "";
          let voiceover = "";
          let subtitles = [];
          let complianceNotes = [];
          let mediaRefs = branch.assetUrls || {};
          let planRecord = null;

          if (useLlmPlans) {
            const branchPlans = branchPlanBatches.get(branchKey);
            let planPayload = thirtySecondPlanPayloads?.[segmentIndex - 1]
              || pickBranchBatchPlan(variantBatchPlans, branchVariantIndex, segmentIndex)
              || pickBranchBatchPlan(branchPlans, branchVariantIndex, segmentIndex);
            if (!planPayload) {
              planSequence += 1;
              options.onPlanProgress?.({
                index: planSequence,
                total: totalPlans,
                branchLabel: branch.branchLabel || branch.branchId,
                branchVariantIndex,
                segmentIndex
              });
              planPayload = await generatePlan(context, {
                batch,
                branch,
                decomposition: batch.decomposition,
                channelRules,
                branchVariantIndex,
                segmentIndex,
                segmentRole: slice.segmentRole,
                sliceDurationSec: slice.sliceDurationSec || slice.durationSec,
                currentSlice: slice,
                totalSegmentCount: segmentMultiplier,
                isFinalSeedanceSlice: segmentIndex === segmentMultiplier,
                mandatoryMoneyVisualCarrier: segmentIndex === 1,
                conversionEffectOpportunities: slice.conversionEffectOpportunities || [],
                knowledgeNotes: options.knowledgeNotes,
                llmConfig: options.llmConfig || {}
              });
            }
          hook = planPayload.hook;
          body = planPayload.body;
          cta = planPayload.cta;
          ending = planPayload.ending;
          seedancePrompt = planPayload.seedancePrompt;
          imagePrompt = planPayload.imagePrompt;
          negativePrompt = planPayload.negativePrompt;
          voiceover = planPayload.voiceover;
          subtitles = planPayload.subtitles;
          complianceNotes = planPayload.complianceNotes;
          mediaRefs = planPayload.mediaRefs;
          const segmentRole = planPayload.segmentRole || slice.segmentRole;
          const sliceDurationSec = slice.sliceDurationSec || slice.durationSec;
          planPayload = {
            ...planPayload,
            segmentRole,
            sliceDurationSec
          };
          const outputTemplateMode = planPayload.outputTemplateMode;
          const moneyVisuals = planPayload.moneyVisuals;
          const withdrawalVisual = planPayload.withdrawalVisual;
          const subtitleWorkflow = planPayload.subtitleWorkflow;
          const sliceDiversity = planPayload.sliceDiversity;
          const conversionEffectOpportunities = planPayload.conversionEffectOpportunities;
          planRecord = buildGenerationPlanRecord({
            batch,
            branch,
            scriptId,
            generationTaskId,
            branchVariantIndex,
            segmentIndex,
            sequence: localSequence,
            planPayload: {
              hook,
              body,
              voiceover,
              subtitles,
              cta,
              ending,
              imagePrompt,
              seedancePrompt,
              negativePrompt,
              mediaRefs,
              complianceNotes,
              segmentRole,
              sliceDurationSec,
              ...pickSliceMetadata(slice),
              outputTemplateMode,
              moneyVisuals,
              withdrawalVisual,
              subtitleWorkflow,
              sliceDiversity,
              conversionEffectOpportunities
            }
          });
          localPlans.push(planRecord);
        }

        const script = {
          scriptId,
          batchId: batch.batchId,
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          variantIndex: localSequence,
          segmentIndex,
          durationSec: slice.durationSec,
          isFinalSeedanceSlice: segmentIndex === segmentMultiplier,
          segmentRole: planRecord?.segmentRole || slice.segmentRole,
          sliceDurationSec: planRecord?.sliceDurationSec || slice.sliceDurationSec || slice.durationSec,
          ...pickSliceMetadata(slice),
          hook,
          body,
          cta,
          ending,
          branchDraft: branch,
          ...(rewardExpression(batch, branch) ? { rewardExpression: rewardExpression(batch, branch) } : {}),
          ...(planRecord ? {
            planId: planRecord.planId,
            voiceover,
            subtitles,
            imagePrompt,
            seedancePrompt,
            negativePrompt,
            mediaRefs,
            complianceNotes,
            segmentRole: planRecord.segmentRole,
            sliceDurationSec: planRecord.sliceDurationSec,
            outputTemplateMode: planRecord.outputTemplateMode,
            moneyVisuals: planRecord.moneyVisuals,
            withdrawalVisual: planRecord.withdrawalVisual,
            subtitleWorkflow: planRecord.subtitleWorkflow,
            sliceDiversity: planRecord.sliceDiversity,
            conversionEffectOpportunities: planRecord.conversionEffectOpportunities || slice.conversionEffectOpportunities
          } : {}),
          promptPath: userRelative(context, promptTarget),
          scriptPath: userRelative(context, scriptTarget)
        };
        await writeAtomicJson(scriptTarget, script);
        await writePlainPrompt(
          promptTarget,
          useLlmPlans ? seedancePrompt : buildPrompt(batch, script, "video")
        );
        await writePlainPrompt(
          imagePromptTarget,
          useLlmPlans ? imagePrompt : buildPrompt(batch, script, "image")
        );

        localScripts.push(script);
        localTasks.push({
          generationTaskId,
          batchId: batch.batchId,
          scriptId,
          ...(planRecord ? { planId: planRecord.planId } : {}),
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          segmentIndex,
          durationSec: slice.durationSec,
          segmentRole: planRecord?.segmentRole || slice.segmentRole,
          sliceDurationSec: planRecord?.sliceDurationSec || slice.sliceDurationSec || slice.durationSec,
          ...pickSliceMetadata(slice),
          status: useLlmPlans ? "pending_preview" : "pending",
          modelImage: MODEL_IMAGE,
          modelVideo: resolveSeedanceModel(batch),
          ...(planRecord ? {
            moneyVisuals: planRecord.moneyVisuals,
            conversionEffectOpportunities: planRecord.conversionEffectOpportunities || slice.conversionEffectOpportunities,
            subtitleWorkflow: planRecord.subtitleWorkflow,
            sliceDiversity: planRecord.sliceDiversity
          } : {}),
          promptPath: script.promptPath,
          remoteUrlStored: false,
          attempts: 0
        });
      }
        return { branchVariantIndex, scripts: localScripts, tasks: localTasks, plans: localPlans };
      }
    );
    for (const result of variantResults.sort((a, b) => Number(a.branchVariantIndex || 0) - Number(b.branchVariantIndex || 0))) {
      plans.push(...result.plans);
      scripts.push(...result.scripts);
      tasks.push(...result.tasks);
    }
    sequence += Number(batch.estimate?.variantCount || 0) * segmentMultiplier;
  }

  const prepared = {
    ...batch,
    ...(useLlmPlans ? {
      previewType: "seedance_plan",
      plans
    } : {}),
    branchDrafts,
    warnings: [
      ...(Array.isArray(batch.warnings) ? batch.warnings : []),
      ...planWarnings.filter((warning) => !(Array.isArray(batch.warnings) ? batch.warnings : []).includes(warning))
    ],
    scripts,
    tasks,
    outputs: Array.isArray(batch.outputs) ? batch.outputs : [],
    qcSummary: batch.qcSummary || { total: 0, passed: 0, failed: 0, warnings: [] }
  };
  const saved = await writeBatch(context, prepared);
  await writeTaskMaps(context, saved);
  await writeProcessTraceFiles(context, saved);
  await ensureEventFile(context, saved.batchId);
  return saved;
}

async function enrichBatchWorkbenchContext(context, detail) {
  const batch = detail?.batch;
  if (!batch) return detail;

  let estimateId = batch.estimate?.estimateId || batch.request?.estimateId || null;
  let estimateRecord = estimateId ? await loadEstimateFromMysql(context, estimateId) : null;
  if (!estimateRecord) {
    const referenceVideoId = batch.referenceVideo?.referenceVideoId || batch.request?.referenceVideoId || "";
    if (referenceVideoId) {
      estimateRecord = await loadLatestBatchEstimateForReferenceVideo(context, referenceVideoId);
      estimateId = estimateRecord?.estimate?.estimateId || estimateId;
    }
  }

  const decomposition = [batch.decomposition, estimateRecord?.decomposition, batch.request?.decomposition]
    .find((item) => item && (item.referenceVideoId || item.scene || item.hook || item.action)) || null;
  const templateSnapshot = batch.templateSnapshot?.draft
    ? batch.templateSnapshot
    : (estimateRecord?.templateSnapshot || batch.templateSnapshot || null);
  const rawBranchDrafts = batch.branchDrafts?.length
    ? batch.branchDrafts
    : (estimateRecord?.request?.branches || batch.request?.branchDrafts || batch.request?.branches || []);
  const branchDrafts = normalizeStoredBranchDrafts(templateSnapshot, rawBranchDrafts);
  const estimate = estimateRecord
    ? {
        ...estimateRecord.estimate,
        ...batch.estimate,
        estimateId: estimateId || estimateRecord.estimate?.estimateId,
        request: {
          ...(estimateRecord.request || {}),
          ...(batch.estimate?.request || {})
        }
      }
    : batch.estimate;

  const referenceVideo = batch.referenceVideo?.referenceVideoId
    ? batch.referenceVideo
    : (estimateRecord?.referenceVideo || batch.referenceVideo || null);

  const changed = referenceVideo !== batch.referenceVideo
    || decomposition !== batch.decomposition
    || templateSnapshot !== batch.templateSnapshot
    || branchDrafts !== batch.branchDrafts
    || estimate !== batch.estimate;
  if (!changed) return detail;

  return {
    ...detail,
    batch: {
      ...batch,
      referenceVideo,
      decomposition,
      templateSnapshot,
      branchDrafts,
      estimate
    }
  };
}

function backgroundJobSummary(job = null) {
  if (!job) return null;
  return {
    id: job.id || "",
    type: job.type || "",
    subjectType: job.subjectType || "",
    subjectId: job.subjectId || "",
    status: job.status || "",
    progress: Number(job.progress || 0),
    message: job.message || "",
    draftSignature: job.draftSignature || "",
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    error: job.error ? {
      code: job.error.code || "",
      message: job.error.message || "",
      recoverable: Boolean(job.error.recoverable),
      data: job.error.data && typeof job.error.data === "object" ? job.error.data : {}
    } : null
  };
}

async function attachBackgroundJobSummaries(context, detail) {
  const batch = detail?.batch;
  if (!batch?.batchId) return detail;
  const referenceVideoId = batch.referenceVideo?.referenceVideoId || batch.request?.referenceVideoId || "";
  const [planJobs, decompositionJobs] = await Promise.all([
    listBackgroundJobs(context, {
      type: "seedance_plan",
      subjectType: "batch",
      subjectId: batch.batchId
    }).catch(() => []),
    referenceVideoId
      ? listBackgroundJobs(context, {
        type: "decomposition",
        subjectType: "reference_video",
        subjectId: referenceVideoId
      }).catch(() => [])
      : Promise.resolve([])
  ]);
  return {
    ...detail,
    backgroundJobs: {
      latestPlanJob: backgroundJobSummary(planJobs[0] || null),
      latestDecompositionJob: backgroundJobSummary(decompositionJobs[0] || null)
    }
  };
}

export async function getBatchDetail(context, batchId) {
  const initial = await readBatch(context, batchId);
  const { pollUpstreamBatch, shouldPollUpstreamBatch } = await import("./upstream-poll.mjs");
  if (shouldPollUpstreamBatch(initial)) {
    try {
      await pollUpstreamBatch(context, batchId);
    } catch (error) {
      console.warn(`[wangzhuan] upstream poll failed for ${batchId}: ${error?.message || error}`);
    }
  }
  let detail = await loadBatchDetailFromMysql(context, batchId);
  if (!detail?.batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  detail = await enrichBatchWorkbenchContext(context, detail);
  detail = await attachBackgroundJobSummaries(context, detail);
  return detail;
}

export async function stopBatch(context, batchId, request = {}) {
  const batch = await readBatch(context, batchId);
  if (!STOPPABLE_BATCH_STATUSES.has(batch.status)) {
    throw new WangzhuanError("not_running", "批次当前状态不可停止", { batchId, status: batch.status });
  }
  const now = new Date().toISOString();
  let stoppedCount = 0;
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    stoppedCount += 1;
    return {
      ...task,
      status: "stopped",
      errorCode: request.reason || "user_stopped",
      errorMessage: "用户已停止批次",
      finishedAt: now
    };
  });
  const stopped = await writeBatchWithTrigger(context, {
    ...batch,
    status: "stopped",
    tasks,
    stoppedAt: now,
    stopReason: request.reason || "user_stopped"
  }, "user_stop");
  await writeTaskMaps(context, stopped);
  await recordTelemetryEvent(context, "batch_stopped", {
    batchId: stopped.batchId,
    completedCount: tasks.filter((task) => task.status === "succeeded").length,
    failedCount: tasks.filter((task) => task.status === "failed" || task.status === "stopped").length
  });
  return {
    ...(await getBatchDetail(context, stopped.batchId)),
    stoppedCount
  };
}

export function batchStatusAfterSeedanceSubmission(batchStatus, state = {}) {
  if (["qc", "partial_failed"].includes(batchStatus)) return batchStatus;
  if (Number(state.submittedCount || 0) > 0) return "running";
  if (Number(state.failedSubmitCount || 0) > 0 && !state.hasDeferredPending) return "failed";
  return batchStatus === "queued" ? "running" : batchStatus;
}

export function resolveSeedanceConcurrencyLimit(context = {}) {
  const configured = context.config?.wangzhuan?.limits?.maxConcurrency
    ?? context.config?.wangzhuan?.capabilities?.maxConcurrency
    ?? 4;
  return Math.max(1, Math.min(Number(configured) || 4, 50));
}

export function resolveSeedanceSubmissionLeaseSeconds(provider = {}) {
  const configuredTimeoutMs = Number(provider.config?.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 600_000;
  return Math.max(300, Math.min(Math.ceil(timeoutMs / 1000) + 60, 3600));
}

export async function submitPendingGenerationTasks(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (batch.status === "stopped" || batch.status === "preview_required") {
    return { batch, submittedCount: 0, failedSubmitCount: 0 };
  }
  const now = new Date().toISOString();
  let submittedCount = 0;
  let failedSubmitCount = 0;
  const provider = createSeedanceProviderClient(context);
  if (!provider) {
    throw new WangzhuanError("upstream_failed", "Seedance 未配置，无法提交生成任务", {
      batchId,
      requiredConfig: "wangzhuan.seedanceProvider.endpoint",
      requiredEnv: ["WANGZHUAN_SEEDANCE_ENDPOINT", "WANGZHUAN_LLM_API_KEY"]
    });
  }
  const concurrencyLimit = resolveSeedanceConcurrencyLimit(context);
  const requestedLimit = Math.max(1, Number(batch.estimate?.requestedConcurrency || batch.request?.requestedConcurrency || 1) || 1);
  const originalTasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const pendingIndexes = [];
  for (let index = 0; index < originalTasks.length; index += 1) {
    if (isGenerationTaskSubmitReady(batch, originalTasks[index])) pendingIndexes.push(index);
  }
  const leaseOwner = `seedance_submit:${batchId}:${process.pid}:${Date.now()}`.slice(0, 128);
  const leaseSeconds = resolveSeedanceSubmissionLeaseSeconds(provider);
  const claim = await claimPendingSeedanceTasks(context, {
    batchId,
    candidateTaskUids: pendingIndexes.map((index) => originalTasks[index].generationTaskId),
    requestedLimit,
    concurrencyLimit,
    leaseOwner,
    leaseSeconds
  });
  const claimedTaskUids = new Set(claim.taskUids);
  const claimedIndexes = pendingIndexes.filter((index) => claimedTaskUids.has(originalTasks[index].generationTaskId));
  const persistedTaskUids = [];
  const writebackFailures = [];
  if (claimedIndexes.length) {
    const chunkResults = await Promise.all(claimedIndexes.map(async (taskIndex) => {
      const sourceTask = originalTasks[taskIndex];
      try {
        const nextTask = await submitTaskToSeedance(context, batch, sourceTask, provider, now, leaseOwner);
        await persistSeedanceSubmissionResult(context, {
          batchId,
          taskUid: sourceTask.generationTaskId,
          leaseOwner,
          task: nextTask
        });
        return { taskIndex, nextTask, persisted: true };
      } catch (error) {
        return { taskIndex, nextTask: null, persisted: false, error };
      }
    }));
    for (const { taskIndex, nextTask, persisted, error } of chunkResults) {
      const taskUid = originalTasks[taskIndex].generationTaskId;
      if (!persisted) {
        writebackFailures.push({ taskUid, error });
        continue;
      }
      persistedTaskUids.push(taskUid);
      if (nextTask.status === "waiting_upstream") submittedCount += 1;
      if (nextTask.status === "failed") failedSubmitCount += 1;
    }
  }
  if (writebackFailures.length) {
    throw new WangzhuanError("database_unavailable", "Seedance 提交结果未能完整写入数据库，已保留任务租约并停止自动重提", {
      batchId,
      taskIds: writebackFailures.map((item) => item.taskUid),
      causes: writebackFailures.map((item) => String(item.error?.code || item.error?.message || "writeback_failed").slice(0, 80))
    });
  }
  const refreshed = await readBatch(context, batchId);
  const tasks = Array.isArray(refreshed.tasks) ? refreshed.tasks : [];
  const hasDeferredPending = tasks.some((task) => task.status === "pending");
  const nextStatus = batchStatusAfterSeedanceSubmission(refreshed.status, {
    submittedCount,
    failedSubmitCount,
    hasDeferredPending
  });
  const saved = await writeBatch(context, {
    ...refreshed,
    status: nextStatus,
    tasks,
    startedAt: refreshed.startedAt || (submittedCount > 0 ? now : undefined)
  });
  if (persistedTaskUids.length) {
    await releasePendingSeedanceTaskClaims(context, {
      batchId,
      taskUids: persistedTaskUids,
      leaseOwner
    }).catch((error) => {
      console.warn(`[wangzhuan] failed to release Seedance submission lease for ${batchId}: ${error.message}`);
    });
  }
  await writeTaskMaps(context, saved);
  for (const task of saved.tasks.filter((item) => item.startedAt === now && item.status === "waiting_upstream")) {
    await recordTelemetryEvent(context, "generation_task_submitted", {
      batchId: saved.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      imageTaskId: task.imageTaskId,
      seedanceTaskId: task.seedanceTaskId,
      provider: task.provider || provider.provider,
      modelImage: task.modelImage,
      modelVideo: task.modelVideo
    }, { audit: true }).catch((error) => {
      console.warn(`[wangzhuan] failed to record Seedance submission telemetry for ${task.generationTaskId}: ${error.message}`);
    });
  }
  return {
    batch: saved,
    submittedCount,
    failedSubmitCount,
    deferredCount: Math.max(0, pendingIndexes.length - claimedIndexes.length)
  };
}

export async function retryFailedGenerationTask(context, batchId, generationTaskId) {
  const batch = await readBatch(context, batchId);
  if (batch.status === "stopped") {
    return { batch, retriedCount: 0 };
  }
  const now = new Date().toISOString();
  let found = false;
  const tasks = [];
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    if (task.generationTaskId !== generationTaskId) {
      tasks.push(task);
      continue;
    }
    found = true;
    const pendingRetry = task.status === "pending" && Boolean(task.retryInfo || task.responseSummary?.retryInfo);
    if (task.status !== "failed" && !pendingRetry) {
      throw new WangzhuanError("invalid_state_transition", "任务当前状态不可重试", {
        batchId,
        generationTaskId,
        status: task.status
      });
    }
    if (pendingRetry) {
      tasks.push(task);
      continue;
    }
    const attempts = Number(task.attempts || 0);
    const maxAttempts = Number(task.maxAttempts || 2);
    if (attempts >= maxAttempts) {
      throw new WangzhuanError("retry_exhausted", "任务重试次数已耗尽", {
        batchId,
        generationTaskId,
        attempts,
        maxAttempts
      });
    }
    const retryInfo = {
      automatic: true,
      retriedAt: now,
      priorErrorCode: task.errorCode || "upstream_failed",
      priorErrorMessage: task.errorMessage || "Seedance 上游任务失败",
      attempt: attempts + 1,
      maxAttempts
    };
    const resetTask = {
      ...task,
      status: "pending",
      attempts,
      retryInfo,
      seedanceTaskId: "",
      providerJobId: "",
      remoteUrlStored: false,
      finishedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      responseSummary: { ...(task.responseSummary || {}), retryInfo }
    };
    tasks.push(resetTask);
  }
  if (!found) {
    throw new WangzhuanError("task_not_found", "任务不存在", { batchId, generationTaskId });
  }
  // A retry may be triggered after partial delivery has already settled the
  // run. Keep terminal partial/qc status while the task is resubmitted; the
  // task-level scheduler and upstream poll job will advance it later.
  const retryBatchStatus = ["qc", "partial_failed"].includes(batch.status) ? batch.status : "running";
  const reset = await writeBatchWithTrigger(context, { ...batch, status: retryBatchStatus, tasks }, "scheduler_retry");
  await writeTaskMaps(context, reset);
  const submitted = await submitPendingGenerationTasks(context, batchId);
  const saved = submitted.batch;
  const retried = saved.tasks.find((task) => task.generationTaskId === generationTaskId);
  const priorAttempts = Number(batch.tasks.find((task) => task.generationTaskId === generationTaskId)?.attempts || 0);
  const retriedCount = Number(retried?.attempts || 0) > priorAttempts ? 1 : 0;
  if (retriedCount > 0) {
    await recordTelemetryEvent(context, "generation_task_retried", {
      batchId: saved.batchId,
      generationTaskId,
      scriptId: retried?.scriptId || "",
      attempts: retried?.attempts || 0,
      imageTaskId: retried?.imageTaskId || "",
      seedanceTaskId: retried?.seedanceTaskId || ""
    }, { audit: true }).catch((error) => {
      console.warn(`[wangzhuan] failed to record Seedance retry telemetry for ${generationTaskId}: ${error.message}`);
    });
  }
  return { ...submitted, batch: saved, retriedCount };
}

function currentPlanIds(batch, request = {}) {
  const requested = Array.isArray(request.confirmedPlanIds)
    ? request.confirmedPlanIds.filter(Boolean)
    : [];
  if (requested.length) return new Set(requested);
  return new Set((Array.isArray(batch.plans) ? batch.plans : []).map((plan) => plan.planId));
}

function hasSeedanceUpstreamIdentity(task = {}) {
  return Boolean(
    String(task.seedanceTaskId || "").trim()
    || String(task.providerJobId || "").trim()
  );
}

function isRecoverableConfirmedPlanPreSubmitFailure(task = {}) {
  return task.status === "failed"
    && task.errorCode === "asset_review_pending"
    && !hasSeedanceUpstreamIdentity(task);
}

export function recoverConfirmedPlanPreSubmitFailures(batch = {}) {
  if (!batch.previewConfirmedAt
    || batch.previewType !== "seedance_plan"
    || !["partial_failed", "failed"].includes(batch.status)) {
    return { batch, recoveredTaskIds: [] };
  }
  const recoveredTaskIds = [];
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (!isRecoverableConfirmedPlanPreSubmitFailure(task)) return task;
    const attempts = Math.max(0, Number(task.attempts || 0) || 0);
    const maxAttempts = Math.max(1, Number(task.maxAttempts || 2) || 2);
    recoveredTaskIds.push(task.generationTaskId);
    return {
      ...task,
      status: "pending",
      attempts: Math.min(attempts, maxAttempts - 1),
      finishedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined
    };
  });
  if (!recoveredTaskIds.length) return { batch, recoveredTaskIds };
  return {
    batch: {
      ...batch,
      status: batch.status === "failed" ? "running" : batch.status,
      tasks
    },
    recoveredTaskIds
  };
}

function editablePlanById(request = {}) {
  const map = new Map();
  if (!Array.isArray(request.plans)) return map;
  for (const plan of request.plans) {
    if (plan?.planId) map.set(plan.planId, plan);
  }
  return map;
}

function planRepairContextForConfirm(batch = {}, branch = {}, plan = {}) {
  const draft = batch.templateSnapshot?.draft || {};
  const request = batch.estimate?.request || {};
  const targetLanguage = branch.languages?.[0] || branch.language || draft.languages?.[0] || draft.language || request.languages?.[0] || request.language;
  const targetRegion = branch.regions?.[0] || branch.targetRegions?.[0] || branch.targetRegion || draft.regions?.[0] || draft.targetRegions?.[0] || draft.targetRegion || request.targetRegions?.[0] || request.targetRegion;
  return {
    targetLanguage,
    targetRegion,
    currencySymbol: branch.currencySymbol || draft.currencySymbol || batch.estimate?.request?.currencySymbol,
    sourceSlice: plan.sourceSlice || plan,
    sliceDurationSec: plan.sliceDurationSec,
    mandatoryMoneyVisualCarrier: Boolean(plan.mandatoryMoneyVisualCarrier || plan.segmentIndex === 1 || plan.sequence === 1),
    conversionEffectOpportunities: plan.conversionEffectOpportunities || [],
    subtitleWorkflow: plan.subtitleWorkflow,
    truthRules: branch.truthRules || draft.truthRules || {}
  };
}

export async function applyConfirmedPlanEdits(context, batch, plans, confirmedPlanIds, request = {}) {
  const edits = editablePlanById(request);
  const now = new Date().toISOString();
  const nextPlans = [];
  const nextScripts = [];

  for (const plan of plans) {
    const isConfirmed = confirmedPlanIds.has(plan.planId);
    const editedPlan = edits.get(plan.planId);
    const branch = (Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === plan.branchId);
    const candidatePlan = isConfirmed && editedPlan ? { ...plan, ...editedPlan } : plan;
    const repairedPlan = isConfirmed
      ? repairFormalPlanContract(candidatePlan, planRepairContextForConfirm(batch, branch || {}, candidatePlan))
      : candidatePlan;
    const payload = validateSeedancePlan(repairedPlan, {
      branch: branch || {},
      branchId: plan.branchId,
      branchVariantIndex: plan.branchVariantIndex,
      segmentIndex: plan.segmentIndex,
      sliceDurationSec: plan.sliceDurationSec,
      subtitleWorkflow: plan.subtitleWorkflow
    });
    nextPlans.push({
      ...plan,
      ...payload,
      status: isConfirmed ? "confirmed" : plan.status,
      ...(isConfirmed ? { confirmedAt: now } : {})
    });
  }

  const planMap = new Map(nextPlans.map((plan) => [plan.planId, plan]));
  for (const script of Array.isArray(batch.scripts) ? batch.scripts : []) {
    const plan = script.planId ? planMap.get(script.planId) : null;
    if (!plan || !confirmedPlanIds.has(plan.planId)) {
      nextScripts.push(script);
      continue;
    }
    const branch = (Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === script.branchId);
    const nextScript = {
      ...script,
      ...(branch ? { branchDraft: mergeBranchMediaDraft(branch, script.branchDraft || {}) } : {}),
      hook: plan.hook,
      body: plan.body,
      voiceover: plan.voiceover,
      subtitles: plan.subtitles,
      cta: plan.cta,
      ending: plan.ending,
      imagePrompt: plan.imagePrompt,
      seedancePrompt: plan.seedancePrompt,
      negativePrompt: plan.negativePrompt,
      mediaRefs: plan.mediaRefs,
      complianceNotes: plan.complianceNotes,
      segmentRole: plan.segmentRole,
      sliceDurationSec: plan.sliceDurationSec,
      outputTemplateMode: plan.outputTemplateMode,
      moneyVisuals: plan.moneyVisuals,
      withdrawalVisual: plan.withdrawalVisual,
      subtitleWorkflow: plan.subtitleWorkflow,
      sliceDiversity: plan.sliceDiversity,
      conversionEffectOpportunities: plan.conversionEffectOpportunities
    };
    nextScripts.push(nextScript);
    if (script.scriptPath) {
      await writeAtomicJson(join(context.userProjectRoot, script.scriptPath), nextScript);
    }
    if (script.promptPath) {
      await writePlainPrompt(join(context.userProjectRoot, script.promptPath), plan.seedancePrompt);
    }
    const task = (Array.isArray(batch.tasks) ? batch.tasks : []).find((item) => item.scriptId === script.scriptId);
    if (task?.generationTaskId && script.promptPath) {
      await writePlainPrompt(
        join(dirname(join(context.userProjectRoot, script.promptPath)), `${task.generationTaskId}_image.txt`),
        plan.imagePrompt
      );
    }
  }

  return { nextPlans, nextScripts, confirmedAt: now };
}

async function confirmBatchPlanOnce(context, batchId, request) {
  const batch = await readBatch(context, batchId);
  if (batch.previewConfirmedAt
    && batch.previewType === "seedance_plan"
    && batch.status !== "preview_required") {
    const confirmedPlanIds = currentPlanIds(batch, request);
    const plans = Array.isArray(batch.plans) ? batch.plans : [];
    const unknownPlanIds = [...confirmedPlanIds].filter((planId) => !plans.some((plan) => plan.planId === planId));
    const unconfirmedPlanIds = [...confirmedPlanIds].filter((planId) => !plans.some((plan) => plan.planId === planId && plan.status === "confirmed"));
    if (!unknownPlanIds.length && !unconfirmedPlanIds.length) {
      const rawBranchSource = batch.branchDrafts || batch.request?.branchDrafts || batch.request?.branches || [];
      const branchSource = normalizeBranchDrafts(batch.templateSnapshot?.draft || {}, rawBranchSource);
      const review = await ensureAssetReviewsApproved(context, branchSource);
      const reviewedBatch = {
        ...batch,
        branchDrafts: review.branches,
        request: {
          ...(batch.request || {}),
          branches: review.branches,
          branchDrafts: review.branches
        }
      };
      if (!review.reviewResult.ok) {
        await writeBatchWithTrigger(context, reviewedBatch, "batch_write");
        throw new WangzhuanError("asset_review_pending", "产品素材审核未通过，请上传 Seedance 素材并完成审核后再确认生成", {
          failures: review.reviewResult.failures,
          assetsByBranch: review.reviewResult.assetsByBranch
        });
      }
      const recovery = recoverConfirmedPlanPreSubmitFailures(reviewedBatch);
      const resumedBatch = recovery.recoveredTaskIds.length
        ? await writeBatchWithTrigger(context, recovery.batch, "scheduler_retry")
        : reviewedBatch;
      if (recovery.recoveredTaskIds.length) await writeTaskMaps(context, resumedBatch);
      return { batch: resumedBatch, confirmedPlanIds: [...confirmedPlanIds], resumed: true };
    }
  }
  if (batch.status !== "preview_required") {
    throw new WangzhuanError("validation_error", "当前批次不在预案确认阶段", {
      batchId,
      status: batch.status
    });
  }
  if (batch.previewType !== "seedance_plan") {
    throw new WangzhuanError("validation_error", "当前批次不是 Seedance 预案确认", {
      batchId,
      previewType: batch.previewType || null
    });
  }
  const confirmedPlanIds = currentPlanIds(batch, request);
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  if (!plans.length) {
    throw new WangzhuanError("validation_error", "没有可确认的 Seedance 预案", { batchId });
  }
  const unknownPlanIds = [...confirmedPlanIds].filter((planId) => !plans.some((plan) => plan.planId === planId));
  if (unknownPlanIds.length) {
    throw new WangzhuanError("validation_error", "存在未知预案编号", { batchId, unknownPlanIds });
  }
  const assetReviewAlreadyConfirmed = Boolean(request.assetReviewConfirmed && (batch.assetReviewConfirmedAt || batch.request?.assetReviewConfirmed));
  const rawBranchSource = assetReviewAlreadyConfirmed
    ? batch.branchDrafts || batch.request?.branches || []
    : Array.isArray(request.branchDrafts) && request.branchDrafts.length
      ? request.branchDrafts
      : batch.branchDrafts || batch.request?.branches || [];
  const branchSource = normalizeBranchDrafts(batch.templateSnapshot?.draft || {}, rawBranchSource);
  const review = assetReviewAlreadyConfirmed
    ? { branches: branchSource, reviewResult: validateAssetReviewState(branchSource) }
    : await ensureAssetReviewsApproved(context, branchSource);
  const reviewResult = review.reviewResult;
  const reviewedBatch = {
    ...batch,
    branchDrafts: review.branches,
    request: {
      ...(batch.request || {}),
      branches: review.branches,
      postProcess: normalizeBatchPostProcess(request.postProcess ?? batch.request?.postProcess)
    }
  };
  if (!reviewResult.ok) {
    await writeBatchWithTrigger(context, reviewedBatch, "batch_write");
    throw new WangzhuanError("asset_review_pending", "产品素材审核未通过，请上传 Seedance 素材并完成审核后再确认生成", {
      failures: reviewResult.failures,
      assetsByBranch: reviewResult.assetsByBranch
    });
  }
  const { nextPlans, nextScripts, confirmedAt } = await applyConfirmedPlanEdits(context, reviewedBatch, plans, confirmedPlanIds, request);
  const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (task.status !== "pending_preview") return task;
    if (!task.planId || !confirmedPlanIds.has(task.planId)) return task;
    return { ...task, status: "pending" };
  });
  const unconfirmedPreviewTasks = nextTasks.filter((task) => task.status === "pending_preview");
  if (unconfirmedPreviewTasks.length) {
    throw new WangzhuanError("validation_error", "仍有未确认的 Seedance 预案", {
      batchId,
      pendingPreviewCount: unconfirmedPreviewTasks.length
    });
  }
  const saved = await writeBatchWithTrigger(context, {
    ...reviewedBatch,
    status: "queued",
    plans: nextPlans,
    scripts: nextScripts,
    tasks: nextTasks,
    previewConfirmedAt: confirmedAt,
    previewConfirmedBy: currentUserId(context),
    previewConfirmationNotes: cleanConfirmationNotes(request.confirmationNotes)
  }, "plan_confirmed");
  await writeTaskMaps(context, saved);
  return { batch: saved, confirmedPlanIds: [...confirmedPlanIds] };
}

async function replayConfirmedBatchPlan(context, batchId, summary = {}) {
  const replayBatchId = summary?.batch?.batchId || summary?.confirmedBatch?.batchId || summary?.batchId || batchId;
  const batch = await readBatch(context, replayBatchId);
  return {
    batch,
    confirmedBatch: batch,
    confirmedPlanIds: (Array.isArray(batch.plans) ? batch.plans : [])
      .filter((plan) => plan.status === "confirmed")
      .map((plan) => plan.planId),
    submittedCount: Number(summary.submittedCount || 0),
    failedSubmitCount: Number(summary.failedSubmitCount || 0),
    deferredCount: Number(summary.deferredCount || 0),
    replayed: true
  };
}

export async function confirmBatchPlan(context, batchId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const requestHash = hashPayload({ batchId, ...request });
  return runIdempotentOperation(
    context,
    "batch_plan_confirm",
    request.idempotencyKey,
    requestHash,
    async () => {
      const confirmed = await confirmBatchPlanOnce(context, batchId, request);
      const submitted = await submitPendingGenerationTasks(context, batchId);
      await recordTelemetryEvent(context, "seedance_plan_confirmed", {
        batchId,
        confirmedPlanCount: confirmed.confirmedPlanIds.length,
        resumed: Boolean(confirmed.resumed)
      }, { audit: true }).catch((error) => {
        console.warn(`[wangzhuan] failed to record Seedance plan confirmation telemetry for ${batchId}: ${error.message}`);
      });
      return {
        ...submitted,
        batch: submitted.batch,
        confirmedBatch: confirmed.batch,
        confirmedPlanIds: confirmed.confirmedPlanIds
      };
    },
    {
      resourceType: "batch",
      replayResponse: (summary) => replayConfirmedBatchPlan(context, batchId, summary)
    }
  );
}

export async function confirmBatchAssets(context, batchId, request = {}) {
  const batch = await readBatch(context, batchId);
  const rawBranchSource = Array.isArray(request.branchDrafts) && request.branchDrafts.length
    ? request.branchDrafts
    : batch.branchDrafts || batch.request?.branches || [];
  const branchSource = normalizeBranchDrafts(batch.templateSnapshot?.draft || {}, rawBranchSource);
  const review = await ensureAssetReviewsApproved(context, branchSource);
  if (!review.reviewResult.ok) {
    await writeBatchWithTrigger(context, {
      ...batch,
      branchDrafts: review.branches,
      request: {
        ...(batch.request || {}),
        branches: review.branches,
        branchDrafts: review.branches
      }
    }, "batch_write");
    throw new WangzhuanError("asset_review_pending", "产品素材审核未通过，请等待审核通过后再确认结果", {
      failures: review.reviewResult.failures,
      assetsByBranch: review.reviewResult.assetsByBranch
    });
  }
  const saved = await writeBatchWithTrigger(context, {
    ...batch,
    branchDrafts: review.branches,
    request: {
      ...(batch.request || {}),
      branches: review.branches,
      branchDrafts: review.branches,
      assetReviewConfirmed: true
    },
    assetReviewConfirmedAt: new Date().toISOString(),
    assetReviewConfirmedBy: currentUserId(context)
  }, "seedance_assets_confirmed");
  return {
    batch: saved,
    branches: review.branches,
    reviewResult: review.reviewResult
  };
}

function cleanConfirmationNotes(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 2000) : undefined;
}

export async function getActiveBatch(context) {
  await requireFactsStore();
  const active = await loadActivePipelineRunFromMysql(context);
  if (active?.batchId) {
    return getBatchDetail(context, active.batchId);
  }
  return {
    batch: null,
    events: [],
    backgroundJobs: {
      latestPlanJob: null,
      latestDecompositionJob: null
    },
    downloadSummary: {
      outputsTotal: 0,
      downloadEligibleCount: 0,
      packageReady: false,
      missingFiles: []
    }
  };
}

export {
  readBatch,
  writeTaskMaps
};

export const __pipelineTestHooks = Object.freeze({
  submitTaskToSeedance
});
