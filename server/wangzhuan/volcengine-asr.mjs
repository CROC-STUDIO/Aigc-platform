import { randomUUID } from "node:crypto";

import { WangzhuanError } from "./http.mjs";

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
const PROCESSING_CODES = new Set(["20000001", "20000002"]);

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveVolcengineAsrConfig(context = {}) {
  const source = context.config?.wangzhuan?.volcengineAsr || {};
  const apiKeyEnv = cleanString(source.apiKeyEnv, "VOLCENGINE_ASR_API_KEY");
  const appIdEnv = cleanString(source.appIdEnv, "VOLCENGINE_ASR_APP_ID");
  const accessTokenEnv = cleanString(source.accessTokenEnv, "VOLCENGINE_ASR_ACCESS_TOKEN");
  return {
    endpoint: cleanString(source.endpoint, DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    resourceId: cleanString(source.resourceId, "volc.seedasr.auc"),
    apiKeyEnv,
    appIdEnv,
    accessTokenEnv,
    apiKey: cleanString(source.apiKey, cleanString(process.env[apiKeyEnv])),
    appId: cleanString(source.appId, cleanString(process.env[appIdEnv])),
    accessToken: cleanString(source.accessToken, cleanString(process.env[accessTokenEnv])),
    enableAutoLang: booleanValue(source.enableAutoLang, true),
    timeoutMs: positiveNumber(source.timeoutMs, 600000),
    pollIntervalMs: positiveNumber(source.pollIntervalMs, 2000)
  };
}

export function buildVolcengineAsrHeaders(config, requestId, isSubmit = false) {
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": requestId
  };
  if (config.apiKey) headers["X-Api-Key"] = config.apiKey;
  else if (config.appId && config.accessToken) {
    headers["X-Api-App-Key"] = config.appId;
    headers["X-Api-Access-Key"] = config.accessToken;
  } else {
    throw new WangzhuanError("upstream_failed", `未配置火山语音 API Key，请设置 ${config.apiKeyEnv}；旧版控制台可设置 ${config.appIdEnv} 和 ${config.accessTokenEnv}`);
  }
  if (isSubmit) headers["X-Api-Sequence"] = "-1";
  return headers;
}

function responseCode(response) {
  return cleanString(response.headers.get("X-Api-Status-Code"));
}

async function responseText(response) {
  try {
    return (await response.text()).slice(0, 800);
  } catch {
    return "";
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function invoke(fetchImpl, url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      throw new WangzhuanError("upstream_failed", `火山语音接口请求失败（HTTP ${response.status}）`, { status: response.status, detail: await responseText(response) });
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeVolcengineAudio({
  audioUrl,
  language = "",
  uid = "aigc-platform",
  config,
  requestId = randomUUID(),
  fetchImpl = fetch
}) {
  if (!/^https:\/\//i.test(cleanString(audioUrl))) {
    throw new WangzhuanError("upstream_failed", "火山语音识别需要可访问的 HTTPS 音频 URL");
  }
  const resolved = { ...config };
  const requestedLanguage = cleanString(language);
  const requestOptions = {
    model_name: "bigmodel",
    enable_itn: true,
    enable_punc: true,
    show_utterances: true
  };
  if (!requestedLanguage && resolved.enableAutoLang !== false) requestOptions.enable_auto_lang = true;
  const submit = await invoke(fetchImpl, `${resolved.endpoint}/submit`, buildVolcengineAsrHeaders(resolved, requestId, true), {
    user: { uid },
    audio: { url: audioUrl, format: "mp3", ...(requestedLanguage ? { language: requestedLanguage } : {}) },
    request: requestOptions
  }, resolved.timeoutMs);
  const submitCode = responseCode(submit);
  if (submitCode !== "20000000") {
    throw new WangzhuanError("upstream_failed", `火山语音提交失败：${submitCode || "未知状态"}`, { code: submitCode, logId: submit.headers.get("X-Tt-Logid") || "" });
  }
  const deadline = Date.now() + resolved.timeoutMs;
  while (Date.now() < deadline) {
    const query = await invoke(fetchImpl, `${resolved.endpoint}/query`, buildVolcengineAsrHeaders(resolved, requestId), {}, Math.min(resolved.timeoutMs, Math.max(1000, deadline - Date.now())));
    const code = responseCode(query);
    if (code === "20000000") return query.json();
    if (!PROCESSING_CODES.has(code)) {
      throw new WangzhuanError("upstream_failed", `火山语音识别失败：${code || "未知状态"}`, { code, logId: query.headers.get("X-Tt-Logid") || "", detail: await responseText(query) });
    }
    await sleep(Math.min(resolved.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new WangzhuanError("upstream_failed", "火山语音识别超时", { timeoutMs: resolved.timeoutMs });
}
