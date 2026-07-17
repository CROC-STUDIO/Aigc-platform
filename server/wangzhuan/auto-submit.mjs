import { createHash } from "node:crypto";

import { estimateBatch, prepareBatchPlanFromEstimate } from "./estimates.mjs";
import { WangzhuanError } from "./http.mjs";
import { confirmBatchPlan, submitPendingGenerationTasks } from "./pipeline.mjs";
import { runBatchQc } from "./qc.mjs";
import { pollUpstreamBatch } from "./upstream-poll.mjs";

export const AUTO_SUBMIT_MODE = Object.freeze({
  submitted: "submitted",
  confirmationRequired: "confirmation_required"
});

const DEFAULT_DEPS = Object.freeze({
  estimateBatch,
  prepareBatchPlanFromEstimate,
  confirmBatchPlan,
  submitPendingGenerationTasks,
  pollUpstreamBatch,
  runBatchQc
});

function stageSlug(stage) {
  return String(stage || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "stage";
}

export function buildAutoSubmitIdempotencyKey(base, stage) {
  const digest = createHash("sha256")
    .update(`${String(base || "")}:${String(stage || "")}`)
    .digest("hex")
    .slice(0, 16);
  return `auto_${stageSlug(stage)}_${digest}`;
}

function ensureIdempotencyKey(request = {}) {
  const key = String(request.idempotencyKey || "").trim();
  if (!key) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  return key;
}

function confirmedPlanIds(plans = []) {
  return plans.map((plan) => plan?.planId).filter(Boolean);
}

function resolveBatchId(planResult = {}, request = {}) {
  const batchId = planResult.batch?.batchId || request.batchId || "";
  if (!batchId) {
    throw new WangzhuanError("validation_error", "自动提交未生成批次编号", { field: "batchId" });
  }
  return batchId;
}

async function maybeRunQc(context, batch, deps) {
  if (batch?.status !== "qc") return { batch, qc: null };
  const qc = await deps.runBatchQc(context, batch.batchId);
  return { batch: qc.batch || batch, qc };
}

export async function runAutoSubmitPipeline(context, request = {}, depsOverride = {}) {
  const deps = { ...DEFAULT_DEPS, ...depsOverride };
  const baseKey = ensureIdempotencyKey(request);
  const estimatePayload = {
    ...request,
    idempotencyKey: buildAutoSubmitIdempotencyKey(baseKey, "estimate")
  };
  const estimateResult = await deps.estimateBatch(context, estimatePayload);
  const estimate = estimateResult?.estimate;
  if (!estimate?.estimateId) {
    throw new WangzhuanError("validation_error", "估算结果缺少 estimateId", { field: "estimateId" });
  }
  const confirmationToken = request.confirmationToken || estimate.confirmationToken;
  if (estimate.confirmationRequired && !request.confirmationToken) {
    return {
      mode: AUTO_SUBMIT_MODE.confirmationRequired,
      estimate,
      limits: estimateResult.limits || null,
      capabilities: estimateResult.capabilities || null
    };
  }

  const planResult = await deps.prepareBatchPlanFromEstimate(context, {
    idempotencyKey: buildAutoSubmitIdempotencyKey(baseKey, "plan"),
    ...(request.batchId ? { batchId: request.batchId } : {}),
    estimateId: estimate.estimateId,
    llmConfig: request.llmConfig || request.planLlmConfig || {},
    knowledgeNotes: request.knowledgeNotes || "",
    ...(confirmationToken ? { confirmationToken } : {})
  });
  const batchId = resolveBatchId(planResult, request);
  const plans = Array.isArray(planResult.plans) ? planResult.plans : (planResult.batch?.plans || []);
  const confirmed = await deps.confirmBatchPlan(context, batchId, {
    idempotencyKey: buildAutoSubmitIdempotencyKey(baseKey, "confirm"),
    confirmedPlanIds: confirmedPlanIds(plans),
    plans,
    branchDrafts: request.branchDrafts || request.branches || [],
    assetReviewConfirmed: Boolean(request.assetReviewConfirmed)
  });
  const submitted = Number.isFinite(Number(confirmed?.submittedCount))
    ? confirmed
    : await deps.submitPendingGenerationTasks(context, batchId);
  const polled = await deps.pollUpstreamBatch(context, batchId);
  const qcResult = await maybeRunQc(context, polled.batch || submitted.batch || confirmed.batch, deps);
  return {
    mode: AUTO_SUBMIT_MODE.submitted,
    estimate,
    plans,
    confirmedBatch: confirmed.confirmedBatch || confirmed.batch,
    submittedCount: submitted.submittedCount || 0,
    failedSubmitCount: submitted.failedSubmitCount || 0,
    batch: qcResult.batch,
    qc: qcResult.qc,
    needsPoll: Boolean(polled.needsPoll)
  };
}
