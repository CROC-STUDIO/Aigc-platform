import { WangzhuanError } from "./http.mjs";

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function titleFromUrl(url) {
  const id = url.searchParams.get("id") || "";
  if (id) return id.split(".").filter(Boolean).pop() || id;
  const pathParts = url.pathname.split("/").filter(Boolean);
  return pathParts.at(-1)?.replace(/[-_]+/g, " ") || "";
}

function detectStore(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes("play.google")) return "google_play";
  if (host.includes("apps.apple")) return "app_store";
  return "unknown_store";
}

function emptyCandidates(productName = "") {
  return {
    productName,
    developer: "",
    description: "",
    icon: null,
    screenshots: []
  };
}

function fallbackStoreResult(rawUrl, url) {
  return {
    url: rawUrl,
    store: detectStore(url),
    provider: {
      name: "url_fallback",
      status: "fallback_only"
    },
    candidates: emptyCandidates(titleFromUrl(url)),
    warnings: [
      "当前先使用链接解析兜底信息；如需 icon、截图和完整商店描述，需要接入商店页抓取服务。"
    ],
    nextStageNotes: [
      "建议新增 store metadata provider，按 google_play / app_store 分流抓取。",
      "保持 /api/wangzhuan/store-page/inspect 返回结构不变，只替换内部 provider。",
      "provider 成功时返回 productName、developer、description、icon、screenshots；失败时回退当前 URL 兜底。"
    ],
    inspectedAt: new Date().toISOString()
  };
}

function normalizeProviderResult(rawUrl, store, payload = {}, providerName = "custom_provider") {
  const candidates = payload.candidates && typeof payload.candidates === "object" ? payload.candidates : {};
  const screenshots = Array.isArray(candidates.screenshots) ? candidates.screenshots.filter((item) => item && typeof item === "object") : [];
  return {
    url: rawUrl,
    store,
    provider: {
      name: providerName,
      status: "connected"
    },
    candidates: {
      productName: cleanString(candidates.productName),
      developer: cleanString(candidates.developer),
      description: cleanString(candidates.description),
      icon: candidates.icon && typeof candidates.icon === "object" ? candidates.icon : null,
      screenshots
    },
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map((item) => cleanString(item)).filter(Boolean) : [],
    nextStageNotes: Array.isArray(payload.nextStageNotes) ? payload.nextStageNotes.map((item) => cleanString(item)).filter(Boolean) : [],
    inspectedAt: new Date().toISOString()
  };
}

async function inspectWithProvider(context, request, url, store) {
  if (typeof context.inspectStorePageProvider === "function") {
    const payload = await context.inspectStorePageProvider({
      url: request.url,
      store
    });
    return normalizeProviderResult(request.url, store, payload, "context.inspectStorePageProvider");
  }

  const provider = context.config?.wangzhuan?.storePageProvider || {};
  const endpoint = cleanString(provider.endpoint);
  if (!endpoint) return null;

  if (typeof (context.fetch || globalThis.fetch) !== "function") {
    throw new WangzhuanError("upstream_failed", "商店页抓取服务未配置 fetch 能力", { provider: "storePageProvider" }, 502);
  }

  const fetchImpl = context.fetch || globalThis.fetch;
  const response = await fetchImpl(endpoint, {
    method: cleanString(provider.method, "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({
      url: request.url,
      store,
      providerOptions: provider.options || {}
    })
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new WangzhuanError("upstream_failed", "商店页抓取服务返回了不可解析的数据", {
      provider: endpoint
    }, 502);
  }
  if (!response.ok) {
    throw new WangzhuanError("upstream_failed", "商店页抓取服务调用失败", {
      provider: endpoint,
      status: response.status,
      upstreamMessage: payload.message || payload.detail || ""
    }, 502);
  }
  return normalizeProviderResult(request.url, store, payload, endpoint);
}

export async function inspectStorePage(context, request = {}) {
  const rawUrl = cleanString(request.url);
  if (!rawUrl) {
    throw new WangzhuanError("validation_error", "产品链接不能为空", { field: "url" });
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WangzhuanError("validation_error", "产品链接格式不正确", { field: "url" });
  }

  const store = detectStore(url);
  const providerResult = await inspectWithProvider(context, { ...request, url: rawUrl }, url, store);
  if (providerResult) return providerResult;
  return fallbackStoreResult(rawUrl, url);
}
