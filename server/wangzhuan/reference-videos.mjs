import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { effectiveLimits } from "./config.mjs";
import { WangzhuanError } from "./http.mjs";
import { resolveLlmConfig } from "./llm-config.mjs";
import {
  hasWangzhuanFactsStore,
  loadReferenceVideoProbeFromMysql,
  loadVideoDecompositionFromMysql,
  nextReferenceVideoIdFromMysql,
  syncReferenceVideoFact,
  syncVideoDecompositionFact
} from "./mysql-facts.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import { buildPublicUrl } from "../object-storage.mjs";
import { flattenDecompositionFieldValue } from "./decomposition-text.mjs";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/mov"]);
const execFileAsync = promisify(execFile);
const DEFAULT_LLM_TIMEOUT_MS = 180000;
const DEFAULT_REFERENCE_FRAME_COUNT = 5;
const MAX_REFERENCE_FRAME_COUNT = 8;
const DECOMPOSITION_REQUIRED_FIELDS = Object.freeze([
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality",
  "hook"
]);

const DECOMPOSITION_JSON_SCHEMA_HINT = Object.freeze({
  scene: "视频主要场景，说明空间、App 页面或人物所在环境",
  subject: "画面主体，说明人物、手机、产品 UI 或奖励元素",
  action: "核心动作，说明用户行为、镜头推进和转折",
  camera: "镜头语言，说明景别、运镜、节奏",
  lighting: "光线和画面氛围",
  style: "素材风格，例如真人口播、手持演示、UGC、App demo",
  quality: "画质和生成质量要求",
  hook: "前三秒钩子，保留结构但不要照搬竞品文案",
  phoneUi: "可选，手机界面/产品界面重点",
  rewardFeedback: "可选，奖励反馈或转化刺激点",
  cta: "可选，行动号召结构",
  disclaimer: "可选，合规提醒或不能夸大的点"
});

const DECOMPOSITION_FIELD_ALIASES = Object.freeze({
  scene: ["scene", "场景", "主要场景", "视频场景"],
  subject: ["subject", "主体", "画面主体", "主要主体"],
  action: ["action", "动作", "核心动作", "行为", "转化动作"],
  camera: ["camera", "镜头", "镜头语言", "运镜", "拍摄方式"],
  lighting: ["lighting", "光线", "灯光", "氛围", "画面氛围"],
  style: ["style", "风格", "素材风格", "表现风格"],
  quality: ["quality", "画质", "质量", "生成质量", "清晰度"],
  hook: ["hook", "钩子", "前三秒钩子", "开头钩子", "吸引点"],
  phoneUi: ["phoneUi", "phone_ui", "手机界面", "产品界面", "App界面", "APP界面"],
  rewardFeedback: ["rewardFeedback", "reward_feedback", "奖励反馈", "收益反馈", "金币反馈"],
  cta: ["cta", "CTA", "行动号召", "下载引导"],
  disclaimer: ["disclaimer", "合规提醒", "免责声明", "限制说明"]
});

const DECOMPOSITION_CONTAINER_KEYS = Object.freeze([
  "decomposition",
  "video_decomposition",
  "videoDecomposition",
  "script",
  "scriptJson",
  "result",
  "draft",
  "拆解",
  "脚本拆解",
  "视频拆解"
]);

function sanitizeFileName(name) {
  const parsed = parse(basename(name || "reference.mp4"));
  const safeBase = parsed.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "reference";
  const safeExt = parsed.ext.toLowerCase();
  return `${safeBase}${safeExt}`;
}

function parseUploadContent(content) {
  if (typeof content !== "string" || !content.includes(",")) {
    throw new WangzhuanError("validation_error", "上传素材读取失败，请重新选择素材", { field: "content" });
  }
  const base64 = content.split(",").pop();
  const buffer = Buffer.from(base64 || "", "base64");
  if (!buffer.length) {
    throw new WangzhuanError("invalid_video", "视频文件为空", { field: "content" });
  }
  return buffer;
}

function ratioFor(width, height) {
  if (!width || !height) return "";
  const value = width / height;
  if (Math.abs(value - 9 / 16) < 0.03) return "9:16";
  if (Math.abs(value - 16 / 9) < 0.03) return "16:9";
  if (Math.abs(value - 1) < 0.03) return "1:1";
  return `${width}:${height}`;
}

function issue(code, field, message, severity = "error") {
  return { code, field, message, severity };
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

function parseFrameRate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0/0") return 0;
  if (!text.includes("/")) return numberOrZero(text);
  const [rawNum, rawDen] = text.split("/");
  const numerator = Number(rawNum);
  const denominator = Number(rawDen);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function normalizeAudioStream(stream = {}) {
  return {
    codec: String(stream.codec_name || stream.codec || ""),
    sampleRate: numberOrZero(stream.sample_rate ?? stream.sampleRate),
    channels: numberOrZero(stream.channels),
    bitRateBps: numberOrZero(stream.bit_rate ?? stream.bitRateBps)
  };
}

function normalizeProbeResult(raw = {}) {
  const videoStream = Array.isArray(raw.streams)
    ? raw.streams.find((stream) => stream.codec_type === "video")
    : null;
  const audioStreams = Array.isArray(raw.streams)
    ? raw.streams.filter((stream) => stream.codec_type === "audio").map(normalizeAudioStream)
    : Array.isArray(raw.audioStreams) ? raw.audioStreams.map(normalizeAudioStream) : [];
  const durationSec = numberOrZero(raw.durationSec ?? raw.format?.duration ?? videoStream?.duration);
  const width = numberOrZero(raw.width ?? videoStream?.width);
  const height = numberOrZero(raw.height ?? videoStream?.height);
  return {
    durationSec,
    width,
    height,
    formatName: String(raw.formatName ?? raw.format?.format_name ?? ""),
    bitRateBps: numberOrZero(raw.bitRateBps ?? raw.format?.bit_rate),
    videoCodec: String(raw.videoCodec ?? videoStream?.codec_name ?? ""),
    fps: numberOrZero(raw.fps ?? parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate)),
    colorSpace: String(raw.colorSpace ?? videoStream?.color_space ?? videoStream?.color_primaries ?? ""),
    pixelFormat: String(raw.pixelFormat ?? videoStream?.pix_fmt ?? ""),
    audioStreams,
    canExtractFrame: raw.canExtractFrame !== false && Boolean(width && height)
  };
}

function requestMetadataProbe(request = {}) {
  return normalizeProbeResult({
    durationSec: request.durationSec,
    width: request.width,
    height: request.height,
    canExtractFrame: request.canExtractFrame !== false
  });
}

export async function ffprobeMediaFile(filePath, { timeoutMs = 15000, mediaLabel = "媒体文件" } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    }));
  } catch (error) {
    const unavailable = error?.code === "ENOENT";
    throw new WangzhuanError("invalid_video", unavailable ? `ffprobe 未安装，无法检查${mediaLabel}` : `ffprobe 无法读取${mediaLabel}`, {
      field: "ffprobe",
      reason: unavailable ? "not_found" : String(error?.code || "probe_failed")
    });
  }
  try {
    return normalizeProbeResult(JSON.parse(stdout || "{}"));
  } catch {
    throw new WangzhuanError("invalid_video", "ffprobe 返回结果无法解析", { field: "ffprobe" });
  }
}

export async function ffprobeReferenceVideo(filePath, { timeoutMs = 15000 } = {}) {
  return ffprobeMediaFile(filePath, { timeoutMs, mediaLabel: "参考视频" });
}

async function probeReferenceVideo(context, filePath, request) {
  if (typeof context.probeReferenceVideo === "function") {
    return normalizeProbeResult(await context.probeReferenceVideo({ filePath, request }));
  }
  if (context.mockReferenceProbe) {
    return requestMetadataProbe(request);
  }
  const timeoutMs = numberOrZero(context.config?.wangzhuan?.ffprobe?.timeoutMs) || 15000;
  return ffprobeReferenceVideo(filePath, { timeoutMs });
}

export async function checkReferenceVideo(context, request = {}) {
  const paths = wangzhuanPaths(context);
  const limits = effectiveLimits(context.config || {});
  const fileName = sanitizeFileName(request.fileName || request.name);
  const ext = extname(fileName).toLowerCase();
  const mimeType = String(request.mimeType || "").toLowerCase();
  if (!VIDEO_EXTS.has(ext) || (mimeType && !VIDEO_MIME_TYPES.has(mimeType))) {
    throw new WangzhuanError("invalid_video", "视频格式不符合要求", { field: "fileName", allowedExts: [...VIDEO_EXTS] });
  }

  const buffer = parseUploadContent(request.content);
  if (buffer.length > limits.maxUploadVideoBytes) {
    throw new WangzhuanError("file_too_large", "文件超过大小上限", {
      sizeBytes: buffer.length,
      maxUploadVideoBytes: limits.maxUploadVideoBytes
    });
  }

  const referenceVideoId = await nextReferenceVideoIdFromMysql(context);
  if (!referenceVideoId) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存参考视频状态");
  }

  const referenceDir = join(paths.referenceVideosDir, referenceVideoId);
  await mkdir(referenceDir, { recursive: true });
  const originalPath = join(referenceDir, `original${ext}`);
  await writeFile(originalPath, buffer);
  const storage = await syncWangzhuanAsset(context, originalPath, "reference_video", { required: true });

  const mediaProbe = await probeReferenceVideo(context, originalPath, request);
  const durationSec = mediaProbe.durationSec;
  const width = mediaProbe.width;
  const height = mediaProbe.height;
  const canExtractFrame = mediaProbe.canExtractFrame;
  const ratio = ratioFor(width, height);
  const issues = [];

  if (!Number.isFinite(durationSec) || durationSec < limits.minReferenceDurationSec || durationSec > limits.maxReferenceDurationSec) {
    issues.push(issue("invalid_video", "durationSec", `参考视频时长需在 ${limits.minReferenceDurationSec}-${limits.maxReferenceDurationSec}s`));
  }
  if (!width || !height) {
    issues.push(issue("invalid_video", "width", "缺少视频尺寸"));
  } else if (ratio !== "9:16") {
    issues.push(issue("invalid_video", "ratio", "首期推荐 9:16 竖版参考视频", "warn"));
  }
  if (!canExtractFrame) {
    issues.push(issue("invalid_video", "canExtractFrame", "参考视频无法抽帧"));
  }

  const probe = {
    referenceVideoId,
    fileName,
    mimeType: mimeType || mimeForExt(ext),
    sizeBytes: buffer.length,
    durationSec,
    width,
    height,
    ratio,
    formatName: mediaProbe.formatName,
    bitRateBps: mediaProbe.bitRateBps,
    videoCodec: mediaProbe.videoCodec,
    fps: mediaProbe.fps,
    colorSpace: mediaProbe.colorSpace,
    pixelFormat: mediaProbe.pixelFormat,
    audioStreamCount: mediaProbe.audioStreams.length,
    audioStreams: mediaProbe.audioStreams,
    canExtractFrame,
    status: issues.some((item) => item.severity === "error") ? "fail" : issues.length ? "warn" : "pass",
    issues,
    storedPath: toProjectRelative(context.userProjectRoot, originalPath),
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl
  };

  await writeAtomicJson(join(referenceDir, "probe.json"), probe);
  const synced = await syncReferenceVideoFact(context, probe);
  if (synced?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存参考视频状态");
  }
  await recordTelemetryEvent(context, "reference_video_checked", {
    referenceVideoId,
    status: probe.status,
    durationSec: probe.durationSec,
    ratio: probe.ratio,
    issueCodes: probe.issues.map((item) => item.code)
  });

  return { referenceVideo: { ...probe, previewUrl: storage.storageUrl } };
}

function mimeForExt(ext) {
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

export async function loadReferenceVideoProbe(context, referenceVideoId) {
  if (!/^ref_\d{8}_\d{3}$/.test(String(referenceVideoId || ""))) {
    throw new WangzhuanError("reference_video_not_found", "参考视频不存在，请重新上传", { referenceVideoId });
  }
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取参考视频状态");
  }
  const mysqlProbe = await loadReferenceVideoProbeFromMysql(context, referenceVideoId);
  if (!mysqlProbe) {
    throw new WangzhuanError("reference_video_not_found", "参考视频不存在，请重新上传", { referenceVideoId });
  }
  return mysqlProbe;
}

export function validateVideoDecomposition(referenceVideoId, decomposition = {}) {
  const normalized = normalizeVideoDecompositionPayload(decomposition);
  const missingFields = DECOMPOSITION_REQUIRED_FIELDS.filter((field) => {
    const value = normalized[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  return {
    referenceVideoId,
    schemaVersion: "video_decomposition.v1",
    scene: String(normalized.scene || ""),
    subject: String(normalized.subject || ""),
    action: String(normalized.action || ""),
    camera: String(normalized.camera || ""),
    lighting: String(normalized.lighting || ""),
    style: String(normalized.style || ""),
    quality: String(normalized.quality || ""),
    hook: String(normalized.hook || ""),
    ...(normalized.subtitleArea ? { subtitleArea: normalized.subtitleArea } : {}),
    ...(normalized.appIconArea ? { appIconArea: normalized.appIconArea } : {}),
    ...(normalized.phoneUi ? { phoneUi: String(normalized.phoneUi) } : {}),
    ...(normalized.rewardFeedback ? { rewardFeedback: String(normalized.rewardFeedback) } : {}),
    ...(normalized.cta ? { cta: String(normalized.cta) } : {}),
    ...(normalized.disclaimer ? { disclaimer: String(normalized.disclaimer) } : {}),
    missingFields
  };
}

function firstStringValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return flattenDecompositionFieldValue(value.trim());
    if (value && typeof value === "object") return flattenDecompositionFieldValue(value);
  }
  return "";
}

function normalizeVideoDecompositionPayload(raw = {}) {
  const source = DECOMPOSITION_CONTAINER_KEYS.reduce((found, key) => {
    if (found) return found;
    const value = raw?.[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }, null) || raw;
  const normalized = {};
  for (const [field, aliases] of Object.entries(DECOMPOSITION_FIELD_ALIASES)) {
    const value = firstStringValue(source, aliases);
    if (value) normalized[field] = value;
  }
  for (const field of ["subtitleArea", "appIconArea"]) {
    if (source?.[field]) normalized[field] = source[field];
  }
  return normalized;
}

function resolveStoredVideoPath(context, storedPath) {
  const relative = String(storedPath || "").replace(/^[\\/]+/, "");
  if (!relative || relative.includes("..")) {
    throw new WangzhuanError("reference_video_not_found", "参考视频原文件路径无效，请重新上传", { field: "storedPath" });
  }
  return join(context.userProjectRoot, relative);
}

function referenceFrameTimestamps(durationSec, frameCount) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0 || frameCount <= 0) return [];
  if (frameCount === 1) return [Math.max(0, Math.round(Math.min(duration * 0.5, duration - 0.1) * 100) / 100)];
  const end = Math.max(0, duration - 0.1);
  return Array.from({ length: frameCount }, (_, index) => {
    const raw = end * (index / (frameCount - 1));
    return Math.round(raw * 100) / 100;
  });
}

async function ffmpegExtractReferenceFrames(filePath, timestampsSec, { timeoutMs = 20000 } = {}) {
  const frames = [];
  const frameDir = join(parse(filePath).dir, "llm-frames");
  await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(frameDir, { recursive: true });
  try {
    for (let index = 0; index < timestampsSec.length; index += 1) {
      const timestampSec = timestampsSec[index];
      const framePath = join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        String(timestampSec),
        "-i",
        filePath,
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
    }
  } finally {
    await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
  return frames;
}

async function extractReferenceFrames(context, filePath, timestampsSec) {
  if (!timestampsSec.length) return [];
  if (typeof context.extractReferenceFrames === "function") {
    return context.extractReferenceFrames({ filePath, timestampsSec });
  }
  const timeoutMs = numberOrZero(context.config?.wangzhuan?.llm?.frameExtractTimeoutMs) || 20000;
  return ffmpegExtractReferenceFrames(filePath, timestampsSec, { timeoutMs });
}

async function collectReferenceVideoVisionInputs(context, probe) {
  const videoPath = resolveStoredVideoPath(context, probe.storedPath);
  const mimeType = probe.mimeType || mimeForExt(extname(videoPath).toLowerCase());
  const fileUrl = resolveModelFileUrl(probe);
  const frameCount = clampInteger(
    context.config?.wangzhuan?.llm?.referenceFrameCount,
    DEFAULT_REFERENCE_FRAME_COUNT,
    1,
    MAX_REFERENCE_FRAME_COUNT
  );
  const timestampsSec = referenceFrameTimestamps(probe.durationSec, frameCount);
  const warnings = [];
  let frames = [];
  try {
    frames = await extractReferenceFrames(context, videoPath, timestampsSec);
  } catch (error) {
    warnings.push({
      code: "reference_frame_extract_failed",
      message: "参考视频抽帧失败，已改为仅传原视频文件给模型",
      reason: String(error?.message || error?.code || "unknown").slice(0, 160)
    });
  }
  if (probe.storageUrl && !fileUrl) {
    warnings.push({
      code: "reference_video_storage_url_not_external",
      message: "参考视频存储地址不是可外部访问的 HTTP(S) URL，已回退为本地文件输入",
      reason: "storage_url_not_http"
    });
  }
  const videoBuffer = fileUrl ? null : await readFile(videoPath);
  return {
    fileName: probe.fileName || basename(videoPath),
    mimeType,
    ...(fileUrl ? { fileUrl } : { fileDataUrl: `data:${mimeType};base64,${videoBuffer.toString("base64")}` }),
    frames: frames.filter((frame) => typeof frame?.dataUrl === "string" && frame.dataUrl.startsWith("data:image/")),
    timestampsSec,
    warnings
  };
}

function resolveModelFileUrl(probe = {}) {
  return externalHttpUrl(probe.storageUrl) || directObjectStorageUrl(probe.storageKey) || "";
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

function videoProbePrompt(probe) {
  return [
    `文件名：${probe.fileName}`,
    `referenceVideoId：${probe.referenceVideoId}`,
    `时长：${probe.durationSec || "-"} 秒`,
    `画幅：${probe.width || "-"}x${probe.height || "-"}，比例：${probe.ratio || "-"}`,
    `格式：${probe.formatName || "-"}`,
    `视频编码：${probe.videoCodec || "-"}`,
    `FPS：${probe.fps || "-"}`,
    `码率：${probe.bitRateBps || "-"}`,
    `颜色空间：${probe.colorSpace || "-"}`,
    `音轨数量：${probe.audioStreamCount || 0}`
  ].join("\n");
}

function buildDecompositionMessages(probe, request = {}, llmConfig = {}, visionInputs = {}) {
  const notes = String(request.knowledgeNotes || "").trim();
  const promptText = [
    "请根据参考视频文件和抽样画面帧，生成网赚素材脚本拆解 JSON 草稿。",
    "",
    "参考视频信息：",
    videoProbePrompt(probe),
    "",
    "字段说明：",
    JSON.stringify(DECOMPOSITION_JSON_SCHEMA_HINT, null, 2),
    "",
    notes ? `业务经验规则：\n${notes}` : "业务经验规则：未填写",
    "",
    `模型配置：provider=${llmConfig.provider || "unknown"}，model=${llmConfig.model || "unknown"}`,
    "",
    "要求：",
    "1. 必须结合上传视频/抽帧画面判断镜头、节奏、产品露出、CTA 和 ending，不要只依据元数据。",
    "2. hook 写结构化钩子，不要写竞品品牌或照搬字幕。",
    "3. scene/subject/action/camera/lighting/style/quality 要能直接被后续脚本裂变使用。",
    "4. 如能判断手机界面、奖励反馈、CTA、合规提醒，可补 phoneUi/rewardFeedback/cta/disclaimer。",
    "5. 只返回 JSON 对象。"
  ].join("\n");
  const userContent = [
    { type: "text", text: promptText }
  ];
  if (visionInputs.fileUrl) {
    userContent.push({
      type: "file",
      file: {
        filename: visionInputs.fileName || probe.fileName || "reference-video.mp4",
        file_url: visionInputs.fileUrl
      }
    });
  } else if (visionInputs.fileDataUrl) {
    userContent.push({
      type: "file",
      file: {
        filename: visionInputs.fileName || probe.fileName || "reference-video.mp4",
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
        "你是网赚广告素材拆解专家，只做结构化拆解，不生成侵权复刻内容。",
        "你必须输出严格 JSON 对象，不要 markdown，不要解释。",
        "拆解目标是学习镜头结构、节奏、话术功能和转化逻辑，规避竞品品牌、人物、水印和原文案照搬。",
        "输出字段必须至少包含：scene, subject, action, camera, lighting, style, quality, hook。"
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
    throw new WangzhuanError("model_failed", "模型没有返回拆解内容", { reason: "empty_content" });
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
  throw new WangzhuanError("model_failed", "模型返回不是合法 JSON，请重试或手动修正", { reason: "invalid_json" });
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
            filename: part.file?.filename || "reference-video.mp4",
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

function redactedModelRequest({ requestId, inputMode, url, headers, body }) {
  const apiKeyEnv = headers?.Authorization ? "WANGZHUAN_LLM_API_KEY" : "API_KEY";
  return {
    requestId,
    createdAt: new Date().toISOString(),
    inputMode,
    request: {
      method: "POST",
      url,
      headers: {
        ...headers,
        ...(headers?.Authorization ? { Authorization: `Bearer <REDACTED:${apiKeyEnv}>` } : {})
      },
      body
    }
  };
}

async function maybeDumpModelRequest(context, probe, request) {
  const requestId = String(request?.requestId || "").trim();
  if (!requestId || !context?.userProjectRoot || !probe?.referenceVideoId) return;
  const target = join(wangzhuanPaths(context).referenceVideosDir, probe.referenceVideoId, `llm-request-${requestId}.json`);
  await writeAtomicJson(target, request);
}

async function callOpenAiCompatibleLlm(llmConfig, messages, options = {}) {
  if (!llmConfig.apiKey) {
    const apiKeyEnv = llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY";
    throw new WangzhuanError("model_failed", "未配置网赚拆解模型 API Key", {
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
  const redactedHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer <REDACTED:${llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY"}>`
  };
  const responsesPayload = {
    model: llmConfig.model,
    input: responsesInputFromMessages(messages),
    temperature: llmConfig.temperature,
    text: { format: { type: "json_object" } }
  };
  const inputMode = modelInputMode(messages);
  const chatMessages = canUseResponsesInput(messages) ? dropFileParts(messages) : messages;
  const chatPayload = {
    model: llmConfig.model,
    messages: chatMessages,
    temperature: llmConfig.temperature,
    response_format: { type: "json_object" }
  };
  const useResponses = canUseResponsesInput(messages);
  const initialUrl = useResponses ? responsesUrl(llmConfig.endpoint) : chatCompletionsUrl(llmConfig.endpoint);
  if (typeof options.dumpRequest === "function") {
    await options.dumpRequest(redactedModelRequest({
      requestId: options.requestId,
      inputMode,
      url: initialUrl,
      headers: redactedHeaders,
      body: useResponses ? responsesPayload : chatPayload
    }));
  }
  try {
    response = await fetch(initialUrl, {
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
    throw new WangzhuanError("model_failed", reason === "timeout" ? "模型拆解请求超时" : "模型拆解请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      inputMode,
      reason
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new WangzhuanError("model_failed", "模型拆解请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      status: response.status,
      inputMode,
      upstreamMessage: String(payload?.error?.message || payload?.message || "").slice(0, 300)
    });
  }
  return llmResponseText(payload);
}

export async function draftReferenceVideoDecomposition(context, request = {}, options = {}) {
  const probe = await loadReferenceVideoProbe(context, request.referenceVideoId);
  if (probe.status === "fail") {
    throw new WangzhuanError("invalid_video", "参考视频检查未通过，不能自动拆解", { referenceVideoId: probe.referenceVideoId });
  }
  const llmConfig = resolveLlmConfig(context.config || {}, request.llmConfig || {});
  const visionInputs = await collectReferenceVideoVisionInputs(context, probe);
  const messages = buildDecompositionMessages(probe, request, llmConfig, visionInputs);
  const content = typeof context.callWangzhuanLlm === "function"
    ? await context.callWangzhuanLlm({
      messages,
      llmConfig: {
        provider: llmConfig.provider,
        endpoint: llmConfig.endpoint,
        model: llmConfig.model,
        temperature: llmConfig.temperature,
        timeoutMs: llmConfig.timeoutMs,
        apiKeyEnv: llmConfig.apiKeyEnv
      },
      referenceVideo: {
        ...probe,
        fileUrl: visionInputs.fileUrl,
        fileDataUrl: visionInputs.fileDataUrl,
        frameCount: visionInputs.frames.length
      },
      visionInputs
    })
    : await callOpenAiCompatibleLlm(llmConfig, messages, {
      requestId: options.requestId,
      dumpRequest: (dump) => maybeDumpModelRequest(context, probe, dump)
    });
  const decomposition = validateVideoDecomposition(probe.referenceVideoId, parseLlmJsonContent(content));
  if (decomposition.missingFields.length) {
    throw new WangzhuanError("schema_invalid", "模型拆解结果不完整，请重试或手动补充", {
      referenceVideoId: probe.referenceVideoId,
      missingFields: decomposition.missingFields
    });
  }
  await recordTelemetryEvent(context, "script_decomposition_drafted", {
    referenceVideoId: probe.referenceVideoId,
    provider: llmConfig.provider,
    model: llmConfig.model,
    status: "drafted"
  });
  return {
    decomposition,
    draft: {
      source: "llm",
      provider: llmConfig.provider,
      model: llmConfig.model,
      referenceVideoId: probe.referenceVideoId
    },
    warnings: visionInputs.warnings
  };
}

async function loadConfirmedDecomposition(context, referenceVideoId) {
  const mysqlDecomposition = await loadVideoDecompositionFromMysql(context, referenceVideoId);
  if (mysqlDecomposition) {
    const missingFields = Array.isArray(mysqlDecomposition.missingFields) ? mysqlDecomposition.missingFields : [];
    if (!missingFields.length) return mysqlDecomposition;
  }
  const target = join(wangzhuanPaths(context).referenceVideosDir, referenceVideoId, "decomposition.json");
  try {
    const parsed = validateVideoDecomposition(referenceVideoId, JSON.parse(await readFile(target, "utf8")));
    if (!parsed.missingFields.length) return parsed;
  } catch {
    // fall through
  }
  return null;
}

export async function getReferenceVideoWorkflowState(context, referenceVideoId) {
  const probe = await loadReferenceVideoProbe(context, referenceVideoId);
  const decomposition = await loadConfirmedDecomposition(context, referenceVideoId);
  return {
    referenceVideo: probe,
    decomposition,
    decompositionConfirmed: Boolean(decomposition?.referenceVideoId)
  };
}

export async function decomposeReferenceVideo(context, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const probe = await loadReferenceVideoProbe(context, request.referenceVideoId);
  if (probe.status === "fail") {
    throw new WangzhuanError("invalid_video", "参考视频检查未通过，不能拆解", { referenceVideoId: probe.referenceVideoId });
  }
  const decomposition = validateVideoDecomposition(probe.referenceVideoId, request.decomposition || request.mockDecomposition || {});
  if (decomposition.missingFields.length) {
    throw new WangzhuanError("schema_invalid", "拆解结果不完整，请重试或手动补充", {
      referenceVideoId: probe.referenceVideoId,
      missingFields: decomposition.missingFields
    });
  }
  const target = join(wangzhuanPaths(context).referenceVideosDir, probe.referenceVideoId, "decomposition.json");
  await writeAtomicJson(target, decomposition);
  await syncVideoDecompositionFact(context, decomposition);
  await recordTelemetryEvent(context, "script_decomposition_completed", {
    referenceVideoId: probe.referenceVideoId,
    missingFieldsCount: decomposition.missingFields.length,
    status: "completed"
  });
  return {
    decomposition,
    warnings: []
  };
}

export { callOpenAiCompatibleLlm, parseLlmJsonContent };
