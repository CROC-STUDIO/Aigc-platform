import { extname, join } from "node:path";

import { generateBaseSeedancePrompt, refineSeedancePromptWithApprovedAssets } from "./codex-prompt.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeTimestampId } from "./ids.mjs";
import { uploadProductAsset } from "./product-assets.mjs";
import { inspectStorePage } from "./store-page.mjs";
import { readJsonOrDefault, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function productLinkRoot(context, batchId = "") {
  const root = join(wangzhuanPaths(context).userRoot, "product-link");
  return batchId ? join(root, batchId) : root;
}

function parseTarget(context, parseUid) {
  return join(productLinkRoot(context), `${parseUid}.json`);
}

function reviewTarget(context, batchId) {
  return join(productLinkRoot(context, batchId), "asset-review.json");
}

function promptInputTarget(context, batchId, mode) {
  return join(productLinkRoot(context, batchId), `codex-${mode}-input.json`);
}

function fileNameFromUrl(url = "", fallback = "asset") {
  try {
    const value = new URL(url);
    const name = value.pathname.split("/").filter(Boolean).pop() || fallback;
    return name.includes(".") ? name : `${name}.png`;
  } catch {
    return `${fallback}.png`;
  }
}

function candidateAssetId(parseUid, kind, index) {
  return `${parseUid}_${kind}_${String(index + 1).padStart(3, "0")}`;
}

function normalizeProductContext(result = {}) {
  const brief = result.productBrief && typeof result.productBrief === "object" ? result.productBrief : {};
  const candidates = result.candidates && typeof result.candidates === "object" ? result.candidates : {};
  const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata : {};
  return {
    title: cleanString(brief.productName || candidates.productName),
    category: cleanString(brief.category || candidates.category),
    developer: cleanString(brief.developer || candidates.developer),
    summary: cleanString(candidates.shortDescription || brief.description || candidates.description),
    description: cleanString(candidates.description || brief.description),
    coreSellingPoints: cleanArray(brief.coreSellingPoints || candidates.coreSellingPoints).map((item) => cleanString(item)).filter(Boolean),
    mustShow: cleanArray(brief.mustShow).map((item) => cleanString(item)).filter(Boolean),
    mustAvoid: cleanArray(brief.mustAvoid).map((item) => cleanString(item)).filter(Boolean),
    contentRating: cleanString(brief.contentRating || metadata.contentRating),
    store: cleanString(result.store),
    url: cleanString(result.url)
  };
}

function normalizeCandidateAssets(parseUid, result = {}) {
  const candidates = result.candidates && typeof result.candidates === "object" ? result.candidates : {};
  const items = [];
  if (candidates.icon?.url) {
    items.push({
      candidateAssetId: candidateAssetId(parseUid, "icon", items.length),
      kind: "product_icon",
      assetKey: "productIcon",
      sourceUrl: cleanString(candidates.icon.url),
      fileName: cleanString(candidates.icon.fileName || fileNameFromUrl(candidates.icon.url, "product-icon")),
      label: cleanString(candidates.icon.label, "产品图标")
    });
  }
  for (const [index, screenshot] of cleanArray(candidates.screenshots).entries()) {
    const sourceUrl = cleanString(screenshot?.url);
    if (!sourceUrl) continue;
    items.push({
      candidateAssetId: candidateAssetId(parseUid, "screenshot", index),
      kind: "product_screenshot",
      assetKey: `productScreenshot_${index + 1}`,
      sourceUrl,
      fileName: cleanString(screenshot.fileName || fileNameFromUrl(sourceUrl, `product-screenshot-${index + 1}`)),
      label: cleanString(screenshot.label, `产品截图 ${index + 1}`)
    });
  }
  for (const [index, preview] of cleanArray(candidates.videoPreviews).entries()) {
    const sourceUrl = cleanString(preview?.url);
    if (!sourceUrl) continue;
    items.push({
      candidateAssetId: candidateAssetId(parseUid, "video", index),
      kind: "product_recording",
      assetKey: `productRecording_${index + 1}`,
      sourceUrl,
      fileName: cleanString(preview.fileName || fileNameFromUrl(sourceUrl, `product-recording-${index + 1}`)),
      label: cleanString(preview.label, `产品录屏 ${index + 1}`)
    });
  }
  return items;
}

function reviewSummary(items = []) {
  const approvedAssets = [];
  for (const item of items) {
    if (item.status !== "approved") continue;
    approvedAssets.push({
      candidateAssetId: item.candidateAssetId,
      assetKey: item.assetKey,
      assetId: cleanString(item.review?.assetId),
      fileName: item.fileName,
      reviewStatus: item.status,
      previewUrl: cleanString(item.asset?.previewUrl || item.asset?.storageUrl),
      storageUrl: cleanString(item.asset?.storageUrl),
      storageKey: cleanString(item.asset?.storageKey),
      storedPath: cleanString(item.asset?.storedPath)
    });
  }
  return {
    approvedAssets,
    total: items.length,
    approvedCount: approvedAssets.length,
    pendingCount: items.filter((item) => item.status === "pending").length,
    failedCount: items.filter((item) => item.status === "failed").length,
    rejectedCount: items.filter((item) => item.status === "rejected").length
  };
}

async function fetchAssetBuffer(context, sourceUrl) {
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WangzhuanError("upstream_failed", "当前环境缺少 fetch，无法下载候选素材", {
      sourceUrl
    }, 502);
  }
  const response = await fetchImpl(sourceUrl);
  if (!response.ok) {
    throw new WangzhuanError("upstream_failed", `下载候选素材失败：HTTP ${response.status}`, {
      sourceUrl,
      status: response.status
    }, 502);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: cleanString(response.headers.get("content-type"), "application/octet-stream")
  };
}

function dataUrlFromBuffer(buffer, mimeType) {
  return `data:${mimeType || "application/octet-stream"};base64,${buffer.toString("base64")}`;
}

function preferredReviewState(review = {}) {
  const safeReview = review && typeof review === "object" ? review : {};
  const status = cleanString(safeReview.status).toLowerCase();
  if (["approved", "rejected", "failed", "pending", "queued", "running", "processing"].includes(status)) return status;
  if (status === "active" || status === "success" || status === "succeeded" || status === "pass" || status === "passed") return "approved";
  return safeReview.assetId ? "approved" : "pending";
}

export async function parseProductLinkForSeedance(context, request = {}) {
  const raw = await inspectStorePage(context, request);
  const parseUid = makeTimestampId("plink");
  const payload = {
    parseUid,
    url: cleanString(request.url),
    store: cleanString(raw.store),
    provider: raw.provider || {},
    productContext: normalizeProductContext(raw),
    candidateAssets: normalizeCandidateAssets(parseUid, raw),
    warnings: cleanArray(raw.warnings).map((item) => cleanString(item)).filter(Boolean),
    inspectedAt: raw.inspectedAt || new Date().toISOString(),
    raw
  };
  await writeAtomicJson(parseTarget(context, parseUid), payload);
  return payload;
}

export async function loadParsedProductLink(context, parseUid) {
  const target = parseTarget(context, cleanString(parseUid));
  const loaded = await readJsonOrDefault(target, null);
  if (!loaded) {
    throw new WangzhuanError("batch_not_found", "产品链接解析结果不存在", {
      parseUid
    }, 404);
  }
  return loaded;
}

export async function reviewParsedProductLinkAssets(context, request = {}) {
  const batchId = cleanString(request.batchId);
  const parseUid = cleanString(request.parseUid);
  if (!batchId) {
    throw new WangzhuanError("validation_error", "batchId 不能为空", { field: "batchId" });
  }
  if (!parseUid) {
    throw new WangzhuanError("validation_error", "parseUid 不能为空", { field: "parseUid" });
  }
  const parsed = await loadParsedProductLink(context, parseUid);
  const selectedIds = new Set(cleanArray(request.candidateAssetIds).map((item) => cleanString(item)).filter(Boolean));
  const branchId = cleanString(request.branchId, "branch_1");
  const items = [];
  for (const candidate of cleanArray(parsed.candidateAssets)) {
    if (selectedIds.size && !selectedIds.has(candidate.candidateAssetId)) continue;
    const { buffer, mimeType } = await fetchAssetBuffer(context, candidate.sourceUrl);
    const uploaded = await uploadProductAsset(context, {
      assetKey: candidate.assetKey,
      branchId,
      fileName: candidate.fileName || fileNameFromUrl(candidate.sourceUrl, candidate.assetKey),
      mimeType,
      content: dataUrlFromBuffer(buffer, mimeType)
    });
    const asset = uploaded.asset || {};
    items.push({
      candidateAssetId: candidate.candidateAssetId,
      assetKey: candidate.assetKey,
      kind: candidate.kind,
      label: candidate.label,
      fileName: candidate.fileName,
      sourceUrl: candidate.sourceUrl,
      status: preferredReviewState(asset.review),
      asset,
      review: asset.review || {}
    });
  }
  const summary = reviewSummary(items);
  const payload = {
    batchId,
    parseUid,
    branchId,
    items,
    summary,
    updatedAt: new Date().toISOString()
  };
  await writeAtomicJson(reviewTarget(context, batchId), payload);
  return payload;
}

export async function getParsedProductLinkReviewStatus(context, batchId) {
  const loaded = await readJsonOrDefault(reviewTarget(context, cleanString(batchId)), null);
  if (!loaded) {
    throw new WangzhuanError("batch_not_found", "候选素材审核结果不存在", {
      batchId
    }, 404);
  }
  return loaded;
}

async function buildPromptInput(context, request = {}, mode = "base") {
  const batchId = cleanString(request.batchId);
  const parseUid = cleanString(request.parseUid);
  if (!batchId) {
    throw new WangzhuanError("validation_error", "batchId 不能为空", { field: "batchId" });
  }
  if (!parseUid) {
    throw new WangzhuanError("validation_error", "parseUid 不能为空", { field: "parseUid" });
  }
  const parsed = await loadParsedProductLink(context, parseUid);
  const review = await readJsonOrDefault(reviewTarget(context, batchId), null);
  const approvedAssets = cleanArray(review?.summary?.approvedAssets);
  if (mode === "refine" && !approvedAssets.length) {
    throw new WangzhuanError("validation_error", "当前没有审核通过的素材，无法生成 refine prompt", {
      batchId,
      parseUid
    });
  }
  const payload = {
    batchId,
    decompositionResult: request.decompositionResult && typeof request.decompositionResult === "object" ? request.decompositionResult : {},
    productContext: parsed.productContext || {},
    approvedAssets: mode === "refine" ? approvedAssets : cleanArray(request.approvedAssets),
    targetRegion: cleanString(request.targetRegion),
    language: cleanString(request.language),
    durationSec: Number.isFinite(Number(request.durationSec)) ? Number(request.durationSec) : null,
    aspectRatio: cleanString(request.aspectRatio),
    style: cleanString(request.style),
    forbiddenItems: cleanArray(request.forbiddenItems).map((item) => cleanString(item)).filter(Boolean),
    skillName: cleanString(request.skillName),
    repoRoot: cleanString(request.repoRoot),
    timeoutMs: request.timeoutMs,
    model: cleanString(request.model),
    parseUid,
    approvedAssetSummary: review?.summary || { approvedAssets: [] }
  };
  await writeAtomicJson(promptInputTarget(context, batchId, mode), payload);
  return payload;
}

export async function generateSeedancePromptFromParsedProductLink(context, request = {}, mode = "base") {
  const input = await buildPromptInput(context, request, mode);
  const generator = mode === "refine"
    ? (context.refineSeedancePromptWithApprovedAssets || refineSeedancePromptWithApprovedAssets)
    : (context.generateBaseSeedancePrompt || generateBaseSeedancePrompt);
  return generator({
    context,
    ...input,
    requestId: cleanString(request.requestId)
  });
}
