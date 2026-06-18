import { WangzhuanError } from "./http.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function configuredProvider(context = {}, capability = {}) {
  const config = context.config?.wangzhuan?.remixProvider && typeof context.config.wangzhuan.remixProvider === "object"
    ? context.config.wangzhuan.remixProvider
    : {};
  const endpoint = cleanString(
    capability.endpoint,
    cleanString(config.endpoint, cleanString(process.env.WANGZHUAN_REMIX_ENDPOINT))
  );
  const provider = cleanString(capability.provider, cleanString(config.provider, "video_aigc"));
  const apiKeyEnv = cleanString(capability.apiKeyEnv, cleanString(config.apiKeyEnv, "VIDEO_AIGC_API_KEY"));
  const apiKey = cleanString(capability.apiKey, cleanString(config.apiKey, cleanString(process.env[apiKeyEnv])));
  const timeoutMs = Number(capability.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    provider,
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function upstreamError(message, data = {}) {
  return new WangzhuanError("upstream_failed", message, data, 502);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw upstreamError("视频处理平台调用超时", { provider: "video_aigc" });
    }
    throw upstreamError("视频处理平台调用失败", { provider: "video_aigc" });
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
    throw upstreamError("视频处理平台返回了无法解析的数据", {
      provider,
      operation,
      status: response.status
    });
  }
  if (!response.ok) {
    throw upstreamError("视频处理平台返回失败状态", {
      provider,
      operation,
      status: response.status,
      upstreamCode: payload.code || payload.error || payload.status || "",
      upstreamMessage: typeof payload.detail === "string"
        ? payload.detail
        : payload.message || payload.error_message || "",
      validationErrors: Array.isArray(payload.detail) ? payload.detail.slice(0, 5) : []
    });
  }
  return payload;
}

export function hasRemoteRemixProvider(context = {}, capability = {}) {
  return Boolean(context.remixProviderClient || configuredProvider(context, capability).endpoint);
}

export function createRemixProviderClient(context = {}, capability = {}) {
  if (context.remixProviderClient) return context.remixProviderClient;
  const config = configuredProvider(context, capability);
  if (!config.endpoint) return null;
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw upstreamError("当前 Node 运行时不支持 fetch，无法调用视频处理平台", {
      provider: config.provider
    });
  }

  const jsonHeaders = {
    "Content-Type": "application/json",
    ...authHeaders(config.apiKey)
  };

  async function jsonRequest(path, method, body, operation) {
    const response = await fetchWithTimeout(fetchImpl, `${config.endpoint}${path}`, {
      method,
      headers: jsonHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }, config.timeoutMs);
    return readJsonResponse(response, config.provider, operation);
  }

  async function downloadRequest(path, operation) {
    const response = await fetchWithTimeout(fetchImpl, `${config.endpoint}${path}`, {
      method: "GET",
      headers: authHeaders(config.apiKey)
    }, config.timeoutMs);
    if (!response.ok) {
      throw upstreamError("视频处理平台下载失败", {
        provider: config.provider,
        operation,
        status: response.status
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    provider: config.provider,
    async createJob(payload) {
      return jsonRequest("/jobs", "POST", payload, "create_job");
    },
    async getJob(jobId) {
      return jsonRequest(`/jobs/${encodeURIComponent(jobId)}`, "GET", undefined, "get_job");
    },
    async downloadJob(jobId) {
      return downloadRequest(`/jobs/${encodeURIComponent(jobId)}/download`, "download_job");
    }
  };
}
