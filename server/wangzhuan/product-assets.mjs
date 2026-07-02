import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";

import { reviewSeedanceAsset } from "./asset-review.mjs";
import { WangzhuanError } from "./http.mjs";
import { syncWangzhuanAsset, toProjectRelative, wangzhuanPaths } from "./storage.mjs";

const PRODUCT_ASSET_KEYS = new Set([
  "productIcon",
  "productScreenshot",
  "productRecording",
  "ctaAsset",
  "endingAsset",
  "personAsset",
  "rewardElement"
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/mov"]);
const MAX_PRODUCT_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_DISCLAIMER_ASSET_BYTES = 5 * 1024 * 1024;

function sanitizeSegment(value, fallback = "asset") {
  return String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || fallback;
}

function sanitizeFileName(name, fallback = "asset") {
  const parsed = parse(basename(name || fallback));
  const safeBase = sanitizeSegment(parsed.name, fallback);
  const safeExt = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `${safeBase}${safeExt}`;
}

function parseUploadContent(content) {
  if (typeof content !== "string" || !content.includes(",")) {
    throw new WangzhuanError("validation_error", "上传素材读取失败，请重新选择素材", { field: "content" });
  }
  const buffer = Buffer.from(content.split(",").pop() || "", "base64");
  if (!buffer.length) {
    throw new WangzhuanError("invalid_material", "素材文件为空", { field: "content" });
  }
  return buffer;
}

function allowedMimeForExt(ext) {
  if (IMAGE_EXTS.has(ext)) return IMAGE_MIME_TYPES;
  if (VIDEO_EXTS.has(ext)) return VIDEO_MIME_TYPES;
  return new Set();
}

export async function uploadProductAsset(context, request = {}) {
  const assetKey = sanitizeSegment(request.assetKey);
  if (!PRODUCT_ASSET_KEYS.has(assetKey)) {
    throw new WangzhuanError("validation_error", "产品素材字段不支持", { field: "assetKey", assetKey });
  }
  const fileName = sanitizeFileName(request.fileName || request.name, assetKey);
  const ext = extname(fileName).toLowerCase();
  const allowedMimes = allowedMimeForExt(ext);
  const mimeType = String(request.mimeType || "").toLowerCase();
  if (!allowedMimes.size || (mimeType && !allowedMimes.has(mimeType))) {
    throw new WangzhuanError("invalid_material", "素材格式不符合要求，请上传图片或视频", {
      field: "fileName",
      allowedExts: [...IMAGE_EXTS, ...VIDEO_EXTS]
    });
  }
  const buffer = parseUploadContent(request.content);
  if (buffer.length > MAX_PRODUCT_ASSET_BYTES) {
    throw new WangzhuanError("file_too_large", "文件超过大小上限", {
      sizeBytes: buffer.length,
      maxUploadBytes: MAX_PRODUCT_ASSET_BYTES
    });
  }

  const branchId = sanitizeSegment(request.branchId || "branch_1", "branch_1");
  const targetDir = join(wangzhuanPaths(context).userRoot, "product-assets", branchId, assetKey);
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, fileName);
  await writeFile(target, buffer);
  const storage = await syncWangzhuanAsset(context, target, `product_${assetKey}`, { required: true });
  const storedPath = toProjectRelative(context.userProjectRoot, target);
  const normalizedMimeType = mimeType || [...allowedMimes][0] || "application/octet-stream";
  const review = await reviewSeedanceAsset(context, {
    branchId,
    assetKey,
    fileName,
    mimeType: normalizedMimeType,
    buffer,
    storageUrl: storage.storageUrl,
    storageKey: storage.storageKey,
    storedPath
  });
  return {
    asset: {
      branchId,
      assetKey,
      fileName,
      mimeType: normalizedMimeType,
      sizeBytes: buffer.length,
      storedPath,
      previewUrl: storage.storageUrl,
      storageKey: storage.storageKey,
      storageUrl: storage.storageUrl,
      review
    }
  };
}

export async function uploadDisclaimerOverlayAsset(context, request = {}) {
  const fileName = sanitizeFileName(request.fileName || request.name, "disclaimer-overlay.png");
  const ext = extname(fileName).toLowerCase();
  const mimeType = String(request.mimeType || "").toLowerCase();
  if (ext !== ".png" || (mimeType && mimeType !== "image/png")) {
    throw new WangzhuanError("invalid_material", "免责声明贴片只支持透明背景 PNG", {
      field: "fileName",
      allowedExts: [".png"]
    });
  }
  const buffer = parseUploadContent(request.content);
  if (buffer.length > MAX_DISCLAIMER_ASSET_BYTES) {
    throw new WangzhuanError("file_too_large", "免责声明贴片超过大小上限", {
      sizeBytes: buffer.length,
      maxUploadBytes: MAX_DISCLAIMER_ASSET_BYTES
    });
  }
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new WangzhuanError("invalid_material", "免责声明贴片不是有效 PNG 文件", { field: "content" });
  }

  const targetDir = join(wangzhuanPaths(context).userRoot, "disclaimer-overlays");
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, `${Date.now()}-${fileName}`);
  await writeFile(target, buffer);
  const storage = await syncWangzhuanAsset(context, target, "disclaimer_overlay", { required: true });
  const storedPath = toProjectRelative(context.userProjectRoot, target);
  return {
    asset: {
      fileName,
      mimeType: "image/png",
      sizeBytes: buffer.length,
      storedPath,
      previewUrl: storage.storageUrl,
      storageKey: storage.storageKey,
      storageUrl: storage.storageUrl
    }
  };
}
