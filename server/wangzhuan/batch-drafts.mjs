import { join } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { makeBatchId } from "./ids.mjs";
import {
  hasWangzhuanFactsStore,
  loadActivePipelineRunFromMysql,
  loadBatchDetailFromMysql,
  syncBatchFacts
} from "./mysql-facts.mjs";
import { toProjectRelative, wangzhuanPaths } from "./storage.mjs";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function currentProjectName(context) {
  return context.projectName || "current_project";
}

const WORKFLOW_STATUSES = new Set([
  "preview_required",
  "queued",
  "running",
  "stitching",
  "qc",
  "partial_failed",
  "succeeded",
  "failed",
  "stopped"
]);

const PRESERVED_SAVE_STATUSES = new Set(["checking", ...WORKFLOW_STATUSES]);

function resolveDraftSaveStatus(request = {}, existingStatus = "") {
  const existing = String(existingStatus || "").trim();
  const requested = String(request.status || "").trim();
  if (PRESERVED_SAVE_STATUSES.has(existing)) return existing;
  if (requested === "checking") return "checking";
  if (requested === "draft") return "draft";
  if (WORKFLOW_STATUSES.has(requested)) return requested;
  return requested || existing || "checking";
}

function normalizeString(value, max = 0) {
  const text = typeof value === "string" ? value.trim() : "";
  return max > 0 ? text.slice(0, max) : text;
}

function cleanObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ensureReferenceVideo(request = {}) {
  const referenceVideo = cleanObject(request.referenceVideo);
  if (!referenceVideo.referenceVideoId) {
    throw new WangzhuanError("validation_error", "referenceVideo.referenceVideoId 必填", {
      field: "referenceVideo.referenceVideoId"
    });
  }
  return referenceVideo;
}

async function requireFactsStore() {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存批次草稿");
  }
}

async function saveBatchDraftRecord(context, batch) {
  const synced = await syncBatchFacts(context, batch, "batch_draft_saved");
  if (synced?.skipped) {
    const detail = synced.error?.message || synced.error?.code || null;
    if (!await hasWangzhuanFactsStore()) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存批次草稿");
    }
    throw new WangzhuanError("database_unavailable", detail
      ? `批次草稿保存失败：${String(detail).slice(0, 300)}`
      : "批次草稿保存失败", {
      batchId: batch.batchId,
      cause: detail
    });
  }
}

async function loadExistingDraft(context, batchId) {
  if (!batchId) return null;
  const detail = await loadBatchDetailFromMysql(context, batchId);
  return detail?.batch || null;
}

function requestSnapshotFromDraft(request = {}, referenceVideo = {}) {
  return {
    batchName: normalizeString(request.batchName, 160),
    productName: normalizeString(request.productName, 160),
    productLink: normalizeString(request.productLink, 2000),
    knowledgeNotes: normalizeString(request.knowledgeNotes, 4000),
    llmConfig: cleanObject(request.llmConfig),
    disclaimer: normalizeString(request.disclaimer, 2000),
    disclaimerPresetId: normalizeString(request.disclaimerPresetId || request.disclaimerPreset, 64),
    disclaimerPreset: normalizeString(request.disclaimerPreset || request.disclaimerPresetId, 64),
    disclaimerLanguage: normalizeString(request.disclaimerLanguage, 64),
    disclaimerByLanguage: cleanObject(request.disclaimerByLanguage),
    disclaimerOverlay: cleanObject(request.disclaimerOverlay),
    durationSec: Number(request.durationSec || 0) || undefined,
    outputRatio: normalizeString(request.outputRatio, 16),
    variantCount: Number(request.variantCount || 0) || undefined,
    requestedConcurrency: Number(request.requestedConcurrency || 0) || undefined,
    targetChannel: normalizeString(request.targetChannel, 64),
    targetRegion: normalizeString(request.targetRegion, 64),
    targetRegions: Array.isArray(request.targetRegions) ? request.targetRegions : [],
    language: normalizeString(request.language, 64),
    languages: Array.isArray(request.languages) ? request.languages : [],
    promiseLevel: normalizeString(request.promiseLevel, 64),
    templateId: normalizeString(request.templateId, 128),
    versionId: normalizeString(request.versionId, 160),
    templateSnapshot: cleanObject(request.templateSnapshot),
    branches: Array.isArray(request.branches) ? request.branches : [],
    branchDrafts: Array.isArray(request.branchDrafts) ? request.branchDrafts : [],
    decomposition: cleanObject(request.decomposition),
    referenceVideoId: referenceVideo.referenceVideoId
  };
}

function buildDraftBatch(context, existing, request = {}) {
  const now = new Date().toISOString();
  const referenceVideo = ensureReferenceVideo(request);
  const requestSnapshot = requestSnapshotFromDraft(request, referenceVideo);
  const batchId = existing?.batchId || makeBatchId();
  const status = resolveDraftSaveStatus(request, existing?.status);
  const batchName = requestSnapshot.batchName || existing?.userBatchName || existing?.displayBatchName || "";
  const templateSnapshot = request.templateSnapshot !== undefined
    ? request.templateSnapshot
    : existing?.templateSnapshot || null;
  const decomposition = request.decomposition !== undefined
    ? request.decomposition
    : existing?.decomposition || null;
  return {
    batchId,
    userBatchName: batchName,
    displayBatchName: batchName,
    type: "pipeline",
    status,
    userId: currentUserId(context),
    projectRoot: currentProjectName(context),
    templateSnapshot,
    referenceVideo,
    decomposition,
    request: {
      ...(existing?.request || {}),
      ...requestSnapshot,
      batchId,
      sourceStep: normalizeString(request.sourceStep, 64)
    },
    estimate: existing?.estimate || null,
    branchDrafts: Array.isArray(request.branchDrafts) ? request.branchDrafts : (existing?.branchDrafts || []),
    previewType: existing?.previewType,
    plans: Array.isArray(existing?.plans) ? existing.plans : [],
    scripts: Array.isArray(existing?.scripts) ? existing.scripts : [],
    tasks: Array.isArray(existing?.tasks) ? existing.tasks : [],
    outputs: Array.isArray(existing?.outputs) ? existing.outputs : [],
    qcSummary: existing?.qcSummary || { total: 0, passed: 0, failed: 0, warnings: [] },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    startedAt: existing?.startedAt,
    finishedAt: existing?.finishedAt
  };
}

export async function saveBatchDraft(context, request = {}) {
  await requireFactsStore();
  const existing = await loadExistingDraft(context, request.batchId);
  const batch = buildDraftBatch(context, existing, request);
  await saveBatchDraftRecord(context, batch);
  const detail = await loadBatchDetailFromMysql(context, batch.batchId);
  if (!detail?.batch) {
    throw new WangzhuanError("database_unavailable", "批次草稿保存后读取失败", { batchId: batch.batchId });
  }
  return detail;
}

export async function getEditableDraftBatch(context) {
  await requireFactsStore();
  const active = await loadActivePipelineRunFromMysql(context);
  if (!active?.batchId) return null;
  const detail = await loadBatchDetailFromMysql(context, active.batchId);
  if (!detail?.batch) return null;
  if (!["draft", "checking", "preview_required", "queued", "running", "stitching", "qc", "partial_failed"].includes(detail.batch.status)) {
    return null;
  }
  return detail;
}

export function draftReferenceVideoPreviewUrl(context, referenceVideo = {}) {
  const storedPath = typeof referenceVideo.storedPath === "string" ? referenceVideo.storedPath.trim() : "";
  if (!storedPath) return "";
  return `/file?path=${encodeURIComponent(toProjectRelative(context.userProjectRoot, join(wangzhuanPaths(context).userRoot, storedPath).replace(context.userProjectRoot, "").replace(/^[\\/]+/, storedPath)))}`;
}
