import { WangzhuanError } from "./http.mjs";

export const DEFAULT_SEEDANCE_MODEL = "doubao-seedance-2-0-260128";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_SUBMIT_PATH = "/contents/generations/tasks";
const SEEDANCE_720P_MODELS = new Set([
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-fast-260128"
]);
const ASSET_KEY_ORDER = Object.freeze([
  "productIcon",
  "productScreenshot",
  "rewardElement",
  "productRecording",
  "personAsset",
  "endingAsset"
]);
const VIDEO_ASSET_KEYS = new Set(["productRecording", "personAsset", "endingAsset"]);

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isPublicMediaUrl(value) {
  return /^https?:\/\//i.test(cleanString(value)) || /^asset:\/\//i.test(cleanString(value));
}

function normalizeResolution(model, resolution) {
  const value = cleanString(resolution);
  if (!value) return undefined;
  if (SEEDANCE_720P_MODELS.has(cleanString(model).toLowerCase())) {
    return value === "480p" ? "480p" : "720p";
  }
  return value;
}

function mediaItemFromUrl(assetKey, url) {
  const type = VIDEO_ASSET_KEYS.has(assetKey) ? "video_url" : "image_url";
  const role = type === "video_url" ? "reference_video" : "reference_image";
  return { type, url, role, assetKey };
}

export function collectSeedanceMedia(batch = {}, task = {}) {
  const draft = batch.templateSnapshot?.draft || {};
  const script = (Array.isArray(batch.scripts) ? batch.scripts : []).find((item) => item.scriptId === task.scriptId);
  const branch = script?.branchDraft
    || (Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === task.branchId)
    || draft;
  const urls = branch?.assetUrls && typeof branch.assetUrls === "object" ? branch.assetUrls : {};
  const items = [];
  const seen = new Set();
  for (const key of ASSET_KEY_ORDER) {
    const url = cleanString(urls[key]);
    if (!url || !isPublicMediaUrl(url) || seen.has(url)) continue;
    seen.add(url);
    items.push(mediaItemFromUrl(key, url));
  }
  return items;
}

function appendMediaContent(content, media) {
  for (const item of Array.isArray(media) ? media : []) {
    const type = item?.type === "video_url" || item?.type === "audio_url" ? item.type : "image_url";
    const url = cleanString(item?.url || item?.[type]?.url);
    if (!url) continue;
    const upstreamItem = {
      type,
      [type]: { url }
    };
    const role = cleanString(item?.role);
    if (role) upstreamItem.role = role;
    content.push(upstreamItem);
  }
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
  const content = [];
  if (promptText) content.push({ type: "text", text: promptText });
  appendMediaContent(content, media);
  const payload = {
    model: normalizedModel,
    content
  };
  const normalizedMode = cleanString(mode, content.some((item) => item.type !== "text") ? "omni_reference" : "text_to_video");
  if (normalizedMode) payload.mode = normalizedMode;
  const normalizedResolution = normalizeResolution(normalizedModel, resolution);
  if (normalizedResolution) payload.resolution = normalizedResolution;
  if (ratio) payload.ratio = ratio;
  if (duration !== undefined && duration !== null) payload.duration = Number(duration);
  payload.watermark = watermark === undefined || watermark === null ? false : Boolean(watermark);
  if (generateAudio !== undefined && generateAudio !== null) payload.generate_audio = Boolean(generateAudio);
  if (seed !== undefined && seed !== null && seed !== "") payload.seed = Number(seed);
  if (cameraFixed !== undefined && cameraFixed !== null) payload.camera_fixed = Boolean(cameraFixed);
  if (returnLastFrame !== undefined && returnLastFrame !== null) payload.return_last_frame = Boolean(returnLastFrame);
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    Object.assign(payload, metadata);
  }
  return payload;
}

function configuredProvider(context = {}, capability = {}) {
  const config = context.config?.wangzhuan?.seedanceProvider && typeof context.config.wangzhuan.seedanceProvider === "object"
    ? context.config.wangzhuan.seedanceProvider
    : {};
  const apiKeyEnv = cleanString(capability.apiKeyEnv, cleanString(config.apiKeyEnv, "VIDEO_AIGC_API_KEY"));
  const apiKey = cleanString(
    capability.apiKey,
    cleanString(config.apiKey, cleanString(process.env.WANGZHUAN_SEEDANCE_API_KEY, cleanString(process.env[apiKeyEnv])))
  );
  const timeoutMs = positiveNumber(capability.timeoutMs ?? config.timeoutMs, DEFAULT_TIMEOUT_MS);
  return {
    provider: cleanString(capability.provider, cleanString(config.provider, "seedance")),
    endpoint: cleanString(capability.endpoint, cleanString(config.endpoint, cleanString(process.env.WANGZHUAN_SEEDANCE_ENDPOINT))).replace(/\/+$/, ""),
    submitPath: cleanString(capability.submitPath, cleanString(config.submitPath, DEFAULT_SUBMIT_PATH)),
    model: cleanString(capability.model, cleanString(config.model, cleanString(process.env.WANGZHUAN_SEEDANCE_MODEL, DEFAULT_SEEDANCE_MODEL))),
    apiKeyEnv,
    apiKey,
    timeoutMs,
    resolution: cleanString(capability.resolution, cleanString(config.resolution, "720p")),
    ratio: cleanString(capability.ratio, cleanString(config.ratio, "9:16")),
    generateAudio: capability.generateAudio ?? config.generateAudio,
    watermark: capability.watermark ?? config.watermark ?? false
  };
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function upstreamError(message, data = {}) {
  return new WangzhuanError("upstream_failed", message, data, 502);
}

export function seedanceSubmitUrl(endpoint, submitPath = DEFAULT_SUBMIT_PATH) {
  return `${cleanString(endpoint).replace(/\/+$/, "")}/${cleanString(submitPath, DEFAULT_SUBMIT_PATH).replace(/^\/+/, "")}`;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw upstreamError("Seedance 上游请求超时", { provider });
    }
    throw upstreamError("Seedance 上游请求失败", { provider });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, provider, operation) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw upstreamError("Seedance 上游返回了无法解析的数据", {
      provider,
      operation,
      status: response.status
    });
  }
  if (!response.ok) {
    throw upstreamError("Seedance 上游返回失败状态", {
      provider,
      operation,
      status: response.status,
      upstreamCode: payload.code || payload.error || payload.status || "",
      upstreamMessage: typeof payload.detail === "string"
        ? payload.detail
        : payload.message || payload.error_message || "",
      upstreamBody: text.slice(0, 2000)
    });
  }
  return payload;
}

export function parseSeedanceSubmitResponse(payload = {}) {
  const taskId = cleanString(payload.id, cleanString(payload.task_id, cleanString(payload.taskId)));
  return {
    taskId,
    status: cleanString(payload.status, "queued"),
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

export function seedanceTaskUrl(endpoint, taskId, submitPath = DEFAULT_SUBMIT_PATH) {
  const base = seedanceSubmitUrl(endpoint, submitPath).replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(cleanString(taskId))}`;
}

function nestedVideoUrl(value, depth = 0) {
  if (!value || depth > 4) return "";
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const direct = cleanString(value.video_url, cleanString(value.url, cleanString(value.download_url)));
  if (/^https?:\/\//i.test(direct)) return direct;
  if (value.video_url && typeof value.video_url === "object") {
    const nested = cleanString(value.video_url.url);
    if (/^https?:\/\//i.test(nested)) return nested;
  }
  for (const key of ["content", "output", "result", "data", "outputs", "artifacts"]) {
    const found = nestedVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

export function extractSeedanceVideoUrl(payload = {}) {
  return nestedVideoUrl(payload);
}

export function parseSeedancePollResponse(payload = {}) {
  const taskId = cleanString(payload.id, cleanString(payload.task_id, cleanString(payload.taskId)));
  const status = normalizeSeedanceTaskStatus(payload.status || payload.state || payload.task_status);
  return {
    taskId,
    status,
    videoUrl: extractSeedanceVideoUrl(payload),
    responsePayload: payload
  };
}

export function summarizeSeedancePollResponse(result = {}) {
  return {
    taskId: result.taskId || "",
    status: result.status || "",
    upstreamStatus: result.responsePayload?.status || "",
    videoUrlStored: Boolean(result.videoUrl),
    upstreamRequestId: result.responsePayload?.upstream_request_id || result.responsePayload?.request_id || ""
  };
}

export function isTerminalSeedanceStatus(status = "") {
  return TERMINAL_UPSTREAM_STATUSES.has(normalizeSeedanceTaskStatus(status));
}

export function hasRemoteSeedanceProvider(context = {}, capability = {}) {
  return Boolean(context.seedanceProviderClient || configuredProvider(context, capability).endpoint);
}

export function createSeedanceProviderClient(context = {}, capability = {}) {
  if (context.seedanceProviderClient) return context.seedanceProviderClient;
  const config = configuredProvider(context, capability);
  if (!config.endpoint) return null;
  if (!config.apiKey) {
    throw upstreamError("未配置 Seedance API Key", {
      provider: config.provider,
      apiKeyEnv: config.apiKeyEnv
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
    endpoint: config.endpoint,
    config,
    async createTask(payload) {
      const response = await fetchWithTimeout(fetchImpl, seedanceSubmitUrl(config.endpoint, config.submitPath), {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      }, config.timeoutMs, config.provider);
      return parseSeedanceSubmitResponse(await readJsonResponse(response, config.provider, "create_seedance_task"));
    },
    async getTask(taskId) {
      const response = await fetchWithTimeout(fetchImpl, seedanceTaskUrl(config.endpoint, taskId, config.submitPath), {
        method: "GET",
        headers: authHeaders(config.apiKey)
      }, config.timeoutMs, config.provider);
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
      return Buffer.from(await response.arrayBuffer());
    }
  };
}

export function summarizeSeedanceRequest(payload, provider = {}) {
  return {
    provider: cleanString(provider.provider, "seedance"),
    model: payload?.model || "",
    submitPath: provider.submitPath || provider.config?.submitPath || DEFAULT_SUBMIT_PATH,
    mode: payload?.mode || "",
    ratio: payload?.ratio || "",
    duration: payload?.duration,
    resolution: payload?.resolution || "",
    generate_audio: payload?.generate_audio,
    watermark: payload?.watermark,
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
