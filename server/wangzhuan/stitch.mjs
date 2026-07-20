import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { makeOutputId } from "./ids.mjs";
import { buildOutputDisplayName } from "./output-naming.mjs";
import {
  hasWangzhuanFactsStore,
  loadBatchDetailFromMysql,
  loadOutputDetailFromMysql,
  runIdempotentOperation,
  syncBatchFacts
} from "./mysql-facts.mjs";
import {
  removeWangzhuanAssetFromObjectStorage,
  syncWangzhuanAsset,
  toProjectRelative,
  wangzhuanPaths,
  writeAtomicJson
} from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import { resolveBatchPostProcess } from "./postprocess.mjs";
import { classifyStitchSelection } from "./segment-recovery.mjs";
import { buildExpandedOutputName, expansionTimeoutMs, renderExpandedVideo } from "./output-expansion.mjs";
import { writeVolcengineSubtitleArtifacts } from "./subtitles.mjs";
import { resolveVolcengineAsrConfig, transcribeVolcengineAudio } from "./volcengine-asr.mjs";

const STITCH_READY_TASK_STATUSES = new Set(["downloaded", "succeeded", "qc"]);
const FAILED_TASK_STATUSES = new Set(["failed", "skipped", "stopped"]);
const execFileAsync = promisify(execFile);
const DEFAULT_STITCH_TIMEOUT_MS = 120000;
const DEFAULT_OVERLAY_TIMEOUT_MS = 300000;
const POST_PROCESS_MIN_TIMEOUT_MS = 300000;
const POST_PROCESS_TIMEOUT_PER_SECOND_MS = 10000;
const STITCH_IN_FLIGHT = new Map();
const DISCLAIMER_TEMPLATE_IMAGES = Object.freeze({
  en: "public/assets/wangzhuan/disclaimers/en.png",
  pt: "public/assets/wangzhuan/disclaimers/pt.png",
  zh: "public/assets/wangzhuan/disclaimers/zh.png",
  ar: "public/assets/wangzhuan/disclaimers/ar.png",
  es: "public/assets/wangzhuan/disclaimers/es.png",
  fr: "public/assets/wangzhuan/disclaimers/fr.png",
  de: "public/assets/wangzhuan/disclaimers/de.png",
  id: "public/assets/wangzhuan/disclaimers/id.png",
  th: "public/assets/wangzhuan/disclaimers/th.png",
  vi: "public/assets/wangzhuan/disclaimers/vi.png"
});

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

function telemetryRecorder(context) {
  return typeof context.recordTelemetryEvent === "function"
    ? context.recordTelemetryEvent
    : (eventName, payload, options) => recordTelemetryEvent(context, eventName, payload, options);
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

function postProcessTimeoutMs(durationSec) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_OVERLAY_TIMEOUT_MS;
  return Math.max(POST_PROCESS_MIN_TIMEOUT_MS, Math.ceil(duration * POST_PROCESS_TIMEOUT_PER_SECOND_MS));
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

async function probeVideoWidth(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width",
      "-of", "csv=p=0",
      filePath
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const width = Number(String(stdout || "").trim().split(/\s+/)[0]);
    return Number.isFinite(width) && width > 0 ? Math.trunc(width) : 720;
  } catch {
    return 720;
  }
}

async function probeVideoDuration(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const duration = Number(String(stdout || "").trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

async function probeHasAudio(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      filePath
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return Boolean(String(stdout || "").trim());
  } catch {
    return false;
  }
}

export async function probeVideoStreamHealth(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,pix_fmt,width,height",
      "-show_entries", "format=duration,size",
      "-of", "json",
      filePath
    ], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    const parsed = JSON.parse(String(stdout || "{}"));
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
    const format = parsed.format || {};
    return {
      codecName: cleanString(stream.codec_name),
      profile: cleanString(stream.profile),
      pixFmt: cleanString(stream.pix_fmt),
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
      durationSec: Number(format.duration || 0),
      size: Number(format.size || 0)
    };
  } catch {
    return {
      codecName: "",
      profile: "",
      pixFmt: "",
      width: 0,
      height: 0,
      durationSec: 0,
      size: 0
    };
  }
}

function isCorruptDecodeLog(text = "") {
  return /Invalid NAL|Error splitting the input|Decoding error|Could not find codec parameters|not enough frames to estimate rate|Invalid data found when processing input/i
    .test(String(text || ""));
}

export async function assertDecodableVideo(filePath, { timeoutMs = DEFAULT_STITCH_TIMEOUT_MS } = {}) {
  if (!existsSync(filePath)) {
    throw new WangzhuanError("stitch_failed", "拼接输出文件不存在", { filePath });
  }
  const health = await probeVideoStreamHealth(filePath);
  if (!health.codecName || !health.profile || health.profile === "unknown" || !health.pixFmt || health.pixFmt === "unknown") {
    throw new WangzhuanError("stitch_failed", "拼接输出视频流元数据异常，疑似损坏", {
      codecName: health.codecName,
      profile: health.profile,
      pixFmt: health.pixFmt
    });
  }
  if (!(health.width > 0) || !(health.height > 0) || !(health.durationSec > 0) || !(health.size > 1024)) {
    throw new WangzhuanError("stitch_failed", "拼接输出视频时长或尺寸异常", {
      width: health.width,
      height: health.height,
      durationSec: health.durationSec,
      size: health.size
    });
  }
  let stderr = "";
  try {
    const result = await execFileAsync("ffmpeg", [
      "-nostdin",
      "-v", "error",
      "-i", filePath,
      "-f", "null",
      "-"
    ], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    stderr = String(result?.stderr || "");
  } catch (error) {
    stderr = `${error?.stderr || ""}\n${error?.message || ""}`;
    if (!isCorruptDecodeLog(stderr)) {
      throw new WangzhuanError("stitch_failed", "拼接输出解码校验失败", {
        detail: safeErrorMessage(error)
      });
    }
  }
  if (isCorruptDecodeLog(stderr)) {
    throw new WangzhuanError("stitch_failed", "拼接输出存在不可解码帧，已拒绝上传", {
      profile: health.profile,
      pixFmt: health.pixFmt,
      durationSec: health.durationSec
    });
  }
  return health;
}

async function replaceFileAtomically(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await rm(targetPath, { force: true });
    await rename(sourcePath, targetPath);
  }
}

function resolveTemplatePreset(language = "", preset = "auto") {
  const selected = cleanString(preset);
  if (selected && selected !== "auto" && DISCLAIMER_TEMPLATE_IMAGES[selected]) return selected;
  const normalized = cleanString(language).toLowerCase();
  if (normalized.startsWith("pt")) return "pt";
  if (normalized.startsWith("zh") || normalized.includes("chinese")) return "zh";
  if (normalized.startsWith("ar")) return "ar";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("id")) return "id";
  if (normalized.startsWith("th")) return "th";
  if (normalized.startsWith("vi")) return "vi";
  return "en";
}

function resolveRepoPath(relativePath) {
  return resolve(process.cwd(), relativePath);
}

function resolveUserAssetPath(context, storedPath = "") {
  const relativePath = cleanString(storedPath).replace(/^[\\/]+/, "");
  if (!relativePath) return "";
  const fullPath = resolve(context.userProjectRoot, relativePath);
  if (!fullPath.startsWith(resolve(context.userProjectRoot))) return "";
  return fullPath;
}

function resolveDisclaimerOverlayImagePath(context, overlay) {
  const customPath = resolveUserAssetPath(context, overlay.imageStoredPath || overlay.storedPath);
  if (customPath && existsSync(customPath)) return customPath;
  const preset = resolveTemplatePreset(overlay.language, overlay.preset || overlay.templateId);
  const templatePath = resolveRepoPath(DISCLAIMER_TEMPLATE_IMAGES[preset] || DISCLAIMER_TEMPLATE_IMAGES.en);
  return existsSync(templatePath) ? templatePath : "";
}

function resolveDisclaimerOverlay(batch, branchDraft = null) {
  const request = batch?.request || batch?.estimate?.request || {};
  const draft = batch?.templateSnapshot?.draft || {};
  const branchEnabled = branchDraft?.disclaimerEnabled ?? branchDraft?.disclaimerOverlay?.enabled;
  const requestEnabled = request.disclaimerEnabled ?? request.disclaimerOverlay?.enabled;
  const draftEnabled = draft.disclaimerEnabled ?? draft.disclaimerOverlay?.enabled;
  if (branchEnabled === false || requestEnabled === false || draftEnabled === false) {
    return { applied: false, text: "" };
  }
  const branchOverlay = branchDraft?.disclaimerOverlay || {};
  const requestOverlay = request.disclaimerOverlay || {};
  const draftOverlay = draft.disclaimerOverlay || {};
  const imageStoredPath = firstNonEmptyString(branchOverlay.imageStoredPath, requestOverlay.imageStoredPath, draftOverlay.imageStoredPath);
  return {
    applied: true,
    imageStoredPath,
    imageStorageKey: firstNonEmptyString(branchOverlay.imageStorageKey, requestOverlay.imageStorageKey, draftOverlay.imageStorageKey),
    imageFileName: firstNonEmptyString(branchOverlay.imageFileName, requestOverlay.imageFileName, draftOverlay.imageFileName),
    preset: firstNonEmptyString(branchDraft?.disclaimerPreset, request.disclaimerPreset, draft.disclaimerPreset),
    language: firstNonEmptyString(branchDraft?.disclaimerLanguage, request.disclaimerLanguage, draft.disclaimerLanguage),
    templateId: firstNonEmptyString(branchOverlay.templateId, requestOverlay.templateId, draftOverlay.templateId),
    position: firstNonEmptyString(branchOverlay.position, requestOverlay.position, draftOverlay.position) || "bottom_center",
    boxHeight: Number(branchOverlay.boxHeight || requestOverlay.boxHeight || draftOverlay.boxHeight || 88),
    bottomMargin: Number(branchOverlay.bottomMargin || requestOverlay.bottomMargin || draftOverlay.bottomMargin || 3),
    horizontalMargin: Number(branchOverlay.horizontalMargin || requestOverlay.horizontalMargin || draftOverlay.horizontalMargin || 50)
  };
}

async function applyDisclaimerOverlay(context, sourcePath, targetPath, overlay, { timeoutMs = DEFAULT_OVERLAY_TIMEOUT_MS } = {}) {
  if (!overlay?.applied) {
    return { applied: false, targetPath: sourcePath };
  }
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("stitcher_unavailable", "ffmpeg 不可用，无法写入免责声明贴片");
  }
  if (!existsSync(sourcePath)) {
    throw new WangzhuanError("missing_required_file", "免责声明贴片所需的视频文件不存在", { sourcePath });
  }
  const imagePath = resolveDisclaimerOverlayImagePath(context, overlay);
  if (!imagePath) {
    throw new WangzhuanError("missing_required_file", "免责声明贴片 PNG 不存在，请选择模板或上传 PNG", {
      imageStoredPath: overlay.imageStoredPath || ""
    });
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const boxHeight = Math.max(24, Number(overlay.boxHeight || 88));
  const bottomMargin = Math.max(0, Number(overlay.bottomMargin || 3));
  const horizontalMargin = Math.max(0, Number(overlay.horizontalMargin || 50));
  const canvasWidth = await probeVideoWidth(sourcePath);
  const sourceDurationSec = await probeVideoDuration(sourcePath);
  const overlayWidth = Math.max(1, canvasWidth - horizontalMargin * 2);
  const xExpr = overlay.position === "bottom_left" ? String(horizontalMargin) : "(W-w)/2";
  const workDir = await mkdtemp(join(dirname(targetPath), ".wz-overlay-"));
  const tempPath = join(workDir, "overlay.mp4");
  const args = [
    "-y",
    "-i", sourcePath,
    "-loop", "1",
    "-framerate", "30",
    "-i", imagePath,
    "-filter_complex", `[1:v]scale=${overlayWidth}:${boxHeight}:force_original_aspect_ratio=decrease[ov];[0:v][ov]overlay=x=${xExpr}:y=H-h-${bottomMargin}:format=auto:shortest=1[vout]`,
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    // Re-encode audio with the video pass. Copying AAC across filter/remux boundaries
    // has produced undecodable H264/AAC payloads on older ffmpeg (Lavc59) builds.
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    "-shortest",
    ...(sourceDurationSec ? ["-t", String(sourceDurationSec)] : []),
    "-movflags", "+faststart",
    tempPath
  ];
  try {
    await execFileAsync("ffmpeg", args, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    await assertDecodableVideo(tempPath, { timeoutMs });
    await replaceFileAtomically(tempPath, targetPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return { applied: true, targetPath, imagePath };
}

async function applyVolcengineSubtitles(context, batch, outputId, sourcePath, { timeoutMs = DEFAULT_OVERLAY_TIMEOUT_MS } = {}) {
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("stitcher_unavailable", "ffmpeg 不可用，无法烧录字幕");
  }
  if (!existsSync(sourcePath)) {
    throw new WangzhuanError("missing_required_file", "字幕处理所需的成片不存在", { sourcePath });
  }
  const outputDir = join(batchDir(context, batch.batchId), "postprocess-subtitles", outputId);
  const audioPath = join(outputDir, "source.mp3");
  await mkdir(outputDir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", audioPath
  ], { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  const audioStorage = await syncWangzhuanAsset(context, audioPath, "pipeline_subtitle_audio", { required: true });
  const config = resolveVolcengineAsrConfig(context);
  const asrResult = await transcribeVolcengineAudio({
    audioUrl: audioStorage.storageUrl,
    language: batch.request?.language || batch.estimate?.request?.language || "",
    uid: `${currentUserId(context)}:${batch.batchId}`,
    config: { ...config, timeoutMs: Math.max(config.timeoutMs, timeoutMs) }
  });
  const subtitleCanvas = await probeVideoStreamHealth(sourcePath);
  const subtitleSettings = resolveBatchPostProcess(batch).subtitles;
  const artifacts = await writeVolcengineSubtitleArtifacts(asrResult, outputDir, {
    width: subtitleCanvas.width,
    height: subtitleCanvas.height,
    fontSize: subtitleSettings.fontSize,
    centerY: subtitleSettings.centerY,
    textColor: subtitleSettings.textColor
  });
  const workDir = await mkdtemp(join(dirname(sourcePath), ".wz-subtitles-"));
  const tempPath = join(workDir, "subtitled.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", sourcePath,
      "-vf", `ass=${artifacts.assPath.replace(/\\/g, "/").replace(/:/g, "\\:")}`,
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart", tempPath
    ], { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    await assertDecodableVideo(tempPath, { timeoutMs });
    await replaceFileAtomically(tempPath, sourcePath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return {
    enabled: true,
    status: "succeeded",
    cueCount: artifacts.cueCount,
    transcriptPath: userRelative(context, artifacts.transcriptPath),
    srtPath: userRelative(context, artifacts.srtPath),
    assPath: userRelative(context, artifacts.assPath)
  };
}

async function readBatch(context, batchId) {
  validateBatchId(batchId);
  if (typeof context.readBatchForTest === "function") {
    return context.readBatchForTest(batchId);
  }
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
  if (typeof context.writeBatchForTest === "function") {
    return context.writeBatchForTest(next, triggerName);
  }
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
      entries: group.entries.sort((left, right) => {
        const segmentSort = Number(left.script.segmentIndex || left.task.segmentIndex || 0) - Number(right.script.segmentIndex || right.task.segmentIndex || 0);
        if (segmentSort) return segmentSort;
        const storySort = Number(left.script.storySegmentIndex || left.task.storySegmentIndex || 0) - Number(right.script.storySegmentIndex || right.task.storySegmentIndex || 0);
        if (storySort) return storySort;
        const sliceSort = Number(left.script.seedanceSliceIndex || left.task.seedanceSliceIndex || 0) - Number(right.script.seedanceSliceIndex || right.task.seedanceSliceIndex || 0);
        if (sliceSort) return sliceSort;
        const startSort = Number(left.script.startSec ?? left.task.startSec ?? 0) - Number(right.script.startSec ?? right.task.startSec ?? 0);
        return startSort || String(left.task.generationTaskId || "").localeCompare(String(right.task.generationTaskId || ""));
      })
    }))
    .sort((left, right) => {
      const branchSort = String(left.branchId).localeCompare(String(right.branchId));
      return branchSort || left.branchVariantIndex - right.branchVariantIndex;
    });
}

export function hasMultiSliceStitchGroups(batch = {}) {
  const postProcess = resolveBatchPostProcess(batch);
  const requiresPostProcess = Boolean(postProcess.ending || postProcess.subtitles.enabled || postProcess.expansionSizes.length);
  return groupTasksByVariant(batch).some((group) => group.entries.length > 1 || requiresPostProcess);
}

function segmentOutputPath(context, batchId, outputId) {
  return join(batchDir(context, batchId), "segments", `${outputId}.mp4`);
}

function stitchedOutputPath(context, batchId, outputId) {
  return join(batchDir(context, batchId), "stitched", `${outputId}.mp4`);
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
  const subtitleSettings = resolveBatchPostProcess(batch).subtitles;
  const existingByTask = new Map();
  for (const output of existing) {
    for (const taskId of output.generationTaskIds || []) existingByTask.set(taskId, output);
  }
  const outputs = [...existing];
  for (const group of groups) {
    for (const entry of group.entries) {
      const existingOutput = existingByTask.get(entry.task.generationTaskId);
      if (existingOutput) {
        const existingPath = join(context.userProjectRoot, existingOutput.filePath || "");
        const media = await probeVideoStreamHealth(existingPath);
        if (subtitleSettings.enabled && existingOutput.subtitlePostProcess?.status !== "succeeded" && existsSync(existingPath)) {
          const durationSec = Number(entry.task.durationSec || entry.script.durationSec || existingOutput.durationSec || 0);
          try {
            existingOutput.subtitlePostProcess = await applyVolcengineSubtitles(context, batch, existingOutput.outputId, existingPath, {
              timeoutMs: postProcessTimeoutMs(durationSec)
            });
            const storage = await syncWangzhuanAsset(context, existingPath, "pipeline_segment_video", { required: true });
            existingOutput.previewUrl = storage.storageUrl;
            existingOutput.storageKey = storage.storageKey;
            existingOutput.storageUrl = storage.storageUrl;
          } catch (error) {
            existingOutput.subtitlePostProcess = {
              enabled: true,
              status: "failed",
              errorCode: error?.code || "subtitle_postprocess_failed",
              errorMessage: safeErrorMessage(error)
            };
          }
        }
        existingOutput.kind = existingOutput.kind || "segment_video";
        existingOutput.durationSec = Number(entry.task.durationSec || entry.script.durationSec || existingOutput.durationSec || 0);
        existingOutput.displayFileName = buildOutputDisplayName({
          batch,
          script: entry.script,
          outputId: existingOutput.outputId,
          width: media.width,
          height: media.height
        });
        continue;
      }
      // A partial batch can still have an upstream task in flight. It must not
      // block materialization of the downloaded slices in the same group.
      if (!STITCH_READY_TASK_STATUSES.has(entry.task.status) || !entry.task.outputPath) continue;
      const outputId = takeOutputId(batch, sequenceState);
      const target = segmentOutputPath(context, batch.batchId, outputId);
      const filePath = userRelative(context, target);
      const disclaimerOverlay = Number(batch.estimate?.durationSec) === 15
        && group.entries.length === 1
        && !hasMultiSliceStitchGroups(batch)
        ? resolveDisclaimerOverlay(batch, entry.script.branchDraft)
        : { applied: false, text: "" };
      const taskSource = entry.task.outputPath
        ? join(context.userProjectRoot, entry.task.outputPath)
        : "";
      if (taskSource && existsSync(taskSource)) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(taskSource, target);
        if (disclaimerOverlay.applied) {
          const durationSec = Number(entry.task.durationSec || entry.script.durationSec || batch.estimate?.durationSec || 0);
          await applyDisclaimerOverlay(context, target, target, disclaimerOverlay, {
            timeoutMs: postProcessTimeoutMs(durationSec)
          });
        }
      } else {
        throw new WangzhuanError("missing_required_file", "分段视频文件缺失，无法生成分段产出", {
          batchId: batch.batchId,
          generationTaskId: entry.task.generationTaskId,
          outputPath: filePath
        });
      }
      let subtitlePostProcess = subtitleSettings.enabled ? { enabled: true, status: "pending" } : { enabled: false, status: "disabled" };
      const durationSec = Number(entry.task.durationSec || entry.script.durationSec || batch.estimate?.durationSec || 15);
      if (subtitleSettings.enabled) {
        try {
          subtitlePostProcess = await applyVolcengineSubtitles(context, batch, outputId, target, {
            timeoutMs: postProcessTimeoutMs(durationSec)
          });
        } catch (error) {
          subtitlePostProcess = {
            enabled: true,
            status: "failed",
            errorCode: error?.code || "subtitle_postprocess_failed",
            errorMessage: safeErrorMessage(error)
          };
        }
      }
      const storage = await syncWangzhuanAsset(context, target, "pipeline_segment_video", { required: true });
      const media = await probeVideoStreamHealth(target);
      outputs.push({
        outputId,
        sourceType: "pipeline",
        batchId: batch.batchId,
        scriptId: entry.script.scriptId,
        branchId: entry.script.branchId || "",
        branchLabel: entry.script.branchLabel || "",
        branchVariantIndex: entry.script.branchVariantIndex || entry.script.variantIndex,
        generationTaskIds: [entry.task.generationTaskId],
        durationSec,
        kind: "segment_video",
        filePath,
        displayFileName: buildOutputDisplayName({
          batch,
          script: entry.script,
          outputId,
          width: media.width,
          height: media.height
        }),
        previewUrl: storage.storageUrl,
        storageKey: storage.storageKey,
        storageUrl: storage.storageUrl,
        qcStatus: "not_started",
        downloadEligible: false,
        visualPreviewRequired: false,
        previewConfirmed: false,
        subtitlePostProcess,
        disclaimerOverlay
      });
    }
  }
  return outputs;
}

function stitchableEntries(group) {
  return group.entries.filter(({ task }) => {
    return task.seedanceTaskId && STITCH_READY_TASK_STATUSES.has(task.status) && Boolean(task.outputPath);
  });
}

function hasStitchableSegments(group, { requiresPostProcess = false } = {}) {
  const entries = stitchableEntries(group);
  return entries.length > 0 && (group.entries.length >= 2 || requiresPostProcess);
}

function hasUnmaterializedReadySegments(batch = {}) {
  const materializedTaskIds = new Set();
  for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
    if (output.kind !== "segment_video") continue;
    for (const taskId of output.generationTaskIds || []) materializedTaskIds.add(taskId);
  }
  return (Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => {
    return STITCH_READY_TASK_STATUSES.has(task.status)
      && Boolean(task.outputPath)
      && !materializedTaskIds.has(task.generationTaskId);
  });
}

function groupHasTerminalTasks(group) {
  return group.entries.every(({ task }) => {
    return STITCH_READY_TASK_STATUSES.has(task.status) || FAILED_TASK_STATUSES.has(task.status);
  });
}

function deliveryGroupKey(value = {}) {
  return `${value.branchId || "default"}:${Number(value.branchVariantIndex || value.variantIndex || 1)}`;
}

export function isBatchReadyForStitch(batch = {}) {
  const groups = groupTasksByVariant(batch);
  const postProcess = resolveBatchPostProcess(batch);
  const requiresPostProcess = Boolean(postProcess.ending || postProcess.subtitles.enabled || postProcess.expansionSizes.length);
  return groups.length > 0 && groups.some((group) => hasStitchableSegments(group, { requiresPostProcess }));
}

function buildReport({ outputId, segmentOutputIds, preflight, status, errorCode = "", errorMessage = "", disclaimerOverlay = null, tailSegments = [], postProcessEnding = null, subtitlePostProcess = null }) {
  return {
    schemaVersion: "stitch_report.v1",
    outputId,
    status,
    segmentOutputIds,
    tailSegments,
    tool: {
      provider: preflight.provider,
      version: preflight.version,
      preflightStatus: preflight.status
    },
    disclaimerOverlay: disclaimerOverlay || { applied: false, text: "" },
    postProcessEnding,
    subtitlePostProcess,
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
    errorCode: error?.code || "stitch_failed",
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

async function concatSegmentVideos(outputPath, segmentPaths, {
  timeoutMs = DEFAULT_STITCH_TIMEOUT_MS,
  canvas = null
} = {}) {
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("stitcher_unavailable", "ffmpeg 不可用，无法拼接视频");
  }
  for (const segmentPath of segmentPaths) {
    if (!existsSync(segmentPath)) {
      throw new WangzhuanError("missing_required_file", "拼接所需的分段视频不存在", { segmentPath });
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const workDir = await mkdtemp(join(dirname(outputPath), ".wz-stitch-"));
  const tempPath = join(workDir, "concat.mp4");
  try {
    const sourceHealth = canvas || await probeVideoStreamHealth(segmentPaths[0]);
    const canvasWidth = Number(sourceHealth.width) > 0 ? Math.trunc(sourceHealth.width) : 720;
    const canvasHeight = Number(sourceHealth.height) > 0 ? Math.trunc(sourceHealth.height) : 1280;
    const listPath = join(workDir, "concat.txt");
    const listBody = segmentPaths.map((segmentPath) => `file '${toConcatListPath(segmentPath)}'`).join("\n");
    await writeFile(listPath, listBody, "utf8");
    await mkdir(dirname(outputPath), { recursive: true });

    const runConcat = async (args) => {
      await execFileAsync("ffmpeg", args, {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
    };

    let copyError = null;
    try {
      await runConcat([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        tempPath
      ]);
      await assertDecodableVideo(tempPath, { timeoutMs });
    } catch (error) {
      copyError = error;
      await rm(tempPath, { force: true }).catch(() => {});
      // Prefer a full re-encode when stream copy produces undecodable output
      // (common with mixed audio presence / timestamp discontinuities).
      try {
        await runConcat([
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", listPath,
          "-vf", `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-ar", "44100",
          "-ac", "2",
          "-movflags", "+faststart",
          tempPath
        ]);
        await assertDecodableVideo(tempPath, { timeoutMs });
      } catch (reencodeError) {
        throw reencodeError instanceof WangzhuanError
          ? reencodeError
          : (copyError instanceof WangzhuanError ? copyError : new WangzhuanError("stitch_failed", safeErrorMessage(copyError || reencodeError)));
      }
    }
    await replaceFileAtomically(tempPath, outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createPostProcessEndingVideo(context, batchId, outputId, ending, canvas, {
  timeoutMs = DEFAULT_STITCH_TIMEOUT_MS
} = {}) {
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("stitcher_unavailable", "ffmpeg 不可用，无法生成 Ending 视频片段");
  }
  const sourcePath = resolveUserAssetPath(context, ending?.storedPath);
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new WangzhuanError("missing_required_file", "后处理 Ending 文件不存在", {
      storedPath: ending?.storedPath || ""
    });
  }
  const width = Number(canvas?.width) > 0 ? Math.trunc(canvas.width) : 720;
  const height = Number(canvas?.height) > 0 ? Math.trunc(canvas.height) : 1280;
  const target = join(batchDir(context, batchId), "postprocess-ending", `${outputId}_ending.mp4`);
  await mkdir(dirname(target), { recursive: true });
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`;
  const isImage = ending?.mediaType === "image";
  const sourceDurationSec = isImage ? 1 : await probeVideoDuration(sourcePath);
  if (!(sourceDurationSec > 0)) {
    throw new WangzhuanError("invalid_material", "后处理 Ending 视频时长无效", {
      storedPath: ending?.storedPath || ""
    });
  }
  const hasAudio = !isImage && await probeHasAudio(sourcePath);
  const args = isImage
    ? [
        "-y", "-loop", "1", "-i", sourcePath,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", "1", "-vf", filter, "-map", "0:v:0", "-map", "1:a:0"
      ]
    : hasAudio
      ? [
          "-y", "-i", sourcePath, "-t", String(sourceDurationSec), "-vf", filter,
          "-map", "0:v:0", "-map", "0:a:0"
        ]
      : [
          "-y", "-i", sourcePath,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-t", String(sourceDurationSec), "-vf", filter, "-map", "0:v:0", "-map", "1:a:0"
        ];
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    "-shortest",
    "-movflags", "+faststart",
    target
  );
  try {
    await execFileAsync("ffmpeg", args, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    const health = await assertDecodableVideo(target, { timeoutMs });
    return {
      filePath: userRelative(context, target),
      fullPath: target,
      durationSec: isImage ? 1 : health.durationSec,
      mediaType: ending.mediaType,
      sourceFileName: ending.fileName || ""
    };
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

async function deriveExpandedOutputs(context, batch, originalOutput, sequenceState, {
  sourceHealth = null,
  concurrency = 2
} = {}) {
  const expansionSizes = resolveBatchPostProcess(batch).expansionSizes;
  if (!expansionSizes.length) return { outputs: [], failures: [] };
  const inputPath = join(context.userProjectRoot, originalOutput.filePath);
  const health = sourceHealth || await probeVideoStreamHealth(inputPath);
  const originalSizeKey = `${Math.trunc(health.width || 0)}x${Math.trunc(health.height || 0)}`;
  const requests = expansionSizes.filter((item) => item.sizeKey !== originalSizeKey);
  if (!requests.length) return { outputs: [], failures: [] };
  const outputDir = join(batchDir(context, batch.batchId), "expanded", originalOutput.outputId);
  const renderer = context.renderExpandedVideo || renderExpandedVideo;
  const jobs = requests.map((request) => ({
    request,
    outputId: takeOutputId(batch, sequenceState)
  }));
  const outputs = [];
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const { request, outputId } = job;
      try {
        const outputFileName = buildExpandedOutputName(
          originalOutput.displayFileName || `${originalOutput.outputId}.mp4`,
          request.targetWidth,
          request.targetHeight
        );
        const rendered = await renderer({
          inputPath,
          targetWidth: request.targetWidth,
          targetHeight: request.targetHeight,
          outputDir,
          outputFileName,
          timeoutMs: expansionTimeoutMs(health.durationSec || originalOutput.durationSec)
        });
        const storage = await syncWangzhuanAsset(context, rendered.outputPath, "pipeline_expanded_video", { required: true });
        outputs.push({
          outputId,
          sourceType: "pipeline",
          batchId: batch.batchId,
          kind: "expanded_video",
          parentOutputId: originalOutput.outputId,
          branchId: originalOutput.branchId || "",
          branchLabel: originalOutput.branchLabel || "",
          branchVariantIndex: originalOutput.branchVariantIndex,
          generationTaskIds: [...(originalOutput.generationTaskIds || [])],
          durationSec: Number(rendered.durationSec || health.durationSec || originalOutput.durationSec || 0),
          targetWidth: request.targetWidth,
          targetHeight: request.targetHeight,
          sizeKey: request.sizeKey,
          mode: request.mode,
          filePath: userRelative(context, rendered.outputPath),
          displayFileName: rendered.fileName,
          previewUrl: storage.storageUrl,
          storageKey: storage.storageKey,
          storageUrl: storage.storageUrl,
          qcStatus: "not_started",
          downloadEligible: true,
          visualPreviewRequired: false,
          previewConfirmed: false
        });
      } catch (error) {
        failures.push({
          parentOutputId: originalOutput.outputId,
          sizeKey: request.sizeKey,
          targetWidth: request.targetWidth,
          targetHeight: request.targetHeight,
          code: error?.code || "output_expansion_failed",
          message: safeErrorMessage(error)
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, () => worker()));
  outputs.sort((left, right) => left.sizeKey.localeCompare(right.sizeKey));
  failures.sort((left, right) => left.sizeKey.localeCompare(right.sizeKey));
  return { outputs, failures };
}

async function createSucceededStitchOutput(context, batch, group, segmentOutputs, preflight, sequenceState) {
  const outputId = takeOutputId(batch, sequenceState);
  const target = stitchedOutputPath(context, batch.batchId, outputId);
  const postProcessEnding = resolveBatchPostProcess(batch).ending;
  const segmentPaths = segmentOutputs.map((output) => join(context.userProjectRoot, output.filePath));
  const canvas = await probeVideoStreamHealth(segmentPaths[0]);
  const endingSegment = postProcessEnding
    ? await createPostProcessEndingVideo(context, batch.batchId, outputId, postProcessEnding, canvas)
    : null;
  const totalDurationSec = (segmentOutputs.reduce((sum, output) => sum + Number(output.durationSec || 0), 0)
    + Number(endingSegment?.durationSec || 0))
    || group.entries.reduce((sum, entry) => sum + Number(entry.task.durationSec || entry.script.durationSec || 0), 0)
    || Number(batch.estimate?.durationSec || 0);
  const displayFileName = buildOutputDisplayName({
    batch,
    script: group.entries[0]?.script,
    outputId,
    width: canvas.width,
    height: canvas.height
  });
  if (endingSegment) segmentPaths.push(endingSegment.fullPath);
  const disclaimerOverlay = resolveDisclaimerOverlay(batch, group.entries[0]?.script?.branchDraft);
  const segmentSubtitleStatuses = segmentOutputs
    .map((output) => output.subtitlePostProcess)
    .filter((item) => item?.enabled);
  const subtitlePostProcess = segmentSubtitleStatuses.length
    ? {
        enabled: true,
        status: segmentSubtitleStatuses.every((item) => item.status === "succeeded") ? "succeeded" : "partial_failed",
        mode: "segment_before_stitch",
        segmentCount: segmentSubtitleStatuses.length,
        failedCount: segmentSubtitleStatuses.filter((item) => item.status !== "succeeded").length
      }
    : { enabled: false, status: "disabled", mode: "segment_before_stitch" };
  const postProcessFailures = [];
  const timeoutMs = postProcessTimeoutMs(totalDurationSec);
  try {
    // Always concat first, then overlay in a second pass. The old single-pass
    // concat+overlay+-c:a copy path produced undecodable outputs on Lavc59.
    await concatSegmentVideos(target, segmentPaths, { canvas });
    if (disclaimerOverlay.applied) {
      const overlayImagePath = resolveDisclaimerOverlayImagePath(context, disclaimerOverlay);
      if (!overlayImagePath) {
        throw new WangzhuanError("missing_required_file", "免责声明贴片 PNG 不存在，请选择模板或上传 PNG", {
          imageStoredPath: disclaimerOverlay.imageStoredPath || ""
        });
      }
      await applyDisclaimerOverlay(context, target, target, disclaimerOverlay, { timeoutMs });
    }
    for (const segmentOutput of segmentOutputs) {
      if (segmentOutput.subtitlePostProcess?.enabled && segmentOutput.subtitlePostProcess.status !== "succeeded") {
        postProcessFailures.push({
          parentOutputId: segmentOutput.outputId,
          kind: "subtitles",
          code: segmentOutput.subtitlePostProcess.errorCode || "subtitle_postprocess_failed",
          message: segmentOutput.subtitlePostProcess.errorMessage || "分段字幕生成失败"
        });
      }
    }
    await assertDecodableVideo(target, { timeoutMs });
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error instanceof WangzhuanError ? error : new WangzhuanError("stitch_failed", safeErrorMessage(error), {
      batchId: batch.batchId,
      segmentOutputIds: segmentOutputs.map((output) => output.outputId)
    });
  }
  const filePath = userRelative(context, target);
  const storage = await syncWangzhuanAsset(context, target, "pipeline_stitched_video", { required: true });
  const report = buildReport({
    outputId,
    segmentOutputIds: segmentOutputs.map((output) => output.outputId),
    preflight,
    status: "succeeded",
    disclaimerOverlay,
    tailSegments: [],
    postProcessEnding: endingSegment ? {
      filePath: endingSegment.filePath,
      durationSec: endingSegment.durationSec,
      mediaType: endingSegment.mediaType,
      sourceFileName: endingSegment.sourceFileName
    } : null,
    subtitlePostProcess
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
      durationSec: totalDurationSec,
      tailSegments: [],
      postProcessEnding: endingSegment ? {
        filePath: endingSegment.filePath,
        durationSec: endingSegment.durationSec,
        mediaType: endingSegment.mediaType,
        sourceFileName: endingSegment.sourceFileName
      } : null,
      subtitlePostProcess,
      kind: "stitched_video",
      filePath,
      displayFileName,
      previewUrl: storage.storageUrl,
      storageKey: storage.storageKey,
      storageUrl: storage.storageUrl,
      qcStatus: "not_started",
      downloadEligible: true,
      visualPreviewRequired: false,
      previewConfirmed: false,
      stitchReportPath: reportPath,
      disclaimerOverlay
    },
    report: {
      ...report,
      reportPath,
      variantIndex: group.variantIndex,
      branchId: group.branchId || "",
      branchLabel: group.branchLabel || "",
      branchVariantIndex: group.branchVariantIndex
    },
    postProcessFailures
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
  if (!segmentOutputs.length) {
    throw new WangzhuanError("no_segments", "没有可用于产出的分段视频", { batchId });
  }
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
  }, ["qc", "partial_failed"].includes(batch.status) ? "stitch_progress" : "segments_completed");
  await writeTaskMaps(context, saved);
  return saved;
}

export async function finalizeFifteenSecondBatch(context, batchId) {
  return finalizeSegmentBatch(context, batchId);
}

export async function finalizeSegmentBatch(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (Number(batch.estimate?.durationSec) === 30) return batch;
  if (["succeeded", "failed", "stopped"].includes(batch.status)) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "pending")) return batch;
  if ((Array.isArray(batch.tasks) ? batch.tasks : []).some((task) => task.status === "waiting_upstream")) return batch;

  let working = batch;
  if (hasUnmaterializedReadySegments(working)) {
    working = await materializeBatchSegmentOutputs(context, batchId);
  }
  const hasFailedTasks = (Array.isArray(working.tasks) ? working.tasks : [])
    .some((task) => FAILED_TASK_STATUSES.has(task.status));
  const nextStatus = hasFailedTasks ? "partial_failed" : "qc";
  if (working.status !== nextStatus) {
    const triggerName = working.status === "partial_failed" && nextStatus === "qc"
      ? "stitch_progress"
      : working.status === "qc" && nextStatus === "partial_failed"
        ? "qc_partial_failed"
        : hasFailedTasks ? "generation_partial_failed" : "generation_completed";
    working = await writeBatch(
      context,
      { ...working, status: nextStatus },
      triggerName
    );
  }
  return working;
}

async function stitchBatchSegmentsOnce(context, batchId, options = {}) {
  const preflight = preflightStitcher(context);
  if (preflight.status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "拼接能力不可用", { batchId });
  }

  const batch = await readBatch(context, batchId);
  const groups = groupTasksByVariant(batch);
  if (!groups.length || !isBatchReadyForStitch(batch)) {
    throw new WangzhuanError("no_segments", "没有可用于拼接的分段视频", { batchId });
  }

  const withStitchingStatus = await writeBatch(context, { ...batch, status: "stitching" }, "stitch_progress");
  const sequenceState = { next: nextOutputSequence(withStitchingStatus) };
  let segmentOutputs;
  try {
    segmentOutputs = await materializeSegmentOutputs(context, withStitchingStatus, groups, sequenceState);
  } catch (error) {
    const report = await createFailedReport(
      context,
      withStitchingStatus,
      groups[0],
      [],
      preflight,
      error,
      sequenceState
    );
    const saved = await writeBatch(context, {
      ...withStitchingStatus,
      status: "partial_failed",
      outputs: Array.isArray(batch.outputs) ? batch.outputs : [],
      stitchReports: [...(Array.isArray(batch.stitchReports) ? batch.stitchReports : []), report]
    }, "stitch_progress");
    await writeTaskMaps(context, saved);
    await telemetryRecorder(context)("stitch_completed", {
      batchId,
      outputId: report.outputId,
      status: report.status,
      errorCode: report.errorCode
    });
    return stitchResult(context, batchId, saved);
  }
  const segmentByTask = new Map();
  for (const output of segmentOutputs) {
    for (const taskId of output.generationTaskIds || []) segmentByTask.set(taskId, output);
  }

  const existingNonSegmentOutputs = (Array.isArray(batch.outputs) ? batch.outputs : []).filter((output) => output.kind !== "segment_video");
  const previousDerivedOutputs = existingNonSegmentOutputs.filter((output) => ["stitched_video", "expanded_video"].includes(output.kind));
  const nextOutputs = [...segmentOutputs, ...existingNonSegmentOutputs.filter((output) => !["stitched_video", "expanded_video"].includes(output.kind))];
  const stitchReports = options.replaceDerivedOutputs
    ? []
    : Array.isArray(batch.stitchReports) ? [...batch.stitchReports] : [];
  const postProcessFailures = [];
  const successfulDeliveryGroups = new Set();
  const successfulDeliveryTaskIds = new Set();
  let currentSucceededCount = 0;
  let currentFailedCount = 0;

  for (const group of groups) {
    const groupSegments = group.entries.map((entry) => segmentByTask.get(entry.task.generationTaskId)).filter(Boolean);
    const readyEntries = group.entries.filter((entry) => segmentByTask.has(entry.task.generationTaskId));
    const readyGroup = { ...group, entries: readyEntries };
    // Partial batches may contain a failed or still-queued slice. Stitch the
    // ready subset for this group and keep the missing task in partial_failed.
    const groupReady = hasStitchableSegments(readyGroup, { requiresPostProcess: true });
    if (!groupReady) {
      const missingIds = group.entries
        .filter((entry) => !segmentByTask.has(entry.task.generationTaskId))
        .map((entry) => entry.task.generationTaskId);
      const hasTerminalTasks = groupHasTerminalTasks(group);
      const report = await createFailedReport(
        context,
        { ...withStitchingStatus, outputs: nextOutputs },
        group,
        groupSegments,
        preflight,
        new WangzhuanError(
          hasTerminalTasks ? "partial_segments_unavailable" : "segments_not_ready",
          hasTerminalTasks ? "该分组存在失败分片，无法生成完整成片" : "该分组分片尚未全部就绪",
          {
            batchId,
            missingGenerationTaskIds: missingIds
          }
        ),
        sequenceState
      );
      stitchReports.push(report);
      currentFailedCount += 1;
      continue;
    }
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
    try {
      const stitched = await createSucceededStitchOutput(
        context,
        { ...withStitchingStatus, outputs: nextOutputs },
        readyGroup,
        groupSegments,
        preflight,
        sequenceState
      );
      nextOutputs.push(stitched.output);
      postProcessFailures.push(...stitched.postProcessFailures);
      const expanded = await deriveExpandedOutputs(
        context,
        { ...withStitchingStatus, outputs: nextOutputs },
        stitched.output,
        sequenceState
      );
      nextOutputs.push(...expanded.outputs);
      postProcessFailures.push(...expanded.failures);
      stitchReports.push(stitched.report);
      successfulDeliveryGroups.add(deliveryGroupKey(group));
      for (const taskId of stitched.output.generationTaskIds || []) successfulDeliveryTaskIds.add(taskId);
      currentSucceededCount += 1;
      if (readyEntries.length < group.entries.length) currentFailedCount += 1;
    } catch (error) {
      const report = await createFailedReport(
        context,
        { ...withStitchingStatus, outputs: nextOutputs },
        group,
        groupSegments,
        preflight,
        error,
        sequenceState
      );
      stitchReports.push(report);
      currentFailedCount += 1;
    }
  }

  nextOutputs.push(...previousDerivedOutputs.filter((output) => {
    const coveredByTask = (output.generationTaskIds || [])
      .some((taskId) => successfulDeliveryTaskIds.has(taskId));
    return !coveredByTask && !successfulDeliveryGroups.has(deliveryGroupKey(output));
  }));

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
    stitchReports,
    postProcessFailures,
    replaceDerivedOutputs: options.replaceDerivedOutputs === true
  }, nextStatus === "qc" ? "stitch_completed" : "stitch_progress");
  await writeTaskMaps(context, saved);
  const recordEvent = telemetryRecorder(context);
  for (const report of stitchReports.slice(-groups.length)) {
    await recordEvent("stitch_completed", {
      batchId,
      outputId: report.outputId,
      status: report.status,
      errorCode: report.errorCode || ""
    });
  }
  return stitchResult(context, batchId, saved);
}

async function stitchResult(context, batchId, saved) {
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

function stitchSingleFlightKey(context, batchId) {
  const scope = context.userProjectRoot || context.sharedProjectRoot || currentUserId(context);
  return `${scope}:${batchId}`;
}

export function stitchBatchSegments(context, batchId, options = {}) {
  const key = stitchSingleFlightKey(context, batchId);
  const active = STITCH_IN_FLIGHT.get(key);
  if (active) return active;
  const task = stitchBatchSegmentsOnce(context, batchId, options);
  const tracked = task.finally(() => {
    if (STITCH_IN_FLIGHT.get(key) === tracked) STITCH_IN_FLIGHT.delete(key);
  });
  STITCH_IN_FLIGHT.set(key, tracked);
  return tracked;
}

function manualStitchIdempotencyKey(request = {}) {
  const idempotencyKey = String(request.idempotencyKey || "").trim();
  if (!idempotencyKey) {
    throw new WangzhuanError("validation_error", "手动拼接请求缺少 idempotencyKey", {
      field: "idempotencyKey"
    });
  }
  return idempotencyKey;
}

function manualStitchVersion(batch = {}) {
  return Math.max(0, ...(Array.isArray(batch.outputs) ? batch.outputs : [])
    .filter((output) => output.manualStitch === true)
    .map((output) => Number(output.stitchVersion || 0))) + 1;
}

function taskForSegmentOutput(batch, output) {
  const taskIds = new Set((output.generationTaskIds || []).map(String));
  return (Array.isArray(batch.tasks) ? batch.tasks : []).find((task) => {
    return taskIds.has(String(task.generationTaskId || ""));
  }) || null;
}

function manualStitchGroup(batch, selection) {
  const entries = selection.outputs.map((output) => {
    const task = taskForSegmentOutput(batch, output);
    const script = (Array.isArray(batch.scripts) ? batch.scripts : [])
      .find((item) => item.scriptId === task?.scriptId) || {
        scriptId: task?.scriptId,
        branchId: task?.branchId,
        branchLabel: task?.branchLabel,
        branchVariantIndex: task?.branchVariantIndex,
        segmentIndex: task?.segmentIndex,
        durationSec: output.durationSec
      };
    return { task, script, output };
  });
  const first = entries[0] || {};
  return {
    variantIndex: first.task?.branchVariantIndex || 1,
    branchId: selection.kind === "mixed" ? "mixed" : (first.task?.branchId || ""),
    branchLabel: selection.kind === "mixed" ? "混合编排" : (first.task?.branchLabel || ""),
    branchVariantIndex: selection.kind === "mixed" ? 0 : Number(first.task?.branchVariantIndex || 1),
    entries
  };
}

function manualStitchFullPath(context, relativePath, field = "filePath") {
  const root = resolve(context.userProjectRoot);
  const target = resolve(root, String(relativePath || ""));
  if (!relativePath || (target !== root && !target.startsWith(`${root}/`))) {
    throw new WangzhuanError("invalid_material", "拼接输出路径不合法", { field });
  }
  return target;
}

async function validateManualStitchMedia(context, outputs) {
  const media = [];
  for (const output of outputs) {
    const fullPath = manualStitchFullPath(context, output.filePath);
    if (!existsSync(fullPath)) {
      throw new WangzhuanError("missing_required_file", "拼接所需的片段文件不存在", {
        outputId: output.outputId
      });
    }
    await assertDecodableVideo(fullPath);
    const health = await probeVideoStreamHealth(fullPath);
    if (!(health.width > 0) || !(health.height > 0) || !(health.durationSec > 0)) {
      throw new WangzhuanError("invalid_video", "拼接片段媒体参数不完整", {
        outputId: output.outputId
      });
    }
    media.push({
      outputId: output.outputId,
      width: health.width,
      height: health.height,
      durationSec: health.durationSec,
      codecName: health.codecName,
      hasAudio: await probeHasAudio(fullPath)
    });
  }
  return media;
}

async function replayManualStitchVersion(context, batchId, summary = {}) {
  const batch = await readBatch(context, batchId);
  const outputId = summary.output?.outputId || summary.outputId || "";
  const output = (Array.isArray(batch.outputs) ? batch.outputs : []).find((item) => item.outputId === outputId);
  if (!output) throw new WangzhuanError("output_not_found", "拼接版本不存在", { outputId }, 404);
  return { batch, output };
}

async function createManualStitchVersionOnce(context, batchId, request) {
  const outputIds = Array.isArray(request.segmentOutputIds)
    ? request.segmentOutputIds.map(String).filter(Boolean)
    : [];
  if (!outputIds.length) {
    throw new WangzhuanError("validation_error", "至少选择一个片段后才能拼接", {
      field: "segmentOutputIds"
    });
  }
  if (outputIds.length > 50) {
    throw new WangzhuanError("validation_error", "单次拼接最多选择 50 个片段", {
      field: "segmentOutputIds",
      maxItems: 50
    });
  }
  if (new Set(outputIds).size !== outputIds.length) {
    throw new WangzhuanError("validation_error", "拼接队列包含重复片段", {
      field: "segmentOutputIds"
    });
  }

  const batch = await readBatch(context, batchId);
  const selection = classifyStitchSelection(batch, outputIds);
  if (selection.outputs.length !== outputIds.length) {
    throw new WangzhuanError("invalid_material", "拼接队列包含不存在、已删除或非当前版本的片段", {
      requestedOutputIds: outputIds,
      resolvedOutputIds: selection.outputs.map((output) => output.outputId)
    });
  }
  if (!selection.continuityCompatible) {
    throw new WangzhuanError("continuity_lineage_mismatch", "拼接队列包含连续性版本已失效或顺序不兼容的片段", {
      continuityErrors: selection.continuityErrors
    }, 409);
  }
  if (selection.kind === "mixed" && request.confirmMixed !== true) {
    throw new WangzhuanError("mixed_stitch_confirmation_required", "跨变体拼接需要先确认混合编排", {
      sourceGroups: selection.sourceGroups
    }, 409);
  }
  const preflight = preflightStitcher(context);
  if (preflight.status === "unsupported") {
    throw new WangzhuanError("stitcher_unavailable", "拼接能力不可用", { batchId });
  }
  const createForTest = context.createManualStitchOutputForTest;
  const media = createForTest ? [] : await validateManualStitchMedia(context, selection.outputs);
  const sequenceState = { next: nextOutputSequence(batch) };
  const group = manualStitchGroup(batch, selection);
  const created = createForTest
    ? await createForTest({
        context,
        batch,
        group,
        segmentOutputs: selection.outputs,
        preflight,
        outputId: takeOutputId(batch, sequenceState)
      })
    : await createSucceededStitchOutput(
        context,
        batch,
        group,
        selection.outputs,
        preflight,
        sequenceState
      );
  const stitchVersion = manualStitchVersion(batch);
  const createdAt = new Date().toISOString();
  const output = {
    ...created.output,
    displayFileName: `manual-stitch-v${stitchVersion}.mp4`,
    manualStitch: true,
    stitchVersion,
    stitchKind: selection.kind,
    sourceGroups: selection.sourceGroups,
    segmentOutputIds: [...outputIds],
    createdBy: currentUserId(context),
    createdAt,
    compatibility: media
  };
  const report = {
    ...created.report,
    manualStitch: true,
    stitchVersion,
    stitchKind: selection.kind,
    sourceGroups: selection.sourceGroups,
    segmentOutputIds: [...outputIds],
    createdBy: currentUserId(context),
    createdAt
  };
  if (report.reportPath) {
    await writeAtomicJson(manualStitchFullPath(context, report.reportPath, "reportPath"), report);
  }
  const { replaceDerivedOutputs: _replaceDerivedOutputs, ...batchWithoutReplacementFlag } = batch;
  const saved = await writeBatch(context, {
    ...batchWithoutReplacementFlag,
    outputs: [...(Array.isArray(batch.outputs) ? batch.outputs : []), output],
    stitchReports: [...(Array.isArray(batch.stitchReports) ? batch.stitchReports : []), report]
  }, "manual_stitch");
  await telemetryRecorder(context)("manual_stitch_version_created", {
    batchId,
    outputId: output.outputId,
    stitchVersion,
    stitchKind: selection.kind,
    segmentOutputIds: outputIds
  }, { audit: true }).catch(() => {});
  return { batch: saved, output, report };
}

export async function createManualStitchVersion(context, batchId, request = {}) {
  validateBatchId(batchId);
  const idempotencyKey = manualStitchIdempotencyKey(request);
  const requestHash = hashPayload({
    batchId,
    segmentOutputIds: request.segmentOutputIds,
    confirmMixed: request.confirmMixed === true
  });
  const runIdempotent = context.runIdempotentOperation || runIdempotentOperation;
  return runIdempotent(
    context,
    "manual_stitch_version",
    idempotencyKey,
    requestHash,
    () => createManualStitchVersionOnce(context, batchId, request),
    {
      resourceType: "batch",
      replayResponse: (summary) => replayManualStitchVersion(context, batchId, summary)
    }
  );
}

async function manualOutputOwner(context, outputId) {
  const loadOutput = context.loadOutputDetailFromMysql || loadOutputDetailFromMysql;
  const detail = await loadOutput(context, outputId);
  if (!detail?.batchId) throw new WangzhuanError("output_not_found", "拼接版本不存在", { outputId }, 404);
  const batch = await readBatch(context, detail.batchId);
  const output = (Array.isArray(batch.outputs) ? batch.outputs : []).find((item) => item.outputId === outputId);
  if (!output) throw new WangzhuanError("output_not_found", "拼接版本不存在", { outputId }, 404);
  if (output.manualStitch !== true) {
    throw new WangzhuanError("invalid_state_transition", "只能管理手动拼接版本", { outputId }, 409);
  }
  return { batch, output };
}

function manualStitchDisplayFileName(value) {
  const displayFileName = String(value || "").trim();
  if (!displayFileName || displayFileName.length > 160 || /[\\/\u0000-\u001f]/.test(displayFileName)) {
    throw new WangzhuanError("validation_error", "版本名称不能为空、包含路径字符或超过 160 字符", {
      field: "displayFileName",
      maxLength: 160
    });
  }
  return displayFileName.toLowerCase().endsWith(".mp4") ? displayFileName : `${displayFileName}.mp4`;
}

export async function renameManualStitchVersion(context, outputId, request = {}) {
  const { batch, output } = await manualOutputOwner(context, outputId);
  const renamedOutput = {
    ...output,
    displayFileName: manualStitchDisplayFileName(request.displayFileName)
  };
  const saved = await writeBatch(context, {
    ...batch,
    outputs: batch.outputs.map((item) => item.outputId === outputId ? renamedOutput : item)
  }, "manual_stitch_manage");
  await telemetryRecorder(context)("manual_stitch_version_renamed", {
    batchId: batch.batchId,
    outputId,
    displayFileName: renamedOutput.displayFileName
  }, { audit: true }).catch(() => {});
  return { batch: saved, output: renamedOutput };
}

export async function deleteManualStitchVersion(context, outputId) {
  const { batch, output } = await manualOutputOwner(context, outputId);
  const references = batch.outputs.filter((item) => item.outputId !== outputId && (
    item.parentOutputId === outputId
    || (Array.isArray(item.segmentOutputIds) && item.segmentOutputIds.includes(outputId))
  ));
  if (references.length) {
    throw new WangzhuanError("output_in_use", "该拼接版本仍被其他输出引用，暂不能删除", {
      outputId,
      referenceOutputIds: references.map((item) => item.outputId)
    }, 409);
  }
  const report = (Array.isArray(batch.stitchReports) ? batch.stitchReports : [])
    .find((item) => item.outputId === outputId);
  const saved = await writeBatch(context, {
    ...batch,
    deletedOutputIds: [...new Set([...(batch.deletedOutputIds || []), outputId])],
    outputs: batch.outputs.filter((item) => item.outputId !== outputId),
    stitchReports: (batch.stitchReports || []).filter((item) => item.outputId !== outputId)
  }, "manual_stitch_manage");
  const outputPath = manualStitchFullPath(context, output.filePath);
  await removeWangzhuanAssetFromObjectStorage(context, outputPath);
  await rm(outputPath, { force: true });
  if (report?.reportPath) {
    await rm(manualStitchFullPath(context, report.reportPath, "reportPath"), { force: true });
  }
  await telemetryRecorder(context)("manual_stitch_version_deleted", {
    batchId: batch.batchId,
    outputId
  }, { audit: true }).catch(() => {});
  return { batch: saved, deletedOutputId: outputId };
}

function hashPayload(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {}), "utf8").digest("hex");
}

async function retryStitchOnce(context, batchId) {
  const batch = await readBatch(context, batchId);
  const hasPostProcessFailures = Array.isArray(batch.postProcessFailures) && batch.postProcessFailures.length > 0;
  const canRetryCompletedPostProcess = batch.status === "qc" && hasPostProcessFailures;
  if (!["partial_failed", "stitching"].includes(batch.status) && !canRetryCompletedPostProcess) {
    throw new WangzhuanError("invalid_state_transition", "当前状态不支持拼接重试", { batchId, status: batch.status });
  }
  if (canRetryCompletedPostProcess) {
    await writeBatch(context, { ...batch, status: "partial_failed" }, "qc_partial_failed");
  }
  return stitchBatchSegments(context, batchId, { replaceDerivedOutputs: true });
}

async function replayStitchResponse(context, summary = {}) {
  const batchId = summary?.batch?.batchId || summary?.batchId || "";
  const batch = await readBatch(context, batchId);
  return stitchResult(context, batchId, batch);
}

export async function retryStitch(context, batchId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  validateBatchId(batchId);
  const requestHash = hashPayload({ batchId, forceFail: request.forceFail === true });
  return runIdempotentOperation(
    context,
    "retry_stitch",
    request.idempotencyKey,
    requestHash,
    () => retryStitchOnce(context, batchId),
    { resourceType: "batch", replayResponse: (summary) => replayStitchResponse(context, summary) }
  );
}

export const __stitchTestHooks = {
  probeVideoWidth,
  probeVideoStreamHealth,
  assertDecodableVideo,
  resolveDisclaimerOverlay,
  resolveDisclaimerOverlayImagePath,
  postProcessTimeoutMs,
  applyDisclaimerOverlay,
  applyVolcengineSubtitles,
  concatSegmentVideos,
  createPostProcessEndingVideo,
  deriveExpandedOutputs
};
