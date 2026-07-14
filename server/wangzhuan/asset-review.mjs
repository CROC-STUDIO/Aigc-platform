import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { FINAL_TAIL_REFERENCE_ASSET_ORDER, MAX_SEEDANCE_REFERENCE_ASSETS, REFERENCE_ASSET_ORDER } from "./reference-assets.mjs";
import { openWangzhuanObjectStream } from "./storage.mjs";

const ASSET_KEY_TO_SLOT = Object.freeze({
  productIcon: { key: "product_icon", index: 1 },
  productScreenshot: { key: "product_screenshot", index: 2 },
  productRecording: { key: "product_recording", index: 1 },
  ctaAsset: { key: "cta", index: 3 },
  endingAsset: { key: "ending", index: 2 },
  personAsset: { key: "person", index: 4 },
  rewardElement: { key: "reward_element", index: 5 }
});

const MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
});

const DEFAULT_ASSET_REVIEW_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_ASSET_REVIEW_POLL_INTERVAL_MS = 2_000;

export function assetKeyToAssetType(assetKey) {
  const videoKeys = new Set(["productRecording"]);
  return videoKeys.has(assetKey) ? "video_asset" : "image_asset";
}

export function assetKeyToAssetRole(assetKey) {
  return "reference";
}

export function assetKeyToSlot(assetKey) {
  return ASSET_KEY_TO_SLOT[assetKey] || { key: assetKey, index: 0 };
}

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function reviewStatus(value) {
  const status = cleanString(value).toLowerCase();
  if (["approved", "active", "success", "succeeded", "pass", "passed"].includes(status)) return "approved";
  if (["rejected", "reject"].includes(status)) return "rejected";
  if (["failed", "fail", "error"].includes(status)) return "failed";
  if (["running", "processing", "pending", "queued"].includes(status)) return status;
  return status || "pending";
}

function positiveInteger(value, fallback, { min = 0, max = 120_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function assetReviewWaitOptions(context = {}) {
  const config = context.config?.wangzhuan?.seedanceAssetReview || {};
  return {
    timeoutMs: positiveInteger(
      config.waitTimeoutMs ?? process.env.WANGZHUAN_ASSET_REVIEW_WAIT_MS,
      DEFAULT_ASSET_REVIEW_WAIT_TIMEOUT_MS
    ),
    intervalMs: positiveInteger(
      config.pollIntervalMs ?? process.env.WANGZHUAN_ASSET_REVIEW_POLL_MS,
      DEFAULT_ASSET_REVIEW_POLL_INTERVAL_MS,
      { min: 100, max: 30_000 }
    )
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReviewPending(status) {
  return ["pending", "queued", "running", "processing"].includes(reviewStatus(status));
}

function assetTypeFromMime(mimeType = "") {
  const mime = cleanString(mimeType).toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
}

function mimeTypeFromAsset(asset = {}) {
  const explicit = cleanString(asset.mimeType).toLowerCase();
  if (explicit) return explicit;
  const fileName = cleanString(asset.fileName).toLowerCase();
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function normalizeReviewResponse(payload = {}, fallback = {}) {
  const body = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const assetId = cleanString(body.asset_id, cleanString(body.assetId, cleanString(body.id, fallback.assetId)));
  const status = reviewStatus(body.status || fallback.status);
  return {
    assetId,
    status,
    assetType: cleanString(body.asset_type, cleanString(body.assetType, fallback.assetType)),
    contentUrl: cleanString(body.content_url, cleanString(body.contentUrl, fallback.contentUrl)),
    upstreamAssetId: cleanString(body.upstream_asset_id, cleanString(body.upstreamAssetId)),
    upstreamAssetUri: cleanString(body.upstream_asset_uri, cleanString(body.upstreamAssetUri)),
    reviewReason: cleanString(body.review_reason, cleanString(body.reviewReason, fallback.reviewReason)),
    reviewPayload: body.review_payload || body.reviewPayload || {}
  };
}

function seedanceAssetDetailUrl(context = {}, assetId = "") {
  const provider = context.config?.wangzhuan?.seedanceProvider || {};
  const review = context.config?.wangzhuan?.seedanceAssetReview || {};
  const endpoint = cleanString(review.endpoint, cleanString(provider.endpoint, cleanString(process.env.WANGZHUAN_SEEDANCE_ENDPOINT))).replace(/\/+$/, "");
  const basePath = cleanString(review.detailPath, "/seedance/assets/{asset_id}");
  if (!endpoint || !assetId) return "";
  const path = basePath.replace("{asset_id}", encodeURIComponent(assetId)).replace(/^\/+/, "");
  return `${endpoint}/${path}`;
}

function seedanceAssetsUploadUrl(context = {}) {
  const provider = context.config?.wangzhuan?.seedanceProvider || {};
  const review = context.config?.wangzhuan?.seedanceAssetReview || {};
  const endpoint = cleanString(review.endpoint, cleanString(provider.endpoint, cleanString(process.env.WANGZHUAN_SEEDANCE_ENDPOINT))).replace(/\/+$/, "");
  const uploadPath = cleanString(review.uploadPath, "/seedance/assets/upload").replace(/^\/+/, "");
  return endpoint ? `${endpoint}/${uploadPath}` : "";
}

function seedanceApiKey(context = {}) {
  const provider = context.config?.wangzhuan?.seedanceProvider || {};
  const review = context.config?.wangzhuan?.seedanceAssetReview || {};
  const configuredApiKeyEnv = cleanString(review.apiKeyEnv, cleanString(provider.apiKeyEnv));
  return cleanString(
    review.apiKey,
    cleanString(
      provider.apiKey,
      cleanString(
        process.env.WANGZHUAN_SEEDANCE_API_KEY,
        cleanString(configuredApiKeyEnv ? process.env[configuredApiKeyEnv] : "", cleanString(process.env.VIDEO_AIGC_API_KEY))
      )
    )
  );
}

export async function reviewSeedanceAsset(context = {}, asset = {}) {
  const mimeType = mimeTypeFromAsset(asset);
  if (typeof context.reviewProductAsset === "function") {
    return normalizeReviewResponse(await context.reviewProductAsset(asset), {
      assetType: assetTypeFromMime(mimeType),
      contentUrl: asset.storageUrl
    });
  }
  const url = seedanceAssetsUploadUrl(context);
  const apiKey = seedanceApiKey(context);
  if (!url || !apiKey || typeof context.fetch !== "function" && typeof globalThis.fetch !== "function") {
    return {
      assetId: "",
      status: "pending",
      assetType: assetTypeFromMime(mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: "素材审核服务未配置或暂不可用"
    };
  }
  const fetchImpl = context.fetch || globalThis.fetch;
  const buffer = Buffer.isBuffer(asset.buffer) && asset.buffer.length
    ? asset.buffer
    : await loadAssetBuffer(context, asset);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), asset.fileName || "asset");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } catch (error) {
    return {
      assetId: "",
      status: "pending",
      assetType: assetTypeFromMime(mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: `素材审核服务请求失败，已先保存素材：${String(error?.message || error || "").slice(0, 160)}`
    };
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      assetId: "",
      status: "failed",
      assetType: assetTypeFromMime(mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: payload.message || payload.detail || `素材审核上传失败：HTTP ${response.status}`
    };
  }
  return normalizeReviewResponse(payload, {
    assetType: assetTypeFromMime(mimeType),
    contentUrl: asset.storageUrl
  });
}

export async function refreshSeedanceAssetReview(context = {}, asset = {}) {
  if (typeof context.getProductAssetReview === "function") {
    return normalizeReviewResponse(await context.getProductAssetReview(asset), {
      assetId: asset.assetId,
      status: asset.status,
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl,
      reviewReason: asset.reviewReason
    });
  }
  const assetId = cleanString(asset.assetId);
  const url = seedanceAssetDetailUrl(context, assetId);
  const apiKey = seedanceApiKey(context);
  if (!assetId) {
    return {
      assetId: "",
      status: "failed",
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: "素材缺少 Seedance asset_id，请重新上传"
    };
  }
  if (!url || !apiKey || (typeof context.fetch !== "function" && typeof globalThis.fetch !== "function")) {
    return {
      assetId,
      status: reviewStatus(asset.status) || "pending",
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: cleanString(asset.reviewReason, "素材审核状态查询服务未配置")
    };
  }
  const fetchImpl = context.fetch || globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      assetId,
      status: "failed",
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: payload.message || payload.detail || `素材审核状态查询失败：HTTP ${response.status}`
    };
  }
  const normalized = normalizeReviewResponse(payload, {
    assetId,
    status: asset.status,
    assetType: assetTypeFromMime(asset.mimeType),
    contentUrl: asset.storageUrl,
    reviewReason: asset.reviewReason
  });
  return {
    ...normalized,
    reviewReason: cleanString(normalized.reviewReason, asset.reviewReason)
  };
}

async function waitForSeedanceAssetReview(context = {}, asset = {}, initialReview = {}) {
  let latest = { ...initialReview };
  if (!cleanString(latest.assetId) || !isReviewPending(latest.status)) return latest;
  const { timeoutMs, intervalMs } = assetReviewWaitOptions(context);
  if (!timeoutMs) return latest;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isReviewPending(latest.status)) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    latest = await refreshSeedanceAssetReview(context, {
      ...asset,
      ...latest,
      assetId: latest.assetId,
      status: latest.status,
      reviewReason: latest.reviewReason
    });
  }
  return latest;
}

async function bufferFromReadable(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isMissingStorageObjectError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || error?.name || "").toLowerCase();
  return (
    code === "nosuchkey"
    || code === "notfound"
    || code === "nosuchobject"
    || message.includes("specified key does not exist")
    || message.includes("no such key")
    || message.includes("object does not exist")
  );
}

async function loadAssetBuffer(context, asset = {}) {
  if (Buffer.isBuffer(asset.buffer) && asset.buffer.length) return asset.buffer;
  const productInfoPath = resolveProductInfoAssetPath(context, asset.storedPath || asset.storageKey);
  if (productInfoPath) return readFile(productInfoPath);
  if (asset.storageKey) {
    try {
      const object = await openWangzhuanObjectStream(context, asset.storageKey);
      if (object?.body) return bufferFromReadable(object.body);
    } catch (error) {
      if (!asset.storedPath || !isMissingStorageObjectError(error)) {
        throw error;
      }
    }
  }
  if (asset.storedPath) {
    return readFile(resolve(context.userProjectRoot, String(asset.storedPath).replace(/^[\\/]+/, "")));
  }
  throw new WangzhuanError("missing_required_file", "产品素材原文件缺失，请重新上传", {
    assetKey: asset.assetKey,
    fileName: asset.fileName || ""
  });
}

function resolveProductInfoAssetPath(context = {}, value = "") {
  const relative = cleanString(value).replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = relative.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "product_info" || parts[2] !== "assets") return "";
  const productId = parts[1];
  const fileName = parts[3];
  if (!/^[a-z0-9._-]+$/i.test(productId)) return "";
  if (!fileName || fileName !== basename(fileName) || fileName.includes("..")) return "";
  const root = resolve(context.productInfoRoot || join(process.cwd(), "product_info"));
  const assetsRoot = resolve(root, productId, "assets");
  const target = resolve(assetsRoot, fileName);
  return target.startsWith(`${assetsRoot}/`) ? target : "";
}

function shouldReviewAsset(branch = {}, assetKey) {
  const storageKey = cleanString(branch.assetStorageKeys?.[assetKey]);
  const storedPath = cleanString(branch.assetStoredPaths?.[assetKey] || branch.assetRelativePaths?.[assetKey]);
  return Boolean(storageKey || storedPath);
}

function branchHasReferenceAsset(branch = {}, assetKey) {
  return Boolean(
    cleanString(branch?.assetUrls?.[assetKey])
    || cleanString(branch?.assetStorageKeys?.[assetKey])
    || cleanString(branch?.assetStoredPaths?.[assetKey] || branch?.assetRelativePaths?.[assetKey])
  );
}

export { branchHasReferenceAsset };

function isApprovedAssetReviewState(state = {}) {
  return reviewStatus(state.status) === "approved" && Boolean(cleanString(state.assetId));
}

function isBlockingAssetReviewState(_branch = {}, _assetKey = "", state = {}) {
  return !isApprovedAssetReviewState(state);
}

export function requiresSeedanceAssetReview(branch = {}, assetKey) {
  return branchHasReferenceAsset(branch, assetKey);
}

export function countReferencedAssets(branch = {}) {
  const keys = new Set([
    ...Object.keys(branch.assetFileNames || {}),
    ...Object.keys(branch.assetUrls || {})
  ]);
  let count = 0;
  for (const key of keys) {
    if (!REFERENCE_ASSET_ORDER.includes(key)) continue;
    if (cleanString(branch.assetFileNames?.[key]) || cleanString(branch.assetUrls?.[key])) count += 1;
  }
  return count;
}

function reviewAssetOrder() {
  return [...REFERENCE_ASSET_ORDER, ...FINAL_TAIL_REFERENCE_ASSET_ORDER];
}

export async function ensureAssetReviewsApproved(context, branchDrafts = []) {
  const branches = Array.isArray(branchDrafts) ? branchDrafts : [branchDrafts];
  const nextBranches = [];
  for (const branch of branches) {
    const assetCount = countReferencedAssets(branch);
    if (assetCount > MAX_SEEDANCE_REFERENCE_ASSETS) {
      throw new WangzhuanError("validation_error", "Seedance 参考素材不能超过 9 个，请减少后重试", {
        maxAssets: MAX_SEEDANCE_REFERENCE_ASSETS,
        assetCount,
        branchId: branch.branchId || ""
      });
    }
    const nextBranch = {
      ...branch,
      assetReviews: { ...(branch.assetReviews || {}) }
    };
    for (const assetKey of reviewAssetOrder()) {
      if (!shouldReviewAsset(nextBranch, assetKey)) continue;
      const current = nextBranch.assetReviews?.[assetKey] || {};
      const currentStatus = reviewStatus(current.status);
      if (currentStatus === "approved" || currentStatus === "rejected" || currentStatus === "failed") continue;
      const review = current.assetId
        ? await refreshSeedanceAssetReview(context, {
            assetId: current.assetId,
            assetKey,
            branchId: nextBranch.branchId,
            fileName: nextBranch.assetFileNames?.[assetKey] || assetKey,
            mimeType: current.mimeType || "",
            status: current.status,
            reviewReason: current.reviewReason,
            storageUrl: nextBranch.assetUrls?.[assetKey] || "",
            storageKey: nextBranch.assetStorageKeys?.[assetKey] || "",
            storedPath: nextBranch.assetStoredPaths?.[assetKey] || nextBranch.assetRelativePaths?.[assetKey] || ""
          })
        : await reviewSeedanceAsset(context, {
            assetKey,
            branchId: nextBranch.branchId,
            fileName: nextBranch.assetFileNames?.[assetKey] || assetKey,
            mimeType: current.mimeType || "",
            storageUrl: nextBranch.assetUrls?.[assetKey] || "",
            storageKey: nextBranch.assetStorageKeys?.[assetKey] || "",
            storedPath: nextBranch.assetStoredPaths?.[assetKey] || nextBranch.assetRelativePaths?.[assetKey] || ""
          });
      const settledReview = await waitForSeedanceAssetReview(context, {
        assetKey,
        branchId: nextBranch.branchId,
        fileName: nextBranch.assetFileNames?.[assetKey] || assetKey,
        mimeType: current.mimeType || "",
        storageUrl: nextBranch.assetUrls?.[assetKey] || "",
        storageKey: nextBranch.assetStorageKeys?.[assetKey] || "",
        storedPath: nextBranch.assetStoredPaths?.[assetKey] || nextBranch.assetRelativePaths?.[assetKey] || ""
      }, review);
      nextBranch.assetReviews[assetKey] = {
        ...current,
        ...settledReview
      };
    }
    nextBranches.push(nextBranch);
  }
  const reviewResult = validateAssetReviewState(nextBranches);
  return { branches: nextBranches, reviewResult };
}

export function validateAssetReviewState(branchDrafts = []) {
  const branches = Array.isArray(branchDrafts) ? branchDrafts : [branchDrafts];
  const failures = [];
  for (const branch of branches) {
    const assetReviews = branch.assetReviews || {};
    for (const key of reviewAssetOrder()) {
      if (!requiresSeedanceAssetReview(branch, key)) continue;
      const fileName = branch.assetFileNames?.[key];
      const state = assetReviews[key] || {};
      if (!isBlockingAssetReviewState(branch, key, state)) continue;
      failures.push({
        branchId: branch.branchId || "branch_0",
        branchLabel: branch.branchLabel || "",
        assetKey: key,
        fileName: fileName,
        status: state.status || "pending",
        assetId: state.assetId || "",
        reason: state.reviewReason || (state.assetId ? "等待审核" : "素材缺少 Seedance assetId，请先上传并审核")
      });
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    assetsByBranch: branches.map((branch) => ({
      branchId: branch.branchId || "branch_0",
      branchLabel: branch.branchLabel || "",
      assets: reviewAssetOrder()
        .filter((key) => requiresSeedanceAssetReview(branch, key))
        .map((key) => ({
          key,
          fileName: branch.assetFileNames?.[key],
          url: branch.assetUrls?.[key],
          assetId: branch.assetReviews?.[key]?.assetId || "",
          status: branch.assetReviews?.[key]?.status || "pending",
          reason: branch.assetReviews?.[key]?.reviewReason || ""
        }))
    }))
  };
}
