import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { reviewSeedanceAsset } from "./asset-review.mjs";
import { readBatch, submitPendingGenerationTasks, writeBatch, writeTaskMaps } from "./pipeline.mjs";
import {
  createSeedanceProviderClient,
  normalizeSeedanceTaskStatus,
  summarizeSeedancePollResponse
} from "./seedance-provider.mjs";
import { finalizeSegmentBatch, stitchBatchSegments } from "./stitch.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths } from "./storage.mjs";
import { WangzhuanError } from "./http.mjs";

const ACTIVE_POLL_BATCH_STATUSES = new Set(["running", "stitching"]);
const MAX_SUCCEEDED_WITHOUT_VIDEO_URL_POLLS = 30;
const execFileAsync = promisify(execFile);

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
  if (["stopped", "failed", "succeeded", "qc", "partial_failed"].includes(batch.status)) return false;
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  if (tasks.some((task) => shouldPollTaskStatus(task))) return true;
  if (tasks.some((task) => task.status === "pending") && ACTIVE_POLL_BATCH_STATUSES.has(batch.status)) return true;
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
    throw new WangzhuanError("missing_required_file", "缺少第一段视频，无法生成第二段连续性参考帧", {
      batchId: batch.batchId,
      generationTaskId: sourceTask.generationTaskId
    });
  }
  const target = continuityFramePath(context, batch.batchId, sourceTask.generationTaskId);
  await mkdir(dirname(target), { recursive: true });
  await execFileAsync("ffmpeg", [
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
  const review = await reviewSeedanceAsset(context, {
    branchId: sourceTask.branchId || "",
    assetKey: "continuityFrame",
    fileName: `${sourceTask.generationTaskId}_last_frame.jpg`,
    mimeType: "image/jpeg",
    buffer,
    storageUrl: storage.storageUrl,
    storageKey: storage.storageKey,
    storedPath
  });
  return {
    sourceGenerationTaskId: sourceTask.generationTaskId,
    storedPath,
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl,
    review,
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
    || Number(before.missingVideoUrlPolls || 0) !== Number(after.missingVideoUrlPolls || 0)
    || Boolean(before.responseSummary?.waitingForVideoUrl) !== Boolean(after.responseSummary?.waitingForVideoUrl)
    || Boolean(before.responseSummary?.videoUrlStored) !== Boolean(after.responseSummary?.videoUrlStored);
}

function taskSegmentKey(task = {}) {
  return [
    task.branchId || "default",
    String(task.branchVariantIndex || task.variantIndex || 1)
  ].join(":");
}

function isApprovedContinuityReference(reference = {}) {
  const status = String(reference.review?.status || "").toLowerCase();
  return Boolean(reference.review?.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(status));
}

async function attachContinuityReferences(context, batch, tasks, now) {
  if (Number(batch.estimate?.durationSec || 15) !== 30) return { tasks, changed: false };
  const nextTasks = [...tasks];
  let changed = false;
  for (let index = 0; index < nextTasks.length; index += 1) {
    const task = nextTasks[index];
    if (task.status !== "pending" || Number(task.segmentIndex || 1) <= 1 || task.continuityReference) continue;
    const previous = nextTasks.find((candidate) => {
      return taskSegmentKey(candidate) === taskSegmentKey(task)
        && Number(candidate.segmentIndex || 1) === Number(task.segmentIndex || 1) - 1
        && candidate.status === "downloaded"
        && Boolean(candidate.outputPath);
    });
    if (!previous) continue;
    try {
      const continuityReference = await extractContinuityFrame(context, batch, previous);
      if (!isApprovedContinuityReference(continuityReference)) {
        nextTasks[index] = {
          ...task,
          status: "failed",
          finishedAt: now,
          errorCode: "continuity_reference_failed",
          errorMessage: continuityReference.review?.reviewReason || "第一段尾帧审核未通过，无法提交第二段生成",
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
        errorMessage: error?.message || "第一段尾帧生成失败，无法提交第二段生成"
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

  const polled = await provider.getTask(task.seedanceTaskId || task.providerJobId);
  const normalized = normalizeSeedanceTaskStatus(polled.status);
  const responseSummary = summarizeSeedancePollResponse(polled);

  if (normalized === "queued" || normalized === "running") {
    return {
      ...task,
      responseSummary: {
        ...(task.responseSummary || {}),
        ...responseSummary
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
      responseSummary: {
        ...(task.responseSummary || {}),
        ...responseSummary
      }
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
            ...(task.responseSummary || {}),
            ...responseSummary,
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
          ...(task.responseSummary || {}),
          ...responseSummary,
          missingVideoUrlPolls
        }
      };
    }

    const buffer = await provider.downloadVideo(polled.videoUrl);
    const outputPath = await writeSegmentBuffer(context, batch.batchId, task.generationTaskId, buffer);

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
        ...(task.responseSummary || {}),
        ...responseSummary
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
      ...(task.responseSummary || {}),
      ...responseSummary
    }
  };
}

async function advanceThirtySecondBatch(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (Number(batch.estimate?.durationSec) !== 30) return batch;
  if (["qc", "succeeded", "partial_failed", "failed", "stopped"].includes(batch.status)) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "waiting_upstream")) return batch;
  if ((Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "stitched_video")) return batch;
  const detail = await stitchBatchSegments(context, batchId);
  return detail.batch;
}

export function shouldPollUpstreamBatch(batch = {}) {
  return batchNeedsUpstreamPoll(batch);
}

export async function pollUpstreamBatch(context, batchId) {
  let batch = await readBatch(context, batchId);
  if (["stopped", "failed", "succeeded"].includes(batch.status)) {
    return { batch, needsPoll: false, polledCount: 0, advanced: false };
  }

  const provider = createSeedanceProviderClient(context);
  const now = new Date().toISOString();
  let polledCount = 0;
  let tasksChanged = false;
  const nextTasks = [];

  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    if (!shouldPollTaskStatus(task)) {
      nextTasks.push(task);
      continue;
    }
    polledCount += 1;
    const polledTask = await pollGenerationTask(context, batch, task, provider, now);
    if (generationTaskPollChanged(task, polledTask)) {
      tasksChanged = true;
    }
    nextTasks.push(polledTask);
  }

  const durationSec = Number(batch.estimate?.durationSec || 15);
  const continuity = durationSec === 30
    ? await attachContinuityReferences(context, batch, nextTasks, now)
    : { tasks: nextTasks, changed: false };
  if (tasksChanged || continuity.changed) {
    batch = await writeBatch(context, {
      ...batch,
      status: statusAfterTaskWrite(batch, continuity.tasks),
      tasks: continuity.tasks
    }, "downloaded_output");
    await writeTaskMaps(context, batch);
  }

  let advanced = false;
  if (durationSec === 30) {
    if (tasksChanged && (Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) {
      const submitted = await submitPendingGenerationTasks(context, batchId);
      batch = submitted.batch;
      if (submitted.submittedCount > 0) advanced = true;
    }
    const beforeStatus = batch.status;
    batch = await advanceThirtySecondBatch(context, batchId);
    advanced = batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "stitched_video");
  } else {
    const beforeStatus = batch.status;
    batch = await finalizeSegmentBatch(context, batchId);
    advanced = batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "segment_video");
  }

  const needsPoll = batchNeedsUpstreamPoll(batch);
  return { batch, needsPoll, polledCount, advanced };
}
