import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

import { getChannelRules } from "./channel-rules.mjs";
import { REQUIRED_STRONG_TRUTH_FIELDS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { llmSupportsVideoUrl, resolveQcLlmConfig } from "./llm-config.mjs";
import { hasWangzhuanFactsStore, loadBatchDetailFromMysql, syncBatchFacts } from "./mysql-facts.mjs";
import { toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import { buildPublicUrl } from "../object-storage.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_LLM_TIMEOUT_MS = 180000;
const DEFAULT_GENERATED_FRAME_COUNT = 3;
const MAX_GENERATED_FRAME_COUNT = 6;
const DEFAULT_MAX_LOCAL_VIDEO_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL_QC_THRESHOLD = 0.7;

const SCRIPT_REQUIRED_FIELDS = Object.freeze([
  "scriptId",
  "batchId",
  "variantIndex",
  "segmentIndex",
  "durationSec",
  "hook",
  "body",
  "cta",
  "ending",
  "promptPath",
  "scriptPath"
]);

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

async function writeBatch(context, batch) {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const synced = await syncBatchFacts(context, next, "qc_completed");
  if (synced?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存业务状态");
  }
  return next;
}

function resolveUserPath(context, relativePath) {
  if (!relativePath || String(relativePath).match(/^[A-Za-z]:[\\/]|^\//)) {
    throw new WangzhuanError("validation_error", "文件路径不合法", { path: relativePath });
  }
  const root = resolve(context.userProjectRoot);
  const target = resolve(root, String(relativePath));
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new WangzhuanError("validation_error", "文件路径越界", { path: relativePath });
  }
  return target;
}

async function readNonEmptyText(target) {
  if (!existsSync(target)) return "";
  return (await readFile(target, "utf8")).trim();
}

function check(checkId, status, message, field = "") {
  return {
    checkId,
    status,
    severity: status === "pass" ? "info" : status,
    message,
    ...(field ? { field } : {})
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clampInteger(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanText(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeJson(value, max = 4000) {
  if (value === undefined || value === null || value === "") return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function mimeForExt(ext) {
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function externalHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function directObjectStorageUrl(storageKey) {
  const key = String(storageKey || "").replace(/^\/+/, "");
  if (!key) return "";
  if (externalHttpUrl(process.env.S3_PUBLIC_BASE_URL)) {
    return buildPublicUrl(key, process.env);
  }
  const bucket = String(process.env.S3_BUCKET || "").trim();
  const region = String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim();
  if (!bucket || !region) return "";
  const endpoint = String(process.env.S3_ENDPOINT || "").trim();
  const forcePathStyle = ["1", "true", "yes", "on"].includes(String(process.env.S3_FORCE_PATH_STYLE || "").trim().toLowerCase());
  const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  if (endpoint) {
    const url = new URL(endpoint);
    if (forcePathStyle) return `${url.origin.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}/${encodedKey}`;
    return `${url.protocol}//${bucket}.${url.host}/${encodedKey}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function resolveModelFileUrl(asset = {}) {
  return externalHttpUrl(asset.storageUrl) || externalHttpUrl(asset.previewUrl) || directObjectStorageUrl(asset.storageKey) || "";
}

function generatedFrameTimestamps(durationSec, frameCount) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0 || frameCount <= 0) return [];
  if (frameCount === 1) return [Math.max(0, Math.round(Math.min(duration * 0.5, duration - 0.1) * 100) / 100)];
  const start = Math.min(0.5, Math.max(0, duration - 0.1));
  const end = Math.max(start, duration - 0.25);
  return Array.from({ length: frameCount }, (_, index) => {
    const raw = start + ((end - start) * index) / Math.max(1, frameCount - 1);
    return Math.round(raw * 100) / 100;
  });
}

function usableVisionFrames(frames = []) {
  return frames.filter((frame) => typeof frame?.dataUrl === "string" && frame.dataUrl.startsWith("data:image/"));
}

async function ffmpegExtractGeneratedFrames(filePath, timestampsSec, { timeoutMs = 20000 } = {}) {
  if (!existsSync(filePath)) {
    throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  }
  const frames = [];
  const frameDir = join(parse(filePath).dir, "qc-llm-frames");
  await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(frameDir, { recursive: true });
  try {
    for (let index = 0; index < timestampsSec.length; index += 1) {
      const timestampSec = timestampsSec[index];
      const framePath = join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          filePath,
          "-ss",
          String(timestampSec),
          "-frames:v",
          "1",
          "-vf",
          "scale='min(720,iw)':-2",
          "-q:v",
          "3",
          framePath
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: timeoutMs,
          windowsHide: true
        });
        const buffer = await readFile(framePath);
        if (buffer.length) {
          frames.push({
            index,
            timestampSec,
            mimeType: "image/jpeg",
            dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`
          });
        }
      } catch {
        // Skip individual frame samples; caller can fall back to inline video input.
      }
    }
  } finally {
    await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!frames.length && timestampsSec.length) {
    throw new Error(`generated frame samples missing for '${filePath}'`);
  }
  return frames;
}

async function extractGeneratedFrames(context, filePath, timestampsSec, output) {
  if (!timestampsSec.length) return [];
  if (typeof context.extractGeneratedVideoFrames === "function") {
    return context.extractGeneratedVideoFrames({ filePath, timestampsSec, output });
  }
  const timeoutMs = numberOrZero(context.config?.wangzhuan?.llm?.frameExtractTimeoutMs) || 20000;
  return ffmpegExtractGeneratedFrames(filePath, timestampsSec, { timeoutMs });
}

async function readLocalVideoDataUrl(videoPath, mimeType, maxBytes) {
  const info = await stat(videoPath);
  if (info.size > maxBytes) {
    throw new WangzhuanError("model_failed", "本地生成视频过大，无法进行模型质检", {
      inputMode: "file_data",
      reason: `size=${info.size};max=${maxBytes}`
    });
  }
  const videoBuffer = await readFile(videoPath);
  return `data:${mimeType};base64,${videoBuffer.toString("base64")}`;
}

async function fetchRemoteVideoDataUrl(url, mimeType, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`remote video too large: ${buffer.length}`);
    }
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } finally {
    clearTimeout(timer);
  }
}

async function collectGeneratedVideoVisionInputs(context, output, options = {}) {
  const qcLlmConfig = resolveQcLlmConfig(context.config || {});
  const preferVideoUrl = llmSupportsVideoUrl(qcLlmConfig);
  const forceInlineVideo = options.forceInlineVideo === true;
  const skipRemoteVideoUrl = forceInlineVideo;
  const videoPath = resolveUserPath(context, output.filePath);
  const mimeType = output.mimeType || mimeForExt(extname(videoPath).toLowerCase());
  const fileUrl = resolveModelFileUrl(output);
  const frameCount = clampInteger(
    context.config?.wangzhuan?.llm?.generatedFrameCount ?? context.config?.wangzhuan?.llm?.referenceFrameCount,
    DEFAULT_GENERATED_FRAME_COUNT,
    1,
    MAX_GENERATED_FRAME_COUNT
  );
  const timestampsSec = generatedFrameTimestamps(output.durationSec, frameCount);
  const warnings = [];
  let frames = [];
  try {
    frames = await extractGeneratedFrames(context, videoPath, timestampsSec, output);
  } catch (error) {
    warnings.push({
      code: "generated_frame_extract_failed",
      message: "生成视频抽帧失败，已改为仅传视频文件给模型",
      reason: String(error?.message || error?.code || "unknown").slice(0, 160)
    });
  }
  const usableFrames = usableVisionFrames(frames);
  if (output.storageUrl && !fileUrl) {
    warnings.push({
      code: "generated_video_storage_url_not_external",
      message: "生成视频存储地址不是可外部访问的 HTTP(S) URL，已回退为本地文件输入",
      reason: "storage_url_not_http"
    });
  }
  if (fileUrl && !skipRemoteVideoUrl && (preferVideoUrl || usableFrames.length)) {
    if (preferVideoUrl && !usableFrames.length && warnings.some((warning) => warning.code === "generated_frame_extract_failed")) {
      warnings.push({
        code: "generated_video_url_primary",
        message: "抽帧失败，已改为使用远程视频 URL 给质检模型",
        reason: "prefer_video_url"
      });
    }
    return {
      fileName: basename(videoPath),
      mimeType,
      fileUrl,
      frames: usableFrames,
      timestampsSec,
      warnings
    };
  }
  let info;
  const maxBytes = numberOrZero(context.config?.wangzhuan?.llm?.maxLocalVideoBytes) || DEFAULT_MAX_LOCAL_VIDEO_BYTES;
  try {
    info = await stat(videoPath);
  } catch {
    if (fileUrl) {
      if (skipRemoteVideoUrl) {
        try {
          const fileDataUrl = await fetchRemoteVideoDataUrl(fileUrl, mimeType, maxBytes);
          warnings.push({
            code: "generated_video_remote_inline_fallback",
            message: "本地生成视频不存在，已下载远程视频并以内联方式传给质检模型",
            reason: "chat_completions_requires_file_data"
          });
          return {
            fileName: basename(videoPath),
            mimeType,
            fileDataUrl,
            frames: usableFrames,
            timestampsSec,
            warnings
          };
        } catch (error) {
          if (usableFrames.length) {
            warnings.push({
              code: "generated_video_remote_download_failed",
              message: "远程视频下载失败，模型质检仅使用抽帧画面",
              reason: String(error?.message || error).slice(0, 160)
            });
            return {
              fileName: basename(videoPath),
              mimeType,
              frames: usableFrames,
              timestampsSec,
              warnings
            };
          }
          throw new WangzhuanError("model_failed", "远程视频下载失败，无法进行模型质检", {
            inputMode: "file_data",
            reason: String(error?.message || error).slice(0, 160)
          });
        }
      }
      if (!usableFrames.length) {
        warnings.push({
          code: "generated_video_local_missing",
          message: "本地生成视频不存在，已回退为远程视频地址",
          reason: "local_file_missing"
        });
      }
      return {
        fileName: basename(videoPath),
        mimeType,
        fileUrl,
        frames: usableFrames,
        timestampsSec,
        warnings
      };
    }
    throw new WangzhuanError("missing_required_file", "生成视频文件不存在，无法进行模型质检", {
      filePath: output.filePath
    });
  }
  if (info.size > maxBytes) {
    warnings.push({
      code: "generated_video_too_large_for_inline_input",
      message: "本地生成视频过大，模型质检仅使用抽帧画面",
      reason: `size=${info.size};max=${maxBytes}`
    });
    if (fileUrl && !skipRemoteVideoUrl) {
      if (!usableFrames.length) {
        warnings.push({
          code: "generated_video_inline_fallback_unavailable",
          message: "抽帧失败且本地视频过大，已改为仅传远程视频地址",
          reason: "frames_missing_and_video_too_large"
        });
      }
      return {
        fileName: basename(videoPath),
        mimeType,
        fileUrl,
        frames: usableFrames,
        timestampsSec,
        warnings
      };
    }
    return {
      fileName: basename(videoPath),
      mimeType,
      frames: usableFrames,
      timestampsSec,
      warnings
    };
  }
  if (skipRemoteVideoUrl && fileUrl && !usableFrames.length) {
    warnings.push({
      code: "generated_video_inline_fallback",
      message: "当前质检模型不支持远程视频 URL，已改为内联本地视频给模型",
      reason: "chat_completions_requires_file_data"
    });
  } else if (fileUrl && !usableFrames.length) {
    warnings.push({
      code: "generated_video_inline_fallback",
      message: "抽帧或远程视频不可用，已改为内联本地视频给模型",
      reason: "prefer_local_inline_over_remote_only"
    });
  }
  const fileDataUrl = await readLocalVideoDataUrl(videoPath, mimeType, maxBytes);
  return {
    fileName: basename(videoPath),
    mimeType,
    fileDataUrl,
    frames: usableFrames,
    timestampsSec,
    warnings
  };
}

function tasksForOutput(batch, output) {
  const taskIds = new Set(output.generationTaskIds || []);
  return (Array.isArray(batch.tasks) ? batch.tasks : []).filter((task) => taskIds.has(task.generationTaskId));
}

function scriptsForTasks(batch, tasks, output) {
  const scriptsById = new Map((Array.isArray(batch.scripts) ? batch.scripts : []).map((script) => [script.scriptId, script]));
  const ids = new Set(tasks.map((task) => task.scriptId).filter(Boolean));
  if (output.scriptId) ids.add(output.scriptId);
  return [...ids].map((scriptId) => scriptsById.get(scriptId)).filter(Boolean);
}

async function scriptSchemaCheck(context, batch, output, tasks) {
  const scripts = scriptsForTasks(batch, tasks, output);
  if (!scripts.length) {
    return check("script_schema", "fail", "输出缺少关联脚本", "scripts");
  }
  for (const script of scripts) {
    const missing = SCRIPT_REQUIRED_FIELDS.filter((field) => {
      const value = script[field];
      return value === undefined || value === null || value === "";
    });
    if (missing.length) {
      return check("script_schema", "fail", `脚本缺少字段：${missing.join(",")}`, "scripts");
    }
    if (!existsSync(resolveUserPath(context, script.scriptPath))) {
      return check("script_schema", "fail", "脚本文件不存在", "scriptPath");
    }
  }
  return check("script_schema", "pass", "脚本结构完整");
}

function templateSnapshotCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (!batch.templateSnapshot?.templateId || !batch.templateSnapshot?.versionId || !draft.productName) {
    return check("template_snapshot", "fail", "模板快照缺少 templateId/versionId/productName", "templateSnapshot");
  }
  return check("template_snapshot", "pass", "模板快照完整");
}

async function promptSchemaCheck(context, tasks) {
  if (!tasks.length) {
    return check("prompt_schema", "fail", "输出缺少关联任务", "tasks");
  }
  for (const task of tasks) {
    const seedancePrompt = resolveUserPath(context, task.promptPath);
    const imagePrompt = join(dirname(seedancePrompt), `${task.generationTaskId}_image.txt`);
    if (!(await readNonEmptyText(seedancePrompt))) {
      return check("prompt_schema", "fail", "Seedance prompt 缺失或为空", "promptPath");
    }
    if (!(await readNonEmptyText(imagePrompt))) {
      return check("prompt_schema", "fail", "Image prompt 缺失或为空", "promptPath");
    }
  }
  return check("prompt_schema", "pass", "prompt 文件存在且非空");
}

function taskIdPresenceCheck(tasks) {
  if (!tasks.length) return check("task_id_presence", "fail", "输出缺少关联任务", "generationTaskIds");
  if (tasks.some((task) => !task.seedanceTaskId)) {
    return check("task_id_presence", "fail", "Seedance task_id 缺失", "seedanceTaskId");
  }
  return check("task_id_presence", "pass", "上游 task_id 已记录");
}

function videoSpecCheck(context, output) {
  if (![15, 30].includes(Number(output.durationSec)) || !output.kind) {
    return check("video_spec", "fail", "输出缺少时长或类型记录", "output");
  }
  if (!existsSync(resolveUserPath(context, output.filePath))) {
    return check("video_spec", "fail", "输出文件不存在", "filePath");
  }
  return check("video_spec", "pass", "输出文件和规格记录存在");
}

async function stitchReportPresenceCheck(context, batch, output) {
  if (output.kind !== "stitched_video" && Number(output.durationSec) !== 30) return null;
  if (!output.stitchReportPath) {
    return check("stitch_report_presence", "fail", "30s 输出缺少 stitch report 路径", "stitchReportPath");
  }
  const reportTarget = resolveUserPath(context, output.stitchReportPath);
  if (!existsSync(reportTarget)) {
    return check("stitch_report_presence", "fail", "30s 输出缺少 stitch report 文件", "stitchReportPath");
  }
  const report = JSON.parse(await readFile(reportTarget, "utf8"));
  if (report.outputId !== output.outputId || report.status !== "succeeded") {
    return check("stitch_report_presence", "fail", "stitch report 与输出不匹配或未成功", "stitchReport");
  }
  const knownReport = (batch.stitchReports || []).find((item) => item.outputId === output.outputId);
  if (!knownReport) {
    return check("stitch_report_presence", "fail", "batch manifest 未记录 stitch report", "stitchReports");
  }
  return check("stitch_report_presence", "pass", "30s stitch report 存在且成功");
}

function scriptPolicyText(script = {}) {
  return [
    script.hook,
    script.body,
    script.cta,
    script.ending,
    script.rewardExpression,
    script.voiceover,
    ...(Array.isArray(script.subtitles) ? script.subtitles : []),
    ...(Array.isArray(script.complianceNotes) ? script.complianceNotes : [])
  ].filter(Boolean).join("\n");
}

function textForPolicy(batch, tasks) {
  const scriptsById = new Map((Array.isArray(batch.scripts) ? batch.scripts : []).map((script) => [script.scriptId, script]));
  return tasks
    .map((task) => scriptsById.get(task.scriptId))
    .filter(Boolean)
    .map((script) => scriptPolicyText(script))
    .join("\n")
    .toLowerCase();
}

function scriptReviewSummary(scripts = []) {
  return scripts.map((script) => ({
    scriptId: script.scriptId,
    branchId: script.branchId || "",
    branchLabel: script.branchLabel || "",
    branchVariantIndex: script.branchVariantIndex || script.variantIndex || 1,
    segmentIndex: script.segmentIndex || 1,
    durationSec: script.durationSec || 15,
    hook: script.hook || "",
    body: script.body || "",
    cta: script.cta || "",
    ending: script.ending || "",
    rewardExpression: script.rewardExpression || "",
    materialDirection: script.branchDraft?.materialDirection || "",
    voiceoverStyle: script.branchDraft?.voiceoverStyle || "",
    branchProductName: script.branchDraft?.productName || ""
  }));
}

function taskReviewSummary(tasks = []) {
  return tasks.map((task) => ({
    generationTaskId: task.generationTaskId,
    scriptId: task.scriptId,
    branchId: task.branchId || "",
    branchLabel: task.branchLabel || "",
    segmentIndex: task.segmentIndex || 1,
    provider: task.provider || "seedance",
    modelVideo: task.modelVideo || "",
    seedanceTaskId: task.seedanceTaskId || "",
    requestSummary: task.requestSummary || null,
    responseSummary: task.responseSummary || null
  }));
}

function templateReviewSummary(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  return {
    templateId: batch.templateSnapshot?.templateId || "",
    versionId: batch.templateSnapshot?.versionId || "",
    productName: draft.productName || "",
    cta: draft.cta || "",
    ending: draft.ending || "",
    currencySymbol: draft.currencySymbol || "",
    language: draft.language || "",
    regions: Array.isArray(draft.regions) ? draft.regions : [],
    targetChannels: Array.isArray(draft.targetChannels) ? draft.targetChannels : [],
    promiseLevel: draft.promiseLevel || "",
    materialDirection: draft.materialDirection || "",
    voiceoverStyle: draft.voiceoverStyle || "",
    truthRules: draft.truthRules || {}
  };
}

function generatedVideoProbePrompt(output, visionInputs) {
  return [
    `outputId：${output.outputId}`,
    `kind：${output.kind || "-"}`,
    `sourceType：${output.sourceType || "-"}`,
    `durationSec：${output.durationSec || "-"}`,
    `branchId：${output.branchId || "-"}`,
    `branchLabel：${output.branchLabel || "-"}`,
    `branchVariantIndex：${output.branchVariantIndex || "-"}`,
    `generationTaskIds：${(output.generationTaskIds || []).join(", ") || "-"}`,
    `modelInputMode：${visionInputs.fileUrl ? "file_url" : visionInputs.fileDataUrl ? "file_data" : "frames_only"}`,
    `sampledFrameCount：${visionInputs.frames?.length || 0}`
  ].join("\n");
}

function buildGeneratedVideoQcMessages(batch, output, tasks, scripts, llmConfig, visionInputs) {
  const promptText = [
    "请对生成好的视频做网赚素材视觉质检，判断它是否达到本批次的生成效果要求。",
    "",
    "生成视频信息：",
    generatedVideoProbePrompt(output, visionInputs),
    "",
    "参考视频拆解要求：",
    safeJson(batch.decomposition || {}, 6000),
    "",
    "模板和裂变子节点配置：",
    safeJson(templateReviewSummary(batch), 6000),
    "",
    "本输出关联脚本：",
    safeJson(scriptReviewSummary(scripts), 10000),
    "",
    "本输出关联 Seedance 任务摘要：",
    safeJson(taskReviewSummary(tasks), 12000),
    "",
    `模型配置：provider=${llmConfig.provider || "unknown"}，model=${llmConfig.model || "unknown"}`,
    "",
    "质检标准：",
    "1. 必须结合生成视频/抽帧画面判断，不要只看文字配置。",
    "2. 判断画面是否符合拆解里的 scene/subject/action/camera/lighting/style/quality/hook。",
    "3. 判断是否体现脚本要求的产品名、收益/奖励反馈、CTA、口播/字幕/镜头节奏等核心转化点。",
    "4. 判断是否明显偏离 Seedance prompt、裂变子节点配置、目标语言/地区/渠道规则。",
    "5. 如出现空画面、严重穿帮、主体缺失、文案不符、产品或奖励反馈缺失、过度夸大收益、疑似侵权复刻，应判为不通过。",
    "",
    "只返回 JSON 对象，字段：",
    JSON.stringify({
      passed: "boolean，整体是否可进入下载交付",
      score: "0-1 的数字，低于阈值通常不通过",
      summary: "中文一句话质检结论",
      matched: ["已达标的要点"],
      issues: [{ code: "问题编码", severity: "minor|major|critical", message: "问题说明" }],
      recommendedAction: "approve|regenerate|manual_review"
    }, null, 2)
  ].join("\n");
  const userContent = [{ type: "text", text: promptText }];
  if (visionInputs.fileUrl) {
    userContent.push({
      type: "file",
      file: {
        filename: visionInputs.fileName || `${output.outputId}.mp4`,
        file_url: visionInputs.fileUrl
      }
    });
  } else if (visionInputs.fileDataUrl) {
    userContent.push({
      type: "file",
      file: {
        filename: visionInputs.fileName || `${output.outputId}.mp4`,
        file_data: visionInputs.fileDataUrl
      }
    });
  }
  for (const frame of visionInputs.frames || []) {
    userContent.push({
      type: "image_url",
      image_url: { url: frame.dataUrl }
    });
  }
  return [
    {
      role: "system",
      content: [
        "你是短视频广告生成结果的资深质检员。",
        "你必须严格基于生成视频画面、抽帧和配置目标做判断。",
        "你只输出严格 JSON 对象，不要 markdown，不要解释。",
        "若画面与脚本/拆解目标不一致，宁可判为不通过或人工复核。"
      ].join("\n")
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

function parseLlmJsonContent(content) {
  const text = String(content || "").trim();
  if (!text) {
    throw new WangzhuanError("model_failed", "模型没有返回视频质检内容", { reason: "empty_content" });
  }
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
    text.match(/\{[\s\S]*\}/)?.[0]
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate form.
    }
  }
  throw new WangzhuanError("model_failed", "模型返回不是合法 JSON，请重试或手动复核", { reason: "invalid_json" });
}

function chatCompletionsUrl(endpoint) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function responsesUrl(endpoint) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  if (clean.endsWith("/responses")) return clean;
  if (clean.endsWith("/chat/completions")) return clean.replace(/\/chat\/completions$/, "/responses");
  return `${clean}/responses`;
}

function llmResponseText(payload = {}) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
      .filter(Boolean)
      .join("\n");
  }
  return typeof payload?.output_text === "string" ? payload.output_text : "";
}

function responsesInputFromMessages(messages = []) {
  return messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
        if (part?.type === "text") return { type: "input_text", text: part.text || "" };
        if (part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url || "" };
        if (part?.type === "file") {
          return {
            type: "input_file",
            filename: part.file?.filename || "generated-video.mp4",
            ...(part.file?.file_url ? { file_url: part.file.file_url } : { file_data: part.file?.file_data || "" })
          };
        }
        return part;
      })
      : [{ type: "input_text", text: String(message.content || "") }]
  }));
}

function canUseResponsesInput(messages = []) {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file"));
}

function dropFileParts(messages = []) {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter((part) => part?.type !== "file")
      : message.content
  }));
}

function modelInputMode(messages = []) {
  const hasFileUrlInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_url));
  const hasFileDataInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_data));
  return hasFileUrlInput ? "file_url" : hasFileDataInput ? "file_data" : "frames_only";
}

async function callOpenAiCompatibleLlm(llmConfig, messages) {
  if (!llmConfig.apiKey) {
    const apiKeyEnv = llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY";
    throw new WangzhuanError("model_failed", "未配置视频质检模型 API Key", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      apiKeyEnv,
      upstreamMessage: `未配置模型 API Key，请在环境变量 ${apiKeyEnv} 中配置后重启服务`
    });
  }
  const controller = new AbortController();
  const timeoutMs = numberOrZero(llmConfig.timeoutMs) || DEFAULT_LLM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let payload = {};
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${llmConfig.apiKey}`
  };
  const responsesPayload = {
    model: llmConfig.model,
    input: responsesInputFromMessages(messages),
    temperature: llmConfig.temperature,
    text: { format: { type: "json_object" } }
  };
  const chatMessages = canUseResponsesInput(messages) ? dropFileParts(messages) : messages;
  const chatPayload = {
    model: llmConfig.model,
    messages: chatMessages,
    temperature: llmConfig.temperature,
    response_format: { type: "json_object" }
  };
  const useResponses = canUseResponsesInput(messages);
  const inputMode = modelInputMode(messages);
  try {
    response = await fetch(useResponses ? responsesUrl(llmConfig.endpoint) : chatCompletionsUrl(llmConfig.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(useResponses ? responsesPayload : chatPayload),
      signal: controller.signal
    });
    payload = await response.json().catch(() => ({}));
    if (useResponses && ([400, 404, 415, 422].includes(response.status) || response.status >= 500)) {
      response = await fetch(chatCompletionsUrl(llmConfig.endpoint), {
        method: "POST",
        headers,
        body: JSON.stringify(chatPayload),
        signal: controller.signal
      });
      payload = await response.json().catch(() => ({}));
    }
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    throw new WangzhuanError("model_failed", reason === "timeout" ? "视频质检模型请求超时" : "视频质检模型请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      inputMode,
      reason
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new WangzhuanError("model_failed", "视频质检模型请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      status: response.status,
      inputMode,
      upstreamMessage: String(payload?.error?.message || payload?.message || "").slice(0, 300)
    });
  }
  return llmResponseText(payload);
}

function normalizeModelReview(raw = {}, llmConfig = {}, visionInputs = {}, warnings = []) {
  const score = Math.max(0, Math.min(1, Number(raw.score ?? raw.matchScore ?? 0)));
  const threshold = DEFAULT_MODEL_QC_THRESHOLD;
  const issues = Array.isArray(raw.issues)
    ? raw.issues.map((issue, index) => ({
      code: cleanText(issue?.code || `issue_${index + 1}`, 80),
      severity: cleanText(issue?.severity || "major", 24),
      message: cleanText(issue?.message || issue?.description || issue, 500)
    })).filter((issue) => issue.message)
    : [];
  const passed = raw.passed === true || (raw.passed !== false && score >= threshold && issues.every((issue) => issue.severity === "minor"));
  return {
    provider: llmConfig.provider,
    model: llmConfig.model,
    passed,
    score,
    threshold,
    summary: cleanText(raw.summary || raw.conclusion || (passed ? "模型视频质检通过" : "模型视频质检未通过"), 600),
    matched: Array.isArray(raw.matched) ? raw.matched.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 20) : [],
    issues,
    recommendedAction: cleanText(raw.recommendedAction || (passed ? "approve" : "regenerate"), 80),
    inputMode: visionInputs.fileUrl ? "file_url" : visionInputs.fileDataUrl ? "file_data" : "frames_only",
    frameCount: visionInputs.frames?.length || 0,
    warnings
  };
}

function modelReviewCheck(modelReview) {
  if (!modelReview) return null;
  if (modelReview.passed) {
    return check("model_video_qc", "pass", `模型视频质检通过：${modelReview.summary}`);
  }
  return check("model_video_qc", "fail", `模型视频质检未通过：${modelReview.summary}`, "modelReview");
}

function shouldRunModelVideoQc(context, batch, output) {
  if (output.sourceType !== "pipeline") return false;
  if (!output.filePath) return false;
  const isFinalStitchedOutput = output.kind === "stitched_video";
  const isFinalSingleSegmentOutput = Number(batch.estimate?.durationSec) === 15 && Number(output.durationSec) === 15;
  if (!isFinalStitchedOutput && !isFinalSingleSegmentOutput) return false;
  if (typeof context.callWangzhuanLlm === "function" || typeof context.callWangzhuanQcLlm === "function") return true;
  const qcLlm = context.config?.wangzhuan?.qcLlm;
  const llm = context.config?.wangzhuan?.llm;
  if (qcLlm && typeof qcLlm === "object") return true;
  return Boolean(llm && typeof llm === "object");
}

async function runModelVideoQc(context, batch, output, tasks, scripts, options = {}) {
  const llmConfig = resolveQcLlmConfig(context.config || {});
  const visionInputs = await collectGeneratedVideoVisionInputs(context, output, options);
  if (!visionInputs.fileUrl && !visionInputs.fileDataUrl && !(visionInputs.frames || []).length) {
    throw new WangzhuanError("model_failed", "视频质检缺少可供模型分析的视频或抽帧输入", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      inputMode: "none"
    });
  }
  const messages = buildGeneratedVideoQcMessages(batch, output, tasks, scripts, llmConfig, visionInputs);
  const publicLlmConfig = {
    provider: llmConfig.provider,
    endpoint: llmConfig.endpoint,
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    timeoutMs: llmConfig.timeoutMs,
    apiKeyEnv: llmConfig.apiKeyEnv
  };
  const content = typeof context.callWangzhuanQcLlm === "function"
    ? await context.callWangzhuanQcLlm({
      messages,
      llmConfig: publicLlmConfig,
      generatedVideo: {
        ...output,
        fileUrl: visionInputs.fileUrl,
        fileDataUrl: visionInputs.fileDataUrl,
        frameCount: visionInputs.frames.length
      },
      visionInputs,
      output,
      batch,
      tasks,
      scripts
    })
    : typeof context.callWangzhuanLlm === "function"
      ? await context.callWangzhuanLlm({
        messages,
        llmConfig: publicLlmConfig,
        generatedVideo: {
          ...output,
          fileUrl: visionInputs.fileUrl,
          fileDataUrl: visionInputs.fileDataUrl,
          frameCount: visionInputs.frames.length
        },
        visionInputs,
        output,
        batch,
        tasks,
        scripts
      })
      : await callOpenAiCompatibleLlm(llmConfig, messages);
  return normalizeModelReview(parseLlmJsonContent(content), publicLlmConfig, visionInputs, visionInputs.warnings || []);
}

function productTextReplacementCheck(batch, tasks) {
  const productName = String(batch.templateSnapshot?.draft?.productName || "").trim().toLowerCase();
  const text = textForPolicy(batch, tasks);
  if (!productName || !text.includes(productName)) {
    return check("product_text_replacement", "warn", "脚本未明显包含模板产品名", "templateSnapshot.draft.productName");
  }
  return check("product_text_replacement", "pass", "脚本文案使用模板产品名");
}

function currencyLocaleCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (!draft.currencySymbol || !draft.language || !Array.isArray(draft.regions) || !draft.regions.length) {
    return check("currency_locale", "fail", "模板缺少货币、语言或地区", "templateSnapshot.draft");
  }
  return check("currency_locale", "pass", "货币、语言和地区字段存在");
}

function strongPromiseTruthRulesCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (draft.promiseLevel !== "strong_commitment") {
    return check("strong_promise_truth_rules", "pass", "非强承诺模板无需七字段检查");
  }
  const missing = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !String(draft.truthRules?.[field] || "").trim());
  if (missing.length) {
    return check("strong_promise_truth_rules", "fail", `强承诺缺少字段：${missing.join(",")}`, "truthRules");
  }
  return check("strong_promise_truth_rules", "pass", "强承诺真实规则完整");
}

async function channelRuleCheck(context, batch, tasks) {
  const draft = batch.templateSnapshot?.draft || {};
  const channel = draft.targetChannels?.[0] || "generic";
  const rules = await getChannelRules(context, { channel, promiseLevel: draft.promiseLevel || "stable" });
  const text = textForPolicy(batch, tasks);
  const forbidden = rules.rules.flatMap((rule) => rule.forbiddenTerms || []);
  const hit = forbidden.find((term) => term && text.includes(String(term).toLowerCase()));
  if (hit) return check("channel_rule", "fail", `触发渠道禁用词：${hit}`, "channelRule");
  const requiredDisclaimers = [...new Set(rules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
  const missingDisclaimer = requiredDisclaimers.find((item) => item && !text.includes(String(item).toLowerCase()));
  if (missingDisclaimer) {
    return check("channel_rule", "fail", `缺少渠道免责声明：${missingDisclaimer}`, "channelRule.requiredDisclaimers");
  }
  return check("channel_rule", "pass", "未触发渠道禁用词");
}

function qcStatusFromChecks(checks) {
  if (checks.some((item) => item.status === "fail")) return "fail";
  if (checks.some((item) => item.status === "manual_required")) return "manual_required";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function downloadEligibility(batch, output, qcStatus) {
  if (qcStatus !== "pass") return false;
  if (output.sourceType !== "pipeline") return false;
  if (output.kind === "stitched_video" && Number(output.durationSec) === 30) return true;
  if (Number(batch.estimate?.durationSec) === 15 && Number(output.durationSec) === 15) return true;
  return false;
}

async function qcReportForOutput(context, batch, output) {
  const tasks = tasksForOutput(batch, output);
  const scripts = scriptsForTasks(batch, tasks, output);
  const checks = [
    await scriptSchemaCheck(context, batch, output, tasks),
    templateSnapshotCheck(batch),
    productTextReplacementCheck(batch, tasks),
    currencyLocaleCheck(batch),
    await channelRuleCheck(context, batch, tasks),
    strongPromiseTruthRulesCheck(batch),
    await promptSchemaCheck(context, tasks),
    taskIdPresenceCheck(tasks),
    videoSpecCheck(context, output)
  ];
  const stitchCheck = await stitchReportPresenceCheck(context, batch, output);
  if (stitchCheck) checks.push(stitchCheck);
  let modelReview = null;
  if (shouldRunModelVideoQc(context, batch, output) && !checks.some((item) => item.status === "fail")) {
    try {
      modelReview = await runModelVideoQc(context, batch, output, tasks, scripts);
      const modelCheck = modelReviewCheck(modelReview);
      if (modelCheck) checks.push(modelCheck);
    } catch (error) {
      const shouldRetryInline = error?.data?.inputMode === "file_url"
        || String(error?.data?.upstreamMessage || error?.message || "").includes("file_data");
      if (shouldRetryInline) {
        try {
          modelReview = await runModelVideoQc(context, batch, output, tasks, scripts, { forceInlineVideo: true });
          const modelCheck = modelReviewCheck(modelReview);
          if (modelCheck) checks.push(modelCheck);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (!modelReview) {
        modelReview = {
          provider: error?.data?.provider || resolveQcLlmConfig(context.config || {}).provider,
          model: error?.data?.model || resolveQcLlmConfig(context.config || {}).model,
          passed: false,
          score: 0,
          threshold: DEFAULT_MODEL_QC_THRESHOLD,
          summary: cleanText(error?.message || "视频质检模型请求失败", 600),
          matched: [],
          issues: [{
            code: error?.code || "model_failed",
            severity: "critical",
            message: cleanText(error?.data?.upstreamMessage || error?.message || "视频质检模型请求失败", 600)
          }],
          recommendedAction: "manual_review",
          inputMode: error?.data?.inputMode || "",
          frameCount: 0,
          warnings: []
        };
        checks.push(check("model_video_qc", "fail", `模型视频质检失败：${modelReview.summary}`, "modelReview"));
      }
    }
  }
  const qcStatus = qcStatusFromChecks(checks);
  return {
    schemaVersion: "qc_report.v1",
    outputId: output.outputId,
    sourceType: output.sourceType,
    ...(output.batchId ? { batchId: output.batchId } : {}),
    ...(output.remixId ? { remixId: output.remixId } : {}),
    qcStatus,
    visualPreviewRequired: Boolean(output.visualPreviewRequired),
    previewConfirmed: Boolean(output.previewConfirmed),
    checks,
    ...(modelReview ? { modelReview } : {}),
    summary: modelReview?.summary || (qcStatus === "pass" ? "QC passed" : "QC requires attention"),
    createdAt: new Date().toISOString()
  };
}

function batchStatusFromReports(reports) {
  if (!reports.length) return "qc";
  if (reports.every((report) => report.qcStatus === "pass")) return "succeeded";
  if (reports.every((report) => report.qcStatus === "fail")) return "failed";
  return "partial_failed";
}

export async function runBatchQc(context, batchId) {
  const batch = await readBatch(context, batchId);
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const reports = [];
  const nextOutputs = [];

  for (const output of outputs) {
    const report = await qcReportForOutput(context, batch, output);
    const reportTarget = join(batchDir(context, batch.batchId), "qc", `${output.outputId}.json`);
    await writeAtomicJson(reportTarget, report);
    await recordTelemetryEvent(context, "qc_completed", {
      outputId: output.outputId,
      batchId: batch.batchId,
      sourceType: output.sourceType,
      qcStatus: report.qcStatus,
      checkFailureCodes: report.checks.filter((item) => item.status !== "pass").map((item) => item.checkId)
    });
    reports.push(report);
    nextOutputs.push({
      ...output,
      qcStatus: report.qcStatus,
      downloadEligible: downloadEligibility(batch, output, report.qcStatus),
      qcReportPath: toProjectRelative(context.userProjectRoot, reportTarget),
      qcChecks: report.checks,
      qcSummary: report.summary,
      ...(report.modelReview ? {
        modelQcSummary: {
          provider: report.modelReview.provider,
          model: report.modelReview.model,
          passed: report.modelReview.passed,
          score: report.modelReview.score,
          summary: report.modelReview.summary,
          issueCodes: report.modelReview.issues.map((issue) => issue.code),
          recommendedAction: report.modelReview.recommendedAction
        }
      } : {})
    });
  }

  const failed = reports.filter((report) => report.qcStatus === "fail" || report.qcStatus === "manual_required").length;
  const warningReports = reports.filter((report) => report.qcStatus === "warn");
  const nextBatch = await writeBatch(context, {
    ...batch,
    status: batchStatusFromReports(reports),
    outputs: nextOutputs,
    qcSummary: {
      total: reports.length,
      passed: reports.filter((report) => report.qcStatus === "pass").length,
      failed,
      warnings: warningReports.map((report) => ({ outputId: report.outputId, qcStatus: report.qcStatus }))
    }
  });

  return {
    batch: nextBatch,
    reports,
    downloadSummary: {
      outputsTotal: nextOutputs.length,
      downloadEligibleCount: nextOutputs.filter((item) => item.downloadEligible).length,
      packageReady: nextOutputs.some((item) => item.downloadEligible),
      missingFiles: []
    }
  };
}
