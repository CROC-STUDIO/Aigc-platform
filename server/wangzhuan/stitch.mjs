import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { makeOutputId } from "./ids.mjs";
import { appendJsonl, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const SEGMENT_REQUIRED_TASK_STATUSES = new Set(["waiting_upstream", "downloaded", "succeeded"]);

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
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

function batchPath(context, batchId) {
  return join(batchDir(context, batchId), "batch.json");
}

function eventPath(context, batchId) {
  return join(batchDir(context, batchId), "tasks.jsonl");
}

function retryIdempotencyPath(context, batchId, idempotencyKey) {
  const safe = String(idempotencyKey || "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
  return join(wangzhuanPaths(context).idempotencyDir, `retry_stitch_${batchId}_${safe}.json`);
}

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

function safeErrorMessage(error) {
  const raw = error?.message || "拼接失败";
  return raw.replace(/[A-Za-z]:[\\/][^\s]+/g, "[path]").replace(/\/[^\s]+/g, "[path]");
}

async function readBatch(context, batchId) {
  const target = batchPath(context, batchId);
  if (!existsSync(target)) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
  const batch = JSON.parse(await readFile(target, "utf8"));
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatch(context, batch) {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.batchesDir, next.batchId, "batch.json"), next);
  const indexPath = join(paths.batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.items = Array.isArray(index.items) ? index.items : [];
    const item = index.items.find((entry) => entry.batchId === next.batchId);
    if (item) {
      item.status = next.status;
      item.updatedAt = now;
    }
    await writeAtomicJson(indexPath, index);
  }
  return next;
}

async function appendEvent(context, batchId, event) {
  await appendJsonl(eventPath(context, batchId), {
    createdAt: new Date().toISOString(),
    batchId,
    ...event
  });
}

async function writeText(target, text) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function writeTaskMaps(context, batch) {
  const dir = join(batchDir(context, batch.batchId), "task-map");
  const jsonPath = join(dir, "task-id-map.json");
  const csvPath = join(dir, "task-id-map.csv");
  await writeAtomicJson(jsonPath, batch.tasks);
  const outputsByTask = new Map();
  for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
    for (const taskId of output.generationTaskIds || []) {
      if (!outputsByTask.has(taskId)) outputsByTask.set(taskId, output);
    }
  }
  const header = [
    "source_type",
    "batch_id",
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
  const rows = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    const output = outputsByTask.get(task.generationTaskId);
    return [
      "pipeline",
      batch.batchId,
      task.scriptId,
      task.generationTaskId,
      task.imageTaskId || "",
      task.seedanceTaskId || "",
      task.modelImage,
      task.modelVideo,
      output?.outputId || "",
      output?.filePath || task.outputPath || "",
      output?.qcStatus || "",
      task.errorCode || ""
    ];
  });
  const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  await writeText(csvPath, `${csv}\n`);
}

export function preflightStitcher(context = {}) {
  const stitcher = context.capabilities?.stitcher ?? context.config?.wangzhuan?.capabilities?.stitcher;
  const checkedAt = new Date().toISOString();
  if (stitcher?.status === "available" || stitcher?.available === true) {
    return {
      provider: stitcher.provider || "configured",
      version: stitcher.version || "",
      status: stitcher.degraded ? "degraded" : "supported",
      checkedAt
    };
  }
  return {
    provider: "unknown",
    version: "",
    status: "unsupported",
    checkedAt
  };
}

function groupTasksByVariant(batch) {
  const scriptsById = new Map((Array.isArray(batch.scripts) ? batch.scripts : []).map((script) => [script.scriptId, script]));
  const groups = new Map();
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const script = scriptsById.get(task.scriptId);
    if (!script) continue;
    if (!groups.has(script.variantIndex)) groups.set(script.variantIndex, []);
    groups.get(script.variantIndex).push({ task, script });
  }
  return [...groups.entries()].map(([variantIndex, entries]) => ({
    variantIndex,
    entries: entries.sort((left, right) => left.script.segmentIndex - right.script.segmentIndex)
  })).sort((left, right) => left.variantIndex - right.variantIndex);
}

function segmentOutputPath(context, batchId, outputId) {
  return join(batchDir(context, batchId), "segments", `${outputId}.mp4`);
}

function stitchedOutputPath(context, batchId, outputId) {
  return join(batchDir(context, batchId), "stitched", `${outputId}_30s.mp4`);
}

function stitchReportPath(context, batchId, outputId) {
  return join(batchDir(context, batchId), "stitch", `${outputId}_stitch-report.json`);
}

function outputPreviewUrl(filePath) {
  return `/file?path=${encodeURIComponent(filePath)}`;
}

function outputSequence(outputId) {
  const match = String(outputId || "").match(/^out_[a-f0-9]{4}_(\d{3})$/);
  return match ? Number(match[1]) : 0;
}

function nextOutputSequence(batch) {
  const outputSequences = (Array.isArray(batch.outputs) ? batch.outputs : []).map((output) => outputSequence(output.outputId));
  const reportSequences = (Array.isArray(batch.stitchReports) ? batch.stitchReports : []).map((report) => outputSequence(report.outputId));
  return Math.max(0, ...outputSequences, ...reportSequences) + 1;
}

function takeOutputId(batch, sequenceState) {
  const outputId = makeOutputId(batch.batchId, sequenceState.next);
  sequenceState.next += 1;
  return outputId;
}

async function materializeSegmentOutputs(context, batch, groups, sequenceState) {
  const existing = Array.isArray(batch.outputs) ? batch.outputs.filter((output) => output.kind === "segment_video") : [];
  const existingByTask = new Map();
  for (const output of existing) {
    for (const taskId of output.generationTaskIds || []) existingByTask.set(taskId, output);
  }
  const outputs = [...existing];
  for (const group of groups) {
    for (const entry of group.entries) {
      if (existingByTask.has(entry.task.generationTaskId)) continue;
      const outputId = takeOutputId(batch, sequenceState);
      const target = segmentOutputPath(context, batch.batchId, outputId);
      const filePath = userRelative(context, target);
      await writeText(target, [
        "mock segment video",
        `batch=${batch.batchId}`,
        `variant=${entry.script.variantIndex}`,
        `segment=${entry.script.segmentIndex}`,
        `task=${entry.task.generationTaskId}`
      ].join("\n"));
      outputs.push({
        outputId,
        sourceType: "pipeline",
        batchId: batch.batchId,
        scriptId: entry.script.scriptId,
        generationTaskIds: [entry.task.generationTaskId],
        durationSec: 15,
        kind: "segment_video",
        filePath,
        previewUrl: outputPreviewUrl(filePath),
        qcStatus: "not_started",
        downloadEligible: false,
        visualPreviewRequired: false,
        previewConfirmed: false
      });
    }
  }
  return outputs;
}

function hasTwoSubmittedSegments(group) {
  return group.entries.length === 2 && group.entries.every(({ task }) => {
    return task.seedanceTaskId && SEGMENT_REQUIRED_TASK_STATUSES.has(task.status);
  });
}

function buildReport({ outputId, segmentOutputIds, preflight, status, errorCode = "", errorMessage = "" }) {
  return {
    schemaVersion: "stitch_report.v1",
    outputId,
    status,
    segmentOutputIds,
    tool: {
      provider: preflight.provider,
      version: preflight.version,
      preflightStatus: preflight.status
    },
    errorCode,
    errorMessage,
    createdAt: new Date().toISOString()
  };
}

async function readEvents(context, batchId) {
  try {
    const text = await readFile(eventPath(context, batchId), "utf8");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeReport(context, batchId, report) {
  const target = stitchReportPath(context, batchId, report.outputId);
  await writeAtomicJson(target, report);
  return userRelative(context, target);
}

async function createFailedReport(context, batch, group, segmentOutputs, preflight, error, sequenceState) {
  const outputId = takeOutputId(batch, sequenceState);
  const report = buildReport({
    outputId,
    segmentOutputIds: segmentOutputs.map((output) => output.outputId),
    preflight,
    status: "failed",
    errorCode: "stitch_failed",
    errorMessage: safeErrorMessage(error)
  });
  const reportPath = await writeReport(context, batch.batchId, report);
  return {
    ...report,
    reportPath,
    variantIndex: group.variantIndex
  };
}

async function createSucceededStitchOutput(context, batch, group, segmentOutputs, preflight, sequenceState) {
  const outputId = takeOutputId(batch, sequenceState);
  const target = stitchedOutputPath(context, batch.batchId, outputId);
  const filePath = userRelative(context, target);
  await writeText(target, [
    "mock stitched video",
    `batch=${batch.batchId}`,
    `variant=${group.variantIndex}`,
    `segments=${segmentOutputs.map((output) => output.outputId).join(",")}`
  ].join("\n"));
  const report = buildReport({
    outputId,
    segmentOutputIds: segmentOutputs.map((output) => output.outputId),
    preflight,
    status: "succeeded"
  });
  const reportPath = await writeReport(context, batch.batchId, report);
  return {
    output: {
      outputId,
      sourceType: "pipeline",
      batchId: batch.batchId,
      generationTaskIds: group.entries.map((entry) => entry.task.generationTaskId),
      durationSec: 30,
      kind: "stitched_video",
      filePath,
      previewUrl: outputPreviewUrl(filePath),
      qcStatus: "not_started",
      downloadEligible: false,
      visualPreviewRequired: false,
      previewConfirmed: false,
      stitchReportPath: reportPath
    },
    report: {
      ...report,
      reportPath,
      variantIndex: group.variantIndex
    }
  };
}

export async function stitchBatchSegments(context, batchId, options = {}) {
  const preflight = preflightStitcher(context);
  if (preflight.status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "30s 拼接能力不可用", { batchId });
  }

  const batch = await readBatch(context, batchId);
  if (batch.estimate?.durationSec !== 30) {
    throw new WangzhuanError("no_segments", "没有可用于拼接的分段视频", { batchId, durationSec: batch.estimate?.durationSec });
  }
  const groups = groupTasksByVariant(batch);
  if (!groups.length || groups.some((group) => !hasTwoSubmittedSegments(group))) {
    throw new WangzhuanError("no_segments", "没有可用于拼接的分段视频", { batchId });
  }

  const withStitchingStatus = await writeBatch(context, { ...batch, status: "stitching" });
  await appendEvent(context, batchId, { event: "stitch_started", provider: preflight.provider });
  const sequenceState = { next: nextOutputSequence(withStitchingStatus) };
  const segmentOutputs = await materializeSegmentOutputs(context, withStitchingStatus, groups, sequenceState);
  const segmentByTask = new Map();
  for (const output of segmentOutputs) {
    for (const taskId of output.generationTaskIds || []) segmentByTask.set(taskId, output);
  }

  const existingNonSegmentOutputs = (Array.isArray(batch.outputs) ? batch.outputs : []).filter((output) => output.kind !== "segment_video");
  const nextOutputs = [...segmentOutputs, ...existingNonSegmentOutputs.filter((output) => output.kind !== "stitched_video")];
  const stitchReports = Array.isArray(batch.stitchReports) ? [...batch.stitchReports] : [];
  let currentSucceededCount = 0;
  let currentFailedCount = 0;

  for (const group of groups) {
    const groupSegments = group.entries.map((entry) => segmentByTask.get(entry.task.generationTaskId)).filter(Boolean);
    if (options.forceFail) {
      const report = await createFailedReport(
        context,
        { ...withStitchingStatus, outputs: nextOutputs },
        group,
        groupSegments,
        preflight,
        new Error("mock stitch failure"),
        sequenceState
      );
      stitchReports.push(report);
      currentFailedCount += 1;
      continue;
    }
    const stitched = await createSucceededStitchOutput(
      context,
      { ...withStitchingStatus, outputs: nextOutputs },
      group,
      groupSegments,
      preflight,
      sequenceState
    );
    nextOutputs.push(stitched.output);
    stitchReports.push(stitched.report);
    currentSucceededCount += 1;
  }

  const hasStitched = currentSucceededCount > 0;
  const nextStatus = hasStitched && currentFailedCount === 0 ? "qc" : "partial_failed";
  const tasks = withStitchingStatus.tasks.map((task) => {
    const segmentOutput = segmentByTask.get(task.generationTaskId);
    if (!segmentOutput) return task;
    return {
      ...task,
      status: nextStatus === "qc" ? "qc" : "downloaded",
      outputPath: segmentOutput.filePath
    };
  });
  const saved = await writeBatch(context, {
    ...withStitchingStatus,
    status: nextStatus,
    tasks,
    outputs: nextOutputs,
    stitchReports
  });
  await writeTaskMaps(context, saved);
  await appendEvent(context, batchId, {
    event: nextStatus === "qc" ? "stitch_succeeded" : "stitch_failed",
    stitchedCount: nextOutputs.filter((output) => output.kind === "stitched_video").length,
    failedCount: currentFailedCount
  });
  for (const report of stitchReports.slice(-groups.length)) {
    await recordTelemetryEvent(context, "stitch_completed", {
      batchId,
      outputId: report.outputId,
      status: report.status,
      errorCode: report.errorCode || ""
    });
  }
  return {
    batch: saved,
    events: await readEvents(context, batchId),
    downloadSummary: {
      outputsTotal: saved.outputs.length,
      downloadEligibleCount: saved.outputs.filter((item) => item.downloadEligible).length,
      packageReady: saved.outputs.some((item) => item.downloadEligible),
      missingFiles: []
    }
  };
}

export async function retryStitch(context, batchId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  validateBatchId(batchId);
  const replayPath = retryIdempotencyPath(context, batchId, request.idempotencyKey);
  if (existsSync(replayPath)) {
    return JSON.parse(await readFile(replayPath, "utf8")).result;
  }
  const batch = await readBatch(context, batchId);
  if (batch.status !== "partial_failed") {
    throw new WangzhuanError("invalid_state_transition", "当前状态不支持拼接重试", { batchId, status: batch.status });
  }
  const result = await stitchBatchSegments(context, batchId);
  await writeAtomicJson(replayPath, {
    endpoint: "retry-stitch",
    batchId,
    result,
    createdAt: new Date().toISOString()
  });
  return result;
}
