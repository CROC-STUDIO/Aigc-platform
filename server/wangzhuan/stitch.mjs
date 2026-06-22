import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { WangzhuanError } from "./http.mjs";
import { makeOutputId } from "./ids.mjs";
import {
  hasWangzhuanFactsStore,
  loadBatchDetailFromMysql,
  loadIdempotencyFactFromMysql,
  recordIdempotencyFact,
  syncBatchFacts
} from "./mysql-facts.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const SEGMENT_REQUIRED_TASK_STATUSES = new Set(["waiting_upstream", "downloaded", "succeeded"]);
const execFileAsync = promisify(execFile);
const DEFAULT_STITCH_TIMEOUT_MS = 120000;

function ffmpegAvailableSync() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function toConcatListPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

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

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

function safeErrorMessage(error) {
  const raw = error?.message || "拼接失败";
  return raw.replace(/[A-Za-z]:[\\/][^\s]+/g, "[path]").replace(/\/[^\s]+/g, "[path]");
}

async function readBatch(context, batchId) {
  validateBatchId(batchId);
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取业务状态");
  }
  const detail = await loadBatchDetailFromMysql(context, batchId);
  const batch = detail?.batch;
  if (!batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatch(context, batch, triggerName = "stitch_progress") {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const synced = await syncBatchFacts(context, next, triggerName);
  if (synced?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存业务状态");
  }
  return next;
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
  if (stitcher?.status === "unavailable" || stitcher?.available === false) {
    return {
      provider: stitcher?.provider || "unknown",
      version: stitcher?.version || "",
      status: "unsupported",
      checkedAt
    };
  }
  if (stitcher?.status === "available" || stitcher?.available === true) {
    return {
      provider: stitcher.provider || "ffmpeg",
      version: stitcher.version || "",
      status: stitcher.degraded ? "degraded" : "supported",
      checkedAt
    };
  }
  if (ffmpegAvailableSync()) {
    return {
      provider: "ffmpeg",
      version: "",
      status: "supported",
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
    const key = `${script.branchId || "default"}:${script.branchVariantIndex || script.variantIndex || 1}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        branchId: script.branchId || "",
        branchLabel: script.branchLabel || "",
        branchVariantIndex: Number(script.branchVariantIndex || script.variantIndex || 1),
        variantIndex: Number(script.variantIndex || 1),
        entries: []
      });
    }
    groups.get(key).entries.push({ task, script });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: group.entries.sort((left, right) => left.script.segmentIndex - right.script.segmentIndex)
    }))
    .sort((left, right) => {
      const branchSort = String(left.branchId).localeCompare(String(right.branchId));
      return branchSort || left.branchVariantIndex - right.branchVariantIndex;
    });
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
      const taskSource = entry.task.outputPath
        ? join(context.userProjectRoot, entry.task.outputPath)
        : "";
      if (taskSource && existsSync(taskSource)) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(taskSource, target);
      } else {
        throw new WangzhuanError("missing_required_file", "分段视频文件缺失，无法生成分段产出", {
          batchId: batch.batchId,
          generationTaskId: entry.task.generationTaskId,
          outputPath: filePath
        });
      }
      const storage = await syncWangzhuanAsset(context, target, "pipeline_segment_video", { required: true });
      outputs.push({
        outputId,
        sourceType: "pipeline",
        batchId: batch.batchId,
        scriptId: entry.script.scriptId,
        branchId: entry.script.branchId || "",
        branchLabel: entry.script.branchLabel || "",
        branchVariantIndex: entry.script.branchVariantIndex || entry.script.variantIndex,
        generationTaskIds: [entry.task.generationTaskId],
        durationSec: 15,
        kind: "segment_video",
        filePath,
        previewUrl: storage.storageUrl,
        storageKey: storage.storageKey,
        storageUrl: storage.storageUrl,
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
    variantIndex: group.variantIndex,
    branchId: group.branchId || "",
    branchLabel: group.branchLabel || "",
    branchVariantIndex: group.branchVariantIndex
  };
}

async function concatSegmentVideos(outputPath, segmentPaths, { timeoutMs = DEFAULT_STITCH_TIMEOUT_MS } = {}) {
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("stitcher_unavailable", "ffmpeg 不可用，无法拼接 30s 视频");
  }
  for (const segmentPath of segmentPaths) {
    if (!existsSync(segmentPath)) {
      throw new WangzhuanError("missing_required_file", "拼接所需的分段视频不存在", { segmentPath });
    }
  }
  const listDir = await mkdtemp(join(tmpdir(), "wz-stitch-list-"));
  try {
    const listPath = join(listDir, "concat.txt");
    const listBody = segmentPaths.map((segmentPath) => `file '${toConcatListPath(segmentPath)}'`).join("\n");
    await writeFile(listPath, listBody, "utf8");
    await mkdir(dirname(outputPath), { recursive: true });
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outputPath
    ], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
  } finally {
    await rm(listDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createSucceededStitchOutput(context, batch, group, segmentOutputs, preflight, sequenceState) {
  const outputId = takeOutputId(batch, sequenceState);
  const target = stitchedOutputPath(context, batch.batchId, outputId);
  const filePath = userRelative(context, target);
  const segmentPaths = segmentOutputs.map((output) => join(context.userProjectRoot, output.filePath));
  try {
    await concatSegmentVideos(target, segmentPaths);
  } catch (error) {
    throw error instanceof WangzhuanError ? error : new WangzhuanError("stitch_failed", safeErrorMessage(error), {
      batchId: batch.batchId,
      segmentOutputIds: segmentOutputs.map((output) => output.outputId)
    });
  }
  const storage = await syncWangzhuanAsset(context, target, "pipeline_stitched_video", { required: true });
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
      branchId: group.branchId || "",
      branchLabel: group.branchLabel || "",
      branchVariantIndex: group.branchVariantIndex,
      generationTaskIds: group.entries.map((entry) => entry.task.generationTaskId),
      durationSec: 30,
      kind: "stitched_video",
      filePath,
      previewUrl: storage.storageUrl,
      storageKey: storage.storageKey,
      storageUrl: storage.storageUrl,
      qcStatus: "not_started",
      downloadEligible: false,
      visualPreviewRequired: false,
      previewConfirmed: false,
      stitchReportPath: reportPath
    },
    report: {
      ...report,
      reportPath,
      variantIndex: group.variantIndex,
      branchId: group.branchId || "",
      branchLabel: group.branchLabel || "",
      branchVariantIndex: group.branchVariantIndex
    }
  };
}

export async function materializeBatchSegmentOutputs(context, batchId) {
  const batch = await readBatch(context, batchId);
  const groups = groupTasksByVariant(batch);
  if (!groups.length) {
    throw new WangzhuanError("no_segments", "没有可用于产出的分段视频", { batchId });
  }
  const sequenceState = { next: nextOutputSequence(batch) };
  const segmentOutputs = await materializeSegmentOutputs(context, batch, groups, sequenceState);
  const existingNonSegmentOutputs = (Array.isArray(batch.outputs) ? batch.outputs : []).filter((output) => output.kind !== "segment_video");
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    const segment = segmentOutputs.find((output) => (output.generationTaskIds || []).includes(task.generationTaskId));
    if (!segment) return task;
    return {
      ...task,
      status: task.status === "waiting_upstream" ? "downloaded" : task.status,
      outputPath: task.outputPath || segment.filePath
    };
  });
  const saved = await writeBatch(context, {
    ...batch,
    tasks,
    outputs: [...segmentOutputs, ...existingNonSegmentOutputs]
  }, "segments_completed");
  await writeTaskMaps(context, saved);
  return saved;
}

export async function finalizeFifteenSecondBatch(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (Number(batch.estimate?.durationSec) !== 15) return batch;
  if (["qc", "succeeded", "partial_failed", "failed", "stopped"].includes(batch.status)) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "waiting_upstream")) return batch;

  let working = batch;
  const hasSegments = (Array.isArray(working.outputs) ? working.outputs : []).some((output) => output.kind === "segment_video");
  if (!hasSegments) {
    working = await materializeBatchSegmentOutputs(context, batchId);
  }
  if (working.status === "running" || working.status === "queued") {
    working = await writeBatch(context, { ...working, status: "qc" }, "generation_completed");
  }
  return working;
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
        new Error("stitch forced failure"),
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
  }, nextStatus === "qc" ? "stitch_completed" : "stitch_progress");
  await writeTaskMaps(context, saved);
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
    events: (await loadBatchDetailFromMysql(context, batchId))?.events || [],
    downloadSummary: {
      outputsTotal: saved.outputs.length,
      downloadEligibleCount: saved.outputs.filter((item) => item.downloadEligible).length,
      packageReady: saved.outputs.some((item) => item.downloadEligible),
      missingFiles: []
    }
  };
}

function hashPayload(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {}), "utf8").digest("hex");
}

export async function retryStitch(context, batchId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  validateBatchId(batchId);
  const requestHash = hashPayload({ batchId, forceFail: request.forceFail === true });
  const replay = await loadIdempotencyFactFromMysql(context, "retry_stitch", request.idempotencyKey, requestHash);
  if (replay) return replay;
  const batch = await readBatch(context, batchId);
  if (batch.status !== "partial_failed") {
    throw new WangzhuanError("invalid_state_transition", "当前状态不支持拼接重试", { batchId, status: batch.status });
  }
  const result = await stitchBatchSegments(context, batchId);
  await recordIdempotencyFact(context, "retry_stitch", request.idempotencyKey, requestHash, {
    type: "batch",
    id: batchId,
    response: result
  });
  return result;
}
