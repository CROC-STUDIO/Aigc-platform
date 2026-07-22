import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { reviewSeedanceAsset, waitForSeedanceAssetReview } from "./asset-review.mjs";
import {
  findContinuitySourceTask,
  readBatch as readPipelineBatch,
  retryFailedGenerationTask,
  submitPendingGenerationTasks,
  taskNeedsContinuityReference,
  writeBatch,
  writeTaskMaps
} from "./pipeline.mjs";
import {
  createSeedanceProviderClient,
  normalizeSeedanceTaskStatus,
  summarizeSeedancePollResponse
} from "./seedance-provider.mjs";
import {
  finalizeSegmentBatch,
  hasMultiSliceStitchGroups,
  isBatchReadyForStitch,
  stitchBatchSegments
} from "./stitch.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths } from "./storage.mjs";
import { WangzhuanError } from "./http.mjs";
import { runFfmpeg } from "./ffmpeg-runner.mjs";

const ACTIVE_POLL_BATCH_STATUSES = new Set(["running", "stitching"]);
const PENDING_SUBMISSION_BATCH_STATUSES = new Set(["queued", "running", "stitching", "qc", "partial_failed"]);
const MAX_SUCCEEDED_WITHOUT_VIDEO_URL_POLLS = 30;
const MAX_SUBMISSION_RECONCILIATION_ATTEMPTS = 20;
const execFileAsync = promisify(execFile);
const UPSTREAM_POLL_IN_FLIGHT = new Map();

async function readBatch(context, batchId) {
  if (typeof context.readBatchForTest === "function") {
    return context.readBatchForTest(batchId);
  }
  return readPipelineBatch(context, batchId);
}

async function submitPendingTasks(context, batchId) {
  if (typeof context.submitPendingGenerationTasksForTest === "function") {
    return context.submitPendingGenerationTasksForTest(batchId);
  }
  return submitPendingGenerationTasks(context, batchId);
}

function pollSingleFlightKey(context, batchId) {
  const scope = context.userProjectRoot || context.sharedProjectRoot || context.userId || context.user?.username || "local";
  return `${scope}:${batchId}`;
}

function runPollSingleFlight(key, worker) {
  const active = UPSTREAM_POLL_IN_FLIGHT.get(key);
  if (active) return active;
  const task = Promise.resolve().then(worker);
  const tracked = task.finally(() => {
    if (UPSTREAM_POLL_IN_FLIGHT.get(key) === tracked) UPSTREAM_POLL_IN_FLIGHT.delete(key);
  });
  UPSTREAM_POLL_IN_FLIGHT.set(key, tracked);
  return tracked;
}

async function mapWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }));
  return results;
}

function resolvePollConcurrency(context = {}) {
  const configured = Number(context.config?.wangzhuan?.upstreamPollConcurrency);
  if (Number.isFinite(configured) && configured > 0) return Math.min(10, Math.round(configured));
  return 3;
}

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

function taskSegmentPath(context, batchId, generationTaskId) {
  return join(wangzhuanPaths(context).batchesDir, batchId, "segments", `${generationTaskId}.mp4`);
}

function continuityFramePath(context, batchId, generationTaskId) {
  return join(wangzhuanPaths(context).batchesDir, batchId, "continuity", `${generationTaskId}_last_frame.jpg`);
}

function isLegacyMockGenerationTask(task = {}) {
  if (task.provider === "mock") return true;
  const seedanceTaskId = String(task.seedanceTaskId || "");
  return seedanceTaskId.startsWith("mock_");
}

function batchNeedsUpstreamPoll(batch = {}) {
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const hasPendingUpstreamTasks = tasks.some((task) => shouldPollTaskStatus(task));
  if (["stopped", "failed", "succeeded"].includes(batch.status)) return false;
  if (hasPendingUpstreamTasks) return true;
  if (PENDING_SUBMISSION_BATCH_STATUSES.has(batch.status)
    && tasks.some((task) => task.status === "pending")) return true;
  if (["qc", "partial_failed"].includes(batch.status)) return false;
  if (!ACTIVE_POLL_BATCH_STATUSES.has(batch.status)) return false;
  const durationSec = Number(batch.estimate?.durationSec || 15);
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  if (durationSec !== 30) {
    return !outputs.some((output) => output.kind === "segment_video")
      && tasks.some((task) => task.status === "downloaded");
  }
  if (durationSec === 30) {
    return !outputs.some((output) => output.kind === "stitched_video")
      && tasks.some((task) => task.status === "downloaded");
  }
  return false;
}

async function writeSegmentBuffer(context, batchId, generationTaskId, buffer) {
  const target = taskSegmentPath(context, batchId, generationTaskId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return userRelative(context, target);
}

async function extractContinuityFrame(context, batch, sourceTask) {
  const sourcePath = sourceTask.outputPath ? join(context.userProjectRoot, sourceTask.outputPath) : "";
  if (!sourcePath) {
    throw new WangzhuanError("missing_required_file", "缺少前序片段视频，无法生成后续片段连续性参考帧", {
      batchId: batch.batchId,
      generationTaskId: sourceTask.generationTaskId
    });
  }
  const target = continuityFramePath(context, batch.batchId, sourceTask.generationTaskId);
  await mkdir(dirname(target), { recursive: true });
  await runFfmpeg([
    "-y",
    "-sseof", "-0.2",
    "-i", sourcePath,
    "-frames:v", "1",
    "-q:v", "2",
    target
  ], {
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const storage = await syncWangzhuanAsset(context, target, "pipeline_continuity_frame", { required: true });
  const storedPath = userRelative(context, target);
  const buffer = await readFile(target);
  const reviewInput = {
    branchId: sourceTask.branchId || "",
    assetKey: "continuityFrame",
    fileName: `${sourceTask.generationTaskId}_last_frame.jpg`,
    mimeType: "image/jpeg",
    buffer,
    storageUrl: storage.storageUrl,
    storageKey: storage.storageKey,
    storedPath
  };
  const review = await reviewSeedanceAsset(context, reviewInput);
  const settledReview = await waitForSeedanceAssetReview(context, reviewInput, review);
  return {
    sourceGenerationTaskId: sourceTask.generationTaskId,
    sourceContinuitySliceId: sourceTask.continuitySliceId || "",
    sourceOutputId: sourceTask.currentOutputId || sourceTask.responseSummary?.outputId || "",
    sourceOutputPath: sourceTask.outputPath || "",
    sourceAttempt: Number(sourceTask.attempts || 0),
    storedPath,
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl,
    review: settledReview,
    createdAt: new Date().toISOString()
  };
}

function shouldPollTaskStatus(task = {}) {
  if (task.status === "waiting_upstream") return true;
  return task.status === "failed"
    && task.errorCode === "upstream_failed"
    && String(task.errorMessage || "").includes("未返回视频地址")
    && Boolean(task.seedanceTaskId || task.providerJobId);
}

function generationTaskPollChanged(before = {}, after = {}) {
  return before.status !== after.status
    || before.outputPath !== after.outputPath
    || before.errorMessage !== after.errorMessage
    || Number(before.upstreamPollAttempts ?? before.responseSummary?.upstreamPollAttempts ?? 0)
      !== Number(after.upstreamPollAttempts ?? after.responseSummary?.upstreamPollAttempts ?? 0)
    || before.responseSummary?.upstreamStatus !== after.responseSummary?.upstreamStatus
    || Number(before.responseSummary?.pollFailureCount || 0) !== Number(after.responseSummary?.pollFailureCount || 0)
    || before.responseSummary?.pollErrorMessage !== after.responseSummary?.pollErrorMessage
    || Number(before.missingVideoUrlPolls || 0) !== Number(after.missingVideoUrlPolls || 0)
    || Boolean(before.responseSummary?.waitingForVideoUrl) !== Boolean(after.responseSummary?.waitingForVideoUrl)
    || Boolean(before.responseSummary?.videoUrlStored) !== Boolean(after.responseSummary?.videoUrlStored);
}

function normalizeReconciliationResult(result = {}) {
  const raw = String(result.status || result.state || "").toLowerCase();
  if (["queued", "pending"].includes(raw)) return "queued";
  if (["running", "processing", "in_progress"].includes(raw)) return "running";
  if (["succeeded", "success", "completed", "done"].includes(raw)) return "succeeded";
  if (["not_found", "notfound", "not_created", "missing", "absent"].includes(raw)) return "not_created";
  return "unknown";
}

async function reconcileUnknownSubmissionBatch(context, batchId, taskUid) {
  let batch = await readBatch(context, batchId);
  const unknownTasks = (Array.isArray(batch.tasks) ? batch.tasks : [])
    .filter((task) => task.status === "failed"
      && task.errorCode === "submission_unknown"
      && (!taskUid || task.generationTaskId === taskUid));
  if (!unknownTasks.length) return { batch, needsReconciliation: false, reconciledCount: 0 };
  const provider = createSeedanceProviderClient(context);
  const now = new Date().toISOString();
  const retryTaskIds = [];
  let changed = false;
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (!unknownTasks.some((candidate) => candidate.generationTaskId === task.generationTaskId)) return task;
    const previousAttempts = Number(task.responseSummary?.submissionReconciliationAttempts || 0);
    if (previousAttempts >= MAX_SUBMISSION_RECONCILIATION_ATTEMPTS) return task;
    changed = true;
    return {
      ...task,
      responseSummary: {
        ...(task.responseSummary || {}),
        submissionReconciliationAttempts: previousAttempts + 1,
        submissionReconciliationLastAttemptAt: now
      }
    };
  });
  if (changed) {
    batch = await writeBatch(context, { ...batch, tasks }, "scheduler_retry");
  }
  for (const task of unknownTasks) {
    const current = (Array.isArray(batch.tasks) ? batch.tasks : []).find((item) => item.generationTaskId === task.generationTaskId) || task;
    let result = { status: "unknown", responsePayload: { reason: "provider_reconcile_not_available" } };
    try {
      if (typeof provider?.reconcileSubmission === "function") {
        result = await provider.reconcileSubmission({
          submissionRequestId: current.requestSummary?.submissionRequestId || current.responseSummary?.submissionRequestId || "",
          batchId,
          generationTaskId: current.generationTaskId,
          attemptNo: Number(current.attempts || 0),
          requestSummary: current.requestSummary || {}
        });
      }
    } catch (error) {
      result = { status: "unknown", responsePayload: { errorCode: error?.code || "reconciliation_failed", errorMessage: error?.message || "" } };
    }
    const status = normalizeReconciliationResult(result);
    const responseSummary = {
      ...(current.responseSummary || {}),
      reconciliationStatus: status,
      reconciliationResponse: {
        status: result.status || status,
        taskId: result.taskId || "",
        videoUrlStored: Boolean(result.videoUrl),
        errorCode: result.responsePayload?.errorCode || "",
        errorMessage: result.responsePayload?.errorMessage || ""
      },
      ...(result.taskId ? { seedanceTaskId: result.taskId } : {}),
      ...(result.videoUrl ? { videoUrlStored: true } : {})
    };
    if (status === "succeeded" && result.videoUrl && typeof provider?.downloadVideo === "function") {
      try {
        const buffer = await provider.downloadVideo(result.videoUrl);
        const outputPath = await writeSegmentBuffer(context, batchId, current.generationTaskId, buffer);
        const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((item) => item.generationTaskId === current.generationTaskId
          ? {
              ...item,
              status: "downloaded",
              outputPath,
              remoteUrlStored: true,
              finishedAt: now,
              errorCode: "",
              errorMessage: "",
              responseSummary
            }
          : item);
        batch = await writeBatch(context, { ...batch, tasks: nextTasks }, "downloaded_output");
        continue;
      } catch (error) {
        responseSummary.reconciliationDownloadError = error?.message || "对账成功结果下载失败";
      }
    }
    if ((status === "queued" || status === "running" || status === "succeeded") && result.taskId) {
      const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((item) => item.generationTaskId === current.generationTaskId
        ? {
            ...item,
            status: "waiting_upstream",
            seedanceTaskId: result.taskId,
            providerJobId: result.taskId,
            errorCode: "",
            errorMessage: "",
            finishedAt: "",
            responseSummary
          }
        : item);
      batch = await writeBatch(context, { ...batch, tasks: nextTasks }, "scheduler_retry");
      continue;
    }
    if (status === "not_created" && Number(current.responseSummary?.submissionReconciliationRetryCount || 0) < 1) {
      const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((item) => item.generationTaskId === current.generationTaskId
        ? {
            ...item,
            errorCode: "submission_not_created",
            errorMessage: "对账确认 Seedance 未创建任务，允许自动重试一次",
            responseSummary: { ...responseSummary, submissionReconciliationRetryCount: 1 }
          }
        : item);
      batch = await writeBatch(context, { ...batch, tasks: nextTasks }, "scheduler_retry");
      retryTaskIds.push(current.generationTaskId);
    } else {
      const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((item) => item.generationTaskId === current.generationTaskId
        ? { ...item, responseSummary }
        : item);
      batch = await writeBatch(context, { ...batch, tasks: nextTasks }, "scheduler_retry");
    }
  }
  for (const generationTaskId of retryTaskIds) {
    batch = (await retryFailedGenerationTask(context, batchId, generationTaskId, { automatic: true, triggerName: "scheduler_retry" })).batch;
  }
  if (!retryTaskIds.length
    && !(Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending" || task.status === "waiting_upstream")) {
    if ((Number(batch.estimate?.durationSec) === 30 || hasMultiSliceStitchGroups(batch)) && isBatchReadyForStitch(batch)) {
      batch = (await stitchBatchSegments(context, batchId, { replaceDerivedOutputs: true })).batch;
    } else {
      batch = await finalizeSegmentBatch(context, batchId);
    }
  }
  const needsReconciliation = (Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "failed"
    && task.errorCode === "submission_unknown"
    && Number(task.responseSummary?.submissionReconciliationAttempts || 0) < MAX_SUBMISSION_RECONCILIATION_ATTEMPTS);
  return { batch, needsReconciliation, reconciledCount: unknownTasks.length };
}

function isApprovedContinuityReference(reference = {}) {
  const status = String(reference.review?.status || "").toLowerCase();
  return Boolean(reference.review?.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(status));
}

function isPendingContinuityReference(reference = {}) {
  return ["pending", "queued", "running", "processing"].includes(String(reference.review?.status || "").toLowerCase());
}

function continuityTaskVariantKey(task = {}) {
  return [
    task.branchId || "default",
    String(task.branchVariantIndex || task.variantIndex || 1)
  ].join(":");
}

function findFailedContinuitySourceTask(tasks = [], task = {}) {
  const previousSliceId = String(task.previousSliceId || "").trim();
  const hasFissionSliceOrder = Number.isFinite(Number(task.storySegmentIndex))
    && Number.isFinite(Number(task.seedanceSliceIndex))
    && Number(task.seedanceSliceIndex) > 0;
  return tasks.find((candidate) => {
    if (candidate.status !== "failed" || continuityTaskVariantKey(candidate) !== continuityTaskVariantKey(task)) return false;
    if (previousSliceId) {
      return String(candidate.continuitySliceId || "").trim() === previousSliceId
        && (!task.continuityGroupId || candidate.continuityGroupId === task.continuityGroupId);
    }
    if (hasFissionSliceOrder) {
      return Number(candidate.storySegmentIndex || 0) === Number(task.storySegmentIndex)
        && Number(candidate.seedanceSliceIndex || 0) === Number(task.seedanceSliceIndex) - 1;
    }
    return Number(candidate.segmentIndex || 1) === Number(task.segmentIndex || 1) - 1;
  }) || null;
}

async function attachContinuityReferences(context, batch, tasks, now) {
  const nextTasks = [...tasks];
  let changed = false;
  for (let index = 0; index < nextTasks.length; index += 1) {
    const task = nextTasks[index];
    if (task.status !== "pending" || !taskNeedsContinuityReference(batch, task)) continue;
    if (task.continuityReference) {
      if (!isPendingContinuityReference(task.continuityReference)) continue;
      const review = await waitForSeedanceAssetReview(context, {
        assetId: task.continuityReference.review?.assetId,
        assetKey: "continuityFrame",
        fileName: `${task.continuityReference.sourceGenerationTaskId || task.generationTaskId}_last_frame.jpg`,
        mimeType: "image/jpeg",
        storageUrl: task.continuityReference.storageUrl,
        storageKey: task.continuityReference.storageKey,
        storedPath: task.continuityReference.storedPath
      }, task.continuityReference.review);
      if (isApprovedContinuityReference({ review })) {
        nextTasks[index] = {
          ...task,
          continuityReference: { ...task.continuityReference, review },
          requestSummary: {
            ...(task.requestSummary || {}),
            continuityReference: {
              ...(task.requestSummary?.continuityReference || {}),
              assetId: review.assetId,
              status: review.status
            }
          }
        };
        changed = true;
      }
      continue;
    }
    const previous = findContinuitySourceTask(nextTasks, task);
    if (!previous) {
      const failedPrevious = findFailedContinuitySourceTask(nextTasks, task);
      if (!failedPrevious) continue;
      const sourceReason = failedPrevious.errorMessage ? `：${failedPrevious.errorMessage}` : "";
      nextTasks[index] = {
        ...task,
        status: "failed",
        finishedAt: now,
        errorCode: "continuity_reference_failed",
        errorMessage: `前序分片 ${failedPrevious.generationTaskId} 已失败，无法生成连续性参考帧${sourceReason}`.slice(0, 500),
        responseSummary: {
          ...(task.responseSummary || {}),
          continuityFailure: {
            sourceGenerationTaskId: failedPrevious.generationTaskId,
            sourceStatus: failedPrevious.status,
            sourceErrorCode: failedPrevious.errorCode || "upstream_failed"
          }
        }
      };
      changed = true;
      continue;
    }
    try {
      const continuityReference = await extractContinuityFrame(context, batch, previous);
      if (!isApprovedContinuityReference(continuityReference)) {
        nextTasks[index] = {
          ...task,
          status: "failed",
          finishedAt: now,
          errorCode: "continuity_reference_failed",
          errorMessage: continuityReference.review?.reviewReason || "前序片段尾帧审核未通过，无法提交后续片段生成",
          responseSummary: {
            ...(task.responseSummary || {}),
            continuityReference
          }
        };
      } else {
        nextTasks[index] = {
          ...task,
          continuityReference,
          requestSummary: {
            ...(task.requestSummary || {}),
            continuityReference: {
              sourceGenerationTaskId: continuityReference.sourceGenerationTaskId,
              sourceContinuitySliceId: continuityReference.sourceContinuitySliceId,
              sourceOutputId: continuityReference.sourceOutputId,
              sourceOutputPath: continuityReference.sourceOutputPath,
              sourceAttempt: continuityReference.sourceAttempt,
              storedPath: continuityReference.storedPath,
              assetId: continuityReference.review.assetId,
              status: continuityReference.review.status
            }
          }
        };
      }
      changed = true;
    } catch (error) {
      nextTasks[index] = {
        ...task,
        status: "failed",
        finishedAt: now,
        errorCode: error?.code || "continuity_reference_failed",
        errorMessage: error?.message || "前序片段尾帧生成失败，无法提交后续片段生成"
      };
      changed = true;
    }
  }
  return { tasks: nextTasks, changed };
}

export function statusAfterTaskWrite(batch, tasks) {
  if (["stopped", "failed", "succeeded", "qc", "partial_failed"].includes(batch.status)) return batch.status;
  if (tasks.some((task) => task.status === "pending" || task.status === "waiting_upstream")) return batch.status;
  // `downloaded_output` is a task-level persistence trigger. Keep the run
  // in its current non-terminal state and let later workflow triggers
  // (`generation_completed` / `stitch_progress` / `qc_completed`) settle the
  // final run status.
  if (tasks.some((task) => task.status === "failed")) return batch.status;
  return batch.status;
}

async function pollGenerationTask(context, batch, task, provider, now) {
  if (isLegacyMockGenerationTask(task)) {
    return {
      ...task,
      status: "failed",
      finishedAt: now,
      errorCode: "upstream_failed",
      errorMessage: "任务使用了 Mock 提交，无法轮询真实上游",
      responseSummary: {
        ...(task.responseSummary || {}),
        status: "failed",
        upstreamStatus: "failed"
      }
    };
  }

  if (!provider?.getTask) {
    throw new WangzhuanError("upstream_failed", "Seedance provider 未配置 poll 能力", {
      generationTaskId: task.generationTaskId,
      batchId: batch.batchId
    });
  }

  let polled;
  try {
    polled = await provider.getTask(task.seedanceTaskId || task.providerJobId);
  } catch (error) {
    const pollFailureCount = Number(task.responseSummary?.pollFailureCount || 0) + 1;
    return {
      ...task,
      responseSummary: {
        ...(task.responseSummary || {}),
        pollFailureCount,
        pollErrorCode: error?.code || "upstream_poll_failed",
        pollErrorMessage: error?.message || "查询 Seedance 状态失败，后台将自动重试"
      }
    };
  }
  const normalized = normalizeSeedanceTaskStatus(polled.status);
  const responseSummary = summarizeSeedancePollResponse(polled);
  const responseWithPollRecovery = {
    ...(task.responseSummary || {}),
    ...responseSummary,
    pollFailureCount: 0,
    pollErrorCode: "",
    pollErrorMessage: ""
  };

  if (normalized === "queued" || normalized === "running") {
    const upstreamPollAttempts = Number(task.upstreamPollAttempts ?? task.responseSummary?.upstreamPollAttempts ?? 0) + 1;
    return {
      ...task,
      upstreamPollAttempts,
      responseSummary: {
        ...responseWithPollRecovery,
        upstreamPollAttempts
      }
    };
  }

  if (normalized === "failed") {
    return {
      ...task,
      status: "failed",
      finishedAt: now,
      errorCode: "upstream_failed",
      errorMessage: "Seedance 上游任务失败",
      responseSummary: responseWithPollRecovery
    };
  }

  if (normalized === "succeeded") {
    if (!polled.videoUrl || typeof provider.downloadVideo !== "function") {
      const missingVideoUrlPolls = Number(task.missingVideoUrlPolls || 0) + 1;
      if (!polled.videoUrl && missingVideoUrlPolls < MAX_SUCCEEDED_WITHOUT_VIDEO_URL_POLLS) {
        return {
          ...task,
          status: "waiting_upstream",
          errorCode: "",
          errorMessage: "",
          finishedAt: "",
          missingVideoUrlPolls,
          responseSummary: {
            ...responseWithPollRecovery,
            waitingForVideoUrl: true,
            missingVideoUrlPolls
          }
        };
      }
      return {
        ...task,
        status: "failed",
        finishedAt: now,
        errorCode: "upstream_failed",
        errorMessage: polled.videoUrl ? "Seedance provider 未配置视频下载能力" : "Seedance 上游未返回视频地址",
          responseSummary: {
            ...responseWithPollRecovery,
            missingVideoUrlPolls
        }
      };
    }

    let outputPath;
    try {
      const buffer = await provider.downloadVideo(polled.videoUrl);
      outputPath = await writeSegmentBuffer(context, batch.batchId, task.generationTaskId, buffer);
    } catch (error) {
      const pollFailureCount = Number(task.responseSummary?.pollFailureCount || 0) + 1;
      return {
        ...task,
        status: "waiting_upstream",
        responseSummary: {
          ...responseWithPollRecovery,
          pollFailureCount,
          pollErrorCode: error?.code || "upstream_download_failed",
          pollErrorMessage: error?.message || "下载 Seedance 视频失败，后台将自动重试"
        }
      };
    }

    return {
      ...task,
      status: "downloaded",
      outputPath,
      remoteUrlStored: true,
      finishedAt: now,
      missingVideoUrlPolls: 0,
      errorCode: "",
      errorMessage: "",
      responseSummary: {
        ...responseWithPollRecovery
      }
    };
  }

  return {
    ...task,
    status: "failed",
    finishedAt: now,
    errorCode: "upstream_failed",
    errorMessage: `Seedance 上游任务状态异常：${normalized || polled.status || "unknown"}`,
    responseSummary: {
      ...responseWithPollRecovery
    }
  };
}

async function advanceThirtySecondBatch(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (Number(batch.estimate?.durationSec) !== 30) return batch;
  if (["succeeded", "failed", "stopped"].includes(batch.status)) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "waiting_upstream")) return batch;
  if (stitchedDeliveryCoversReadyTasks(batch)) return batch;
  if (!isBatchReadyForStitch(batch)) {
    const hasFailedTasks = (Array.isArray(batch.tasks) ? batch.tasks : [])
      .some((task) => task.status === "failed" || task.status === "stopped");
    if (!hasFailedTasks) return batch;
    return writeBatch(context, { ...batch, status: "partial_failed" }, "generation_partial_failed");
  }
  const detail = await stitchBatchSegments(context, batchId, { replaceDerivedOutputs: true });
  return detail.batch;
}

function stitchedDeliveryCoversReadyTasks(batch = {}) {
  const readyTaskIds = (Array.isArray(batch.tasks) ? batch.tasks : [])
    .filter((task) => ["downloaded", "succeeded", "qc"].includes(task.status) && task.outputPath)
    .map((task) => task.generationTaskId);
  if (!readyTaskIds.length) return false;
  const deliveredTaskIds = new Set(
    (Array.isArray(batch.outputs) ? batch.outputs : [])
      .filter((output) => output.kind === "stitched_video")
      .flatMap((output) => output.generationTaskIds || [])
  );
  return readyTaskIds.every((taskId) => deliveredTaskIds.has(taskId));
}

export function shouldPollUpstreamBatch(batch = {}) {
  return batchNeedsUpstreamPoll(batch);
}

async function pollUpstreamBatchOnce(context, batchId) {
  let batch = await readBatch(context, batchId);
  if (["stopped", "failed", "succeeded"].includes(batch.status)
    || (["qc", "partial_failed"].includes(batch.status)
      && !(Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => shouldPollTaskStatus(task) || task.status === "pending"))) {
    return { batch, needsPoll: false, polledCount: 0, advanced: false };
  }

  const provider = createSeedanceProviderClient(context);
  const now = new Date().toISOString();
  let polledCount = 0;
  let tasksChanged = false;
  const nextTasks = [];

  const taskResults = await mapWithConcurrency(
    Array.isArray(batch.tasks) ? batch.tasks : [],
    resolvePollConcurrency(context),
    async (task) => {
    if (!shouldPollTaskStatus(task)) {
      return { before: task, after: task, polled: false };
    }
    const polledTask = await pollGenerationTask(context, batch, task, provider, now);
      return { before: task, after: polledTask, polled: true };
    }
  );
  for (const result of taskResults) {
    if (result.polled) polledCount += 1;
    if (generationTaskPollChanged(result.before, result.after)) tasksChanged = true;
    nextTasks.push(result.after);
  }

  const durationSec = Number(batch.estimate?.durationSec || 15);
  const continuity = await attachContinuityReferences(context, batch, nextTasks, now);
  if (tasksChanged || continuity.changed) {
    batch = await writeBatch(context, {
      ...batch,
      status: statusAfterTaskWrite(batch, continuity.tasks),
      tasks: continuity.tasks
    }, "downloaded_output");
    await writeTaskMaps(context, batch);
  }

  let advanced = false;
  if (PENDING_SUBMISSION_BATCH_STATUSES.has(batch.status)
    && (Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) {
    const submitted = await submitPendingTasks(context, batchId);
    batch = submitted.batch;
    if (submitted.submittedCount > 0) advanced = true;
  }
  if (durationSec === 30 || hasMultiSliceStitchGroups(batch)) {
    const beforeStatus = batch.status;
    if (durationSec === 30) {
      batch = await advanceThirtySecondBatch(context, batchId);
    } else if (isBatchReadyForStitch(batch)) {
      if (!stitchedDeliveryCoversReadyTasks(batch)) {
        batch = (await stitchBatchSegments(context, batchId, { replaceDerivedOutputs: true })).batch;
      }
    } else {
      batch = await finalizeSegmentBatch(context, batchId);
    }
    advanced = advanced || batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "stitched_video");
  } else {
    const beforeStatus = batch.status;
    batch = await finalizeSegmentBatch(context, batchId);
    advanced = advanced || batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "segment_video");
  }

  const needsPoll = batchNeedsUpstreamPoll(batch);
  return { batch, needsPoll, polledCount, advanced };
}

export function pollUpstreamBatch(context, batchId) {
  return runPollSingleFlight(
    pollSingleFlightKey(context, batchId),
    () => pollUpstreamBatchOnce(context, batchId)
  );
}

export function reconcileUnknownSubmission(context, batchId, taskUid) {
  return runPollSingleFlight(
    `${pollSingleFlightKey(context, batchId)}:submission-reconciliation:${taskUid || "batch"}`,
    () => reconcileUnknownSubmissionBatch(context, batchId, taskUid)
  );
}

export const __upstreamPollTestHooks = {
  batchNeedsUpstreamPoll,
  mapWithConcurrency,
  resolvePollConcurrency,
  runPollSingleFlight
};
