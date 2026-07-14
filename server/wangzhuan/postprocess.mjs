import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { normalizeExpansionRequest } from "./output-expansion.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths } from "./storage.mjs";
import { normalizeSubtitlePostProcess } from "./subtitles.mjs";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/mov"]);
const MAX_ENDING_BYTES = 100 * 1024 * 1024;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeSegment(value, fallback = "ending") {
  return String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || fallback;
}

function sanitizeFileName(value) {
  const parsed = parse(basename(value || "ending"));
  const name = sanitizeSegment(parsed.name, "ending");
  const extension = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `${name}${extension}`;
}

function mediaTypeFor(ext, mimeType = "") {
  if (IMAGE_EXTS.has(ext) && (!mimeType || IMAGE_MIME_TYPES.has(mimeType))) return "image";
  if (VIDEO_EXTS.has(ext) && (!mimeType || VIDEO_MIME_TYPES.has(mimeType))) return "video";
  return "";
}

function decodeUploadContent(content) {
  if (typeof content !== "string" || !content.includes(",")) {
    throw new WangzhuanError("validation_error", "Ending 文件读取失败，请重新选择", { field: "content" });
  }
  const buffer = Buffer.from(content.split(",").pop() || "", "base64");
  if (!buffer.length) {
    throw new WangzhuanError("invalid_material", "Ending 文件为空", { field: "content" });
  }
  return buffer;
}

function normalizeEnding(value) {
  if (!value || typeof value !== "object" || value.enabled === false) return null;
  const fileName = cleanString(value.fileName || value.name);
  const mimeType = cleanString(value.mimeType).toLowerCase();
  const extension = extname(fileName).toLowerCase();
  const mediaType = cleanString(value.mediaType) || mediaTypeFor(extension, mimeType);
  const storedPath = cleanString(value.storedPath);
  const storageUrl = cleanString(value.storageUrl);
  if (!fileName || !mediaType || (!storedPath && !storageUrl)) return null;
  return {
    enabled: true,
    fileName,
    mimeType,
    storedPath,
    storageKey: cleanString(value.storageKey),
    storageUrl,
    previewUrl: cleanString(value.previewUrl) || storageUrl,
    mediaType,
    imageDurationSec: 1
  };
}

export function normalizeExpansionSizes(values = []) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeExpansionRequest(value);
    const sizeKey = `${item.targetWidth}x${item.targetHeight}`;
    if (seen.has(sizeKey)) continue;
    seen.add(sizeKey);
    normalized.push({ ...item, sizeKey });
  }
  return normalized;
}

export function normalizeBatchPostProcess(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ending: normalizeEnding(source.ending),
    subtitles: normalizeSubtitlePostProcess(source.subtitles),
    expansionSizes: normalizeExpansionSizes(source.expansionSizes)
  };
}

export function resolveBatchPostProcess(batch = {}) {
  const source = batch?.request?.postProcess
    ?? batch?.estimate?.request?.postProcess
    ?? batch?.templateSnapshot?.draft?.postProcess
    ?? {};
  return normalizeBatchPostProcess(source);
}

export async function uploadPostProcessEnding(context, request = {}) {
  const fileName = sanitizeFileName(request.fileName || request.name);
  const extension = extname(fileName).toLowerCase();
  const mimeType = cleanString(request.mimeType).toLowerCase();
  const mediaType = mediaTypeFor(extension, mimeType);
  if (!mediaType) {
    throw new WangzhuanError("invalid_material", "后处理 Ending 只支持图片或视频", {
      field: "fileName",
      allowedExts: [...IMAGE_EXTS, ...VIDEO_EXTS]
    });
  }
  const buffer = decodeUploadContent(request.content);
  if (buffer.length > MAX_ENDING_BYTES) {
    throw new WangzhuanError("file_too_large", "后处理 Ending 超过大小上限", {
      sizeBytes: buffer.length,
      maxUploadBytes: MAX_ENDING_BYTES
    });
  }

  const targetDir = join(wangzhuanPaths(context).userRoot, "postprocess-assets", "ending");
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${fileName}`);
  await writeFile(target, buffer);
  const storage = await syncWangzhuanAsset(context, target, "postprocess_ending", { required: true });
  const storedPath = toProjectRelative(context.userProjectRoot, target);
  return {
    asset: {
      enabled: true,
      fileName,
      mimeType,
      mediaType,
      imageDurationSec: 1,
      sizeBytes: buffer.length,
      storedPath,
      previewUrl: storage.storageUrl,
      storageKey: storage.storageKey,
      storageUrl: storage.storageUrl
    }
  };
}
