import { execFile } from "node:child_process";
import { join } from "node:path";
import { assetKeyToSlot, branchHasReferenceAsset, countReferencedAssets } from "./asset-review.mjs";
import { configuredApiKey } from "./llm-config.mjs";
import { WangzhuanError } from "./http.mjs";
import {
  isReferenceVideoAssetKey,
  MAX_SEEDANCE_REFERENCE_ASSETS,
  orderedReferenceAssetKeys
} from "./reference-assets.mjs";

export const DEFAULT_SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SUBMIT_PATH = "/seedance/videos/generations";
const DEFAULT_TASK_POLL_PATH = "/seedance/tasks";
const SEEDANCE_720P_MODELS = new Set([
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-fast-260128"
]);
function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function execTai(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile("tai", args, { maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalizeResolution(model, resolution) {
  const value = cleanString(resolution);
  if (!value) return undefined;
  if (SEEDANCE_720P_MODELS.has(cleanString(model).toLowerCase())) {
    return value === "480p" ? "480p" : "720p";
  }
  return value;
}

function isApprovedAssetReview(review = {}) {
  const status = String(review.status || "").toLowerCase();
  return Boolean(cleanString(review.assetId) && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(status));
}

function missingAssetReviewError(branch = {}, assetKey, review = {}) {
  const assetId = cleanString(review.assetId);
  const status = String(review.status || "").toLowerCase();
  let reason = "请先点击「上传 Seedance 素材并审核」，获得 assetId 后再确认生成";
  if (assetId && status && !isApprovedAssetReview(review)) {
    reason = cleanString(review.reviewReason, `素材审核状态为 ${status || "pending"}，需审核通过后再提交 Seedance`);
  } else if (!assetId) {
    reason = "素材缺少 Seedance assetId，不能使用 S3 URL 直接提交";
  }
  return new WangzhuanError("asset_review_pending", reason, {
    branchId: branch?.branchId || "",
    branchLabel: branch?.branchLabel || "",
    assetKey,
    fileName: branch?.assetFileNames?.[assetKey] || "",
    assetId,
    status: review.status || "pending",
    reviewReason: review.reviewReason || ""
  });
}

function mediaItemFromReviewedAsset(assetKey, review = {}) {
  const assetId = cleanString(review.assetId);
  if (!assetId) return null;
  const type = isReferenceVideoAssetKey(assetKey) ? "video_asset" : "image_asset";
  return {
    type,
    assetId,
    assetKey,
    assetRole: "reference"
  };
}

function isFinalSeedanceSlice(batch = {}, task = {}) {
  if (task.isFinalSeedanceSlice === true || task.segmentRole === "cta_slice") return true;
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const sameVariantTasks = tasks.filter((candidate) => {
    return cleanString(candidate.branchId || "default") === cleanString(task.branchId || "default")
      && Number(candidate.branchVariantIndex || candidate.variantIndex || 1) === Number(task.branchVariantIndex || task.variantIndex || 1);
  });
  if (!sameVariantTasks.length) return false;
  const maxSegmentIndex = Math.max(...sameVariantTasks.map((candidate) => Number(candidate.segmentIndex || 1)));
  return Number(task.segmentIndex || 1) === maxSegmentIndex;
}

function seedanceReferenceOrderForTask(batch = {}, task = {}, branch = {}) {
  return orderedReferenceAssetKeys(branch, {
    includeFinalTail: isFinalSeedanceSlice(batch, task),
    includeUnknown: false
  });
}

function objectMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function branchHasMediaAsset(branch = {}, assetKey = "") {
  return Boolean(
    cleanString(branch.assetFileNames?.[assetKey])
    || cleanString(branch.assetUrls?.[assetKey])
    || cleanString(branch.assetStorageKeys?.[assetKey])
    || cleanString(branch.assetStoredPaths?.[assetKey])
    || cleanString(branch.assetRelativePaths?.[assetKey])
  );
}

function branchAssetContentHash(branch = {}, assetKey = "") {
  return cleanString(branch.assetContentHashes?.[assetKey]);
}

function branchAssetStorageIdentity(branch = {}, assetKey = "") {
  return cleanString(branch.assetStorageKeys?.[assetKey])
    || cleanString(branch.assetStoredPaths?.[assetKey])
    || cleanString(branch.assetRelativePaths?.[assetKey])
    || cleanString(branch.assetUrls?.[assetKey]);
}

function reviewHasState(review = {}) {
  return Boolean(review && typeof review === "object" && Object.keys(review).length);
}

function reviewMatchesBranchContent(review = {}, branch = {}, assetKey = "") {
  const assetContentHash = branchAssetContentHash(branch, assetKey);
  const reviewContentHash = cleanString(review.contentHash);
  return !assetContentHash || assetContentHash === reviewContentHash;
}

function branchesReferenceSameAsset(latest = {}, base = {}, assetKey = "", baseReview = {}) {
  const latestHash = branchAssetContentHash(latest, assetKey);
  const baseHash = branchAssetContentHash(base, assetKey) || cleanString(baseReview.contentHash);
  if (latestHash || baseHash) return Boolean(latestHash && baseHash && latestHash === baseHash);
  const latestIdentity = branchAssetStorageIdentity(latest, assetKey);
  const baseIdentity = branchAssetStorageIdentity(base, assetKey);
  return Boolean(latestIdentity && baseIdentity && latestIdentity === baseIdentity);
}

function mergedBranchAssetReviews(latest = {}, base = {}) {
  const latestReviews = objectMap(latest.assetReviews);
  const baseReviews = objectMap(base.assetReviews);
  const keys = new Set([
    ...Object.keys(objectMap(latest.assetFileNames)),
    ...Object.keys(objectMap(latest.assetUrls)),
    ...Object.keys(objectMap(latest.assetStorageKeys)),
    ...Object.keys(objectMap(latest.assetStoredPaths)),
    ...Object.keys(objectMap(latest.assetRelativePaths))
  ]);
  const merged = {};
  for (const assetKey of keys) {
    if (!branchHasMediaAsset(latest, assetKey)) continue;
    const latestReview = latestReviews[assetKey];
    if (reviewHasState(latestReview)) {
      if (!reviewMatchesBranchContent(latestReview, latest, assetKey)) continue;
      const contentHash = branchAssetContentHash(latest, assetKey);
      merged[assetKey] = contentHash && !cleanString(latestReview.contentHash)
        ? { ...latestReview, contentHash }
        : latestReview;
      continue;
    }
    const baseReview = baseReviews[assetKey];
    if (!isApprovedAssetReview(baseReview)) continue;
    if (!branchesReferenceSameAsset(latest, base, assetKey, baseReview)) continue;
    if (!reviewMatchesBranchContent(baseReview, latest, assetKey)) continue;
    const contentHash = branchAssetContentHash(latest, assetKey);
    merged[assetKey] = contentHash && !cleanString(baseReview.contentHash)
      ? { ...baseReview, contentHash }
      : baseReview;
  }
  return merged;
}

function latestBranchMediaFields(latest = {}) {
  const storedPaths = {
    ...(latest.assetStoredPaths && typeof latest.assetStoredPaths === "object" ? latest.assetStoredPaths : {}),
    ...(latest.assetRelativePaths && typeof latest.assetRelativePaths === "object" ? latest.assetRelativePaths : {})
  };
  return {
    assetFileNames: { ...objectMap(latest.assetFileNames) },
    assetUrls: { ...objectMap(latest.assetUrls) },
    assetStorageKeys: { ...objectMap(latest.assetStorageKeys) },
    assetStoredPaths: storedPaths,
    assetContentHashes: { ...objectMap(latest.assetContentHashes) }
  };
}

export function mergeBranchMediaDraft(latest = {}, base = {}) {
  return {
    ...base,
    ...latest,
    ...latestBranchMediaFields(latest),
    assetReviews: mergedBranchAssetReviews(latest, base)
  };
}

export function resolveBranchForSeedanceMedia(batch = {}, task = {}) {
  const draft = batch.templateSnapshot?.draft || {};
  const script = (Array.isArray(batch.scripts) ? batch.scripts : []).find((item) => item.scriptId === task.scriptId);
  const branchId = cleanString(task.branchId || script?.branchId);
  const branchSources = [
    ...(Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []),
    ...(Array.isArray(batch.request?.branchDrafts) ? batch.request.branchDrafts : []),
    ...(Array.isArray(batch.request?.branches) ? batch.request.branches : [])
  ];
  const latestBranch = branchId
    ? branchSources.find((item) => cleanString(item?.branchId) === branchId) || null
    : branchSources[0] || null;
  const scriptBranch = script?.branchDraft || null;
  const hasExplicitBranches = branchSources.length > 1;
  if (latestBranch && scriptBranch) return mergeBranchMediaDraft(latestBranch, scriptBranch);
  if (latestBranch) return latestBranch;
  if (scriptBranch) return scriptBranch;
  return hasExplicitBranches ? { branchId: branchId || "", assetUrls: {} } : draft;
}

export function collectSeedanceMedia(batch = {}, task = {}) {
  const branch = resolveBranchForSeedanceMedia(batch, task);
  const reviews = branch?.assetReviews && typeof branch.assetReviews === "object" ? branch.assetReviews : {};
  const storedPaths = branch?.assetStoredPaths && typeof branch.assetStoredPaths === "object" ? branch.assetStoredPaths : {};
  const items = [];
  const seen = new Set();
  for (const key of seedanceReferenceOrderForTask(batch, task, branch)) {
    const review = reviews[key] || {};
    if (branchHasReferenceAsset(branch, key)) {
      if (!isApprovedAssetReview(review)) {
        throw missingAssetReviewError(branch, key, review);
      }
      const reviewed = mediaItemFromReviewedAsset(key, review);
      if (!reviewed?.assetId || seen.has(`asset:${reviewed.assetId}`)) continue;
      seen.add(`asset:${reviewed.assetId}`);
      const storedPath = cleanString(storedPaths[key]);
      if (storedPath) reviewed.storedPath = storedPath;
      items.push(reviewed);
    }
  }
  if (items.length > MAX_SEEDANCE_REFERENCE_ASSETS) {
    throw new WangzhuanError("validation_error", "Seedance 参考素材不能超过 9 个，请减少后重试", {
      maxAssets: MAX_SEEDANCE_REFERENCE_ASSETS,
      assetCount: items.length,
      branchId: branch?.branchId || task.branchId || ""
    });
  }
  return items;
}

export function assertSeedanceReferenceAssetLimits(branchDrafts = []) {
  for (const branch of branchDrafts) {
    const assetCount = countReferencedAssets(branch);
    if (assetCount > MAX_SEEDANCE_REFERENCE_ASSETS) {
      throw new WangzhuanError("validation_error", "Seedance 参考素材不能超过 9 个，请减少后重试", {
        maxAssets: MAX_SEEDANCE_REFERENCE_ASSETS,
        assetCount,
        branchId: branch.branchId || ""
      });
    }
  }
}

function referenceTypeFromMediaItem(item = {}) {
  if (item?.type === "video_asset") return "video_asset";
  if (item?.type === "image_asset") return "image_asset";
  if (item?.type === "video_url") return "video";
  if (item?.type === "audio_url") return "audio";
  return "image";
}

function slotMetadataFromAssetKey(assetKey) {
  const key = cleanString(assetKey);
  if (!key) return null;
  const slot = assetKeyToSlot(key);
  return {
    slot_key: slot.key,
    slot_index: slot.index
  };
}

function buildReferenceItems(media = []) {
  const items = [];
  for (const item of Array.isArray(media) ? media : []) {
    const metadata = slotMetadataFromAssetKey(item?.assetKey);
    const assetId = cleanString(item?.assetId);
    if (assetId) {
      const entry = {
        type: referenceTypeFromMediaItem(item),
        asset_id: assetId,
        asset_role: cleanString(item?.assetRole, "reference")
      };
      if (metadata) entry.metadata = metadata;
      const storedPath = cleanString(item?.storedPath);
      if (storedPath) entry.stored_path = storedPath;
      items.push(entry);
      continue;
    }
    const url = cleanString(item?.url);
    if (!url) continue;
    const reference = {
      type: referenceTypeFromMediaItem(item),
      url
    };
    if (metadata) reference.metadata = metadata;
    const role = cleanString(item?.role);
    if (role) reference.role = role;
    const storedPath = cleanString(item?.storedPath);
    if (storedPath) reference.stored_path = storedPath;
    items.push(reference);
  }
  return items;
}

export function resolveSeedanceModel(batch = {}, provider = {}, task = {}) {
  const draft = batch.templateSnapshot?.draft || {};
  return cleanString(
    task?.modelVideo,
    cleanString(
      batch.estimate?.request?.seedanceModel,
      cleanString(
        draft.seedanceModel,
        cleanString(provider?.config?.model, cleanString(provider?.model, DEFAULT_SEEDANCE_MODEL))
      )
    )
  );
}

export function buildSeedanceGenerationPayload({
  model = DEFAULT_SEEDANCE_MODEL,
  prompt = "",
  media = [],
  mode,
  ratio = "9:16",
  duration = 15,
  resolution = "720p",
  generateAudio,
  watermark,
  seed,
  cameraFixed,
  returnLastFrame,
  metadata
} = {}) {
  const promptText = cleanString(prompt);
  const normalizedModel = cleanString(model, DEFAULT_SEEDANCE_MODEL);
  const references = buildReferenceItems(media);
  const payload = {
    model: normalizedModel,
    prompt: promptText,
    duration: normalizeSeedancePayloadDuration(duration)
  };
  const normalizedMode = cleanString(mode, references.length ? "omni_reference" : "text_to_video");
  if (normalizedMode) payload.mode = normalizedMode;
  const normalizedResolution = normalizeResolution(normalizedModel, resolution);
  if (normalizedResolution) payload.resolution = normalizedResolution;
  if (ratio) payload.ratio = ratio;
  payload.watermark = watermark === undefined || watermark === null ? false : Boolean(watermark);
  payload.generate_audio = generateAudio === undefined || generateAudio === null ? true : Boolean(generateAudio);
  if (references.length) payload.content = references;
  if (seed !== undefined && seed !== null && seed !== "") payload.seed = Number(seed);
  if (cameraFixed !== undefined && cameraFixed !== null) payload.camera_fixed = Boolean(cameraFixed);
  if (returnLastFrame !== undefined && returnLastFrame !== null) payload.return_last_frame = Boolean(returnLastFrame);
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    Object.assign(payload, metadata);
  }
  return payload;
}

/** Seedance upstream accepts integer durations in [4, 15] only. */
export const SEEDANCE_DURATION_MIN_SEC = 4;
export const SEEDANCE_DURATION_MAX_SEC = 15;

export function normalizeSeedancePayloadDuration(duration = 15) {
  const numericDuration = Number(duration);
  if (!Number.isFinite(numericDuration) || numericDuration <= 0) return 15;
  return Math.max(
    SEEDANCE_DURATION_MIN_SEC,
    Math.min(SEEDANCE_DURATION_MAX_SEC, Math.ceil(numericDuration))
  );
}

function configuredProvider(context = {}, capability = {}) {
  const config = context.config?.wangzhuan?.seedanceProvider && typeof context.config.wangzhuan.seedanceProvider === "object"
    ? context.config.wangzhuan.seedanceProvider
    : {};
  const apiKeyEnv = cleanString(capability.apiKeyEnv, cleanString(config.apiKeyEnv, "WANGZHUAN_LLM_API_KEY"));
  const apiKey = cleanString(
    capability.apiKey,
    cleanString(config.apiKey, cleanString(process.env.WANGZHUAN_SEEDANCE_API_KEY, configuredApiKey({ apiKeyEnv, apiKey: config.apiKey })))
  );
  const timeoutMs = positiveNumber(capability.timeoutMs ?? config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollTimeoutMs = positiveNumber(capability.pollTimeoutMs ?? config.pollTimeoutMs, 60000);
  const useTai = Boolean(capability.useTai ?? config.useTai ?? false);
  return {
    provider: cleanString(capability.provider, cleanString(config.provider, "seedance")),
    endpoint: cleanString(capability.endpoint, cleanString(config.endpoint, cleanString(process.env.WANGZHUAN_SEEDANCE_ENDPOINT))).replace(/\/+$/, ""),
    submitPath: cleanString(capability.submitPath, cleanString(config.submitPath, DEFAULT_SUBMIT_PATH)),
    taskPollPath: cleanString(capability.taskPollPath, cleanString(config.taskPollPath, DEFAULT_TASK_POLL_PATH)),
    reconcilePath: cleanString(capability.reconcilePath, cleanString(config.reconcilePath)),
    reconcileMethod: cleanString(capability.reconcileMethod, cleanString(config.reconcileMethod, "GET")).toUpperCase(),
    model: cleanString(capability.model, cleanString(config.model, cleanString(process.env.WANGZHUAN_SEEDANCE_MODEL, DEFAULT_SEEDANCE_MODEL))),
    apiKeyEnv,
    apiKey,
    timeoutMs,
    pollTimeoutMs,
    useTai,
    resolution: cleanString(capability.resolution, cleanString(config.resolution, "720p")),
    ratio: cleanString(capability.ratio, cleanString(config.ratio, "9:16")),
    generateAudio: capability.generateAudio ?? config.generateAudio ?? true,
    watermark: capability.watermark ?? config.watermark ?? false
  };
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function upstreamError(message, data = {}, code = "upstream_failed") {
  return new WangzhuanError(code, message, data, 502);
}

export function seedanceSubmitUrl(endpoint, submitPath = DEFAULT_SUBMIT_PATH) {
  return `${cleanString(endpoint).replace(/\/+$/, "")}/${cleanString(submitPath, DEFAULT_SUBMIT_PATH).replace(/^\/+/, "")}`;
}

export function seedanceReconcileUrl(endpoint, reconcilePath = "", requestId = "") {
  const path = cleanString(reconcilePath);
  if (!path) return "";
  const encoded = encodeURIComponent(cleanString(requestId));
  const resolved = path.includes(":requestId")
    ? path.replaceAll(":requestId", encoded)
    : `${path.replace(/\/+$/, "")}/${encoded}`;
  return `${cleanString(endpoint).replace(/\/+$/, "")}/${resolved.replace(/^\/+/, "")}`;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, provider, transportFailureCode = "upstream_failed") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw upstreamError("Seedance 上游请求超时，提交结果未知", { provider, submissionUnknown: true }, transportFailureCode);
    }
    throw upstreamError("Seedance 上游请求失败，提交结果未知", { provider, submissionUnknown: true }, transportFailureCode);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, provider, operation, options = {}) {
  const submission = options.submission === true;
  let text;
  try {
    text = await response.text();
  } catch {
    throw upstreamError("Seedance 上游响应读取失败，提交结果未知", {
      provider,
      operation,
      status: response.status,
      ...(submission ? { submissionUnknown: true } : {})
    }, submission ? "submission_unknown" : "upstream_failed");
  }
  const ambiguousSubmission = submission
    && (response.ok || response.status === 408 || response.status >= 500);
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw upstreamError("Seedance 上游返回了无法解析的数据", {
      provider,
      operation,
      status: response.status,
      ...(ambiguousSubmission ? { submissionUnknown: true } : {})
    }, ambiguousSubmission ? "submission_unknown" : "upstream_failed");
  }
  if (!response.ok) {
    const submissionUnknown = submission && (response.status === 408 || response.status >= 500);
    throw upstreamError("Seedance 上游返回失败状态", {
      provider,
      operation,
      status: response.status,
      ...(submissionUnknown ? { submissionUnknown: true } : {}),
      upstreamCode: payload.code || payload.error || payload.status || "",
      upstreamMessage: typeof payload.detail === "string"
        ? payload.detail
        : payload.message || payload.error_message || "",
      upstreamBody: text.slice(0, 2000)
    }, submissionUnknown ? "submission_unknown" : "upstream_failed");
  }
  return payload;
}

function unwrapUpstreamPayload(payload = {}) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

export function parseSeedanceSubmitResponse(payload = {}) {
  const body = unwrapUpstreamPayload(payload);
  const taskId = cleanString(body.task_id, cleanString(body.id, cleanString(body.taskId)));
  return {
    taskId,
    status: cleanString(body.status, "queued"),
    responsePayload: payload
  };
}

export function normalizeSeedanceReconciliationStatus(status = "") {
  const value = cleanString(status).toLowerCase();
  if (["queued", "pending", "running", "processing", "in_progress"].includes(value)) return value === "queued" || value === "pending" ? "queued" : "running";
  if (["succeeded", "success", "completed", "done"].includes(value)) return "succeeded";
  if (["not_found", "notfound", "not_created", "missing", "absent"].includes(value)) return "not_created";
  return "unknown";
}

export function parseSeedanceReconciliationResponse(payload = {}) {
  const body = unwrapUpstreamPayload(payload);
  const taskId = cleanString(body.task_id, cleanString(body.id, cleanString(body.taskId)));
  return {
    status: normalizeSeedanceReconciliationStatus(body.status || body.state || body.task_status || body.result),
    taskId,
    videoUrl: extractSeedanceVideoUrl(payload),
    responsePayload: payload
  };
}

const TERMINAL_UPSTREAM_STATUSES = new Set(["succeeded", "success", "completed", "done", "failed", "error", "canceled", "cancelled"]);

export function normalizeSeedanceTaskStatus(status = "") {
  const value = cleanString(status, "queued").toLowerCase();
  if (["succeeded", "success", "completed", "done"].includes(value)) return "succeeded";
  if (["failed", "error", "canceled", "cancelled"].includes(value)) return "failed";
  if (["running", "processing", "in_progress"].includes(value)) return "running";
  return "queued";
}

export function seedanceTaskUrl(endpoint, taskId, taskPollPath = DEFAULT_TASK_POLL_PATH) {
  const base = `${cleanString(endpoint).replace(/\/+$/, "")}/${cleanString(taskPollPath, DEFAULT_TASK_POLL_PATH).replace(/^\/+/, "")}`;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(cleanString(taskId))}`;
}

function firstHttpUrl(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
}

function directVideoUrl(value = {}) {
  if (!value || typeof value !== "object") return "";
  const direct = firstHttpUrl(
    value.video_url,
    value.file_url,
    value.url,
    value.download_url,
    value.output_url,
    value.media_url,
    value.videoUrl
  );
  if (/^https?:\/\//i.test(direct)) return direct;
  if (value.video_url && typeof value.video_url === "object") {
    const nested = cleanString(value.video_url.url);
    if (/^https?:\/\//i.test(nested)) return nested;
  }
  if (typeof value.video === "string" && /^https?:\/\//i.test(value.video)) return value.video;
  if (value.video && typeof value.video === "object") {
    const nested = directVideoUrl(value.video);
    if (nested) return nested;
  }
  return "";
}

function extractContentBlockVideoUrl(content) {
  if (!content) return "";
  if (typeof content === "string" && /^https?:\/\//i.test(content)) return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const found = extractContentBlockVideoUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof content !== "object") return "";
  return directVideoUrl(content);
}

function nestedVideoUrl(value, depth = 0) {
  if (!value || depth > 5) return "";
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const direct = directVideoUrl(value);
  if (direct) return direct;
  for (const key of ["content", "output", "output_assets", "result", "data", "outputs", "artifacts", "task", "response", "generation", "media"]) {
    const found = nestedVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function extractResultsVideoUrl(payload = {}) {
  const results = payload.results;
  if (!Array.isArray(results)) return "";
  for (const item of results) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
    const found = nestedVideoUrl(item, 0);
    if (found) return found;
  }
  return "";
}

function extractOutputAssetsVideoUrl(payload = {}) {
  const assets = payload.output_assets;
  if (!Array.isArray(assets)) return "";
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const type = cleanString(item.type).toLowerCase();
    const url = directVideoUrl(item);
    if (!url) continue;
    if (type === "video" || !type || isLikelyVideoUrl(url)) return url;
  }
  return "";
}

function isLikelyVideoUrl(value = "") {
  const url = cleanString(value);
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

function isLikelyImageUrl(value = "") {
  const url = cleanString(value);
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
}

function isJpegBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff;
}

export function extractSeedanceVideoUrl(payload = {}) {
  const body = unwrapUpstreamPayload(payload);
  const candidates = [body, payload].filter((item, index, list) => item && list.indexOf(item) === index);
  for (const candidate of candidates) {
    const result = candidate.result;
    if (typeof result === "string" && /^https?:\/\//i.test(result)) return result;
    const contentUrl = extractContentBlockVideoUrl(candidate.content);
    if (contentUrl) return contentUrl;
    const resultsUrl = extractResultsVideoUrl(candidate);
    if (resultsUrl) return resultsUrl;
    const outputAssetsUrl = extractOutputAssetsVideoUrl(candidate);
    if (outputAssetsUrl) return outputAssetsUrl;
    const nested = nestedVideoUrl(candidate);
    if (nested) return nested;
    const previewUrl = cleanString(candidate.preview_url);
    if (/^https?:\/\//i.test(previewUrl) && isLikelyVideoUrl(previewUrl) && !isLikelyImageUrl(previewUrl)) {
      return previewUrl;
    }
  }
  return "";
}

export function extractSeedancePreviewUrl(payload = {}) {
  const previewUrl = cleanString(payload.preview_url);
  return /^https?:\/\//i.test(previewUrl) ? previewUrl : "";
}

export function parseSeedancePollResponse(payload = {}) {
  const body = unwrapUpstreamPayload(payload);
  const taskId = cleanString(body.id, cleanString(body.task_id, cleanString(body.taskId)));
  const status = normalizeSeedanceTaskStatus(body.status || body.state || body.task_status);
  return {
    taskId,
    status,
    videoUrl: extractSeedanceVideoUrl(payload),
    responsePayload: payload
  };
}

export function summarizeSeedancePollResponse(result = {}) {
  const body = unwrapUpstreamPayload(result.responsePayload || {});
  return {
    taskId: result.taskId || "",
    status: result.status || "",
    upstreamStatus: cleanString(body.status, cleanString(body.state, cleanString(body.task_status, result.status || ""))),
    videoUrlStored: Boolean(result.videoUrl),
    upstreamRequestId: result.responsePayload?.upstream_request_id || result.responsePayload?.request_id || body.request_id || ""
  };
}

export function isTerminalSeedanceStatus(status = "") {
  return TERMINAL_UPSTREAM_STATUSES.has(normalizeSeedanceTaskStatus(status));
}

export function hasRemoteSeedanceProvider(context = {}, capability = {}) {
  return Boolean(context.seedanceProviderClient || configuredProvider(context, capability).endpoint);
}

function createTaiSeedanceProviderClient(context = {}, capability = {}) {
  const config = configuredProvider(context, capability);
  function resolveLocalPath(storedPath) {
    return storedPath ? join(context.userProjectRoot, storedPath) : "";
  }
  return {
    provider: config.provider,
    model: config.model,
    config,
    async createTask(payload, metadata = {}) {
      const args = ["aigc", "seedance"];
      const mode = payload.mode || "omni_reference";
      args.push("--mode", mode);
      const model = payload.model || DEFAULT_SEEDANCE_MODEL;
      args.push("--model", model);
      if (payload.duration) { args.push("--duration"); args.push(String(payload.duration)); }
      if (payload.ratio) { args.push("--ratio"); args.push(payload.ratio); }
      if (payload.resolution) { args.push("--resolution"); args.push(payload.resolution); }
      if (payload.watermark === false) args.push("--no-watermark");
      if (payload.generate_audio === false) args.push("--no-audio");
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const item of content) {
        const localPath = resolveLocalPath(cleanString(item.stored_path));
        if (!localPath) continue;
        const itemType = cleanString(item.type);
        if (itemType.startsWith("video") || itemType === "video_asset") {
          args.push("--video", localPath);
        } else if (itemType === "audio") {
          args.push("--audio", localPath);
        } else {
          args.push("--image", localPath);
        }
      }
      if (payload.prompt) args.push(payload.prompt);
      let stdout, stderr;
      try {
        const result = await execTai(args);
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const msg = cleanString(error.stderr || error.stdout || error.message, "tai CLI 执行失败");
        throw upstreamError(msg, {
          provider: config.provider,
          args: args.slice(0, 6).join(" "),
          stderr: cleanString(error.stderr || "").slice(0, 1000),
          submissionUnknown: true
        }, "submission_unknown");
      }
      const combined = (stdout || "") + (stderr || "");
      const taskIdMatch = combined.match(/Task:\s*(cgt-\w+)/i)
        || combined.match(/["']?task_id["']?\s*[:=]\s*["']?(\w+)["']?/i);
      const taskId = taskIdMatch ? taskIdMatch[1].trim() : combined.trim();
      if (!taskId || taskId.length < 5) {
        throw upstreamError("tai CLI 未返回有效的任务 ID，提交结果未知", {
          provider: config.provider,
          output: combined.slice(0, 1000),
          submissionUnknown: true
        }, "submission_unknown");
      }
      return { taskId, status: "queued", responsePayload: { taskId, taiStdout: (stdout || "").slice(0, 2000), taiStderr: (stderr || "").slice(0, 2000) } };
    },
    async getTask(taskId) {
      let stdout, stderr;
      try {
        const result = await execTai(["aigc", "seedance-status", taskId]);
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        return { taskId, status: "queued", videoUrl: "", responsePayload: { taskId, error: cleanString(error.stderr || error.message || "").slice(0, 500) } };
      }
      const combined = (stdout || "") + (stderr || "");
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON, fall back to text parsing */ }
      if (parsed) return parseSeedancePollResponse(parsed);
      const lower = combined.toLowerCase();
      let status = "queued";
      if (/succeeded|completed|done|finished|success/i.test(lower)) status = "succeeded";
      else if (/failed|error|canceled|cancelled/i.test(lower)) status = "failed";
      else if (/running|processing|in_progress/i.test(lower)) status = "running";
      const videoUrlMatch = combined.match(/https?:\/\/[^\s]+\.(mp4|webm|mov)(\?[^\s]*)?/i);
      const videoUrl = videoUrlMatch ? videoUrlMatch[0] : "";
      return { taskId, status, videoUrl, responsePayload: { taskId, raw: combined.slice(0, 2000) } };
    },
    async downloadVideo(videoUrl) {
      const url = cleanString(videoUrl);
      if (!/^https?:\/\//i.test(url)) throw upstreamError("Seedance 视频地址无效", { provider: config.provider });
      const fetchImpl = context.fetch || globalThis.fetch;
      if (typeof fetchImpl !== "function") throw upstreamError("当前 Node 运行时不支持 fetch", { provider: config.provider });
      const response = await fetchWithTimeout(fetchImpl, url, { method: "GET" }, config.timeoutMs, config.provider);
      if (!response.ok) throw upstreamError("Seedance 视频下载失败", { provider: config.provider, operation: "download_seedance_video", status: response.status });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (isJpegBuffer(buffer)) throw upstreamError("Seedance 下载内容是 JPEG 预览图而非视频文件", { provider: config.provider, operation: "download_seedance_video", contentKind: "image/jpeg", bytes: buffer.length });
      return buffer;
    }
  };
}

export function createSeedanceProviderClient(context = {}, capability = {}) {
  if (context.seedanceProviderClient) return context.seedanceProviderClient;
  const config = configuredProvider(context, capability);
  if (config.useTai) return createTaiSeedanceProviderClient(context, capability);
  if (!config.endpoint) return null;
  if (!config.apiKey) {
    throw upstreamError(`未配置 Seedance API Key，请在环境变量 ${config.apiKeyEnv}、WANGZHUAN_SEEDANCE_API_KEY 或 LLM 共用 Skylink 密钥中配置后重启服务`, {
      provider: config.provider,
      apiKeyEnv: config.apiKeyEnv,
      upstreamMessage: `未配置 Seedance API Key，请在环境变量 ${config.apiKeyEnv} 中配置 Skylink project API Key 后重启服务`
    });
  }
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw upstreamError("当前 Node 运行时不支持 fetch，无法调用 Seedance", {
      provider: config.provider
    });
  }
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(config.apiKey)
  };
  return {
    provider: config.provider,
    model: config.model,
    submitPath: config.submitPath,
    taskPollPath: config.taskPollPath,
    endpoint: config.endpoint,
    config,
    async createTask(payload, metadata = {}) {
      const requestHeaders = {
        ...headers,
        ...(cleanString(metadata.submissionRequestId)
          ? {
              "X-Idempotency-Key": cleanString(metadata.submissionRequestId),
              "X-Request-ID": cleanString(metadata.submissionRequestId)
            }
          : {})
      };
      const response = await fetchWithTimeout(fetchImpl, seedanceSubmitUrl(config.endpoint, config.submitPath), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload)
      }, config.timeoutMs, config.provider, "submission_unknown");
      return parseSeedanceSubmitResponse(await readJsonResponse(
        response,
        config.provider,
        "create_seedance_task",
        { submission: true }
      ));
    },
    async reconcileSubmission(request = {}) {
      const requestId = cleanString(request.submissionRequestId);
      const url = seedanceReconcileUrl(config.endpoint, config.reconcilePath, requestId);
      if (!url) return { status: "unknown", taskId: "", responsePayload: { status: "unknown", reason: "reconcile_endpoint_not_configured" } };
      const method = ["GET", "POST"].includes(config.reconcileMethod) ? config.reconcileMethod : "GET";
      const response = await fetchWithTimeout(fetchImpl, url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify({ request_id: requestId, submissionRequestId: requestId }) } : {})
      }, config.pollTimeoutMs, config.provider);
      return parseSeedanceReconciliationResponse(await readJsonResponse(response, config.provider, "reconcile_seedance_submission"));
    },
    async getTask(taskId) {
      const response = await fetchWithTimeout(fetchImpl, seedanceTaskUrl(config.endpoint, taskId, config.taskPollPath), {
        method: "GET",
        headers: authHeaders(config.apiKey)
      }, config.pollTimeoutMs, config.provider);
      return parseSeedancePollResponse(await readJsonResponse(response, config.provider, "poll_seedance_task"));
    },
    async downloadVideo(videoUrl) {
      const url = cleanString(videoUrl);
      if (!/^https?:\/\//i.test(url)) {
        throw upstreamError("Seedance 视频地址无效", { provider: config.provider });
      }
      const response = await fetchWithTimeout(fetchImpl, url, { method: "GET" }, config.timeoutMs, config.provider);
      if (!response.ok) {
        throw upstreamError("Seedance 视频下载失败", {
          provider: config.provider,
          operation: "download_seedance_video",
          status: response.status
        });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (isJpegBuffer(buffer)) {
        throw upstreamError("Seedance 下载内容是 JPEG 预览图而非视频文件", {
          provider: config.provider,
          operation: "download_seedance_video",
          contentKind: "image/jpeg",
          bytes: buffer.length
        });
      }
      return buffer;
    }
  };
}

export function summarizeSeedanceRequest(payload, provider = {}) {
  return {
    provider: cleanString(provider.provider, "seedance"),
    model: payload?.model || "",
    submitPath: provider.submitPath || provider.config?.submitPath || DEFAULT_SUBMIT_PATH,
    taskPollPath: provider.taskPollPath || provider.config?.taskPollPath || DEFAULT_TASK_POLL_PATH,
    mode: payload?.mode || "",
    ratio: payload?.ratio || "",
    duration: payload?.duration,
    resolution: payload?.resolution || "",
    generate_audio: payload?.generate_audio,
    watermark: payload?.watermark,
    prompt: payload?.prompt || "",
    references: Array.isArray(payload?.references) ? payload.references : [],
    content: Array.isArray(payload?.content) ? payload.content : []
  };
}

export function summarizeSeedanceResponse(result = {}) {
  return {
    taskId: result.taskId || "",
    status: result.status || "",
    upstreamStatus: result.responsePayload?.status || "",
    upstreamRequestId: result.responsePayload?.upstream_request_id || result.responsePayload?.request_id || ""
  };
}
