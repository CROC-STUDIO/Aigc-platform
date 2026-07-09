import { WangzhuanError } from "./http.mjs";

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function titleFromUrl(url) {
  const id = url.searchParams.get("id") || "";
  if (id) return id.split(".").filter(Boolean).pop() || id;
  const appIdMatch = url.pathname.match(/\/id(\d+)(?:$|[/?#])/);
  if (appIdMatch) return appIdMatch[1];
  const pathParts = url.pathname.split("/").filter(Boolean);
  return pathParts.at(-1)?.replace(/[-_]+/g, " ") || "";
}

function detectStore(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes("play.google")) return "google_play";
  if (host.includes("apps.apple")) return "app_store";
  return "unknown_store";
}

function decodeHtmlEntities(value = "") {
  return cleanString(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function emptyCandidates(productName = "") {
  return {
    productName,
    developer: "",
    category: "",
    shortDescription: "",
    description: "",
    icon: null,
    screenshots: [],
    videoPreviews: [],
    visibleTexts: [],
    coreSellingPoints: []
  };
}

function emptyMetadata() {
  return {
    appId: "",
    bundleId: "",
    storeUrl: "",
    contentRating: "",
    sourceLanguages: [],
    rating: null,
    ratingCount: null,
    version: "",
    releaseDate: "",
    minimumOsVersion: "",
    fileSizeBytes: ""
  };
}

function emptyProductBrief(productName = "") {
  return {
    productName,
    category: "",
    developer: "",
    description: "",
    contentRating: "",
    coreSellingPoints: [],
    targetAudience: [],
    mustShow: [],
    mustAvoid: [
      "不要编造商店页未提供的价格、订阅权益、收益、奖励、排名、评分或用户规模。",
      "不要把商店评分、下载量或评论数写进 Seedance prompt，除非用户明确确认可用。"
    ],
    assetSlots: {
      productIcon: "",
      productScreenshots: [],
      productRecording: ""
    }
  };
}

function fallbackStoreResult(rawUrl, url) {
  const productName = titleFromUrl(url);
  return {
    url: rawUrl,
    store: detectStore(url),
    provider: {
      name: "url_fallback",
      status: "fallback_only"
    },
    candidates: emptyCandidates(productName),
    metadata: emptyMetadata(),
    productBrief: emptyProductBrief(productName),
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
  const videoPreviews = Array.isArray(candidates.videoPreviews) ? candidates.videoPreviews.filter((item) => item && typeof item === "object") : [];
  const normalizedCandidates = {
    productName: cleanString(candidates.productName),
    developer: cleanString(candidates.developer),
    category: cleanString(candidates.category),
    shortDescription: cleanString(candidates.shortDescription),
    description: cleanString(candidates.description),
    icon: candidates.icon && typeof candidates.icon === "object" ? candidates.icon : null,
    screenshots,
    videoPreviews,
    visibleTexts: normalizeStringList(candidates.visibleTexts),
    coreSellingPoints: normalizeStringList(candidates.coreSellingPoints)
  };
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const productBrief = payload.productBrief && typeof payload.productBrief === "object"
    ? payload.productBrief
    : buildProductBrief(normalizedCandidates, metadata);
  return {
    url: rawUrl,
    store,
    provider: {
      name: providerName,
      status: "connected"
    },
    candidates: normalizedCandidates,
    metadata: normalizeMetadata(metadata),
    productBrief,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map((item) => cleanString(item)).filter(Boolean) : [],
    nextStageNotes: Array.isArray(payload.nextStageNotes) ? payload.nextStageNotes.map((item) => cleanString(item)).filter(Boolean) : [],
    inspectedAt: new Date().toISOString()
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeMetadata(value = {}) {
  return {
    appId: stringValue(value.appId),
    bundleId: stringValue(value.bundleId),
    storeUrl: cleanString(value.storeUrl),
    contentRating: cleanString(value.contentRating),
    sourceLanguages: normalizeStringList(value.sourceLanguages),
    rating: numberOrNull(value.rating),
    ratingCount: numberOrNull(value.ratingCount),
    version: cleanString(value.version),
    releaseDate: cleanString(value.releaseDate),
    minimumOsVersion: cleanString(value.minimumOsVersion),
    fileSizeBytes: cleanString(value.fileSizeBytes)
  };
}

function mustShowFromCandidates(candidates = {}) {
  const items = [];
  if (candidates.icon?.url) items.push("产品 logo/icon");
  if (candidates.screenshots?.length) items.push("产品截图中的真实 UI、页面布局和功能入口");
  if (candidates.videoPreviews?.length) items.push("产品预览视频中的真实操作路径和动效节奏");
  for (const point of normalizeStringList(candidates.coreSellingPoints).slice(0, 4)) {
    items.push(point);
  }
  return [...new Set(items)].slice(0, 8);
}

function buildProductBrief(candidates = {}, metadata = {}) {
  const normalizedMetadata = normalizeMetadata(metadata);
  return {
    productName: cleanString(candidates.productName),
    category: cleanString(candidates.category),
    developer: cleanString(candidates.developer),
    description: cleanString(candidates.description),
    contentRating: normalizedMetadata.contentRating,
    coreSellingPoints: normalizeStringList(candidates.coreSellingPoints),
    targetAudience: [],
    mustShow: mustShowFromCandidates(candidates),
    mustAvoid: [
      "不要编造商店页未提供的价格、订阅权益、收益、奖励、排名、评分或用户规模。",
      "不要把商店评分、下载量或评论数写进 Seedance prompt，除非用户明确确认可用。",
      "不要照搬竞品品牌、水印、用户评论或未经确认的宣传语。"
    ],
    assetSlots: {
      productIcon: cleanString(candidates.icon?.url),
      productScreenshots: (Array.isArray(candidates.screenshots) ? candidates.screenshots : [])
        .map((item) => cleanString(item.url))
        .filter(Boolean),
      productRecording: cleanString(candidates.videoPreviews?.[0]?.url)
    }
  };
}

function appStoreCountry(url, request = {}) {
  const explicit = cleanString(request.country || request.region || request.storeCountry);
  if (explicit) return explicit.toLowerCase();
  const firstPathPart = url.pathname.split("/").filter(Boolean)[0] || "";
  return /^[a-z]{2}$/i.test(firstPathPart) ? firstPathPart.toLowerCase() : "us";
}

function appStoreLanguage(request = {}) {
  const explicit = cleanString(request.language || request.lang || request.primaryLanguage);
  if (!explicit) return "en_us";
  return explicit.replace("-", "_").toLowerCase();
}

function appStoreLookupParams(rawUrl, url, request = {}) {
  const idFromQuery = cleanString(url.searchParams.get("id"));
  const idFromPath = cleanString(url.pathname.match(/\/id(\d+)(?:$|[/?#])/)?.[1]);
  const bundleId = cleanString(request.bundleId || url.searchParams.get("bundleId"));
  const appId = cleanString(request.appId || idFromQuery || idFromPath);
  return {
    appId,
    bundleId,
    country: appStoreCountry(url, request),
    lang: appStoreLanguage(request),
    originalUrl: rawUrl
  };
}

function lookupAsset(url = "", kind = "asset", index = 1) {
  const value = cleanString(url);
  if (!value) return null;
  return {
    url: value,
    label: `${kind}_${index}`,
    fileName: `${kind}_${index}`
  };
}

function appStoreVisibleTexts(result = {}) {
  return [
    result.trackName,
    result.artistName,
    result.primaryGenreName,
    result.description,
    result.releaseNotes
  ].map((item) => cleanString(item)).filter(Boolean);
}

function appStoreCoreSellingPoints(result = {}) {
  const description = cleanString(result.description);
  return sellingPointsFromDescription(description);
}

function sellingPointsFromDescription(description = "") {
  const text = cleanString(description);
  if (!text) return [];
  return text
    .split(/\n+|(?<=[.!?。！？])\s+/)
    .map((item) => item.replace(/^[-•\s]+/, "").trim())
    .filter((item) => item.length >= 24)
    .slice(0, 6);
}

function googlePlayPackageId(url, request = {}) {
  return cleanString(request.appId || request.packageName || url.searchParams.get("id"));
}

function googlePlayCountry(request = {}) {
  const explicit = cleanString(request.country || request.region || request.storeCountry || request.regions?.[0]);
  return explicit ? explicit.toUpperCase() : "US";
}

function googlePlayLanguage(request = {}) {
  const explicit = cleanString(request.language || request.lang || request.primaryLanguage);
  return explicit ? explicit.replace("-", "_") : "en_US";
}

function htmlMetaContent(html = "", key = "") {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagPattern = new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${escaped}["'])[^>]*>`, "i");
  const tag = html.match(tagPattern)?.[0] || "";
  const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || "";
  return decodeHtmlEntities(content);
}

function parseJsonLdScripts(html = "") {
  const items = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const raw = decodeHtmlEntities(match[1]);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items.push(...parsed);
      else if (parsed && typeof parsed === "object") items.push(parsed);
    } catch {
      // Ignore malformed structured data and keep meta fallbacks.
    }
  }
  return items;
}

function firstSoftwareJsonLd(html = "") {
  const items = parseJsonLdScripts(html);
  return items.find((item) => {
    const type = Array.isArray(item?.["@type"]) ? item["@type"].join(" ") : cleanString(item?.["@type"]);
    return /SoftwareApplication|MobileApplication|GameApplication/i.test(type);
  }) || items[0] || {};
}

function googlePlayImageUrls(html = "") {
  const urls = new Set();
  const patterns = [
    /https?:\\?\/\\?\/play-lh\.googleusercontent\.com\\?\/[^"',<>\s\\]+/gi,
    /https?:\/\/play-lh\.googleusercontent\.com\/[^"',<>\s\\]+/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const normalized = decodeHtmlEntities(match[0]).replace(/\\u003d/g, "=");
      if (/^https?:\/\/play-lh\.googleusercontent\.com\//i.test(normalized)) urls.add(normalized);
    }
  }
  return [...urls];
}

function googlePlayVideoUrls(html = "") {
  const urls = new Set();
  const patterns = [
    /https?:\\?\/\\?\/(?:www\.)?youtube\.com\\?\/watch\?v=[A-Za-z0-9_-]+/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[A-Za-z0-9_-]+/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const normalized = decodeHtmlEntities(match[0]);
      if (/^https?:\/\/(?:www\.)?youtube\.com\/watch/i.test(normalized)) urls.add(normalized);
    }
  }
  return [...urls];
}

function normalizeGooglePlayResult(rawUrl, pageUrl, html = "", packageId = "") {
  const data = firstSoftwareJsonLd(html);
  const productName = cleanString(data.name)
    || htmlMetaContent(html, "og:title").replace(/\s+-\s+Apps on Google Play$/i, "");
  const description = cleanString(data.description) || htmlMetaContent(html, "og:description");
  const category = cleanString(data.applicationCategory || data.genre || data.category);
  const developer = cleanString(data.author?.name || data.publisher?.name || data.offers?.seller?.name);
  const iconUrl = cleanString(data.image?.url || data.image || htmlMetaContent(html, "og:image"));
  const allImages = [
    ...normalizeStringList(data.screenshot),
    ...normalizeStringList(data.screenshotUrl),
    ...normalizeStringList(data.screenshots),
    ...googlePlayImageUrls(html)
  ].map(decodeHtmlEntities).filter(Boolean);
  const uniqueImages = [...new Set(allImages)];
  const screenshots = uniqueImages
    .filter((item) => item !== iconUrl)
    .slice(0, 12)
    .map((item, index) => lookupAsset(item, "google_play_screenshot", index + 1));
  const videoPreviews = [
    ...normalizeStringList(data.video),
    ...normalizeStringList(data.trailer),
    ...googlePlayVideoUrls(html)
  ].map(decodeHtmlEntities)
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 4)
    .map((item, index) => lookupAsset(item, "google_play_preview", index + 1));

  const candidates = {
    productName,
    developer,
    category,
    shortDescription: cleanString(htmlMetaContent(html, "twitter:description")),
    description,
    icon: iconUrl ? {
      url: iconUrl,
      label: "google_play_icon",
      fileName: "google_play_icon"
    } : null,
    screenshots,
    videoPreviews,
    visibleTexts: [
      productName,
      developer,
      category,
      description
    ].filter(Boolean),
    coreSellingPoints: sellingPointsFromDescription(description)
  };
  const metadata = normalizeMetadata({
    appId: packageId,
    storeUrl: pageUrl,
    contentRating: cleanString(data.contentRating),
    rating: data.aggregateRating?.ratingValue,
    ratingCount: data.aggregateRating?.ratingCount || data.aggregateRating?.reviewCount
  });
  return {
    url: rawUrl,
    store: "google_play",
    provider: {
      name: "google_play_html",
      status: "connected",
      pageUrl
    },
    candidates,
    metadata,
    productBrief: buildProductBrief(candidates, metadata),
    warnings: productName || description ? [] : [
      "Google Play 页面已返回，但未解析到完整结构化字段；可能需要接入更稳定的商店页抓取 provider。"
    ],
    nextStageNotes: [
      "Google Play 元数据来自公开商店页 HTML；页面结构可能随地区、语言或反爬策略变化。",
      "截图和预览视频仍是远程 URL，使用前建议沉淀为产品素材。",
      "coreSellingPoints 由描述文本自动拆句生成，进入 Seedance prompt 前建议允许用户确认。"
    ],
    inspectedAt: new Date().toISOString(),
    ...(packageId ? { appId: packageId } : {})
  };
}

async function inspectGooglePlayPage(context, request, url) {
  const packageId = googlePlayPackageId(url, request);
  if (!packageId) return null;
  const pageUrl = new URL("https://play.google.com/store/apps/details");
  pageUrl.searchParams.set("id", packageId);
  pageUrl.searchParams.set("hl", googlePlayLanguage(request));
  pageUrl.searchParams.set("gl", googlePlayCountry(request));

  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WangzhuanError("upstream_failed", "当前运行环境不支持 Google Play 页面请求", {
      provider: "google_play_html"
    }, 502);
  }
  const response = await fetchImpl(pageUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": googlePlayLanguage(request).replace("_", "-"),
      "User-Agent": "Mozilla/5.0 (compatible; AigcPlatformStoreInspector/1.0)"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new WangzhuanError("upstream_failed", "Google Play 页面抓取失败", {
      provider: "google_play_html",
      status: response.status
    }, 502);
  }
  return normalizeGooglePlayResult(request.url, pageUrl.toString(), text, packageId);
}

function normalizeAppStoreLookupResult(rawUrl, lookupUrl, result = {}) {
  const screenshots = [
    ...normalizeStringList(result.screenshotUrls),
    ...normalizeStringList(result.ipadScreenshotUrls),
    ...normalizeStringList(result.appletvScreenshotUrls)
  ].map((item, index) => lookupAsset(item, "app_store_screenshot", index + 1)).filter(Boolean);
  const videoPreviews = normalizeStringList(result.previewUrl)
    .map((item, index) => lookupAsset(item, "app_store_preview", index + 1))
    .filter(Boolean);
  const iconUrl = cleanString(result.artworkUrl512 || result.artworkUrl100 || result.artworkUrl60);
  const candidates = {
    productName: cleanString(result.trackName),
    developer: cleanString(result.sellerName || result.artistName),
    category: cleanString(result.primaryGenreName || result.genres?.[0]),
    shortDescription: cleanString(result.primaryGenreName || result.trackContentRating),
    description: cleanString(result.description),
    icon: iconUrl ? {
      url: iconUrl,
      label: "app_store_icon",
      fileName: "app_store_icon"
    } : null,
    screenshots,
    videoPreviews,
    visibleTexts: appStoreVisibleTexts(result),
    coreSellingPoints: appStoreCoreSellingPoints(result)
  };
  const metadata = normalizeMetadata({
    appId: result.trackId,
    bundleId: result.bundleId,
    storeUrl: result.trackViewUrl,
    contentRating: result.trackContentRating,
    sourceLanguages: result.languageCodesISO2A,
    rating: result.averageUserRating,
    ratingCount: result.userRatingCount,
    version: result.version,
    releaseDate: result.currentVersionReleaseDate || result.releaseDate,
    minimumOsVersion: result.minimumOsVersion,
    fileSizeBytes: result.fileSizeBytes
  });
  return {
    url: rawUrl,
    store: "app_store",
    provider: {
      name: "apple_lookup",
      status: "connected",
      lookupUrl
    },
    candidates,
    metadata,
    productBrief: buildProductBrief(candidates, metadata),
    warnings: [],
    nextStageNotes: [
      "App Store 元数据来自 Apple Lookup API；截图和预览视频仍是远程 URL，使用前建议沉淀为产品素材。",
      "coreSellingPoints 由描述文本自动拆句生成，进入 Seedance prompt 前建议允许用户确认。"
    ],
    inspectedAt: new Date().toISOString()
  };
}

async function inspectAppStoreLookup(context, request, url) {
  const { appId, bundleId, country, lang } = appStoreLookupParams(request.url, url, request);
  if (!appId && !bundleId) return null;
  const lookupUrl = new URL("https://itunes.apple.com/lookup");
  if (appId) lookupUrl.searchParams.set("id", appId);
  else lookupUrl.searchParams.set("bundleId", bundleId);
  lookupUrl.searchParams.set("country", country);
  lookupUrl.searchParams.set("lang", lang);
  lookupUrl.searchParams.set("entity", "software");

  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WangzhuanError("upstream_failed", "当前运行环境不支持 App Store Lookup 请求", {
      provider: "apple_lookup"
    }, 502);
  }
  const response = await fetchImpl(lookupUrl, {
    headers: {
      Accept: "application/json"
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new WangzhuanError("upstream_failed", "App Store Lookup 返回了不可解析的数据", {
      provider: "apple_lookup"
    }, 502);
  }
  if (!response.ok) {
    throw new WangzhuanError("upstream_failed", "App Store Lookup 调用失败", {
      provider: "apple_lookup",
      status: response.status,
      upstreamMessage: payload.errorMessage || ""
    }, 502);
  }
  const result = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!result) {
    throw new WangzhuanError("not_found", "App Store 未找到该应用", {
      provider: "apple_lookup",
      appId,
      bundleId,
      country
    }, 404);
  }
  return normalizeAppStoreLookupResult(request.url, lookupUrl.toString(), result);
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
  if (store === "google_play") {
    const googlePlayResult = await inspectGooglePlayPage(context, { ...request, url: rawUrl }, url);
    if (googlePlayResult) return googlePlayResult;
  }
  if (store === "app_store") {
    const appStoreResult = await inspectAppStoreLookup(context, { ...request, url: rawUrl }, url);
    if (appStoreResult) return appStoreResult;
  }
  return fallbackStoreResult(rawUrl, url);
}
