import { confirmBatchAssets, getBatchDetail } from "./pipeline.mjs";
import {
  generateBaseSeedancePrompt,
  refineSeedancePromptWithApprovedAssets
} from "./codex-prompt.mjs";
import { WangzhuanError } from "./http.mjs";

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map((item) => cleanString(item)).filter(Boolean) : [];
}

function cleanObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

function hasUsableDecomposition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (cleanString(value.referenceVideoId)) return true;
  return Boolean(
    cleanString(value.scene)
    || cleanString(value.hook)
    || cleanString(value.action)
    || cleanString(value.subject)
    || Array.isArray(value.storySegments) && value.storySegments.length
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function firstNonEmptyArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function reviewedBranchesFromBatch(batch = {}) {
  return Array.isArray(batch.branchDrafts) && batch.branchDrafts.length
    ? batch.branchDrafts
    : Array.isArray(batch.request?.branchDrafts) && batch.request.branchDrafts.length
      ? batch.request.branchDrafts
      : Array.isArray(batch.request?.branches)
        ? batch.request.branches
        : [];
}

function collectApprovedAssets(branches = []) {
  const approved = [];
  for (const branch of branches) {
    const reviews = branch?.assetReviews && typeof branch.assetReviews === "object" ? branch.assetReviews : {};
    for (const [assetKey, review] of Object.entries(reviews)) {
      const status = cleanString(review?.status).toLowerCase();
      if (!["approved", "active", "success", "succeeded", "pass", "passed"].includes(status)) continue;
      const assetId = cleanString(review?.assetId);
      if (!assetId) continue;
      approved.push({
        branchId: cleanString(branch.branchId),
        branchLabel: cleanString(branch.branchLabel),
        assetKey,
        assetId,
        fileName: firstNonEmptyString(branch.assetFileNames?.[assetKey], assetKey),
        reviewStatus: "approved",
        previewUrl: cleanString(branch.assetUrls?.[assetKey]),
        storageUrl: cleanString(branch.assetUrls?.[assetKey]),
        storageKey: cleanString(branch.assetStorageKeys?.[assetKey]),
        storedPath: firstNonEmptyString(branch.assetStoredPaths?.[assetKey], branch.assetRelativePaths?.[assetKey])
      });
    }
  }
  return approved;
}

function countReferencedAssets(branches = []) {
  let count = 0;
  for (const branch of branches) {
    const keys = new Set([
      ...Object.keys(branch?.assetFileNames || {}),
      ...Object.keys(branch?.assetUrls || {}),
      ...Object.keys(branch?.assetStorageKeys || {}),
      ...Object.keys(branch?.assetStoredPaths || {}),
      ...Object.keys(branch?.assetRelativePaths || {})
    ]);
    for (const key of keys) {
      if (firstNonEmptyString(
        branch?.assetFileNames?.[key],
        branch?.assetUrls?.[key],
        branch?.assetStorageKeys?.[key],
        branch?.assetStoredPaths?.[key],
        branch?.assetRelativePaths?.[key]
      )) {
        count += 1;
      }
    }
  }
  return count;
}

function buildProductContext(batch = {}, branches = [], requestOverrides = {}) {
  const firstBranch = branches[0] || {};
  const request = batch.request || {};
  const draft = batch.templateSnapshot?.draft || {};
  return {
    title: firstNonEmptyString(firstBranch.productName, request.productName, draft.productName),
    productName: firstNonEmptyString(firstBranch.productName, request.productName, draft.productName),
    productLink: firstNonEmptyString(requestOverrides.productLink, firstBranch.productLink, request.productLink, draft.productLink),
    batchName: firstNonEmptyString(batch.userBatchName, batch.displayBatchName, request.batchName),
    knowledgeNotes: cleanString(request.knowledgeNotes),
    cta: firstNonEmptyString(firstBranch.cta, draft.cta),
    ending: firstNonEmptyString(firstBranch.ending, draft.ending),
    materialDirection: firstNonEmptyString(firstBranch.materialDirection, draft.materialDirection),
    voiceoverStyle: firstNonEmptyString(firstBranch.voiceoverStyle, draft.voiceoverStyle),
    customPrompt: firstNonEmptyString(firstBranch.customPrompt, draft.customPrompt),
    negativePrompt: firstNonEmptyString(firstBranch.negativePrompt, draft.negativePrompt),
    promiseLevel: firstNonEmptyString(firstBranch.promiseLevel, request.promiseLevel, draft.promiseLevel),
    targetChannel: firstNonEmptyString(request.targetChannel),
    targetRegions: firstNonEmptyArray(firstBranch.regions, request.targetRegions, draft.regions),
    languages: firstNonEmptyArray(firstBranch.languages, request.languages, draft.languages),
    branchSummaries: branches.map((branch) => ({
      branchId: cleanString(branch.branchId),
      branchLabel: cleanString(branch.branchLabel),
      productName: cleanString(branch.productName),
      materialDirection: cleanString(branch.materialDirection),
      cta: cleanString(branch.cta),
      ending: cleanString(branch.ending)
    }))
  };
}

function buildPromptRequest(batch = {}, branches = [], approvedAssets = [], request = {}) {
  const firstBranch = branches[0] || {};
  const productContext = buildProductContext(batch, branches, request);
  const negativePrompt = firstNonEmptyString(firstBranch.negativePrompt, batch.templateSnapshot?.draft?.negativePrompt);
  const explicitForbiddenItems = cleanArray(request.forbiddenItems);
  const forbiddenItems = explicitForbiddenItems.length
    ? explicitForbiddenItems
    : (negativePrompt ? [negativePrompt] : []);
  return {
    batchId: batch.batchId,
    decompositionResult: cleanObject(batch.decomposition),
    productContext,
    approvedAssets,
    targetRegion: firstNonEmptyString(
      request.targetRegion,
      firstBranch.regions?.[0],
      batch.request?.targetRegions?.[0],
      batch.request?.targetRegion,
      batch.templateSnapshot?.draft?.regions?.[0]
    ),
    language: firstNonEmptyString(
      request.language,
      firstBranch.languages?.[0],
      firstBranch.language,
      batch.request?.languages?.[0],
      batch.request?.language,
      batch.templateSnapshot?.draft?.languages?.[0],
      batch.templateSnapshot?.draft?.language
    ),
    durationSec: Number(request.durationSec || batch.estimate?.durationSec || batch.request?.durationSec || batch.templateSnapshot?.draft?.defaultDurationSec || 0) || null,
    aspectRatio: firstNonEmptyString(
      request.aspectRatio,
      batch.estimate?.outputRatio,
      batch.request?.outputRatio,
      batch.templateSnapshot?.draft?.outputRatio
    ),
    style: firstNonEmptyString(
      request.style,
      firstBranch.materialDirection,
      batch.decomposition?.style
    ),
    forbiddenItems,
    requestId: cleanString(request.requestId),
    skillName: cleanString(request.skillName),
    repoRoot: cleanString(request.repoRoot),
    model: cleanString(request.model),
    timeoutMs: request.timeoutMs
  };
}

export async function autoGenerateSeedancePrompt(context, batchId, request = {}) {
  const safeBatchId = cleanString(batchId);
  if (!safeBatchId) {
    throw new WangzhuanError("validation_error", "batchId 不能为空", { field: "batchId" });
  }
  const loadDetail = context.getBatchDetail || getBatchDetail;
  const detail = await loadDetail(context, safeBatchId);
  if (!detail?.batch) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId: safeBatchId }, 404);
  }

  const batch = detail.batch;
  if (!hasUsableDecomposition(batch.decomposition)) {
    throw new WangzhuanError("validation_error", "视频拆解尚未完成，暂不能生成 Seedance prompt", {
      batchId: safeBatchId,
      reason: "decomposition_not_ready"
    });
  }

  const confirmAssets = context.confirmBatchAssets || confirmBatchAssets;
  const confirmed = await confirmAssets(context, safeBatchId, {
    branchDrafts: reviewedBranchesFromBatch(batch),
    assetReviewConfirmed: true
  });
  const reviewedBatch = confirmed?.batch || batch;
  const reviewedBranches = Array.isArray(confirmed?.branches) ? confirmed.branches : reviewedBranchesFromBatch(reviewedBatch);
  const approvedAssets = collectApprovedAssets(reviewedBranches);
  const mode = approvedAssets.length ? "refine" : "base";
  const generator = mode === "refine"
    ? (context.refineSeedancePromptWithApprovedAssets || refineSeedancePromptWithApprovedAssets)
    : (context.generateBaseSeedancePrompt || generateBaseSeedancePrompt);
  const promptRequest = buildPromptRequest(reviewedBatch, reviewedBranches, approvedAssets, request);
  const promptDraft = await generator({
    context,
    ...promptRequest
  });

  return {
    batch: reviewedBatch,
    mode,
    promptDraft,
    productContext: promptRequest.productContext,
    approvedAssetCount: approvedAssets.length,
    referencedAssetCount: countReferencedAssets(reviewedBranches),
    reviewResult: confirmed?.reviewResult || { ok: true, failures: [], assetsByBranch: [] }
  };
}
