import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { effectiveLimits } from "./config.mjs";
import { WangzhuanError } from "./http.mjs";
import { callLlmStreaming, geminiStreamGenerateContentUrl } from "./llm-stream.mjs";
import { invokeLlmWithRetry } from "./llm-invoke.mjs";
import { llmUsesGeminiNativeApi, llmUsesSkylinkGeminiChatBridge, isRetryableLlmError, resolveLlmConfig, llmSupportsVideoUrl } from "./llm-config.mjs";
import { writeSseDelta, writeSseDone, writeSseError, writeSseLog } from "./sse.mjs";
import {
  hasWangzhuanFactsStore,
  loadReferenceVideoProbeByHashFromMysql,
  loadReferenceVideoProbeFromMysql,
  loadVideoDecompositionFromMysql,
  nextReferenceVideoIdFromMysql,
  syncReferenceVideoFact,
  syncVideoDecompositionFact
} from "./mysql-facts.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import { buildPublicUrl } from "../object-storage.mjs";
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  buildDecompositionUserPrompt
} from "./decomposition-prompt.mjs";
import { flattenDecompositionFieldValue } from "./decomposition-text.mjs";
import { normalizeFissionAnalysis } from "./fission-analysis.mjs";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/mov"]);
const execFileAsync = promisify(execFile);
const DEFAULT_LLM_TIMEOUT_MS = 300000;
const DEFAULT_REFERENCE_FRAME_COUNT = 5;
const MAX_REFERENCE_FRAME_COUNT = 90;
const DEFAULT_PROXY_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROXY_CRF = 35;
const PROXY_CRF_LADDER = Object.freeze([35, 38, 41, 44]);
const PROXY_MAX_HEIGHT = 854;
const PROXY_FPS = 15;
const PROXY_AUDIO_BITRATE = "64k";
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
  protagonist: ["protagonist", "mainCharacter", "main_character", "人物", "主角", "具体人物", "人物拆解"],
  voiceover: ["voiceover", "voice_over", "口播", "旁白", "口播内容", "口播功能"],
  onscreenText: ["onscreenText", "on_screen_text", "subtitles", "字幕", "屏幕文字", "画面文字", "贴纸文案"],
  ctaMoment: ["ctaMoment", "cta_moment", "CTA时刻", "CTA出现时机", "行动号召时刻"],
  endingMoment: ["endingMoment", "ending_moment", "Ending时刻", "结尾", "收尾画面"],
  continuityAnchors: ["continuityAnchors", "continuity_anchors", "连续性锚点", "连贯锚点", "关键帧锚点"],
  actionReference: ["actionReference", "action_reference", "动作参考", "Seedance动作参考", "人物动作参考"],
  cameraReference: ["cameraReference", "camera_reference", "运镜参考", "镜头参考", "Seedance运镜参考"],
  textElements: ["textElements", "text_elements", "文字生成", "文字元素", "字幕元素", "画面文字元素"],
  effectReference: ["effectReference", "effect_reference", "特效参考", "转场参考", "动效参考"],
  doNotCopyElements: ["doNotCopyElements", "do_not_copy_elements", "不要复制元素", "不得复刻元素", "竞品禁用元素"],
  rewardFeedback: ["rewardFeedback", "reward_feedback", "奖励反馈", "收益反馈", "金币反馈"],
  cta: ["cta", "CTA", "行动号召", "下载引导"],
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

const FISSION_DECOMPOSITION_FIELDS = Object.freeze([
  "sourceVideoProfile",
  "wholeVideoConversion",
  "wholeVideoSummary",
  "sourceAssemblyMode",
  "continuityPlan",
  "storySegments",
  "seedanceSlices"
]);

export const DECOMPOSITION_PROMPT_VERSION = "fission_decomposition_v4_continuity_schema";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

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

function parseUploadBuffer(request = {}) {
  if (Buffer.isBuffer(request.buffer)) return request.buffer;
  if (request.buffer instanceof Uint8Array) return Buffer.from(request.buffer);
  return parseUploadContent(request.content);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function probePreviewUrl(probe = {}) {
  return String(probe.previewUrl || probe.storageUrl || "").trim()
    || (probe.storedPath ? `/file?path=${encodeURIComponent(probe.storedPath)}` : "");
}

function referenceVideoResponse(probe = {}, extra = {}) {
  const previewUrl = probePreviewUrl(probe);
  return {
    referenceVideo: {
      ...probe,
      ...(previewUrl ? { previewUrl } : {}),
      ...extra
    }
  };
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

function referenceProxySettings(context = {}) {
  const config = context.config?.wangzhuan?.referenceVideoProxy || {};
  const targetBytes = numberOrZero(config.targetBytes) || DEFAULT_PROXY_TARGET_BYTES;
  const initialCrf = clampInteger(config.crf, DEFAULT_PROXY_CRF, 18, 48);
  const configuredLadder = Array.isArray(config.crfLadder)
    ? config.crfLadder.map((item) => clampInteger(item, initialCrf, 18, 48))
    : [];
  return {
    targetBytes,
    crfLadder: [...new Set([initialCrf, ...configuredLadder, ...PROXY_CRF_LADDER])].sort((a, b) => a - b),
    maxHeight: clampInteger(config.maxHeight, PROXY_MAX_HEIGHT, 360, 1280),
    fps: clampInteger(config.fps, PROXY_FPS, 8, 30),
    audioBitrate: String(config.audioBitrate || PROXY_AUDIO_BITRATE)
  };
}

function shouldCreateReferenceProxy(bufferLength, probe, settings) {
  const sizeBytes = numberOrZero(bufferLength);
  if (sizeBytes > settings.targetBytes) return true;
  if (numberOrZero(probe.width) > 720 || numberOrZero(probe.height) > 1280) return true;
  if (numberOrZero(probe.fps) > settings.fps) return true;
  return false;
}

async function statSizeBytes(filePath) {
  const { size } = await stat(filePath);
  return size;
}

async function createReferenceVideoProxy(context, originalPath, targetPath, settings) {
  if (typeof context.createReferenceVideoProxy === "function") {
    return context.createReferenceVideoProxy({ originalPath, targetPath, settings });
  }
  let lastResult = null;
  for (const crf of settings.crfLadder) {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      originalPath,
      "-vf",
      `scale='2*trunc(min(iw,${settings.maxHeight}*dar)/2)':'2*trunc(min(ih,${settings.maxHeight})/2)',fps=${settings.fps},format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-c:a",
      "aac",
      "-b:a",
      settings.audioBitrate,
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      targetPath
    ], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: numberOrZero(context.config?.wangzhuan?.referenceVideoProxy?.timeoutMs) || 120000,
      windowsHide: true
    });
    const sizeBytes = await statSizeBytes(targetPath);
    lastResult = { path: targetPath, crf, sizeBytes };
    if (sizeBytes <= settings.targetBytes) return lastResult;
  }
  return lastResult;
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

  const sourcePath = String(request.filePath || request.localPath || "").trim();
  const buffer = sourcePath ? null : parseUploadBuffer(request);
  const sourceSizeBytes = sourcePath ? await statSizeBytes(sourcePath) : buffer.length;
  if (sourceSizeBytes > limits.maxUploadVideoBytes) {
    throw new WangzhuanError("file_too_large", "文件超过大小上限", {
      sizeBytes: sourceSizeBytes,
      maxUploadVideoBytes: limits.maxUploadVideoBytes
    });
  }
  const fileHash = String(request.fileHash || request.sha256 || "").trim()
    || (sourcePath ? await sha256File(sourcePath) : createHash("sha256").update(buffer).digest("hex"));

  const referenceVideoId = typeof context.nextReferenceVideoId === "function"
    ? await context.nextReferenceVideoId()
    : await nextReferenceVideoIdFromMysql(context);
  if (!referenceVideoId) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存参考视频状态");
  }

  const referenceDir = join(paths.referenceVideosDir, referenceVideoId);
  await mkdir(referenceDir, { recursive: true });
  const originalPath = join(referenceDir, `original${ext}`);
  if (sourcePath) {
    await copyFile(sourcePath, originalPath);
  } else {
    await writeFile(originalPath, buffer);
  }

  const mediaProbe = await probeReferenceVideo(context, originalPath, request);
  const proxySettings = referenceProxySettings(context);
  const proxyRequired = shouldCreateReferenceProxy(sourceSizeBytes, mediaProbe, proxySettings);
  let uploadPath = originalPath;
  let proxyInfo = null;
  if (proxyRequired) {
    const proxyPath = join(referenceDir, "decomposition-proxy.mp4");
    const proxyResult = await createReferenceVideoProxy(context, originalPath, proxyPath, proxySettings);
    if (proxyResult?.path) {
      uploadPath = proxyResult.path;
      const proxyProbe = await probeReferenceVideo(context, proxyResult.path, request);
      proxyInfo = {
        enabled: true,
        crf: proxyResult.crf,
        targetBytes: proxySettings.targetBytes,
        sizeBytes: proxyResult.sizeBytes,
        storedPath: toProjectRelative(context.userProjectRoot, proxyResult.path),
        durationSec: proxyProbe.durationSec,
        width: proxyProbe.width,
        height: proxyProbe.height,
        fps: proxyProbe.fps,
        bitRateBps: proxyProbe.bitRateBps,
        videoCodec: proxyProbe.videoCodec,
        audioStreamCount: proxyProbe.audioStreams.length
      };
    }
  }
  const uploadSizeBytes = proxyInfo?.sizeBytes || sourceSizeBytes;
  const storage = await syncWangzhuanAsset(context, uploadPath, "reference_video", {
    required: true,
    preferRemote: true
  });
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
    fileHash,
    sizeBytes: uploadSizeBytes,
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
    storedPath: toProjectRelative(context.userProjectRoot, uploadPath),
    storageKey: storage.storageKey,
    storageUrl: storage.storageUrl,
    originalStoredPath: toProjectRelative(context.userProjectRoot, originalPath),
    originalSizeBytes: sourceSizeBytes,
    ...(proxyInfo ? { decompositionProxy: proxyInfo } : {})
  };

  await writeAtomicJson(join(referenceDir, "probe.json"), probe);
  const synced = typeof context.syncReferenceVideoFact === "function"
    ? await context.syncReferenceVideoFact(probe)
    : await syncReferenceVideoFact(context, probe);
  if (synced?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存参考视频状态");
  }
  const recordEvent = typeof context.recordTelemetryEvent === "function"
    ? context.recordTelemetryEvent
    : (eventName, payload) => recordTelemetryEvent(context, eventName, payload);
  await recordEvent("reference_video_checked", {
    referenceVideoId,
    status: probe.status,
    durationSec: probe.durationSec,
    ratio: probe.ratio,
    issueCodes: probe.issues.map((item) => item.code)
  });

  return referenceVideoResponse(probe, { previewUrl: storage.storageUrl });
}

export function decompositionCacheKey(probe = {}, request = {}, llmConfig = {}) {
  const fileHash = String(request.fileHash || request.sha256 || probe.fileHash || "").trim();
  if (!fileHash) return "";
  return hashPayload({
    fileHash,
    provider: llmConfig.provider || "",
    model: llmConfig.model || "",
    language: request.language || request.primaryLanguage || "",
    targetRegion: request.targetRegion || "",
    targetRegions: request.targetRegions || request.regions || [],
    knowledgeNotesHash: sha256Normalized(request.knowledgeNotes),
    promptVersion: DECOMPOSITION_PROMPT_VERSION
  });
}

function sha256Normalized(value) {
  return createHash("sha256")
    .update(String(value || "").trim().replace(/\s+/g, " "))
    .digest("hex");
}

function decompositionCachePath(context, cacheKey) {
  if (!cacheKey) return "";
  return join(wangzhuanPaths(context).referenceVideosDir, "_decomposition-cache", `${cacheKey}.json`);
}

async function loadCachedDecomposition(context, probe, request, llmConfig) {
  const cacheKey = decompositionCacheKey(probe, request, llmConfig);
  const target = decompositionCachePath(context, cacheKey);
  if (!target) return null;
  try {
    const info = await stat(target);
    if (Date.now() - info.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
      await rm(target, { force: true });
      return null;
    }
    const parsed = JSON.parse(await readFile(target, "utf8"));
    if (!parsed?.decomposition) return null;
    return {
      cacheKey,
      decomposition: parsed.decomposition
    };
  } catch {
    return null;
  }
}

async function writeCachedDecomposition(context, probe, request, llmConfig, decomposition) {
  const cacheKey = decompositionCacheKey(probe, request, llmConfig);
  const target = decompositionCachePath(context, cacheKey);
  if (!target || !decomposition || decomposition.missingFields?.length) return;
  await mkdir(join(wangzhuanPaths(context).referenceVideosDir, "_decomposition-cache"), { recursive: true });
  await writeAtomicJson(target, {
    cacheKey,
    fileHash: probe.fileHash || request.fileHash || request.sha256 || "",
    referenceVideoId: probe.referenceVideoId,
    llmConfig: {
      provider: llmConfig.provider || "",
      model: llmConfig.model || ""
    },
    request: {
      language: request.language || request.primaryLanguage || "",
      targetRegion: request.targetRegion || "",
      targetRegions: request.targetRegions || request.regions || [],
      knowledgeNotesHash: sha256Normalized(request.knowledgeNotes)
    },
    decomposition,
    updatedAt: new Date().toISOString()
  });
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
  if (typeof context.loadReferenceVideoProbe === "function") {
    const probe = await context.loadReferenceVideoProbe(referenceVideoId);
    if (probe) return probe;
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

async function loadReferenceVideoProbeByHashFromLocal(context, fileHash) {
  const normalizedHash = String(fileHash || "").trim();
  if (!normalizedHash) return null;
  let entries = [];
  try {
    entries = await readdir(wangzhuanPaths(context).referenceVideosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^ref_\d{8}_\d{3}$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of candidates) {
    try {
      const probe = JSON.parse(await readFile(join(wangzhuanPaths(context).referenceVideosDir, entry.name, "probe.json"), "utf8"));
      if (String(probe.fileHash || "").trim() === normalizedHash && probe.status !== "deleted") {
        return probe;
      }
    } catch {
      // Ignore incomplete local reference records and keep searching.
    }
  }
  return null;
}

export async function findReusableReferenceVideo(context, request = {}) {
  const fileHash = String(request.fileHash || request.sha256 || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(fileHash)) {
    throw new WangzhuanError("validation_error", "文件指纹无效，请重新选择素材", { field: "fileHash" });
  }
  const fromContext = typeof context.findReusableReferenceVideo === "function"
    ? await context.findReusableReferenceVideo({ ...request, fileHash })
    : null;
  const probe = fromContext
    || await loadReferenceVideoProbeByHashFromMysql(context, fileHash)
    || await loadReferenceVideoProbeByHashFromLocal(context, fileHash);
  if (!probe) return { hit: false, fileHash, referenceVideo: null };
  return {
    hit: true,
    fileHash,
    referenceVideo: referenceVideoResponse(probe, { reused: true }).referenceVideo
  };
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
    ...(normalized.protagonist ? { protagonist: String(normalized.protagonist) } : {}),
    ...(normalized.voiceover ? { voiceover: String(normalized.voiceover) } : {}),
    ...(normalized.onscreenText ? { onscreenText: String(normalized.onscreenText) } : {}),
    ...(normalized.ctaMoment ? { ctaMoment: String(normalized.ctaMoment) } : {}),
    ...(normalized.endingMoment ? { endingMoment: String(normalized.endingMoment) } : {}),
    ...(normalized.continuityAnchors ? { continuityAnchors: String(normalized.continuityAnchors) } : {}),
    ...(normalized.actionReference ? { actionReference: String(normalized.actionReference) } : {}),
    ...(normalized.cameraReference ? { cameraReference: String(normalized.cameraReference) } : {}),
    ...(normalized.textElements ? { textElements: String(normalized.textElements) } : {}),
    ...(normalized.effectReference ? { effectReference: String(normalized.effectReference) } : {}),
    ...(normalized.doNotCopyElements ? { doNotCopyElements: String(normalized.doNotCopyElements) } : {}),
    ...(normalized.rewardFeedback ? { rewardFeedback: String(normalized.rewardFeedback) } : {}),
    ...(normalized.cta ? { cta: String(normalized.cta) } : {}),
    ...(normalized.disclaimer ? { disclaimer: String(normalized.disclaimer) } : {}),
    ...normalized.fissionAnalysis,
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

function backfillRequiredFieldsFromStorySegments(normalized = {}, source = {}) {
  const segments = Array.isArray(source?.storySegments) ? source.storySegments : [];
  const first = segments.find((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!first) return normalized;
  for (const field of ["scene", "subject", "action", "camera", "lighting", "style", "quality"]) {
    if (normalized[field]) continue;
    const value = firstStringValue(first, DECOMPOSITION_FIELD_ALIASES[field] || [field]);
    if (value) normalized[field] = value;
  }
  if (!normalized.hook) {
    const hook = firstStringValue(first, [
      ...(DECOMPOSITION_FIELD_ALIASES.hook || []),
      "coreHook",
      "core_hook"
    ]);
    if (hook) normalized.hook = hook;
  }
  return normalized;
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
  backfillRequiredFieldsFromStorySegments(normalized, source);
  if (FISSION_DECOMPOSITION_FIELDS.some((field) => Object.hasOwn(source || {}, field))) {
    normalized.fissionAnalysis = normalizeFissionAnalysis({
      ...source,
      ...Object.fromEntries(DECOMPOSITION_REQUIRED_FIELDS.map((field) => [field, normalized[field] || ""]))
    }, {
      strictStorySegmentTiming: Array.isArray(source?.storySegments) && source.storySegments.length > 0,
      deriveSeedanceSlices: true,
      durationSec: Number(source?.sourceVideoProfile?.durationSec || source?.durationSec || 0) || undefined
    });
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

function roundTimestampSec(value) {
  return Math.round(numberOrZero(value) * 100) / 100;
}

function clampTimestampSec(durationSec, value) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0) return 0;
  return roundTimestampSec(Math.min(Math.max(0, numberOrZero(value)), Math.max(0, duration - 0.1)));
}

function dedupeSortedTimestamps(timestampsSec = []) {
  const unique = [];
  for (const timestampSec of timestampsSec.slice().sort((a, b) => a - b)) {
    const rounded = roundTimestampSec(timestampSec);
    if (!unique.length || Math.abs(unique[unique.length - 1] - rounded) >= 0.01) {
      unique.push(rounded);
    }
  }
  return unique;
}

function normalizeSceneCuts(durationSec, sceneCutsSec = [], { minGapSec = 0.8 } = {}) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0) return [];
  const maxTimestamp = Math.max(0, duration - 0.1);
  const sorted = sceneCutsSec
    .map((value) => numberOrZero(value))
    .filter((value) => value > 0 && value < maxTimestamp)
    .sort((a, b) => a - b);
  const normalized = [];
  for (const value of sorted) {
    if (!normalized.length || value - normalized[normalized.length - 1] >= minGapSec) {
      normalized.push(roundTimestampSec(value));
    }
  }
  return normalized;
}

function buildSceneSegments(durationSec, sceneCutsSec = [], options = {}) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0) return [];
  const boundaries = [0, ...normalizeSceneCuts(duration, sceneCutsSec, options), duration];
  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startSec = boundaries[index];
    const endSec = boundaries[index + 1];
    if (endSec - startSec <= 0.05) continue;
    segments.push({
      index,
      startSec: roundTimestampSec(startSec),
      endSec: roundTimestampSec(endSec),
      durationSec: roundTimestampSec(endSec - startSec)
    });
  }
  return segments;
}

function mergeShortSceneSegments(segments = [], { shortSceneMergeThresholdSec = 1.5 } = {}) {
  if (!Array.isArray(segments) || !segments.length || shortSceneMergeThresholdSec <= 0) {
    return Array.isArray(segments) ? segments : [];
  }
  const merged = [];
  for (const segment of segments) {
    if (!merged.length) {
      merged.push({ ...segment });
      continue;
    }
    const previous = merged[merged.length - 1];
    if (segment.durationSec < shortSceneMergeThresholdSec || previous.durationSec < shortSceneMergeThresholdSec) {
      previous.endSec = segment.endSec;
      previous.durationSec = roundTimestampSec(previous.endSec - previous.startSec);
      continue;
    }
    merged.push({ ...segment });
  }
  if (merged.length > 1 && merged.at(-1).durationSec < shortSceneMergeThresholdSec) {
    const last = merged.pop();
    const previous = merged[merged.length - 1];
    previous.endSec = last.endSec;
    previous.durationSec = roundTimestampSec(previous.endSec - previous.startSec);
  }
  return merged.map((segment, index) => ({ ...segment, index }));
}

function sceneSampleBudget(segment, {
  mediumSceneThresholdSec = 6,
  longSceneThresholdSec = 15
} = {}) {
  const durationSec = numberOrZero(segment?.durationSec);
  if (durationSec > longSceneThresholdSec) return 4;
  if (durationSec >= mediumSceneThresholdSec) return 2;
  return 1;
}

function segmentSampleFrames(durationSec, segment, options = {}) {
  if (!segment || segment.durationSec <= 0) return [];
  const budget = sceneSampleBudget(segment, options);
  const ratios = budget >= 4
    ? [0.2, 0.4, 0.6, 0.8]
    : budget === 2
      ? [1 / 3, 2 / 3]
      : [0.5];
  return ratios.map((ratio, ratioIndex) => {
    const span = Math.max(0.05, segment.endSec - segment.startSec);
    const timestampSec = clampTimestampSec(durationSec, segment.startSec + (span * ratio));
    return {
      timestampSec,
      segmentIndex: segment.index,
      segmentDurationSec: segment.durationSec,
      priority: ratioIndex === 0 ? 3 : ratioIndex === ratios.length - 1 ? 1 : 2,
      order: ratioIndex
    };
  });
}

function reduceSceneAwareSamples(samples = [], durationSec, maxFrames, forcedTimestamps = []) {
  const deduped = new Map();
  for (const sample of samples) {
    const key = String(roundTimestampSec(sample.timestampSec));
    const existing = deduped.get(key);
    if (!existing
      || sample.priority > existing.priority
      || (sample.priority === existing.priority && sample.segmentDurationSec > existing.segmentDurationSec)
      || (sample.priority === existing.priority && sample.segmentDurationSec === existing.segmentDurationSec && sample.order < existing.order)) {
      deduped.set(key, { ...sample, timestampSec: roundTimestampSec(sample.timestampSec) });
    }
  }
  const normalized = Array.from(deduped.values()).sort((left, right) => left.timestampSec - right.timestampSec);
  if (normalized.length <= maxFrames) {
    return normalized.map((sample) => sample.timestampSec);
  }

  const forcedKeys = new Set(forcedTimestamps.map((value) => String(roundTimestampSec(value))));
  const forced = normalized.filter((sample) => forcedKeys.has(String(sample.timestampSec)));
  const primaryBySegment = new Map();
  for (const sample of normalized) {
    if (forcedKeys.has(String(sample.timestampSec))) continue;
    const existing = primaryBySegment.get(sample.segmentIndex);
    if (!existing
      || sample.priority > existing.priority
      || (sample.priority === existing.priority && sample.segmentDurationSec > existing.segmentDurationSec)
      || (sample.priority === existing.priority && sample.segmentDurationSec === existing.segmentDurationSec && sample.order < existing.order)) {
      primaryBySegment.set(sample.segmentIndex, sample);
    }
  }

  const retained = [...forced];
  const remainingSlotsForPrimary = Math.max(0, maxFrames - retained.length);
  retained.push(...Array.from(primaryBySegment.values())
    .sort((left, right) => {
      if (right.segmentDurationSec !== left.segmentDurationSec) return right.segmentDurationSec - left.segmentDurationSec;
      return left.timestampSec - right.timestampSec;
    })
    .slice(0, remainingSlotsForPrimary));

  const retainedKeys = new Set(retained.map((sample) => String(sample.timestampSec)));
  if (retained.length < maxFrames) {
    retained.push(...normalized
      .filter((sample) => !retainedKeys.has(String(sample.timestampSec)))
      .sort((left, right) => {
        if (right.priority !== left.priority) return right.priority - left.priority;
        if (right.segmentDurationSec !== left.segmentDurationSec) return right.segmentDurationSec - left.segmentDurationSec;
        return left.timestampSec - right.timestampSec;
      })
      .slice(0, maxFrames - retained.length));
  }
  return dedupeSortedTimestamps(retained.map((sample) => sample.timestampSec)).slice(0, maxFrames);
}

function buildSceneAwareFrameTimestamps(durationSec, sceneCutsSec = [], options = {}) {
  const duration = numberOrZero(durationSec);
  if (duration <= 0) return [];
  const {
    shortSceneMergeThresholdSec = 1.5,
    mediumSceneThresholdSec = 6,
    longSceneThresholdSec = 15,
    maxFrames = 28,
    minSceneGapSec = 0.8,
    startFrameOffsetSec = 0.25,
    endFrameOffsetSec = 0.25
  } = options;
  const segments = mergeShortSceneSegments(
    buildSceneSegments(duration, sceneCutsSec, { minGapSec: minSceneGapSec }),
    { shortSceneMergeThresholdSec }
  );
  const forcedStart = clampTimestampSec(duration, startFrameOffsetSec);
  const forcedEnd = clampTimestampSec(duration, Math.max(0, duration - endFrameOffsetSec));
  const samples = [
    { timestampSec: forcedStart, segmentIndex: -1, segmentDurationSec: duration, priority: 5, order: 0 }
  ];
  for (const segment of segments) {
    samples.push(...segmentSampleFrames(duration, segment, {
      mediumSceneThresholdSec,
      longSceneThresholdSec
    }));
  }
  samples.push({ timestampSec: forcedEnd, segmentIndex: Number.POSITIVE_INFINITY, segmentDurationSec: duration, priority: 5, order: 0 });
  return reduceSceneAwareSamples(samples, duration, maxFrames, [forcedStart, forcedEnd]);
}

function llmUsesGptFrameOnlyDecomposition(llmConfig = {}) {
  return String(llmConfig.provider || "").trim().toLowerCase() === "skylink"
    && /^gpt-5\.(?:4|5)(?:-(?:mini|nano))?$/i.test(String(llmConfig.model || "").trim());
}

async function ffmpegExtractReferenceFrames(filePath, timestampsSec, { timeoutMs = 20000 } = {}) {
  const frames = [];
  const frameDir = join(parse(filePath).dir, "llm-frames");
  await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(frameDir, { recursive: true });
  try {
    const extractionPlan = buildBatchReferenceFrameExtractionPlan(frameDir, timestampsSec);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      filePath,
      "-filter_complex",
      extractionPlan.filterComplex,
      "-q:v",
      "3",
      ...extractionPlan.outputArgs
    ], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true
    });
    for (const output of extractionPlan.outputs) {
      const buffer = await readFile(output.framePath);
      if (buffer.length) {
        frames.push({
          index: output.index,
          timestampSec: output.timestampSec,
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

function buildBatchReferenceFrameExtractionPlan(frameDir, timestampsSec = []) {
  const normalizedTimestamps = timestampsSec.map((timestampSec, index) => ({
    index,
    timestampSec: roundTimestampSec(timestampSec),
    outputLabel: `o${index}`,
    inputLabel: `v${index}`,
    framePath: join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`)
  }));
  if (!normalizedTimestamps.length) {
    return {
      filterComplex: "",
      outputArgs: [],
      outputs: []
    };
  }
  if (normalizedTimestamps.length === 1) {
    const output = normalizedTimestamps[0];
    return {
      filterComplex: `[0:v]trim=start=${output.timestampSec},setpts=PTS-STARTPTS,select='eq(n\\,0)',scale='min(720,iw)':-2[${output.outputLabel}]`,
      outputArgs: ["-map", `[${output.outputLabel}]`, "-frames:v", "1", output.framePath],
      outputs: normalizedTimestamps
    };
  }
  const splitOutputs = normalizedTimestamps.map((output) => `[${output.inputLabel}]`).join("");
  const filterParts = [`[0:v]split=${normalizedTimestamps.length}${splitOutputs}`];
  for (const output of normalizedTimestamps) {
    filterParts.push(
      `[${output.inputLabel}]trim=start=${output.timestampSec},setpts=PTS-STARTPTS,select='eq(n\\,0)',scale='min(720,iw)':-2[${output.outputLabel}]`
    );
  }
  const outputArgs = normalizedTimestamps.flatMap((output) => [
    "-map",
    `[${output.outputLabel}]`,
    "-frames:v",
    "1",
    output.framePath
  ]);
  return {
    filterComplex: filterParts.join(";"),
    outputArgs,
    outputs: normalizedTimestamps
  };
}

async function ffmpegDetectReferenceVideoScenes(filePath, {
  threshold = 0.1,
  timeoutMs = 25000,
  minGapSec = 0.8
} = {}) {
  const { stderr = "" } = await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-i",
    filePath,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-an",
    "-f",
    "null",
    "-"
  ], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true
  });
  const timestamps = [];
  const regex = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  for (const match of stderr.matchAll(regex)) {
    timestamps.push(Number(match[1]));
  }
  return normalizeSceneCuts(Number.POSITIVE_INFINITY, timestamps, { minGapSec });
}

async function extractReferenceFrames(context, filePath, timestampsSec) {
  if (!timestampsSec.length) return [];
  if (typeof context.extractReferenceFrames === "function") {
    return context.extractReferenceFrames({ filePath, timestampsSec });
  }
  const timeoutMs = numberOrZero(context.config?.wangzhuan?.llm?.frameExtractTimeoutMs) || 20000;
  return ffmpegExtractReferenceFrames(filePath, timestampsSec, { timeoutMs });
}

async function detectReferenceVideoScenes(context, filePath, durationSec) {
  if (typeof context.detectReferenceVideoScenes === "function") {
    return context.detectReferenceVideoScenes({ filePath, durationSec });
  }
  const threshold = numberOrZero(context.config?.wangzhuan?.llm?.sceneDetectThreshold) || 0.1;
  const timeoutMs = numberOrZero(context.config?.wangzhuan?.llm?.sceneDetectTimeoutMs) || 25000;
  const minGapSec = numberOrZero(context.config?.wangzhuan?.llm?.sceneDetectMinGapSec) || 0.8;
  return ffmpegDetectReferenceVideoScenes(filePath, { threshold, timeoutMs, minGapSec });
}

async function collectReferenceVideoVisionInputs(context, probe, llmConfig = {}) {
  const videoPath = resolveStoredVideoPath(context, probe.storedPath);
  const mimeType = probe.mimeType || mimeForExt(extname(videoPath).toLowerCase());
  // 拆解只有两种输入模式：① 公网 URL（模型可读视频链接时，如 doubao / gemini）；
  // ② 场景感知抽帧（模型不吃视频链接、或拿不到公网 URL 时）。
  // 不再使用「整段视频 base64 内联」这种慢模式。
  const frameOnlyModel = llmUsesGptFrameOnlyDecomposition(llmConfig);
  let fileUrl = frameOnlyModel ? "" : resolveModelFileUrl(probe);
  const configuredFrameCount = clampInteger(
    context.config?.wangzhuan?.llm?.referenceFrameCount,
    DEFAULT_REFERENCE_FRAME_COUNT,
    1,
    MAX_REFERENCE_FRAME_COUNT
  );
  const warnings = [];
  // 场景感知抽帧对所有模型统一启用；仅在场景检测失败时回退为等距抽帧。
  // 即便走 URL 模式也预抽帧，作为 URL 不可用时降级为抽帧输入的兜底。
  let timestampsSec = referenceFrameTimestamps(probe.durationSec, configuredFrameCount);
  try {
    const sceneCutsSec = await detectReferenceVideoScenes(context, videoPath, probe.durationSec);
    timestampsSec = buildSceneAwareFrameTimestamps(probe.durationSec, sceneCutsSec, {
      shortSceneMergeThresholdSec: numberOrZero(context.config?.wangzhuan?.llm?.sceneShortMergeThresholdSec) || 1.5,
      mediumSceneThresholdSec: numberOrZero(context.config?.wangzhuan?.llm?.sceneMediumThresholdSec) || 6,
      longSceneThresholdSec: numberOrZero(context.config?.wangzhuan?.llm?.sceneLongThresholdSec) || 15,
      maxFrames: clampInteger(context.config?.wangzhuan?.llm?.sceneMaxFrames, 28, 4, 40),
      minSceneGapSec: numberOrZero(context.config?.wangzhuan?.llm?.sceneDetectMinGapSec) || 0.8
    });
  } catch (error) {
    warnings.push({
      code: "reference_scene_detect_failed",
      message: "参考视频场景检测失败，已回退为基础抽帧",
      reason: String(error?.message || error?.code || "unknown").slice(0, 160)
    });
  }
  let frames = [];
  try {
    frames = await extractReferenceFrames(context, videoPath, timestampsSec);
  } catch (error) {
    warnings.push({
      code: "reference_frame_extract_failed",
      message: "参考视频抽帧失败",
      reason: String(error?.message || error?.code || "unknown").slice(0, 160)
    });
  }
  // 走 URL 模式前先做一次 HEAD 探测：确认该公网地址真的可被外部（doubao 服务端）拉取。
  // 不可用则清空 fileUrl，自动落到场景感知抽帧兜底，避免"URL 存在但对方读不到"时白等一次上游失败。
  if (fileUrl) {
    const probeResult = await headProbeReferenceUrl(context, fileUrl);
    if (!probeResult.ok) {
      warnings.push({
        code: "reference_video_url_head_unreachable",
        message: "参考视频公网地址 HEAD 探测失败，已回退为场景感知抽帧输入",
        reason: probeResult.reason
      });
      fileUrl = "";
    }
  }
  if (probe.storageUrl && !fileUrl && !frameOnlyModel) {
    warnings.push({
      code: "reference_video_storage_url_not_external",
      message: "参考视频存储地址不是可外部访问的 HTTP(S) URL，已回退为场景感知抽帧输入",
      reason: "storage_url_not_http"
    });
  }
  return {
    fileName: probe.fileName || basename(videoPath),
    mimeType,
    ...(fileUrl ? { fileUrl } : {}),
    frames: frames.filter((frame) => typeof frame?.dataUrl === "string" && frame.dataUrl.startsWith("data:image/")),
    timestampsSec,
    warnings
  };
}

function resolveModelFileUrl(probe = {}) {
  return externalHttpUrl(probe.storageUrl) || directObjectStorageUrl(probe.storageKey) || "";
}

// 对参考视频公网 URL 做一次轻量 HEAD 探测，判断外部是否可达。
// 可通过 context.headProbeReferenceUrl 注入（便于测试）；可用 wangzhuan.llm.urlHeadProbe=false 关闭。
async function headProbeReferenceUrl(context, fileUrl) {
  if (typeof context.headProbeReferenceUrl === "function") {
    try {
      const injected = await context.headProbeReferenceUrl({ fileUrl });
      if (injected && typeof injected === "object") {
        return { ok: injected.ok !== false, reason: String(injected.reason || "") };
      }
      return { ok: injected !== false, reason: "" };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error?.code || "head_probe_failed").slice(0, 160) };
    }
  }
  if (context.config?.wangzhuan?.llm?.urlHeadProbe === false) {
    return { ok: true, reason: "" };
  }
  const timeoutMs = clampInteger(context.config?.wangzhuan?.llm?.urlHeadProbeTimeoutMs, 5000, 1000, 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(fileUrl, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    if (response.ok) return { ok: true, reason: "" };
    return { ok: false, reason: `http_status_${response.status}` };
  } catch (error) {
    return { ok: false, reason: String(error?.name === "AbortError" ? "head_probe_timeout" : (error?.message || "head_probe_failed")).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
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

function buildDecompositionMessages(probe, request = {}, llmConfig = {}, visionInputs = {}, options = {}) {
  const promptText = buildDecompositionUserPrompt(probe, request, llmConfig, videoProbePrompt, {
    compact: Boolean(options.compact)
  });
  const forceFramesOnly = Boolean(options.forceFramesOnly);
  const userContent = [
    { type: "text", text: promptText }
  ];
  if (!forceFramesOnly && visionInputs.fileUrl) {
    // 模式①：公网 URL —— 模型直接读取整段视频，无需再附抽帧。
    // doubao / 火山 Seed 系模型走 OpenAI 兼容的 video_url 部件（实测 file.file_url 会被拒：
    // "filename must be used together with file_data"）；其它可读 file_url 的模型保留 file 部件。
    if (llmSupportsVideoUrl(llmConfig)) {
      userContent.push({
        type: "video_url",
        video_url: { url: visionInputs.fileUrl }
      });
    } else {
      userContent.push({
        type: "file",
        file: {
          filename: visionInputs.fileName || probe.fileName || "reference-video.mp4",
          file_url: visionInputs.fileUrl
        }
      });
    }
  } else {
    // 模式②：场景感知抽帧 —— 仅发送抽帧。
    for (const frame of visionInputs.frames || []) {
      userContent.push({
        type: "image_url",
        image_url: { url: frame.dataUrl }
      });
    }
  }
  return [
    {
      role: "system",
      content: DECOMPOSITION_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

function isFramesOnlyFallbackError(error) {
  if (!error) return false;
  const text = [
    error.message,
    error.data?.upstreamMessage,
    error.data?.reason
  ].filter(Boolean).join(" ");
  return /file_data|payload|too large|Invalid PDF input|request entity too large|413/i.test(text);
}

function framesOnlyVisionInput(visionInputs = {}, reason = "file_data_unavailable") {
  return {
    ...visionInputs,
    fileUrl: "",
    fileDataUrl: "",
    warnings: [
      ...(Array.isArray(visionInputs.warnings) ? visionInputs.warnings : []),
      {
        code: "reference_video_frames_only_fallback",
        message: "视频文件输入失败，已回退为仅抽帧输入",
        reason
      }
    ]
  };
}

function isModelFileUrlUnavailableError(error) {
  if (!error || error?.data?.inputMode !== "file_url") return false;
  const text = [
    error.message,
    error.data?.upstreamMessage,
    error.data?.reason
  ].filter(Boolean).join(" ").toLowerCase();
  return [
    "file_url",
    "file url",
    "file_uri",
    "file uri",
    "fileurl",
    "url",
    "uri",
    "link",
    "download",
    "fetch",
    "access",
    "accessible",
    "unreachable",
    "not found",
    "404",
    "403",
    "invalid file",
    "video link",
    "视频链接",
    "链接不可用",
    "无法访问",
    "无法读取",
    "下载失败",
    "不可访问",
    "不存在"
  ].some((needle) => text.includes(needle));
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
  const hasVideoUrlInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "video_url" && part.video_url?.url));
  const hasFileUrlInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_url));
  const hasFileDataInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_data));
  return (hasVideoUrlInput || hasFileUrlInput) ? "file_url" : hasFileDataInput ? "file_data" : "frames_only";
}

function shouldForceChatForFileUrl(llmConfig, messages) {
  return modelInputMode(messages) === "file_url"
    && String(llmConfig.provider || "").trim().toLowerCase() === "skylink"
    && /^gpt-5\.(?:4|5)(?:-(?:mini|nano))?$/i.test(String(llmConfig.model || "").trim());
}

function redactedModelRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (Array.isArray(body.contents)) return body;
  if (Array.isArray(body.input)) return body;
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    input: responsesInputFromMessages(body.messages)
  };
}

function geminiGenerateContentUrl(endpoint, model) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  if (clean.endsWith("/v1beta")) return `${clean}/models/${encodeURIComponent(String(model || "").trim())}:generateContent`;
  if (clean.endsWith("/api")) return `${clean}/v1beta/models/${encodeURIComponent(String(model || "").trim())}:generateContent`;
  if (clean.endsWith("/v1")) return `${clean}beta/models/${encodeURIComponent(String(model || "").trim())}:generateContent`;
  return `${clean}/v1beta/models/${encodeURIComponent(String(model || "").trim())}:generateContent`;
}

function geminiPartsFromMessages(messages = []) {
  const systemParts = [];
  const contents = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").toLowerCase();
    const sourceParts = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content || "") }];
    const parts = [];
    for (const part of sourceParts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        parts.push({ text: part.text });
        continue;
      }
      if (part.type === "image_url" && typeof part.image_url?.url === "string") {
        const match = part.image_url.url.match(/^data:([^;,]+);base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: {
              mimeType: match[1],
              data: match[2]
            }
          });
        }
        continue;
      }
      if (part.type === "file") {
        const fileData = String(part.file?.file_data || "");
        const fileUrl = String(part.file?.file_url || "").trim();
        const dataMatch = fileData.match(/^data:([^;,]+);base64,(.+)$/);
        if (dataMatch) {
          parts.push({
            inlineData: {
              mimeType: dataMatch[1],
              data: dataMatch[2]
            }
          });
        } else if (fileUrl) {
          parts.push({
            fileData: {
              mimeType: "video/mp4",
              fileUri: fileUrl
            }
          });
        }
      }
    }
    if (!parts.length) continue;
    if (role === "system") {
      systemParts.push(...parts);
    } else {
      contents.push({
        role: role === "assistant" ? "model" : "user",
        parts
      });
    }
  }
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents
  };
}

function llmResponseTextFromGemini(payload = {}) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
    if (text) return text;
  }
  return "";
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
      body: redactedModelRequestBody(body)
    }
  };
}

function safeResponseErrorPayload(error, fallbackReason) {
  return {
    ok: false,
    error: {
      name: error?.name || "",
      message: String(error?.message || fallbackReason || ""),
      ...(error?.data && typeof error.data === "object" ? { data: error.data } : {})
    }
  };
}

async function maybeDumpModelRequest(context, probe, request) {
  const requestId = String(request?.requestId || "").trim();
  if (!requestId || !context?.userProjectRoot || !probe?.referenceVideoId) return;
  const target = join(wangzhuanPaths(context).referenceVideosDir, probe.referenceVideoId, `llm-request-${requestId}.json`);
  await writeAtomicJson(target, request);
}

async function maybeDumpModelResponse(context, probe, response) {
  const requestId = String(response?.requestId || "").trim();
  if (!requestId || !context?.userProjectRoot || !probe?.referenceVideoId) return;
  const target = join(wangzhuanPaths(context).referenceVideosDir, probe.referenceVideoId, `llm-response-${requestId}.json`);
  await writeAtomicJson(target, response);
}

function buildStreamingDumpHooks(context, probe, llmConfig, requestId) {
  let requestDumped = false;
  let responseDumped = false;
  return {
    async dumpRequest(payload) {
      if (requestDumped) return;
      requestDumped = true;
      await maybeDumpModelRequest(context, probe, payload);
    },
    async dumpResponse(payload) {
      responseDumped = true;
      await maybeDumpModelResponse(context, probe, payload);
    },
    async dumpError(error, inputMode = "") {
      if (responseDumped) return;
      responseDumped = true;
      await maybeDumpModelResponse(context, probe, {
        requestId,
        createdAt: new Date().toISOString(),
        inputMode,
        response: safeResponseErrorPayload(error, error?.data?.reason || "request_failed")
      });
    }
  };
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
  const forceChatForFileUrl = shouldForceChatForFileUrl(llmConfig, messages);
  // GPT-5.x via Skylink /responses rejects input_file.file_url (probe 2026-06-22);
  // chat/completions accepts { type: "file", file: { file_url } } together with frame image_url parts.
  const chatMessages = messages;
  const chatPayload = {
    model: llmConfig.model,
    messages: chatMessages,
    temperature: llmConfig.temperature,
    response_format: { type: "json_object" }
  };
  const useResponses = canUseResponsesInput(messages)
    && !forceChatForFileUrl
    && !llmUsesSkylinkGeminiChatBridge(llmConfig);
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
    if (typeof options.dumpResponse === "function") {
      await options.dumpResponse({
        requestId: options.requestId,
        createdAt: new Date().toISOString(),
        inputMode,
        response: {
          status: response.status,
          ok: response.ok,
          body: payload
        }
      });
    }
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    if (typeof options.dumpResponse === "function") {
      await options.dumpResponse({
        requestId: options.requestId,
        createdAt: new Date().toISOString(),
        inputMode,
        response: {
          ok: false,
          error: {
            name: error?.name || "",
            message: String(error?.message || reason)
          }
        }
      });
    }
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

async function callGeminiCompatibleLlm(llmConfig, messages, options = {}) {
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
  const body = {
    ...geminiPartsFromMessages(messages),
    generationConfig: {
      temperature: llmConfig.temperature
    }
  };
  const inputMode = modelInputMode(messages);
  const url = geminiGenerateContentUrl(llmConfig.endpoint, llmConfig.model);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": llmConfig.apiKey
  };
  if (typeof options.dumpRequest === "function") {
    await options.dumpRequest(redactedModelRequest({
      requestId: options.requestId,
      inputMode,
      url,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": `<REDACTED:${llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY"}>`
      },
      body
    }));
  }
  let response;
  let payload = {};
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    payload = await response.json().catch(() => ({}));
    if (typeof options.dumpResponse === "function") {
      await options.dumpResponse({
        requestId: options.requestId,
        createdAt: new Date().toISOString(),
        inputMode,
        response: {
          status: response.status,
          ok: response.ok,
          body: payload
        }
      });
    }
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    if (typeof options.dumpResponse === "function") {
      await options.dumpResponse({
        requestId: options.requestId,
        createdAt: new Date().toISOString(),
        inputMode,
        response: {
          ok: false,
          error: {
            name: error?.name || "",
            message: String(error?.message || reason)
          }
        }
      });
    }
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
  return llmResponseTextFromGemini(payload);
}

export function buildGeminiRequestBody(messages, temperature) {
  return {
    ...geminiPartsFromMessages(messages),
    generationConfig: {
      temperature
    }
  };
}

async function invokeDecompositionLlmOnce(context, probe, request, llmConfig, visionInputs, options = {}) {
  const messages = buildDecompositionMessages(probe, request, llmConfig, visionInputs, {
    compact: Boolean(options.compactPrompt),
    forceFramesOnly: Boolean(options.forceFramesOnly)
  });
  const dumpHooks = buildStreamingDumpHooks(context, probe, llmConfig, options.requestId);
  if (typeof context.callWangzhuanLlm === "function") {
    return context.callWangzhuanLlm({
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
        fileUrl: options.forceFramesOnly ? "" : visionInputs.fileUrl,
        fileDataUrl: options.forceFramesOnly ? "" : visionInputs.fileDataUrl,
        frameCount: visionInputs.frames.length
      },
      visionInputs: options.forceFramesOnly
        ? { ...visionInputs, fileUrl: "", fileDataUrl: "" }
        : visionInputs
    });
  }
  const streamHandlers = options.streamHandlers;
  if (streamHandlers) {
    const inputMode = modelInputMode(messages);
    const streamMode = llmUsesGeminiNativeApi(llmConfig) ? "gemini.streamGenerateContent" : "chat.completions.stream";
    const streamUrl = llmUsesGeminiNativeApi(llmConfig)
      ? geminiStreamGenerateContentUrl(llmConfig.endpoint, llmConfig.model)
      : chatCompletionsUrl(llmConfig.endpoint);
    await dumpHooks.dumpRequest(redactedModelRequest({
      requestId: options.requestId,
      inputMode,
      url: streamUrl,
      headers: llmUsesGeminiNativeApi(llmConfig)
        ? {
          "Content-Type": "application/json",
          "x-goog-api-key": `<REDACTED:${llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY"}>`
        }
        : {
          "Content-Type": "application/json",
          Authorization: `Bearer <REDACTED:${llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY"}>`
        },
      body: llmUsesGeminiNativeApi(llmConfig)
        ? buildGeminiRequestBody(messages, llmConfig.temperature)
        : {
          model: llmConfig.model,
          messages,
          temperature: llmConfig.temperature,
          response_format: { type: "json_object" },
          stream: true
        }
    }));
    return callLlmStreaming(
      llmConfig,
      messages,
      {
        ...streamHandlers,
        onComplete: async ({ text, mode }) => {
          await dumpHooks.dumpResponse({
            requestId: options.requestId,
            createdAt: new Date().toISOString(),
            inputMode,
            response: {
              ok: true,
              mode: mode || streamMode,
              text
            }
          });
          await streamHandlers.onComplete?.({ text, mode });
        },
        onError: async ({ error, mode }) => {
          await dumpHooks.dumpError(error, inputMode, mode || streamMode);
          await streamHandlers.onError?.({ error, mode });
        }
      },
      (messageList) => buildGeminiRequestBody(messageList, llmConfig.temperature)
    );
  }
  return llmUsesGeminiNativeApi(llmConfig)
    ? callGeminiCompatibleLlm(llmConfig, messages, {
      requestId: options.requestId,
      dumpRequest: (dump) => maybeDumpModelRequest(context, probe, dump),
      dumpResponse: (dump) => maybeDumpModelResponse(context, probe, dump)
    })
    : callOpenAiCompatibleLlm(llmConfig, messages, {
      requestId: options.requestId,
      dumpRequest: (dump) => maybeDumpModelRequest(context, probe, dump),
      dumpResponse: (dump) => maybeDumpModelResponse(context, probe, dump)
    });
}

const DECOMPOSITION_RETRY_TIMEOUT_CAP_MS = 120000;
const DECOMPOSITION_RETRY_BACKOFF_BASE_MS = 1000;
const DECOMPOSITION_RETRY_BACKOFF_MAX_MS = 8000;
const LONG_VIDEO_COMPACT_PROMPT_THRESHOLD_SEC = 45;

/** 重试用更短的超时：首试可以等满配置窗口，但重试快速失败，避免每次都耗满导致总时长成倍膨胀。 */
function decompositionRetryTimeoutMs(baseTimeoutMs) {
  const base = Number(baseTimeoutMs);
  if (!Number.isFinite(base) || base <= 0) return DECOMPOSITION_RETRY_TIMEOUT_CAP_MS;
  return Math.min(base, DECOMPOSITION_RETRY_TIMEOUT_CAP_MS);
}

function parseAndValidateDecompositionContent(probe, content) {
  const decomposition = validateVideoDecomposition(probe.referenceVideoId, parseLlmJsonContent(content));
  if (decomposition.missingFields.length) {
    throw new WangzhuanError("schema_invalid", "模型拆解结果不完整，请重试或手动补充", {
      referenceVideoId: probe.referenceVideoId,
      missingFields: decomposition.missingFields
    });
  }
  return decomposition;
}

function isCompactPromptRetryError(error) {
  return error?.code === "schema_invalid" || error?.data?.reason === "invalid_json";
}

function shouldUseCompactDecompositionPromptInitially(probe) {
  const durationSec = Number(probe?.durationSec);
  return Number.isFinite(durationSec) && durationSec > LONG_VIDEO_COMPACT_PROMPT_THRESHOLD_SEC;
}

async function invokeDecompositionLlm(context, probe, request, llmConfig, visionInputs, options = {}) {
  const maxRetries = Number.isFinite(Number(llmConfig.maxRetries))
    ? Math.max(0, Math.trunc(Number(llmConfig.maxRetries)))
    : 3;
  const retryTimeoutMs = decompositionRetryTimeoutMs(llmConfig.timeoutMs);
  let lastError;
  let activeVisionInputs = visionInputs;
  let fellBackToFramesOnly = false;
  let useCompactPrompt = shouldUseCompactDecompositionPromptInitially(probe);
  return invokeLlmWithRetry({
    maxRetries,
    initialBackoffMs: DECOMPOSITION_RETRY_BACKOFF_BASE_MS,
    maxBackoffMs: DECOMPOSITION_RETRY_BACKOFF_MAX_MS,
    retryTimeoutCapMs: retryTimeoutMs,
    onRetry: async (attempt, retry) => {
      if (options.streamHandlers?.onRetry) {
        options.streamHandlers.onRetry({
          attempt,
          maxRetries,
          timeoutMs: retry.timeoutCapMs,
          inputMode: activeVisionInputs.fileUrl ? "file_url" : "frames_only",
          reason: lastError?.data?.reason || lastError?.code || "",
          upstreamMessage: String(lastError?.data?.upstreamMessage || lastError?.message || "").slice(0, 300),
          code: String(lastError?.code || ""),
          status: Number(lastError?.data?.status || 0) || undefined
        });
      }
    },
    call: async (attempt) => {
      const activeLlmConfig = attempt > 1 && retryTimeoutMs < Number(llmConfig.timeoutMs || 0)
        ? { ...llmConfig, timeoutMs: retryTimeoutMs }
        : llmConfig;
      const content = await invokeDecompositionLlmOnce(context, probe, request, activeLlmConfig, activeVisionInputs, {
        ...options,
        compactPrompt: useCompactPrompt,
        forceFramesOnly: fellBackToFramesOnly
      });
      return parseAndValidateDecompositionContent(probe, content);
    },
    isRetryable: async (error) => {
      lastError = error;
      // 两模式降级：公网 URL 不可读 → 直接改用场景感知抽帧（不再有 base64 内联中间态）。
      if (
        !fellBackToFramesOnly
        && activeVisionInputs.fileUrl
        && (activeVisionInputs.frames?.length || 0) > 0
        && (isModelFileUrlUnavailableError(error) || isFramesOnlyFallbackError(error))
      ) {
        fellBackToFramesOnly = true;
        if (options.streamHandlers?.onFallback) {
          options.streamHandlers.onFallback({
            from: "file_url",
            to: "frames_only",
            reason: String(error?.data?.upstreamMessage || error?.message || "file_url_unavailable").slice(0, 160)
          });
        }
        activeVisionInputs = framesOnlyVisionInput(activeVisionInputs, "file_url_unavailable");
        visionInputs.fileUrl = activeVisionInputs.fileUrl;
        visionInputs.warnings = activeVisionInputs.warnings;
        return "fallback";
      }
      if (isCompactPromptRetryError(error)) {
        useCompactPrompt = true;
      }
      return isRetryableLlmError(error);
    }
  });
}

async function finalizeDraftDecomposition(context, probe, request, llmConfig, decomposition) {
  const recordEvent = typeof context.recordTelemetryEvent === "function"
    ? context.recordTelemetryEvent
    : (eventName, payload) => recordTelemetryEvent(context, eventName, payload);
  await recordEvent("script_decomposition_drafted", {
    referenceVideoId: probe.referenceVideoId,
    provider: llmConfig.provider,
    model: llmConfig.model,
    status: "drafted"
  });
  await writeCachedDecomposition(context, probe, request, llmConfig, decomposition);
  return {
    decomposition,
    draft: {
      source: "llm",
      provider: llmConfig.provider,
      model: llmConfig.model,
      referenceVideoId: probe.referenceVideoId
    },
    warnings: []
  };
}

export async function draftReferenceVideoDecomposition(context, request = {}, options = {}) {
  const probe = await loadReferenceVideoProbe(context, request.referenceVideoId);
  if (probe.status === "fail") {
    throw new WangzhuanError("invalid_video", "参考视频检查未通过，不能自动拆解", { referenceVideoId: probe.referenceVideoId });
  }
  const llmConfig = resolveLlmConfig(context.config || {}, request.llmConfig || {});
  const cached = await loadCachedDecomposition(context, probe, request, llmConfig);
  if (cached?.decomposition) {
    const decomposition = validateVideoDecomposition(probe.referenceVideoId, {
      ...cached.decomposition,
      referenceVideoId: probe.referenceVideoId
    });
    return {
      decomposition,
      draft: {
        source: "cache",
        provider: llmConfig.provider,
        model: llmConfig.model,
        referenceVideoId: probe.referenceVideoId,
        cacheKey: cached.cacheKey
      },
      warnings: [{
        code: "decomposition_cache_hit",
        message: "命中相同视频、模型、地区和语言的拆解缓存"
      }]
    };
  }
  const visionInputs = await collectReferenceVideoVisionInputs(context, probe, llmConfig);
  const decomposition = await invokeDecompositionLlm(context, probe, request, llmConfig, visionInputs, options);
  const result = await finalizeDraftDecomposition(context, probe, request, llmConfig, decomposition);
  return {
    ...result,
    warnings: visionInputs.warnings
  };
}

export async function draftReferenceVideoDecompositionStream(context, request = {}, res, options = {}) {
  const requestId = options.requestId;
  try {
    writeSseLog(res, `[${new Date().toISOString()}] init draft-decomposition stream`);
    const probe = await loadReferenceVideoProbe(context, request.referenceVideoId);
    if (probe.status === "fail") {
      throw new WangzhuanError("invalid_video", "参考视频检查未通过，不能自动拆解", { referenceVideoId: probe.referenceVideoId });
    }
    const llmConfig = resolveLlmConfig(context.config || {}, request.llmConfig || {});
    const visionInputs = await collectReferenceVideoVisionInputs(context, probe, llmConfig);
    writeSseLog(res, `model=${llmConfig.model} provider=${llmConfig.provider}`);
    writeSseLog(res, "POST upstream stream=true …");
    const decomposition = await invokeDecompositionLlm(context, probe, request, llmConfig, visionInputs, {
      requestId,
      streamHandlers: {
        onRequest: ({ mode }) => writeSseLog(res, `upstream: ${mode}`),
        onDelta: (delta) => writeSseDelta(res, delta),
        onRetry: ({ attempt, maxRetries }) => writeSseLog(
          res,
          `upstream retry ${attempt}/${maxRetries} after transient model error`
        ),
        onFallback: ({ from, to, reason }) => writeSseLog(
          res,
          `upstream fallback ${from}->${to}: ${reason || "file_url_unavailable"}`
        )
      }
    });
    writeSseLog(res, "");
    writeSseLog(res, "[DONE] received — parsing JSON …");
    const result = await finalizeDraftDecomposition(context, probe, request, llmConfig, decomposition);
    writeSseLog(res, "parse ok — decomposition ready");
    writeSseDone(res, {
      ...result,
      warnings: visionInputs.warnings
    }, requestId);
  } catch (error) {
    writeSseError(res, error, requestId);
  }
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

export {
  buildBatchReferenceFrameExtractionPlan,
  buildSceneAwareFrameTimestamps,
  callGeminiCompatibleLlm,
  callOpenAiCompatibleLlm,
  detectReferenceVideoScenes,
  extractReferenceFrames,
  parseLlmJsonContent
};
