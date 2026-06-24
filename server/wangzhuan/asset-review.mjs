import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { MAX_SEEDANCE_REFERENCE_ASSETS, REFERENCE_ASSET_ORDER } from "./reference-assets.mjs";
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

export function assetKeyToAssetType(assetKey) {
  const videoKeys = new Set(["productRecording", "endingAsset", "endingAssetInline"]);
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

function assetTypeFromMime(mimeType = "") {
  const mime = cleanString(mimeType).toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
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
  if (typeof context.reviewProductAsset === "function") {
    return normalizeReviewResponse(await context.reviewProductAsset(asset), {
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl
    });
  }
  const url = seedanceAssetsUploadUrl(context);
  const apiKey = seedanceApiKey(context);
  if (!url || !apiKey || typeof context.fetch !== "function" && typeof globalThis.fetch !== "function") {
    return {
      assetId: "",
      status: "pending",
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: "素材审核服务未配置或暂不可用"
    };
  }
  const fetchImpl = context.fetch || globalThis.fetch;
  const buffer = Buffer.isBuffer(asset.buffer) && asset.buffer.length
    ? asset.buffer
    : await loadAssetBuffer(context, asset);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: asset.mimeType || "application/octet-stream" }), asset.fileName || "asset");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
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
      assetId: "",
      status: "failed",
      assetType: assetTypeFromMime(asset.mimeType),
      contentUrl: asset.storageUrl || "",
      reviewReason: payload.message || payload.detail || `素材审核上传失败：HTTP ${response.status}`
    };
  }
  return normalizeReviewResponse(payload, {
    assetType: assetTypeFromMime(asset.mimeType),
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

async function bufferFromReadable(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function loadAssetBuffer(context, asset = {}) {
  if (Buffer.isBuffer(asset.buffer) && asset.buffer.length) return asset.buffer;
  if (asset.storageKey) {
    const object = await openWangzhuanObjectStream(context, asset.storageKey);
    if (object?.body) return bufferFromReadable(object.body);
  }
  if (asset.storedPath) {
    return readFile(resolve(context.userProjectRoot, String(asset.storedPath).replace(/^[\\/]+/, "")));
  }
  throw new WangzhuanError("missing_required_file", "产品素材原文件缺失，请重新上传", {
    assetKey: asset.assetKey,
    fileName: asset.fileName || ""
  });
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
    if (cleanString(branch.assetFileNames?.[key]) || cleanString(branch.assetUrls?.[key])) count += 1;
  }
  return count;
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
    for (const assetKey of REFERENCE_ASSET_ORDER) {
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
      nextBranch.assetReviews[assetKey] = {
        ...current,
        ...review
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
    for (const key of REFERENCE_ASSET_ORDER) {
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
      assets: REFERENCE_ASSET_ORDER
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
