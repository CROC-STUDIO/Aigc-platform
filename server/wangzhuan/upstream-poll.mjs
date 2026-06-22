import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  appendEvent,
  readBatch,
  writeBatch,
  writeTaskMaps
} from "./pipeline.mjs";
import {
  createSeedanceProviderClient,
  normalizeSeedanceTaskStatus,
  summarizeSeedancePollResponse
} from "./seedance-provider.mjs";
import { finalizeFifteenSecondBatch, stitchBatchSegments } from "./stitch.mjs";
import { toProjectRelative, wangzhuanPaths } from "./storage.mjs";

const ACTIVE_POLL_BATCH_STATUSES = new Set(["running", "stitching"]);

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

function taskSegmentPath(context, batchId, generationTaskId) {
  return join(wangzhuanPaths(context).batchesDir, batchId, "segments", `${generationTaskId}.mp4`);
}

function isMockGenerationTask(task = {}) {
  if (task.provider === "mock") return true;
  const seedanceTaskId = String(task.seedanceTaskId || "");
  return seedanceTaskId.startsWith("mock_");
}

function batchNeedsUpstreamPoll(batch = {}) {
  if (["stopped", "failed", "succeeded", "qc", "partial_failed"].includes(batch.status)) return false;
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  if (tasks.some((task) => task.status === "waiting_upstream")) return true;
  if (tasks.some((task) => task.status === "pending") && ACTIVE_POLL_BATCH_STATUSES.has(batch.status)) return true;
  if (!ACTIVE_POLL_BATCH_STATUSES.has(batch.status)) return false;
  const durationSec = Number(batch.estimate?.durationSec || 15);
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  if (durationSec === 15) {
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

async function pollGenerationTask(context, batch, task, provider, now) {
  if (isMockGenerationTask(task)) {
    const outputPath = await writeSegmentBuffer(
      context,
      batch.batchId,
      task.generationTaskId,
      Buffer.from([
        "mock segment video",
        `batch=${batch.batchId}`,
        `task=${task.generationTaskId}`,
        `seedance=${task.seedanceTaskId || ""}`
      ].join("\n"))
    );
    return {
      ...task,
      status: "downloaded",
      outputPath,
      remoteUrlStored: false,
      finishedAt: now,
      responseSummary: {
        ...(task.responseSummary || {}),
        status: "succeeded",
        upstreamStatus: "succeeded",
        mock: true
      }
    };
  }

  if (!provider?.getTask) {
    throw new Error("Seedance provider 未配置 poll 能力");
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

  let outputPath = task.outputPath || "";
  if (polled.videoUrl && provider.downloadVideo) {
    const buffer = await provider.downloadVideo(polled.videoUrl);
    outputPath = await writeSegmentBuffer(context, batch.batchId, task.generationTaskId, buffer);
  } else if (!outputPath) {
    outputPath = await writeSegmentBuffer(
      context,
      batch.batchId,
      task.generationTaskId,
      Buffer.from(`seedance placeholder\nbatch=${batch.batchId}\ntask=${task.generationTaskId}\n`)
    );
  }

  return {
    ...task,
    status: "downloaded",
    outputPath,
    remoteUrlStored: Boolean(polled.videoUrl),
    finishedAt: now,
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
    if (task.status !== "waiting_upstream") {
      nextTasks.push(task);
      continue;
    }
    polledCount += 1;
    const polledTask = await pollGenerationTask(context, batch, task, provider, now);
    if (polledTask.status !== task.status || polledTask.outputPath !== task.outputPath) {
      tasksChanged = true;
    }
    nextTasks.push(polledTask);
  }

  if (tasksChanged) {
    batch = await writeBatch(context, { ...batch, tasks: nextTasks });
    await writeTaskMaps(context, batch);
    await appendEvent(context, batchId, { event: "upstream_polled", polledCount });
  }

  const durationSec = Number(batch.estimate?.durationSec || 15);
  let advanced = false;
  if (durationSec === 30) {
    const beforeStatus = batch.status;
    batch = await advanceThirtySecondBatch(context, batchId);
    advanced = batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "stitched_video");
  } else {
    const beforeStatus = batch.status;
    batch = await finalizeFifteenSecondBatch(context, batchId);
    advanced = batch.status !== beforeStatus || (Array.isArray(batch.outputs) ? batch.outputs : []).some((output) => output.kind === "segment_video");
  }

  const needsPoll = batchNeedsUpstreamPoll(batch);
  return { batch, needsPoll, polledCount, advanced };
}
