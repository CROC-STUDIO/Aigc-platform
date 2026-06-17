import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";

import { effectiveLimits } from "./config.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeReferenceVideoId } from "./ids.mjs";
import { readJsonOrDefault, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/mov"]);
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

async function nextReferenceSeq(paths) {
  const indexPath = join(paths.referenceVideosDir, "index.json");
  const index = await readJsonOrDefault(indexPath, { schemaVersion: "reference-videos.v1", nextSeq: 1, items: [] });
  return { indexPath, index };
}

async function saveReferenceIndex(indexPath, index) {
  await writeAtomicJson(indexPath, index);
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

  const { indexPath, index } = await nextReferenceSeq(paths);
  const referenceVideoId = makeReferenceVideoId(index.nextSeq || 1);
  index.nextSeq = (index.nextSeq || 1) + 1;

  const referenceDir = join(paths.referenceVideosDir, referenceVideoId);
  await mkdir(referenceDir, { recursive: true });
  const originalPath = join(referenceDir, `original${ext}`);
  await writeFile(originalPath, buffer);

  const durationSec = Number(request.durationSec || 0);
  const width = Number(request.width || 0);
  const height = Number(request.height || 0);
  const canExtractFrame = request.canExtractFrame !== false;
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
    canExtractFrame,
    status: issues.some((item) => item.severity === "error") ? "fail" : issues.length ? "warn" : "pass",
    issues,
    storedPath: toProjectRelative(context.userProjectRoot, originalPath)
  };

  await writeAtomicJson(join(referenceDir, "probe.json"), probe);
  index.items = Array.isArray(index.items) ? index.items : [];
  index.items.push({
    referenceVideoId,
    probePath: toProjectRelative(context.userProjectRoot, join(referenceDir, "probe.json")),
    createdBy: context.userId,
    createdAt: new Date().toISOString()
  });
  await saveReferenceIndex(indexPath, index);
  await recordTelemetryEvent(context, "reference_video_checked", {
    referenceVideoId,
    status: probe.status,
    durationSec: probe.durationSec,
    ratio: probe.ratio,
    issueCodes: probe.issues.map((item) => item.code)
  });

  return { referenceVideo: probe };
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
  const probePath = join(wangzhuanPaths(context).referenceVideosDir, referenceVideoId, "probe.json");
  if (!existsSync(probePath)) {
    throw new WangzhuanError("reference_video_not_found", "参考视频不存在，请重新上传", { referenceVideoId });
  }
  return JSON.parse(await readFile(probePath, "utf8"));
}

export function validateVideoDecomposition(referenceVideoId, decomposition = {}) {
  const missingFields = DECOMPOSITION_REQUIRED_FIELDS.filter((field) => {
    const value = decomposition[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  return {
    referenceVideoId,
    schemaVersion: "video_decomposition.v1",
    scene: String(decomposition.scene || ""),
    subject: String(decomposition.subject || ""),
    action: String(decomposition.action || ""),
    camera: String(decomposition.camera || ""),
    lighting: String(decomposition.lighting || ""),
    style: String(decomposition.style || ""),
    quality: String(decomposition.quality || ""),
    hook: String(decomposition.hook || ""),
    ...(decomposition.subtitleArea ? { subtitleArea: decomposition.subtitleArea } : {}),
    ...(decomposition.appIconArea ? { appIconArea: decomposition.appIconArea } : {}),
    ...(decomposition.phoneUi ? { phoneUi: String(decomposition.phoneUi) } : {}),
    ...(decomposition.rewardFeedback ? { rewardFeedback: String(decomposition.rewardFeedback) } : {}),
    ...(decomposition.cta ? { cta: String(decomposition.cta) } : {}),
    ...(decomposition.disclaimer ? { disclaimer: String(decomposition.disclaimer) } : {}),
    missingFields
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
