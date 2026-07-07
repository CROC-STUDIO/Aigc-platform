import { WangzhuanApiError, isBatchQcRunnable, readWorkbenchRestoreRequest, strongTruthFields } from "./wangzhuan-common.js";

const $ = (selector, root = document) => root.querySelector(selector);
const signatureFields = [
  "productName",
  "productLink",
  "assets",
  "targetChannel",
  "targetRegion",
  "targetRegions",
  "language",
  "languages",
  "materialDirection",
  "materialDirectionCustom",
  "voiceoverStyle",
  "promiseLevel",
  "currencySymbol",
  "cta",
  "ending",
  "variantPrompt",
  "customPrompt",
  "negativePrompt"
];

const els = {
  globalError: $("#wzGlobalError"),
  referenceFile: $("#wzReferenceFile"),
  checkReferenceBtn: $("#wzCheckReferenceBtn"),
  referenceUploadStatus: $("#wzReferenceUploadStatus"),
  referencePreview: $("#wzReferencePreview"),
  referenceBox: $("#wzReferenceBox"),
  startNewTaskBtn: $("#wzStartNewTaskBtn"),
  saveDraftBtn: $("#wzSaveDraftBtn"),
  draftDecompositionBtn: $("#wzDraftDecompositionBtn"),
  decompositionStatus: $("#wzDecompositionStatus"),
  decompositionForm: $("#wzDecompositionForm"),
  geminiDecompositionHint: $("#wzGeminiDecompositionHint"),
  llmServiceStatus: $("#wzLlmServiceStatus"),
  templateSelect: $("#wzTemplateSelect"),
  displayName: $("#wzDisplayName"),
  createTemplateBtn: $("#wzCreateTemplateBtn"),
  deleteTemplateBtn: $("#wzDeleteTemplateBtn"),
  confirmRewriteBtn: $("#wzConfirmRewriteBtn"),
  addBranchBtn: $("#wzAddBranchBtn"),
  removeBranchBtn: $("#wzRemoveBranchBtn"),
  branchTabs: $("#wzBranchTabs"),
  targetChannel: $("#wzTargetChannel"),
  targetRegion: $("#wzTargetRegion"),
  language: $("#wzLanguage"),
  currencySymbol: $("#wzCurrencySymbol"),
  currencyCustom: $("#wzCurrencyCustom"),
  productName: $("#wzProductName"),
  productLink: $("#wzProductLink"),
  materialDirection: $("#wzMaterialDirection"),
  materialDirectionCustom: $("#wzMaterialDirectionCustom"),
  voiceoverStyle: $("#wzVoiceoverStyle"),
  promiseLevel: $("#wzPromiseLevel"),
  truthDetails: $("#wzTruthDetails"),
  truthFields: $("#wzTruthFields"),
  cta: $("#wzCta"),
  ending: $("#wzEnding"),
  uploadSeedanceAssetsBtn: $("#wzUploadSeedanceAssetsBtn"),
  variantPrompt: $("#wzVariantPrompt"),
  customPrompt: $("#wzCustomPrompt"),
  negativePrompt: $("#wzNegativePrompt"),
  estimateBox: $("#wzEstimateBox"),
  confirmLimits: $("#wzConfirmLimits"),
  planLlmProvider: $("#wzPlanLlmProvider"),
  planLlmModel: $("#wzPlanLlmModel"),
  planLlmEndpoint: $("#wzPlanLlmEndpoint"),
  planLlmTemperature: $("#wzPlanLlmTemperature"),
  planBatchBtn: $("#wzPlanBatchBtn"),
  confirmPlanBtn: $("#wzConfirmPlanBtn"),
  planBox: $("#wzPlanBox"),
  planStaleNotice: $("#wzPlanStaleNotice"),
  variantCount: $("#wzVariantCount"),
  requestedConcurrency: $("#wzRequestedConcurrency"),
  duration: $("#wzDuration"),
  outputRatio: $("#wzOutputRatio"),
  seedanceModel: $("#wzSeedanceModel"),
  runQcBtn: $("#wzRunQcBtn"),
  stopBatchBtn: $("#wzStopBatchBtn"),
  taskQueue: $("#wzV2TaskQueue"),
  reminders: $("#wzV2Reminders"),
  logs: $("#wzV2Logs"),
  loadOlderLogsBtn: $("#wzLoadOlderLogsBtn"),
  recentResults: $("#wzRecentResults"),
  recentPager: $("#wzRecentPager"),
  refreshRecentBtn: $("#wzRefreshRecentBtn"),
  longTaskStatus: $("#wzV2LongTaskStatus"),
  runStatusBox: $("#wzRunStatusBox"),
  badge: $("#wzCurrentUserBadge"),
  logoutBtn: $("#wzLogoutBtn"),
  loginModal: $("#wzLoginModal"),
  loginUsername: $("#wangzhuanLoginUsername"),
  loginPassword: $("#wangzhuanLoginPassword"),
  loginBtn: $("#wangzhuanLoginBtn")
};

const state = {
  referenceVideo: null,
  decompositionJob: null,
  decompositionDraft: null,
  estimate: null,
  planJob: null,
  batchDetail: null,
  templates: [],
  selectedTemplate: null,
  rewriteConfirmed: false,
  activeBranchIndex: 0,
  branches: [{ branchId: "branch_1", branchIndex: 1, branchLabel: "改写 3.1", assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetReviews: {} }],
  branchDraft: { branchId: "branch_1", branchIndex: 1, branchLabel: "改写 3.1", assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetReviews: {} },
  draftSignature: "",
  stalePlanPreview: false,
  decompositionEditedFields: new Set(),
  visibleLogs: [],
  archivedLogs: [],
  recentResults: [],
  recentPagination: null,
  recentPage: 1,
  recentLoading: false,
  disclaimerOverlayAsset: null,
  confirmPlanSubmitting: false,
  loggedTaskFailures: new Set()
};

let batchPollTimer = 0;
let batchPollNetworkErrorActive = false;
const DECOMPOSITION_LLM_TIMEOUT_MS = 180_000;
const GEMINI_DECOMPOSITION_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1500;
const VISIBLE_LOG_LIMIT = 50;
const OLDER_LOG_PAGE_SIZE = 50;
const RECENT_PAGE_SIZE = 5;
const DEFAULT_SEEDANCE_MODEL = "dreamina-seedance-2-0-fast-260128";
const DEFAULT_VARIANT_COUNT = 3;
const MAX_VARIANT_COUNT = 10;
const MULTI_ASSET_LIMITS = Object.freeze({
  productIcon: 9,
  productScreenshot: 9,
  productRecording: 2
});
const TERMINAL_BATCH_STATUSES = new Set(["succeeded", "failed", "partial_failed", "stopped", "skipped"]);
const PLAN_UPSTREAM_LOCK_SELECTOR = [
  "#wzBatchName",
  "#wzSaveDraftBtn",
  "#wzReferenceFile",
  "#wzCheckReferenceBtn",
  "#wzProjectName",
  "#wzLlmProvider",
  "#wzLlmModel",
  "#wzLlmEndpoint",
  "#wzLlmTemperature",
  "#wzKnowledgeNotes",
  "#wzDraftDecompositionBtn",
  "#wzTemplateSelect",
  "#wzDisplayName",
  "#wzProductName",
  "#wzProductLink",
  "#wzCreateTemplateBtn",
  "#wzAddBranchBtn",
  "#wzRemoveBranchBtn",
  "#wzTargetChannel",
  "#wzTargetRegion",
  "#wzLanguage",
  "#wzMaterialDirection",
  "#wzMaterialDirectionCustom",
  "#wzVoiceoverStyle",
  "#wzPromiseLevel",
  "#wzCurrencySymbol",
  "#wzCurrencyCustom",
  "#wzCta",
  "#wzEnding",
  "#wzVariantPrompt",
  "#wzCustomPrompt",
  "#wzNegativePrompt",
  "#wzDisclaimerPreset",
  "#wzDisclaimerEnabled",
  "#wzDisclaimerOverlayFile",
  "#wzDisclaimerOverlayPosition",
  "#wzDisclaimerOverlayBoxHeight",
  "#wzDisclaimerOverlayBottomMargin",
  "#wzDisclaimerOverlayHorizontalMargin",
  "#wzDuration",
  "#wzOutputRatio",
  "#wzVariantCount",
  "#wzRequestedConcurrency",
  "#wzSeedanceModel",
  "#wzPlanLlmProvider",
  "#wzPlanLlmModel",
  "#wzPlanLlmEndpoint",
  "#wzPlanLlmTemperature",
  "#wzConfirmLimits",
  "#wzPlanBatchBtn",
  "#wzProductIconFile",
  "#wzProductScreenshotFile",
  "#wzProductRecordingFile",
  "#wzPersonAssetFile",
  "#wzRewardElementFile",
  "#wzCtaAssetFile",
  "#wzEndingAssetFile",
  "#wzTruthFields [data-truth-field]",
  "#wzDecompositionForm [data-decomposition-field]"
].join(", ");
let activeReferencePreviewUrl = "";

document.getElementById("wzDecomposeBtn")?.remove();
document.getElementById("wzConfirmReferenceBtn")?.remove();

function value(el) {
  return String(el?.value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function currencyValue() {
  return value(els.currencySymbol) === "custom" ? value(els.currencyCustom) : value(els.currencySymbol);
}

function effectiveMaterialDirection() {
  if (value(els.materialDirection) === "other") {
    return value(els.materialDirectionCustom) || "跟随竞品";
  }
  return value(els.materialDirection);
}

function setCurrencyValue(symbol = "$") {
  const clean = String(symbol || "$").trim() || "$";
  const option = [...(els.currencySymbol?.options || [])].find((item) => item.value === clean);
  if (option) {
    els.currencySymbol.value = clean;
    if (els.currencyCustom) els.currencyCustom.value = "";
  } else {
    els.currencySymbol.value = "custom";
    if (els.currencyCustom) els.currencyCustom.value = clean;
  }
  syncCurrencyCustom();
}

function syncCurrencyCustom() {
  const wrap = $("#wzCurrencyCustomWrap");
  if (wrap) wrap.hidden = value(els.currencySymbol) !== "custom";
}

function selectedDecompositionModel() {
  return value($("#wzLlmModel"));
}

function selectedSeedanceModel() {
  const selected = value($("#wzModelSelect")) || value(els.seedanceModel);
  return normalizeSeedanceModel(selected);
}

function syncSeedanceModel() {
  const model = selectedSeedanceModel();
  const modelSelect = $("#wzModelSelect");
  if (modelSelect) modelSelect.value = model;
  if (els.seedanceModel) els.seedanceModel.value = model;
}

function normalizeSeedanceModel(model = "") {
  const valueText = String(model || "").trim();
  if (!valueText) return DEFAULT_SEEDANCE_MODEL;
  return valueText;
}

function variantCountValue() {
  const raw = Number(value(els.variantCount) || DEFAULT_VARIANT_COUNT);
  return Math.max(1, Math.min(MAX_VARIANT_COUNT, raw || DEFAULT_VARIANT_COUNT));
}

function isGeminiDecompositionModel(model = selectedDecompositionModel()) {
  return String(model || "").trim().toLowerCase().startsWith("gemini-");
}

function decompositionTimeoutMs(model = selectedDecompositionModel()) {
  return isGeminiDecompositionModel(model) ? GEMINI_DECOMPOSITION_TIMEOUT_MS : DECOMPOSITION_LLM_TIMEOUT_MS;
}

function decompositionMaxRetries(model = selectedDecompositionModel()) {
  return isGeminiDecompositionModel(model) ? 3 : 0;
}

function decompositionJobTimeoutWindowMs(model = selectedDecompositionModel()) {
  const timeoutMs = decompositionTimeoutMs(model);
  const retries = decompositionMaxRetries(model);
  return timeoutMs * (retries + 1);
}

function syncGeminiDecompositionHint() {
  if (!els.geminiDecompositionHint) return;
  els.geminiDecompositionHint.hidden = !isGeminiDecompositionModel();
}

function renderTruthFields() {
  if (!els.truthFields || els.truthFields.querySelector("[data-truth-field]")) return;
  els.truthFields.innerHTML = strongTruthFields.map(([key, label]) => (
    `<label>${label}<input data-truth-field="${key}" type="text" /></label>`
  )).join("");
}

function collectTruthRules() {
  const truthRules = {};
  for (const input of els.truthFields?.querySelectorAll("[data-truth-field]") || []) {
    truthRules[input.dataset.truthField] = value(input);
  }
  return truthRules;
}

function applyTruthRules(truthRules = {}) {
  renderTruthFields();
  for (const input of els.truthFields?.querySelectorAll("[data-truth-field]") || []) {
    input.value = truthRules?.[input.dataset.truthField] || "";
  }
  syncTruthDetails();
}

function syncTruthDetails() {
  renderTruthFields();
  if (els.truthDetails) els.truthDetails.open = value(els.promiseLevel) === "strong_commitment";
}

function generatedBatchName() {
  return `网赚素材_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
}

function ensureBatchName() {
  const input = $("#wzBatchName");
  if (input && !value(input)) input.value = generatedBatchName();
  return value(input);
}

function currentBatchId() {
  return state.batchDetail?.batch?.batchId || state.batchDetail?.batchId || "";
}

function emptyAssetMaps() {
  return { assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetReviews: {} };
}

function assetEntryKey(assetKey, index = 0) {
  return index > 0 ? `${assetKey}_${index + 1}` : assetKey;
}

function assetInputFiles(input, assetKey) {
  const files = Array.from(input?.files || []);
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  return files.slice(0, limit);
}

function defaultBranchDraft(index = 0, seed = {}) {
  const branchIndex = index + 1;
  return {
    branchId: seed.branchId || `branch_${branchIndex}`,
    branchIndex,
    branchLabel: seed.branchLabel || `改写 3.${branchIndex}`,
    ...emptyAssetMaps(),
    ...seed,
    assetFileNames: { ...(seed.assetFileNames || {}) },
    assetUrls: { ...(seed.assetUrls || {}) },
    assetStorageKeys: { ...(seed.assetStorageKeys || {}) },
    assetStoredPaths: { ...(seed.assetStoredPaths || {}) },
    assetReviews: { ...(seed.assetReviews || {}) }
  };
}

function activeBranch() {
  if (!state.branches.length) state.branches = [defaultBranchDraft(0)];
  if (state.activeBranchIndex < 0 || state.activeBranchIndex >= state.branches.length) state.activeBranchIndex = 0;
  state.branchDraft = state.branches[state.activeBranchIndex];
  return state.branchDraft;
}

function showError(error, title = "操作失败") {
  const message = error?.message || String(error || "未知错误");
  const requestId = String(error?.requestId || "").trim();
  const detail = requestId ? `${message}（requestId: ${requestId}）` : message;
  if (els.globalError) {
    els.globalError.hidden = false;
    els.globalError.textContent = `${title}：${detail}`;
  }
  log(`${title}：${detail}`);
  if (error?.code === "unauthenticated") showLogin();
}

function clearError() {
  if (!els.globalError) return;
  els.globalError.hidden = true;
  els.globalError.textContent = "";
}

function showLogin() {
  if (els.loginModal) els.loginModal.hidden = false;
}

function hideLogin() {
  if (els.loginModal) els.loginModal.hidden = true;
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text || "处理中";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
    button.disabled = false;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function clientPlanDraftSignature(input = planSignatureInput()) {
  const payload = Object.fromEntries(signatureFields.map((field) => [field, input[field]]));
  return `plansig_${await sha256Hex(stableJson(payload))}`;
}

async function api(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!payload.requestId) payload.requestId = response.headers.get("X-Request-Id") || "";
  if (!payload.message && text && !payload.code) payload.message = text.trim();
  if (!response.ok || payload.ok === false) {
    throw new WangzhuanApiError(payload, response.status);
  }
  return payload.data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function log(message) {
  const entry = `${new Date().toLocaleTimeString()} ${message}`;
  state.visibleLogs.unshift(entry);
  if (state.visibleLogs.length > VISIBLE_LOG_LIMIT) {
    state.archivedLogs.unshift(...state.visibleLogs.splice(VISIBLE_LOG_LIMIT));
  }
  renderLogs();
}

function renderLogs() {
  if (!els.logs) return;
  els.logs.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const entry of state.visibleLogs) {
    const row = document.createElement("div");
    row.textContent = entry;
    fragment.append(row);
  }
  els.logs.append(fragment);
  if (els.loadOlderLogsBtn) {
    els.loadOlderLogsBtn.hidden = !state.archivedLogs.length;
    els.loadOlderLogsBtn.textContent = `加载更早日志（${state.archivedLogs.length}）`;
  }
}

function loadOlderLogs() {
  const chunk = state.archivedLogs.splice(0, OLDER_LOG_PAGE_SIZE);
  state.visibleLogs.push(...chunk);
  renderLogs();
}

function renderVideoPreview(url) {
  if (!els.referencePreview) return;
  if (activeReferencePreviewUrl?.startsWith("blob:") && activeReferencePreviewUrl !== url) {
    URL.revokeObjectURL(activeReferencePreviewUrl);
  }
  activeReferencePreviewUrl = url || "";
  if (!url) {
    els.referencePreview.textContent = "未上传参考视频";
    return;
  }
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  els.referencePreview.replaceChildren(video);
}

function fileUrlFromStoredPath(storedPath = "") {
  const clean = String(storedPath || "").trim();
  return clean ? `/file?path=${encodeURIComponent(clean)}` : "";
}

function referenceVideoPreviewUrl(referenceVideo = {}) {
  return referenceVideo.previewUrl
    || referenceVideo.storageUrl
    || referenceVideo.publicUrl
    || referenceVideo.url
    || fileUrlFromStoredPath(referenceVideo.storedPath || referenceVideo.path)
    || "";
}

function disclaimerTemplateUrl(preset = "auto", language = "") {
  let key = String(preset || "auto").trim();
  if (key === "auto") {
    const normalized = String(language || "").trim().toLowerCase();
    key = normalized.startsWith("pt") ? "pt" : (normalized.startsWith("zh") || normalized.includes("chinese") ? "zh" : "en");
  }
  return ["en", "pt", "zh"].includes(key) ? `/assets/wangzhuan/disclaimers/${key}.png` : "";
}

function disclaimerOverlayAssetFromState() {
  return state.disclaimerOverlayAsset && typeof state.disclaimerOverlayAsset === "object" ? state.disclaimerOverlayAsset : {};
}

function renderDisclaimerOverlayPreview() {
  const box = $("#wzDisclaimerOverlayPreview");
  if (!box) return;
  const asset = disclaimerOverlayAssetFromState();
  const preset = value($("#wzDisclaimerPreset")) || "auto";
  const url = asset.previewUrl || asset.storageUrl || fileUrlFromStoredPath(asset.storedPath) || disclaimerTemplateUrl(preset, value(els.language));
  const label = asset.fileName ? `已上传：${escapeHtml(asset.fileName)}` : "使用内置透明 PNG 模板";
  if (!url) {
    box.textContent = "请选择内置模板或上传透明 PNG。";
    return;
  }
  box.innerHTML = `<span>${label}</span><img src="${escapeHtml(url)}" alt="免责声明贴片预览" style="display:block;width:min(100%,360px);height:auto;margin-top:6px;background:#222;" />`;
}

function describeReferenceVideo(referenceVideo = {}) {
  if (!referenceVideo?.referenceVideoId) return "未上传参考视频";
  const parts = [
    referenceVideo.referenceVideoId,
    referenceVideo.durationSec ? `${referenceVideo.durationSec}s` : "",
    referenceVideo.ratio || "",
    referenceVideo.fileName || referenceVideo.originalName || ""
  ].filter(Boolean);
  return parts.join(" · ");
}

const assetInputs = [
  ["productIcon", "#wzProductIconFile"],
  ["productScreenshot", "#wzProductScreenshotFile"],
  ["productRecording", "#wzProductRecordingFile"],
  ["personAsset", "#wzPersonAssetFile"],
  ["rewardElement", "#wzRewardElementFile"],
  ["ctaAsset", "#wzCtaAssetFile"],
  ["endingAsset", "#wzEndingAssetFile"]
];

function assetReferences() {
  return assetInputs.flatMap(([assetKey, selector]) => {
    const input = $(selector);
    const branch = activeBranch();
    const storedKeys = Object.keys(branch.assetFileNames || {}).filter((key) => key === assetKey || key.startsWith(`${assetKey}_`));
    const keys = storedKeys.length ? storedKeys : [assetKey];
    return keys.map((entryKey) => ({
      assetKey: entryKey,
      branchId: branch.branchId,
      fileName: branch.assetFileNames?.[entryKey] || input?.dataset.uploadedFileName || input?.files?.[0]?.name || "",
      storageKey: branch.assetStorageKeys?.[entryKey] || input?.dataset.storageKey || "",
      storedPath: branch.assetStoredPaths?.[entryKey] || input?.dataset.storedPath || "",
      assetId: branch.assetReviews?.[entryKey]?.assetId || input?.dataset.assetId || "",
      reviewStatus: branch.assetReviews?.[entryKey]?.status || input?.dataset.reviewStatus || ""
    }));
  }).filter((asset) => asset.fileName || asset.storageKey || asset.storedPath || asset.assetId || asset.reviewStatus);
}

function branchAssetEntryKeys(branch = activeBranch(), assetKey = "") {
  return Object.keys(branch.assetFileNames || {})
    .filter((key) => key === assetKey || key.startsWith(`${assetKey}_`))
    .sort((left, right) => {
      const leftIndex = Number(left.replace(`${assetKey}_`, ""));
      const rightIndex = Number(right.replace(`${assetKey}_`, ""));
      return (Number.isFinite(leftIndex) ? leftIndex : -1) - (Number.isFinite(rightIndex) ? rightIndex : -1);
    });
}

function updateBranchAsset(assetKey, asset = {}) {
  const branch = activeBranch();
  branch.assetFileNames[assetKey] = asset.fileName || "";
  branch.assetUrls[assetKey] = asset.storageUrl || asset.previewUrl || "";
  branch.assetStorageKeys[assetKey] = asset.storageKey || "";
  branch.assetStoredPaths[assetKey] = asset.storedPath || "";
  branch.assetReviews[assetKey] = asset.review || {};
}

function pruneBranchAssetsForInput(assetKey, keepKeys = []) {
  const branch = activeBranch();
  const keep = new Set(keepKeys);
  for (const key of branchAssetEntryKeys(branch, assetKey)) {
    if (keep.has(key)) continue;
    delete branch.assetFileNames[key];
    delete branch.assetUrls[key];
    delete branch.assetStorageKeys[key];
    delete branch.assetStoredPaths[key];
    delete branch.assetReviews[key];
  }
}

function disclaimerRequestFields() {
  const language = value(els.language) || "en-US";
  const preset = value($("#wzDisclaimerPreset")) || "auto";
  const enabled = $("#wzDisclaimerEnabled")?.checked !== false;
  const asset = disclaimerOverlayAssetFromState();
  return {
    disclaimer: "",
    disclaimerEnabled: enabled,
    disclaimerPresetId: preset,
    disclaimerPreset: preset,
    disclaimerLanguage: preset === "auto" ? language : preset,
    disclaimerByLanguage: {},
    disclaimerOverlay: {
      enabled,
      templateId: preset,
      imageFileName: asset.fileName || "",
      imageStoredPath: asset.storedPath || "",
      imageStorageKey: asset.storageKey || "",
      imageStorageUrl: asset.storageUrl || asset.previewUrl || "",
      position: value($("#wzDisclaimerOverlayPosition")) || "bottom_center",
      boxHeight: Number(value($("#wzDisclaimerOverlayBoxHeight")) || 88),
      bottomMargin: Number(value($("#wzDisclaimerOverlayBottomMargin")) || 3),
      horizontalMargin: Number(value($("#wzDisclaimerOverlayHorizontalMargin")) || 50)
    }
  };
}

function collectCurrentBranchDraft() {
  const region = value(els.targetRegion);
  const language = value(els.language);
  const branch = activeBranch();
  return {
    ...branch,
    branchIndex: state.activeBranchIndex + 1,
    branchLabel: branch.branchLabel || `改写 3.${state.activeBranchIndex + 1}`,
    displayName: value(els.displayName) || value(els.productName) || branch.displayName || "",
    productName: value(els.productName),
    productLink: value(els.productLink),
    targetChannel: value(els.targetChannel),
    targetChannels: [value(els.targetChannel) || "meta_ads"],
    targetRegion: region,
    targetRegions: [region],
    regions: [region],
    language,
    languages: [language],
    materialDirection: effectiveMaterialDirection(),
    materialDirectionCustom: value(els.materialDirectionCustom),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    currencySymbol: currencyValue(),
    truthRules: collectTruthRules(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    defaultDurationSec: Number(value(els.duration) || 15),
    defaultOutputRatio: value(els.outputRatio) || "9:16",
    ...disclaimerRequestFields(),
    assetFileNames: { ...(branch.assetFileNames || {}) },
    assetUrls: { ...(branch.assetUrls || {}) },
    assetStorageKeys: { ...(branch.assetStorageKeys || {}) },
    assetStoredPaths: { ...(branch.assetStoredPaths || {}) },
    assetReviews: { ...(branch.assetReviews || {}) }
  };
}

function saveActiveBranchFromForm() {
  state.branches[state.activeBranchIndex] = collectCurrentBranchDraft();
  state.branchDraft = state.branches[state.activeBranchIndex];
  return state.branchDraft;
}

function resetAssetInputDatasets() {
  for (const [, selector] of assetInputs) {
    const input = $(selector);
    if (!input) continue;
    delete input.dataset.uploadedFileName;
    delete input.dataset.storageUrl;
    delete input.dataset.storageKey;
    delete input.dataset.storedPath;
    delete input.dataset.assetId;
    delete input.dataset.reviewStatus;
    delete input.dataset.reviewReason;
    input.value = "";
  }
}

function loadBranchToForm(branch = activeBranch()) {
  els.displayName.value = branch.displayName || "";
  els.productName.value = branch.productName || "";
  els.productLink.value = branch.productLink || "";
  els.cta.value = branch.cta || "";
  els.ending.value = branch.ending || "";
  setCurrencyValue(branch.currencySymbol || "$");
  els.targetChannel.value = branch.targetChannel || branch.targetChannels?.[0] || "meta_ads";
  els.targetRegion.value = branch.targetRegion || branch.targetRegions?.[0] || branch.regions?.[0] || "US";
  els.language.value = branch.language || branch.languages?.[0] || "en-US";
  els.duration.value = String(branch.defaultDurationSec || 15);
  els.outputRatio.value = branch.defaultOutputRatio || "9:16";
  els.promiseLevel.value = branch.promiseLevel || "strong_conversion";
  applyTruthRules(branch.truthRules || {});
  els.materialDirection.value = branch.materialDirection || "other";
  els.materialDirectionCustom.value = branch.materialDirectionCustom || "跟随竞品";
  els.voiceoverStyle.value = branch.voiceoverStyle || "遵循竞品";
  els.variantPrompt.value = branch.variantPrompt || "";
  els.customPrompt.value = branch.customPrompt || "";
  els.negativePrompt.value = branch.negativePrompt || "";
  if ($("#wzDisclaimerPreset")) $("#wzDisclaimerPreset").value = branch.disclaimerPreset || branch.disclaimerPresetId || "auto";
  if ($("#wzDisclaimerEnabled")) $("#wzDisclaimerEnabled").checked = branch.disclaimerEnabled !== false && branch.disclaimerOverlay?.enabled !== false;
  if ($("#wzDisclaimerOverlayPosition")) $("#wzDisclaimerOverlayPosition").value = branch.disclaimerOverlay?.position || "bottom_center";
  if ($("#wzDisclaimerOverlayBoxHeight")) $("#wzDisclaimerOverlayBoxHeight").value = String(branch.disclaimerOverlay?.boxHeight ?? 88);
  if ($("#wzDisclaimerOverlayBottomMargin")) $("#wzDisclaimerOverlayBottomMargin").value = String(branch.disclaimerOverlay?.bottomMargin ?? 3);
  if ($("#wzDisclaimerOverlayHorizontalMargin")) $("#wzDisclaimerOverlayHorizontalMargin").value = String(branch.disclaimerOverlay?.horizontalMargin ?? 50);
  state.disclaimerOverlayAsset = branch.disclaimerOverlay?.imageStoredPath ? {
    fileName: branch.disclaimerOverlay.imageFileName || "",
    storedPath: branch.disclaimerOverlay.imageStoredPath || "",
    storageKey: branch.disclaimerOverlay.imageStorageKey || "",
    storageUrl: branch.disclaimerOverlay.imageStorageUrl || ""
  } : null;
  if ($("#wzDisclaimerOverlayFile")) $("#wzDisclaimerOverlayFile").value = "";
  renderDisclaimerOverlayPreview();
  resetAssetInputDatasets();
  for (const [assetKey, selector] of assetInputs) {
    const input = $(selector);
    if (!input) continue;
    input.dataset.uploadedFileName = branch.assetFileNames?.[assetKey] || "";
    input.dataset.storageUrl = branch.assetUrls?.[assetKey] || "";
    input.dataset.storageKey = branch.assetStorageKeys?.[assetKey] || "";
    input.dataset.storedPath = branch.assetStoredPaths?.[assetKey] || "";
    input.dataset.assetId = branch.assetReviews?.[assetKey]?.assetId || "";
    input.dataset.reviewStatus = branch.assetReviews?.[assetKey]?.status || "";
    input.dataset.reviewReason = branch.assetReviews?.[assetKey]?.reviewReason || "";
  }
  syncMaterialDirectionCustom();
  renderAssetReviewState();
}

function firstPresent(...values) {
  return values.find((item) => item !== undefined && item !== null && String(item).trim() !== "");
}

function draftFromBatch(batch = {}) {
  return batch.templateSnapshot?.draft
    || batch.request?.templateSnapshot?.draft
    || batch.estimate?.request?.templateSnapshot?.draft
    || {};
}

function branchDraftsFromBatch(batch = {}) {
  const draft = draftFromBatch(batch);
  const branches = batch.branchDrafts
    || batch.request?.branchDrafts
    || batch.request?.branches
    || batch.estimate?.request?.branchDrafts
    || batch.estimate?.request?.branches
    || draft.branches
    || [];
  if (Array.isArray(branches) && branches.length) {
    return branches.map((branch, index) => defaultBranchDraft(index, {
      ...draft,
      ...branch,
      displayName: branch.displayName || draft.displayName || ""
    }));
  }
  return [defaultBranchDraft(0, draft)];
}

function decompositionFromBatch(batch = {}) {
  return batch.decomposition
    || batch.request?.decomposition
    || batch.estimate?.request?.decomposition
    || batch.referenceVideo?.decomposition
    || null;
}

function referenceVideoFromBatch(batch = {}) {
  return batch.referenceVideo
    || batch.request?.referenceVideo
    || batch.estimate?.request?.referenceVideo
    || null;
}

function restoreRewriteConfirmedFromBatch(batch = {}) {
  const request = batch.estimate?.request || batch.request || {};
  const sourceStep = String(request.sourceStep || "");
  return Boolean(batch.estimate?.estimateId || ["rewrite_confirmed", "estimate", "template_saved"].includes(sourceStep));
}

function restoreV2FromBatchDetail(detail = {}) {
  const batch = detail.batch || detail;
  if (!batch?.batchId) return false;
  const draft = draftFromBatch(batch);
  const request = batch.request || batch.estimate?.request || {};
  const referenceVideo = referenceVideoFromBatch(batch);
  if (referenceVideo?.referenceVideoId) {
    state.referenceVideo = referenceVideo;
    renderVideoPreview(referenceVideoPreviewUrl(referenceVideo));
    els.referenceBox.textContent = describeReferenceVideo(referenceVideo);
    els.referenceUploadStatus.textContent = "已从任务管理恢复参考视频。";
    els.draftDecompositionBtn.disabled = false;
  }

  const decomposition = decompositionFromBatch(batch);
  if (decomposition && Object.values(decomposition).some((item) => String(item || "").trim())) {
    state.decompositionDraft = decomposition;
    state.decompositionEditedFields.clear();
    renderDecompositionForm(decomposition, { preserveUserInput: false });
    els.decompositionStatus.textContent = "已从任务管理恢复 AI 拆解结果。";
  }

  const batchName = firstPresent(batch.userBatchName, batch.displayBatchName, request.userBatchName, request.batchName, batch.batchName, batch.batchId);
  if ($("#wzBatchName")) $("#wzBatchName").value = batchName || "";
  if ($("#wzProjectName")) $("#wzProjectName").value = firstPresent(batch.projectName, request.projectName, $("#wzProjectName").value) || "";

  state.estimate = batch.estimate || null;
  state.branches = branchDraftsFromBatch(batch);
  state.activeBranchIndex = 0;
  activeBranch();
  loadBranchToForm(state.branchDraft);
  if (draft.seedanceModel && $("#wzModelSelect")) $("#wzModelSelect").value = draft.seedanceModel;
  syncSeedanceModel();
  if (request.durationSec && els.duration) els.duration.value = String(request.durationSec);
  if (request.outputRatio && els.outputRatio) els.outputRatio.value = request.outputRatio;
  if (request.seedanceModel && $("#wzModelSelect")) $("#wzModelSelect").value = request.seedanceModel;
  syncSeedanceModel();
  if (request.variantCount && els.variantCount) els.variantCount.value = String(request.variantCount);
  if (request.requestedConcurrency && els.requestedConcurrency) els.requestedConcurrency.value = String(request.requestedConcurrency);
  if (batch.draftSignature) state.draftSignature = batch.draftSignature;
  state.rewriteConfirmed = restoreRewriteConfirmedFromBatch(batch);
  state.stalePlanPreview = false;
  renderBranchTabs();
  renderAssetReviewState();
  renderPlanEditors(Array.isArray(batch.plans) ? batch.plans : []);
  if (state.estimate) {
    const scriptCount = state.estimate.scriptCount || request.variantCount || 0;
    const seedanceCount = state.estimate.seedanceSegmentCount || 0;
    els.estimateBox.textContent = `估算结果：${scriptCount} 条脚本 · ${seedanceCount} 段 Seedance · ${state.branches.length} 个裂变子节点。预计时间：${expectedMinutes()} 分钟。`;
  }
  renderTasks();
  return true;
}

function collectBranchDrafts() {
  saveActiveBranchFromForm();
  return state.branches.map((branch, index) => defaultBranchDraft(index, {
    ...branch,
    branchIndex: index + 1,
    branchLabel: branch.branchLabel || `改写 3.${index + 1}`
  }));
}

function renderBranchTabs() {
  if (!els.branchTabs) return;
  els.branchTabs.innerHTML = state.branches.map((branch, index) => `
    <button class="mini ${index === state.activeBranchIndex ? "" : "ghost"}" type="button" data-branch-index="${index}">
      ${branch.branchLabel || `改写 3.${index + 1}`}
    </button>
  `).join("");
  if (els.removeBranchBtn) els.removeBranchBtn.disabled = state.branches.length <= 1;
}

function switchBranch(index) {
  if (index === state.activeBranchIndex || index < 0 || index >= state.branches.length) return;
  saveActiveBranchFromForm();
  state.activeBranchIndex = index;
  activeBranch();
  loadBranchToForm(state.branchDraft);
  renderBranchTabs();
  markPlanMaybeStale();
}

function addBranch() {
  const source = saveActiveBranchFromForm();
  const nextIndex = state.branches.length;
  const next = defaultBranchDraft(nextIndex, {
    productName: source.productName,
    productLink: source.productLink,
    targetChannel: source.targetChannel,
    targetChannels: source.targetChannels,
    targetRegion: source.targetRegion,
    targetRegions: source.targetRegions,
    regions: source.regions,
    language: source.language,
    languages: source.languages,
    currencySymbol: source.currencySymbol,
    promiseLevel: source.promiseLevel,
    truthRules: source.truthRules,
    voiceoverStyle: source.voiceoverStyle,
    variantPrompt: source.variantPrompt,
    customPrompt: source.customPrompt,
    negativePrompt: source.negativePrompt,
    defaultDurationSec: source.defaultDurationSec,
    defaultOutputRatio: source.defaultOutputRatio,
    disclaimer: source.disclaimer,
    disclaimerEnabled: source.disclaimerEnabled,
    disclaimerPreset: source.disclaimerPreset,
    disclaimerPresetId: source.disclaimerPresetId,
    disclaimerLanguage: source.disclaimerLanguage,
    disclaimerByLanguage: source.disclaimerByLanguage,
    disclaimerOverlay: source.disclaimerOverlay
  });
  state.branches.push(next);
  state.activeBranchIndex = nextIndex;
  activeBranch();
  loadBranchToForm(next);
  renderBranchTabs();
  log(`已新增${next.branchLabel}`);
  markPlanMaybeStale();
}

function removeActiveBranch() {
  if (state.branches.length <= 1) return;
  const removed = state.branches.splice(state.activeBranchIndex, 1)[0];
  state.branches = state.branches.map((branch, index) => defaultBranchDraft(index, {
    ...branch,
    branchIndex: index + 1,
    branchLabel: `改写 3.${index + 1}`
  }));
  state.activeBranchIndex = Math.min(state.activeBranchIndex, state.branches.length - 1);
  activeBranch();
  loadBranchToForm(state.branchDraft);
  renderBranchTabs();
  log(`已删除${removed.branchLabel || "当前子节点"}`);
  markPlanMaybeStale();
}

function currentDraft() {
  const branches = collectBranchDrafts();
  const primary = branches[0] || {};
  return {
    displayName: value(els.displayName) || value(els.productName) || "未命名模板",
    productName: primary.productName || value(els.productName),
    productLink: primary.productLink || value(els.productLink),
    currencySymbol: primary.currencySymbol || currencyValue() || "$",
    targetChannels: [value(els.targetChannel) || "meta_ads"],
    targetRegions: [value(els.targetRegion) || "US"],
    regions: [value(els.targetRegion) || "US"],
    language: value(els.language) || "en-US",
    languages: [value(els.language) || "en-US"],
    materialDirection: effectiveMaterialDirection(),
    materialDirectionCustom: value(els.materialDirectionCustom),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    truthRules: collectTruthRules(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    defaultDurationSec: Number(value(els.duration) || 15),
    defaultOutputRatio: value(els.outputRatio) || "9:16",
    seedanceModel: selectedSeedanceModel(),
    llmConfig: {
      provider: value($("#wzLlmProvider")),
      model: value($("#wzLlmModel")),
      endpoint: value($("#wzLlmEndpoint")),
      temperature: Number(value($("#wzLlmTemperature")) || 0.2)
    },
    planLlmConfig: planLlmConfig(),
    knowledgeNotes: value($("#wzKnowledgeNotes")),
    ...disclaimerRequestFields(),
    branches
  };
}

function renderAssetReviewState() {
  const branch = activeBranch();
  for (const [assetKey, selector] of assetInputs) {
    const input = $(selector);
    const slot = input?.closest(".wz-asset-slot");
    if (!slot) continue;
    let status = slot.querySelector(".wz-v2-asset-status");
    if (!status) {
      status = document.createElement("span");
      status.className = "wz-v2-asset-status";
      slot.append(status);
    }
    let fileList = slot.querySelector(".wz-v2-asset-files");
    if (!fileList) {
      fileList = document.createElement("div");
      fileList.className = "wz-v2-asset-files";
      slot.append(fileList);
    }
    const keys = branchAssetEntryKeys(branch, assetKey);
    const selectedFiles = assetInputFiles(input, assetKey).map((file) => file.name);
    const names = keys.length ? keys.map((key) => branch.assetFileNames[key]).filter(Boolean) : selectedFiles;
    const failed = keys
      .map((key) => branch.assetReviews?.[key])
      .filter((review) => review?.status && !isAssetReviewApproved(review.status));
    const countLabel = names.length ? `${names.length} 个文件` : "未选择";
    const stateLabel = failed.length ? "有审核风险" : (keys.length ? "已记录" : (names.length ? "待上传" : ""));
    status.textContent = stateLabel ? `${countLabel} · ${stateLabel}` : countLabel;
    fileList.innerHTML = names.length
      ? names.map((name) => `<span class="wz-v2-asset-file">${escapeHtml(name)}</span>`).join("")
      : "";
    slot.dataset.hasAsset = names.length ? "1" : "0";
  }
}

function isAssetReviewApproved(status = "") {
  return ["approved", "active", "success", "succeeded", "pass", "passed"].includes(String(status || "").trim().toLowerCase());
}

function renderPlanEditors(plans = []) {
  if (!plans.length) {
    els.planBox.className = "wz-list empty-line";
    els.planBox.textContent = "尚未生成 Seedance prompt";
    return;
  }
  els.planBox.className = "wz-list";
  els.planBox.innerHTML = plans.map((plan, index) => `
    <section class="wz-v2-plan-editor" data-plan-id="${plan.planId || ""}">
      <h3>Prompt ${index + 1}${plan.branchLabel ? ` · ${plan.branchLabel}` : ""}</h3>
      <label>Hook <textarea data-plan-field="hook" class="wz-json-box compact">${plan.hook || ""}</textarea></label>
      <label>口播 <textarea data-plan-field="voiceover" class="wz-json-box compact">${plan.voiceover || ""}</textarea></label>
      <label>Seedance Prompt <textarea data-plan-field="seedancePrompt" class="wz-json-box compact">${plan.seedancePrompt || ""}</textarea></label>
      <label>Negative Prompt <textarea data-plan-field="negativePrompt" class="wz-json-box compact">${plan.negativePrompt || ""}</textarea></label>
    </section>
  `).join("");
}

function hasGeneratedSeedancePlan(batch = state.batchDetail?.batch || state.batchDetail || {}) {
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const batchStatus = String(batch?.status || "").trim();
  return plans.length > 0
    || ["queued", "running", "stitching", "qc", "partial_failed", "succeeded", "failed", "stopped", "skipped"].includes(batchStatus)
    || ["running", "succeeded"].includes(state.planJob?.status);
}

function setPlanUpstreamLocked(locked) {
  document.body?.classList.toggle("wz-v2-plan-locked", Boolean(locked));
  for (const el of document.querySelectorAll(PLAN_UPSTREAM_LOCK_SELECTOR)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement)) continue;
    if (!el.dataset.wzPlanLockOriginal) {
      el.dataset.wzPlanLockOriginal = JSON.stringify({
        disabled: el.disabled,
        readOnly: "readOnly" in el ? el.readOnly : false
      });
    }
    if (locked) {
      if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el.type === "file" || el.type === "checkbox") {
        el.disabled = true;
      } else if ("readOnly" in el) {
        el.readOnly = true;
      }
      continue;
    }
    const original = JSON.parse(el.dataset.wzPlanLockOriginal || "{}");
    el.disabled = Boolean(original.disabled);
    if ("readOnly" in el) el.readOnly = Boolean(original.readOnly);
    delete el.dataset.wzPlanLockOriginal;
  }
}

function collectEditablePlans() {
  const batch = state.batchDetail?.batch || state.batchDetail || {};
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  return plans.map((plan) => {
    const editor = els.planBox?.querySelector(`[data-plan-id="${CSS.escape(plan.planId || "")}"]`);
    const read = (field) => editor?.querySelector(`[data-plan-field="${field}"]`)?.value.trim();
    return {
      ...plan,
      hook: read("hook") ?? plan.hook,
      voiceover: read("voiceover") ?? plan.voiceover,
      seedancePrompt: read("seedancePrompt") ?? plan.seedancePrompt,
      negativePrompt: read("negativePrompt") ?? plan.negativePrompt
    };
  });
}

async function uploadReferenceVideo() {
  const file = els.referenceFile?.files?.[0];
  if (!file) return;
  const localUrl = URL.createObjectURL(file);
  renderVideoPreview(localUrl);
  els.referenceUploadStatus.textContent = "正在上传并检查参考视频...";
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("fileName", file.name);
    form.append("mimeType", file.type || "application/octet-stream");
    const data = await api("/api/wangzhuan/reference-videos/check", {
      method: "POST",
      headers: {},
      body: form
    });
    state.referenceVideo = data.referenceVideo;
    resetDecompositionDraft({ clearForm: true });
    ensureBatchName();
    renderVideoPreview(state.referenceVideo.previewUrl || localUrl);
    els.referenceUploadStatus.textContent = "参考视频已上传";
    els.referenceBox.textContent = `${state.referenceVideo.referenceVideoId} · ${state.referenceVideo.durationSec || "-"}s · ${state.referenceVideo.ratio || "-"}`;
    els.draftDecompositionBtn.disabled = false;
    renderTasks();
    log("参考视频上传完成");
  } catch (error) {
    els.referenceUploadStatus.textContent = error.message || "参考视频上传失败";
    log(`参考视频上传失败：${error.message}`);
  }
}

function bindReferenceDropUpload() {
  const dropZone = $("#wzReferenceDropZone") || $("#wzReferenceUploadPanel");
  if (!dropZone || !els.referenceFile) return;
  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragover");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragover");
    });
  }
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    els.referenceFile.files = transfer.files;
    uploadReferenceVideo();
  });
  dropZone.addEventListener("click", (event) => {
    if (event.target?.closest?.("button, video, input, select, textarea, a")) return;
    els.referenceFile.click();
  });
  dropZone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    els.referenceFile.click();
  });
}

function validateAssetInputLimit(input, assetKey) {
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  if ((input?.files?.length || 0) <= limit) return true;
  showError({ message: `${input.closest(".wz-asset-slot")?.textContent?.trim() || assetKey} 最多上传 ${limit} 个文件` }, "素材数量超限");
  input.value = "";
  renderAssetReviewState();
  return false;
}

function renderDecompositionForm(decomposition = {}, { preserveUserInput = false } = {}) {
  const fields = ["scene", "subject", "action", "camera", "lighting", "style", "quality", "hook"];
  els.decompositionForm.hidden = false;
  els.decompositionForm.classList.remove("empty-line");
  if (!els.decompositionForm.dataset.ready) {
    els.decompositionForm.innerHTML = fields.map((field) => (
      `<label class="wz-field-label">${field}<textarea data-decomposition-field="${field}" class="wz-json-box compact" spellcheck="false"></textarea></label>`
    )).join("");
    els.decompositionForm.dataset.ready = "1";
  }
  for (const field of fields) {
    const input = els.decompositionForm.querySelector(`[data-decomposition-field="${field}"]`);
    if (!input) continue;
    if (preserveUserInput && state.decompositionEditedFields.has(field) && input.value.trim()) continue;
    input.value = decomposition[field] || "";
  }
}

function resetDecompositionDraft({ clearForm = false } = {}) {
  state.decompositionJob = null;
  state.decompositionDraft = null;
  state.decompositionEditedFields.clear();
  if (clearForm) {
    els.decompositionForm.hidden = true;
    els.decompositionForm.classList.add("empty-line");
    els.decompositionForm.innerHTML = "";
    delete els.decompositionForm.dataset.ready;
  }
}

function collectDecompositionForm() {
  const fields = ["scene", "subject", "action", "camera", "lighting", "style", "quality", "hook"];
  const decomposition = {};
  for (const field of fields) {
    const input = els.decompositionForm?.querySelector(`[data-decomposition-field="${field}"]`);
    decomposition[field] = value(input);
  }
  return decomposition;
}

function currentDecomposition() {
  const collected = collectDecompositionForm();
  const hasFormValue = Object.values(collected).some((item) => String(item || "").trim());
  const source = hasFormValue ? collected : state.decompositionDraft;
  if (!source) return null;
  return {
    ...(state.decompositionDraft || {}),
    ...source,
    referenceVideoId: source.referenceVideoId || state.decompositionDraft?.referenceVideoId || state.referenceVideo?.referenceVideoId,
    schemaVersion: source.schemaVersion || state.decompositionDraft?.schemaVersion || "video_decomposition.v1"
  };
}

function countSeedanceReferenceAssets(branch = activeBranch()) {
  const keys = new Set([
    ...Object.keys(branch.assetFileNames || {}),
    ...Object.keys(branch.assetUrls || {})
  ]);
  const items = [];
  for (const key of keys) {
    const fileName = String(branch.assetFileNames?.[key] || "").trim();
    const url = String(branch.assetUrls?.[key] || "").trim();
    if (!fileName && !url) continue;
    items.push({
      assetKey: key,
      label: fileName || key
    });
  }
  return {
    count: items.length,
    items
  };
}

function assertSeedanceReferenceAssetLimit(branches = collectBranchDrafts()) {
  for (const branch of branches) {
    const summary = countSeedanceReferenceAssets(branch);
    if (summary.count <= 9) continue;
    throw new WangzhuanApiError({
      code: "validation_error",
      message: `Seedance 参考素材不能超过 9 个，请减少后重试（当前 ${summary.count} 个：${summary.items.map((item) => item.label).join(" / ")}）`,
      data: {
        branchId: branch.branchId || "",
        assetCount: summary.count,
        maxAssets: 9,
        assetKeys: summary.items.map((item) => item.assetKey)
      }
    }, 400);
  }
}

function planSignatureInput() {
  const region = value(els.targetRegion);
  const language = value(els.language);
  const branches = collectBranchDrafts();
  return {
    productName: value(els.productName),
    productLink: value(els.productLink),
    assets: branches.flatMap((branch) => Object.keys(branch.assetFileNames || {}).map((assetKey) => ({
      branchId: branch.branchId,
      assetKey,
      fileName: branch.assetFileNames?.[assetKey] || "",
      storageKey: branch.assetStorageKeys?.[assetKey] || "",
      storedPath: branch.assetStoredPaths?.[assetKey] || "",
      assetId: branch.assetReviews?.[assetKey]?.assetId || "",
      reviewStatus: branch.assetReviews?.[assetKey]?.status || ""
    })).filter((asset) => asset.fileName || asset.storageKey || asset.storedPath || asset.assetId || asset.reviewStatus)),
    targetChannel: value(els.targetChannel),
    targetRegion: region,
    targetRegions: [region],
    language,
    languages: [language],
    materialDirection: effectiveMaterialDirection(),
    materialDirectionCustom: value(els.materialDirectionCustom),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    truthRules: collectTruthRules(),
    currencySymbol: currencyValue(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    branches
  };
}

function estimateRequest() {
  const region = value(els.targetRegion);
  const language = value(els.language);
  const disclaimerFields = disclaimerRequestFields();
  const branches = collectBranchDrafts();
  return {
    batchName: value($("#wzBatchName")),
    projectName: value($("#wzProjectName")),
    referenceVideoId: state.referenceVideo?.referenceVideoId,
    targetChannel: value(els.targetChannel),
    targetRegion: region,
    targetRegions: [region],
    language,
    languages: [language],
    promiseLevel: value(els.promiseLevel),
    truthRules: collectTruthRules(),
    currencySymbol: currencyValue(),
    durationSec: Number(value(els.duration) || 15),
    variantCount: variantCountValue(),
    requestedConcurrency: Number(value(els.requestedConcurrency) || 1),
    outputRatio: value(els.outputRatio),
    seedanceModel: selectedSeedanceModel(),
    decomposition: currentDecomposition(),
    ...disclaimerFields,
    templateSnapshot: {
      draft: {
        displayName: value(els.displayName),
        productName: value(els.productName),
        productLink: value(els.productLink),
        targetChannels: [value(els.targetChannel) || "meta_ads"],
        targetRegions: [region],
        regions: [region],
        language,
        languages: [language],
        materialDirection: effectiveMaterialDirection(),
        materialDirectionCustom: value(els.materialDirectionCustom),
        voiceoverStyle: value(els.voiceoverStyle),
        promiseLevel: value(els.promiseLevel),
        truthRules: collectTruthRules(),
        currencySymbol: currencyValue(),
        cta: value(els.cta),
        ending: value(els.ending),
        variantPrompt: value(els.variantPrompt),
        customPrompt: value(els.customPrompt),
        negativePrompt: value(els.negativePrompt),
        defaultDurationSec: Number(value(els.duration) || 15),
        defaultOutputRatio: value(els.outputRatio) || "9:16",
        seedanceModel: selectedSeedanceModel(),
        ...disclaimerFields,
        branches
      }
    },
    branches
  };
}

function expectedMinutes() {
  return variantCountValue() * Number(value(els.requestedConcurrency) || 0) * 3;
}

function planLlmConfig() {
  return {
    provider: value(els.planLlmProvider),
    model: value(els.planLlmModel),
    endpoint: value(els.planLlmEndpoint),
    temperature: Number(value(els.planLlmTemperature) || 0.2)
  };
}

function syncMaterialDirectionCustom() {
  const isOther = value(els.materialDirection) === "other";
  const wrap = $("#wzMaterialDirectionCustomWrap");
  if (wrap) wrap.hidden = !isOther;
}

function renderTemplates() {
  if (!els.templateSelect) return;
  const options = [
    `<option value="">不选择模板，直接填写本次批次</option>`,
    ...state.templates.map((template) => `
      <option value="${template.versionId}">
        ${template.draft?.displayName || template.templateId} v${template.versionNumber}${template.isDefault ? " 默认" : ""}
      </option>
    `)
  ];
  els.templateSelect.innerHTML = options.join("");
  syncTemplateActions();
}

function syncTemplateActions() {
  if (els.deleteTemplateBtn) els.deleteTemplateBtn.disabled = !state.selectedTemplate?.templateId;
}

function applyTemplate(template) {
  const draft = template?.draft || {};
  state.selectedTemplate = template || null;
  const drafts = Array.isArray(draft.branches) && draft.branches.length ? draft.branches : [draft];
  state.branches = drafts.map((branch, index) => defaultBranchDraft(index, {
    ...branch,
    displayName: branch.displayName || draft.displayName || "",
    productName: branch.productName || draft.productName || "",
    productLink: branch.productLink || draft.productLink || "",
    currencySymbol: branch.currencySymbol || draft.currencySymbol || "$",
    targetChannel: branch.targetChannel || draft.targetChannels?.[0] || "meta_ads",
    targetChannels: branch.targetChannels || draft.targetChannels || [branch.targetChannel || "meta_ads"],
    targetRegion: branch.targetRegion || draft.targetRegions?.[0] || draft.regions?.[0] || "US",
    targetRegions: branch.targetRegions || draft.targetRegions || draft.regions || [branch.targetRegion || "US"],
    regions: branch.regions || draft.regions || draft.targetRegions || [branch.targetRegion || "US"],
    language: branch.language || draft.language || draft.languages?.[0] || "en-US",
    languages: branch.languages || draft.languages || [branch.language || "en-US"],
    defaultDurationSec: branch.defaultDurationSec || draft.defaultDurationSec || 15,
    defaultOutputRatio: branch.defaultOutputRatio || draft.defaultOutputRatio || "9:16",
    promiseLevel: branch.promiseLevel || draft.promiseLevel || "stable",
    truthRules: branch.truthRules || draft.truthRules || {},
    materialDirection: branch.materialDirection || draft.materialDirection || "other",
    materialDirectionCustom: branch.materialDirectionCustom || draft.materialDirectionCustom || "跟随竞品",
    voiceoverStyle: branch.voiceoverStyle || draft.voiceoverStyle || "遵循竞品",
    variantPrompt: branch.variantPrompt || draft.variantPrompt || "",
    customPrompt: branch.customPrompt || draft.customPrompt || "",
    negativePrompt: branch.negativePrompt || draft.negativePrompt || "",
    disclaimer: branch.disclaimer ?? draft.disclaimer,
    disclaimerEnabled: branch.disclaimerEnabled ?? draft.disclaimerEnabled,
    disclaimerPreset: branch.disclaimerPreset || draft.disclaimerPreset || draft.disclaimerPresetId,
    disclaimerPresetId: branch.disclaimerPresetId || draft.disclaimerPresetId,
    disclaimerLanguage: branch.disclaimerLanguage || draft.disclaimerLanguage,
    disclaimerByLanguage: branch.disclaimerByLanguage || draft.disclaimerByLanguage,
    disclaimerOverlay: branch.disclaimerOverlay || draft.disclaimerOverlay
  }));
  state.activeBranchIndex = 0;
  activeBranch();
  loadBranchToForm(state.branchDraft);
  els.duration.value = String(draft.defaultDurationSec || 15);
  els.outputRatio.value = draft.defaultOutputRatio || "9:16";
  if ($("#wzModelSelect")) $("#wzModelSelect").value = draft.seedanceModel || selectedSeedanceModel();
  syncSeedanceModel();
  renderBranchTabs();
  syncTemplateActions();
  markPlanMaybeStale();
}

async function loadTemplates() {
  const data = await api("/api/wangzhuan/templates");
  state.templates = data.templates || [];
  renderTemplates();
}

async function loadAuth() {
  const response = await fetch("/api/auth");
  const data = await response.json();
  if (data.authenticated) {
    els.badge.textContent = data.user?.displayName || data.user?.username || "已登录";
    els.logoutBtn.hidden = false;
    hideLogin();
    return true;
  } else {
    els.badge.textContent = "未登录";
    els.logoutBtn.hidden = true;
    showLogin();
    return false;
  }
}

function renderTasks() {
  const batch = state.batchDetail?.batch || state.batchDetail || null;
  const tasksInBatch = Array.isArray(batch?.tasks) ? batch.tasks : [];
  const outputsInBatch = Array.isArray(batch?.outputs) ? batch.outputs : [];
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const decompositionReady = Boolean(currentDecomposition());
  const doneStatuses = new Set(["downloaded", "qc", "succeeded", "failed", "skipped", "stopped"]);
  const doneCount = tasksInBatch.filter((task) => doneStatuses.has(task.status)).length;
  const generationProgress = tasksInBatch.length ? Math.round((doneCount / tasksInBatch.length) * 100) : 0;
  const tasks = [
    {
      title: "AI 拆解视频",
      status: state.decompositionJob?.status || (state.decompositionDraft ? "succeeded" : "idle"),
      progress: state.decompositionJob?.progress || (state.decompositionDraft ? 100 : 0),
      message: state.decompositionJob?.message || "等待参考视频"
    },
    {
      title: "Seedance prompt",
      status: state.stalePlanPreview ? "stale" : (state.planJob?.status || (plans.length ? "succeeded" : "idle")),
      progress: state.planJob?.progress || (plans.length ? 100 : 0),
      message: state.stalePlanPreview ? "Seedance prompt 已失效，请重新生成" : (state.planJob?.message || "等待生成")
    },
    {
      title: "视频生成和质检",
      status: state.confirmPlanSubmitting ? "submitting" : (batch?.status || "idle"),
      progress: generationProgress,
      message: state.confirmPlanSubmitting
        ? "正在确认 prompt 并提交 Seedance"
        : (tasksInBatch.length ? `${doneCount}/${tasksInBatch.length} 个子任务` : "沿用现有批次链路")
    }
  ];
  els.taskQueue.innerHTML = tasks.map((task) => `
    <div class="wz-v2-task" data-status="${task.status}">
      <strong>${task.title}</strong>
      <span>${task.status} · ${task.message}</span>
      <div class="wz-v2-progress"><i style="--progress:${task.progress || 0}%"></i></div>
    </div>
  `).join("");
  els.planStaleNotice.hidden = !state.stalePlanPreview;
  const planUpstreamLocked = hasGeneratedSeedancePlan(batch);
  setPlanUpstreamLocked(planUpstreamLocked);
  const planRetryable = isRecoverableBackgroundJob(state.planJob);
  const planBlockedByRewrite = !state.rewriteConfirmed;
  const planBlockedByDecomposition = !decompositionReady;
  const planDisabled = planRetryable
    ? false
    : (planUpstreamLocked || state.stalePlanPreview || planBlockedByRewrite || planBlockedByDecomposition);
  els.planBatchBtn.disabled = planDisabled;
  if (planRetryable) {
    els.planBatchBtn.title = "后台任务可能仍在运行，可重试查询 prompt 结果";
  } else if (state.stalePlanPreview) {
    els.planBatchBtn.title = "Seedance prompt 已失效，请重新生成";
  } else if (planUpstreamLocked) {
    els.planBatchBtn.title = "当前批次已有 Seedance prompt，请先确认或重开任务";
  } else if (planBlockedByRewrite && planBlockedByDecomposition) {
    els.planBatchBtn.title = "请先确认产品/投放信息，并等待视频拆解完成或手动填写脚本拆解";
  } else if (planBlockedByRewrite) {
    els.planBatchBtn.title = "请先确认产品/投放信息";
  } else if (planBlockedByDecomposition) {
    els.planBatchBtn.title = "视频拆解进行中；拆解完成或手动填写脚本拆解后，可直接生成 Seedance prompt";
  } else {
    els.planBatchBtn.title = "";
  }
  els.confirmPlanBtn.disabled = state.confirmPlanSubmitting || !plans.length || state.stalePlanPreview;
  els.stopBatchBtn.disabled = !batch?.batchId || ["succeeded", "failed", "partial_failed", "stopped", "skipped"].includes(batch.status);
  els.runQcBtn.disabled = !batch?.batchId || !isBatchQcRunnable(batch, tasksInBatch, outputsInBatch);
  if (isRecoverableBackgroundJob(state.decompositionJob)) {
    els.draftDecompositionBtn.disabled = false;
  }
  els.runStatusBox.textContent = batch?.batchId
    ? `${batch.batchId} · ${batch.status || "-"} · ${tasksInBatch.length ? `${doneCount}/${tasksInBatch.length} 子任务` : "暂无子任务"}`
    : "尚未开始生成";
  els.longTaskStatus.textContent = tasks.map((task) => `${task.title}:${task.status}`).join(" · ");
  syncBackgroundJobActionButtons();
  renderReminders({ batch, plans });
}

function taskPrimaryId(item = {}) {
  return item.type === "remix" ? item.remixId : item.batchId;
}

function recentResultTitle(item = {}) {
  return item.productName || item.batchName || item.operationType || taskPrimaryId(item) || "未命名任务";
}

function renderRecentResults() {
  if (!els.recentResults) return;
  const items = state.recentResults || [];
  if (state.recentLoading) {
    els.recentResults.className = "wz-list empty-line";
    els.recentResults.textContent = "正在加载最近结果摘要...";
    return;
  }
  if (!items.length) {
    els.recentResults.className = "wz-list empty-line";
    els.recentResults.textContent = "暂无最近结果";
  } else {
    els.recentResults.className = "wz-list wz-v2-recent-list";
    els.recentResults.innerHTML = items.map((item) => {
      const id = taskPrimaryId(item);
      const type = item.type || "batch";
      return `
        <button type="button" class="wz-v2-recent-item" data-recent-type="${escapeHtml(type)}" data-recent-id="${escapeHtml(id)}">
          <span><b>${escapeHtml(recentResultTitle(item))}</b><small>${escapeHtml(id)}</small></span>
          <em>${escapeHtml(item.status || "-")}</em>
        </button>
      `;
    }).join("");
  }
  const pagination = state.recentPagination;
  if (!els.recentPager) return;
  if (!pagination?.total || pagination.totalPages <= 1) {
    els.recentPager.hidden = true;
    els.recentPager.textContent = "";
    return;
  }
  els.recentPager.hidden = false;
  els.recentPager.innerHTML = `
    <button type="button" class="mini ghost" data-recent-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
    <span>${escapeHtml(pagination.page)} / ${escapeHtml(pagination.totalPages)}</span>
    <button type="button" class="mini ghost" data-recent-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
  `;
}

async function loadRecentResults(page = state.recentPage || 1) {
  state.recentLoading = true;
  renderRecentResults();
  try {
    const query = new URLSearchParams({
      scope: "all",
      runType: "pipeline",
      page: String(page),
      pageSize: String(RECENT_PAGE_SIZE)
    });
    const data = await api(`/api/wangzhuan/tasks?${query}`);
    state.recentResults = data.items || [];
    state.recentPagination = data.pagination || null;
    state.recentPage = state.recentPagination?.page || page;
  } finally {
    state.recentLoading = false;
    renderRecentResults();
  }
}

async function openRecentResult(type, id) {
  if (!id) return;
  if (type === "remix") {
    location.href = `/wangzhuan-tasks.html?remixId=${encodeURIComponent(id)}`;
    return;
  }
  const detail = await loadBatchDetail(id);
  restoreV2FromBatchDetail(detail);
  const batch = state.batchDetail?.batch || state.batchDetail || {};
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  els.runStatusBox.textContent = `${batch.batchId || id} · ${batch.status || "-"} · ${tasks.length} 子任务 · ${outputs.length} 输出`;
  log(`已加载最近结果摘要详情：${id}`);
}

function failBackgroundJob(type, message, data = {}) {
  const job = {
    id: data.jobId || "",
    type,
    status: "failed",
    progress: 100,
    message: "任务失败",
    error: {
      code: data.code || "job_failed",
      message: message || "任务失败",
      data
    },
    events: []
  };
  if (type === "decomposition") {
    state.decompositionJob = job;
    els.draftDecompositionBtn.disabled = false;
    els.decompositionStatus.textContent = `AI 拆解失败：${job.error.message}`;
  } else {
    state.planJob = job;
    els.planBatchBtn.disabled = false;
  }
  log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}失败：${job.error.message}`);
  renderTasks();
}

function backgroundJobRetryLabel(type) {
  return type === "decomposition" ? "重试查询拆解结果" : "重试查询 prompt 结果";
}

function isRecoverableBackgroundJob(job = null) {
  const code = String(job?.error?.code || "");
  return Boolean(job?.id) && (code === "job_poll_failed" || code === "job_poll_timeout");
}

function retryableJobMessage(type, detail = "") {
  const prefix = type === "decomposition" ? "AI 拆解结果查询失败" : "Seedance prompt 结果查询失败";
  const cleanDetail = String(detail || "").trim();
  return cleanDetail
    ? `${prefix}，后台任务可能仍在运行，可重试查询。原因：${cleanDetail}`
    : `${prefix}，后台任务可能仍在运行，可重试查询。`;
}

function taskFailureHint(task = {}) {
  const code = String(task.errorCode || "").trim();
  const message = String(task.errorMessage || "").trim();
  if (code === "continuity_reference_failed") {
    return message || "30s 第二段生成依赖第一段连续性参考，但参考帧未准备好或未审核通过";
  }
  if (code === "no_segments") {
    return message || "当前没有可用于拼接的分段视频";
  }
  return message;
}

function logTaskFailureDetails(batch = {}) {
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  for (const task of tasks) {
    if (task.status !== "failed") continue;
    const hint = taskFailureHint(task);
    if (!hint) continue;
    const taskId = String(task.generationTaskId || task.taskUid || "unknown");
    const fingerprint = `${taskId}:${task.errorCode || ""}:${hint}`;
    if (state.loggedTaskFailures.has(fingerprint)) continue;
    state.loggedTaskFailures.add(fingerprint);
    log(`子任务失败：${taskId} · ${hint}`);
  }
}

function markBackgroundJobPollFailure(type, message, data = {}) {
  const recoverableMessage = retryableJobMessage(type, message);
  const job = {
    id: data.jobId || "",
    type,
    status: "running",
    progress: type === "decomposition" ? 30 : 90,
    message: recoverableMessage,
    error: {
      code: data.code || "job_poll_failed",
      message: message || "请求失败",
      recoverable: true,
      data
    },
    result: null,
    events: []
  };
  if (type === "decomposition") {
    state.decompositionJob = job;
    els.draftDecompositionBtn.disabled = false;
    els.decompositionStatus.textContent = recoverableMessage;
  } else {
    state.planJob = job;
    els.planBatchBtn.disabled = false;
  }
  log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}查询中断：${recoverableMessage}`);
  renderTasks();
}

function markBackgroundJobTimeout(type, message, data = {}) {
  const job = {
    id: data.jobId || "",
    type,
    status: "running",
    progress: type === "decomposition" ? 30 : 90,
    message: message || "后台任务仍在运行",
    error: {
      code: data.code || "job_poll_timeout",
      message: message || "后台任务仍在运行",
      recoverable: true,
      data
    },
    result: null,
    events: []
  };
  if (type === "decomposition") {
    state.decompositionJob = job;
    els.draftDecompositionBtn.disabled = false;
    els.decompositionStatus.textContent = message || "AI 拆解耗时较长，后台仍在运行，可稍后刷新继续查看。";
  } else {
    state.planJob = job;
    els.planBatchBtn.disabled = false;
  }
  log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}仍在后台运行：${message}`);
  renderTasks();
}

function syncBackgroundJobActionButtons() {
  const planRetryable = isRecoverableBackgroundJob(state.planJob);
  const decompositionRetryable = isRecoverableBackgroundJob(state.decompositionJob);
  if (els.planBatchBtn) {
    els.planBatchBtn.textContent = planRetryable ? backgroundJobRetryLabel("plan") : "生成 Seedance prompt";
  }
  if (els.draftDecompositionBtn) {
    els.draftDecompositionBtn.textContent = decompositionRetryable ? backgroundJobRetryLabel("decomposition") : "开始解析";
  }
}

function retryBackgroundJobPoll(type) {
  const job = type === "decomposition" ? state.decompositionJob : state.planJob;
  if (!isRecoverableBackgroundJob(job)) return false;
  if (type === "decomposition") {
    const model = job.model || selectedDecompositionModel();
    job.message = "正在重新查询拆解结果";
    job.error = null;
    els.decompositionStatus.textContent = "正在重新查询拆解结果";
    renderTasks();
    pollJob("decomposition", job.id, {
      timeoutMs: decompositionJobTimeoutWindowMs(model),
      timeoutLabel: isGeminiDecompositionModel(model)
        ? "Gemini 拆解耗时较长，后台仍在运行，可稍后刷新继续查看。"
        : `任务超过 ${Math.round(decompositionJobTimeoutWindowMs(model) / 1000)} 秒仍未返回，后台可能仍在运行，请稍后刷新或重新提交拆解`
    });
    return true;
  }
  job.message = "正在重新查询 prompt 结果";
  job.error = null;
  renderTasks();
  pollJob("plan", job.id);
  return true;
}

async function restoreBackgroundJobFromRequest(restoreRequest) {
  const jobType = String(restoreRequest?.jobType || "").trim();
  const jobId = String(restoreRequest?.jobId || "").trim();
  if (!jobType || !jobId) return false;
  if (jobType === "decomposition") {
    state.decompositionJob = {
      id: jobId,
      type: "decomposition",
      status: "running",
      progress: 30,
      message: "正在重新查询拆解结果",
      error: {
        code: "job_poll_failed",
        message: "任务管理页发起重新查询",
        recoverable: true,
        data: {}
      },
      events: []
    };
    els.decompositionStatus.textContent = "正在重新查询拆解结果";
    renderTasks();
    retryBackgroundJobPoll("decomposition");
    return true;
  }
  if (jobType === "plan") {
    state.planJob = {
      id: jobId,
      type: "plan",
      status: "running",
      progress: 90,
      message: "正在重新查询 prompt 结果",
      error: {
        code: "job_poll_failed",
        message: "任务管理页发起重新查询",
        recoverable: true,
        data: {}
      },
      events: []
    };
    renderTasks();
    retryBackgroundJobPoll("plan");
    return true;
  }
  return false;
}

function renderReminders({ batch, plans } = {}) {
  const items = [];
  if (!state.referenceVideo) items.push("先上传参考视频");
  if (state.referenceVideo && !state.decompositionDraft) items.push("参考视频已上传，待 AI 拆解或手动填写脚本");
  if (!state.rewriteConfirmed) items.push("第 3 步产品/投放信息尚未确认");
  if (state.rewriteConfirmed && !currentDecomposition()) items.push("产品信息已确认，等待视频拆解完成后可直接生成 Seedance prompt");
  if (!state.estimate) items.push("尚未生成 Seedance prompt");
  if (state.estimate?.confirmationRequired && !els.confirmLimits?.checked) items.push("本批任务较多，需要确认数量和消耗");
  if (state.stalePlanPreview) items.push("Seedance prompt 已失效，需要重新生成");
  const failedAssets = state.branches.flatMap((branch) => Object.entries(branch.assetReviews || {})
    .filter(([, review]) => review?.status && !isAssetReviewApproved(review.status))
    .map(([key, review]) => `${branch.branchLabel || branch.branchId}/${key}:${review.status}${review.reviewReason ? ` ${review.reviewReason}` : ""}`));
  if (failedAssets.length) items.push(`素材审核未通过：${failedAssets.join("；")}`);
  if (plans?.length && !batch?.tasks?.length) items.push("Seedance prompt 已生成，待确认并提交 Seedance");
  els.reminders.textContent = items.length ? items.join(" / ") : "当前无阻塞项";
}

async function uploadSeedanceAssetsForReview() {
  if (els.uploadSeedanceAssetsBtn) els.uploadSeedanceAssetsBtn.disabled = true;
  try {
    const branch = activeBranch();
    for (const [assetKey, selector] of assetInputs) {
      const input = $(selector);
      const files = assetInputFiles(input, assetKey);
      if (!files.length) continue;
      const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
      if ((input?.files?.length || 0) > limit) {
        showError({ message: `${input.closest(".wz-asset-slot")?.textContent?.trim() || assetKey} 最多上传 ${limit} 个文件` }, "素材上传失败");
        continue;
      }
      for (const [index, file] of files.entries()) {
        const entryKey = assetEntryKey(assetKey, index);
        if (branch.assetFileNames?.[entryKey] === file.name && branch.assetStorageKeys?.[entryKey]) continue;
        const content = await fileToDataUrl(file);
        const data = await api("/api/wangzhuan/product-assets/upload", {
          method: "POST",
          body: JSON.stringify({
            branchId: branch.branchId,
            assetKey: entryKey,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            content
          })
        });
        const asset = data.asset || {};
        updateBranchAsset(entryKey, asset);
        log(`${entryKey} 已上传并完成审核状态记录`);
      }
      pruneBranchAssetsForInput(assetKey, files.map((_, index) => assetEntryKey(assetKey, index)));
      const firstKey = assetEntryKey(assetKey, 0);
      input.dataset.uploadedFileName = branch.assetFileNames?.[firstKey] || "";
      input.dataset.storageUrl = branch.assetUrls?.[firstKey] || "";
      input.dataset.storageKey = branch.assetStorageKeys?.[firstKey] || "";
      input.dataset.storedPath = branch.assetStoredPaths?.[firstKey] || "";
      input.dataset.assetId = branch.assetReviews?.[firstKey]?.assetId || "";
      input.dataset.reviewStatus = branch.assetReviews?.[firstKey]?.status || "";
      input.dataset.reviewReason = branch.assetReviews?.[firstKey]?.reviewReason || "";
      renderAssetReviewState();
    }
    state.stalePlanPreview = Boolean(state.draftSignature && state.batchDetail);
    renderTasks();
  } finally {
    if (els.uploadSeedanceAssetsBtn) els.uploadSeedanceAssetsBtn.disabled = false;
  }
}

async function uploadDisclaimerOverlayAsset() {
  const input = $("#wzDisclaimerOverlayFile");
  const file = input?.files?.[0];
  if (!file) return;
  if (file.type && file.type !== "image/png") {
    showError({ message: "免责声明贴片只支持 PNG" }, "贴片上传失败");
    input.value = "";
    return;
  }
  const content = await fileToDataUrl(file);
  const data = await api("/api/wangzhuan/disclaimer-overlays/upload", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || "image/png",
      content
    })
  });
  state.disclaimerOverlayAsset = data.asset || null;
  renderDisclaimerOverlayPreview();
  renderTasks();
  log("免责声明贴片 PNG 已上传");
  await markPlanMaybeStale();
}

async function confirmRewriteInfo() {
  clearError();
  if (!value(els.productName)) {
    showError({ message: "请先填写产品名" }, "产品信息确认失败");
    return;
  }
  setBusy(els.confirmRewriteBtn, true, "确认中");
  try {
    await uploadSeedanceAssetsForReview();
    await saveDraftBatch("rewrite_confirmed");
    state.rewriteConfirmed = true;
    if (currentDecomposition()) {
      log("产品/投放信息已确认");
    } else {
      log("产品/投放信息已确认，视频拆解尚未完成；拆解完成后可直接生成 Seedance prompt");
    }
    renderTasks();
  } catch (error) {
    showError(error, "产品信息确认失败");
  } finally {
    setBusy(els.confirmRewriteBtn, false);
  }
}

async function saveTemplate() {
  clearError();
  if (!value(els.productName)) {
    showError({ message: "请先填写产品名" }, "模板保存失败");
    return;
  }
  setBusy(els.createTemplateBtn, true, "保存中");
  try {
    await uploadSeedanceAssetsForReview();
    const data = await api("/api/wangzhuan/templates", {
      method: "POST",
      body: JSON.stringify({
        mode: state.selectedTemplate ? "edit_new_version" : "create",
        ...(state.selectedTemplate ? { templateId: state.selectedTemplate.templateId } : {}),
        draft: currentDraft()
      })
    });
    await loadTemplates();
    if (data.template) {
      state.selectedTemplate = data.template;
      els.templateSelect.value = data.template.versionId;
      applyTemplate(data.template);
    }
    log("模板已保存");
  } catch (error) {
    showError(error, "模板保存失败");
  } finally {
    setBusy(els.createTemplateBtn, false);
  }
}

async function deleteSelectedTemplate() {
  clearError();
  if (!state.selectedTemplate?.templateId || !state.selectedTemplate?.versionId) return;
  setBusy(els.deleteTemplateBtn, true, "删除中");
  try {
    await api("/api/wangzhuan/templates/admin", {
      method: "POST",
      body: JSON.stringify({
        action: "delete",
        templateId: state.selectedTemplate.templateId,
        versionId: state.selectedTemplate.versionId
      })
    });
    state.selectedTemplate = null;
    await loadTemplates();
    if (els.templateSelect) els.templateSelect.value = "";
    syncTemplateActions();
    log("模板已删除");
  } catch (error) {
    showError(error, "模板删除失败");
  } finally {
    setBusy(els.deleteTemplateBtn, false);
  }
}

async function saveDraft(sourceStep = "wzv2_manual_draft") {
  return saveDraftBatch(sourceStep);
}

async function saveDraftBatch(sourceStep = "wzv2_manual_draft") {
  if (!state.referenceVideo?.referenceVideoId) {
    throw new WangzhuanApiError({
      code: "validation_error",
      message: "请先上传参考视频",
      data: { field: "referenceVideo.referenceVideoId" }
    }, 400);
  }
  const data = await api("/api/wangzhuan/batches/draft", {
    method: "POST",
    body: JSON.stringify({
      sourceStep,
      batchId: currentBatchId() || undefined,
      userBatchName: value($("#wzBatchName")),
      batchName: value($("#wzBatchName")),
      referenceVideoId: state.referenceVideo?.referenceVideoId || "",
      referenceVideo: state.referenceVideo,
      templateSnapshot: { draft: estimateRequest().templateSnapshot.draft },
      branches: estimateRequest().branches,
      branchDrafts: estimateRequest().branches,
      decomposition: currentDecomposition()
    })
  });
  if (data.batch) state.batchDetail = data;
  log("草稿已保存");
  renderTasks();
  return data;
}

async function confirmSeedanceAssetReviews() {
  const batch = state.batchDetail?.batch || state.batchDetail;
  if (!batch?.batchId) {
    await saveDraftBatch("seedance_assets_review_pending");
  }
  const nextBatch = state.batchDetail?.batch || state.batchDetail;
  if (!nextBatch?.batchId) return;
  const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(nextBatch.batchId)}/confirm-assets`, {
    method: "POST",
    body: JSON.stringify({ branchDrafts: estimateRequest().branches })
  });
  state.batchDetail = data.batch ? { ...state.batchDetail, batch: data.batch } : state.batchDetail;
  if (Array.isArray(data.branches) && data.branches.length) {
    const byId = new Map(data.branches.map((branch) => [branch.branchId, branch]));
    state.branches = state.branches.map((branch, index) => {
      const next = byId.get(branch.branchId);
      return next ? defaultBranchDraft(index, { ...branch, ...next }) : branch;
    });
    activeBranch();
    renderAssetReviewState();
  }
  log("Seedance 素材审核结果已确认");
  renderTasks();
}

async function startDecompositionJob() {
  if (retryBackgroundJobPoll("decomposition")) return;
  if (!state.referenceVideo?.referenceVideoId) return;
  const model = selectedDecompositionModel();
  const timeoutMs = decompositionTimeoutMs(model);
  const maxRetries = decompositionMaxRetries(model);
  state.decompositionEditedFields.clear();
  els.draftDecompositionBtn.disabled = true;
  els.decompositionStatus.textContent = isGeminiDecompositionModel(model)
    ? "AI 拆解已进入后台任务。Gemini 视频拆解可能持续数分钟，请继续填写第 3 步。"
    : "AI 拆解已进入后台任务，继续填写第 3 步。";
  const job = await api("/api/wangzhuan/reference-videos/decomposition-jobs", {
    method: "POST",
    body: JSON.stringify({
      referenceVideoId: state.referenceVideo.referenceVideoId,
      knowledgeNotes: value($("#wzKnowledgeNotes")),
      llmConfig: {
        provider: value($("#wzLlmProvider")),
        model,
        endpoint: value($("#wzLlmEndpoint")),
        temperature: Number(value($("#wzLlmTemperature")) || 0.2),
        timeoutMs,
        maxRetries
      }
    })
  });
  job.model = model;
  job.timeoutMs = timeoutMs;
  job.maxRetries = maxRetries;
  state.decompositionJob = job;
  log("AI 拆解任务已提交");
  renderTasks();
  pollJob("decomposition", job.decompositionJobId, {
    timeoutMs: decompositionJobTimeoutWindowMs(model),
    timeoutLabel: isGeminiDecompositionModel(model)
      ? "Gemini 拆解耗时较长，后台仍在运行，可稍后刷新继续查看。"
      : `任务超过 ${Math.round(decompositionJobTimeoutWindowMs(model) / 1000)} 秒仍未返回，后台可能仍在运行，请稍后刷新或重新提交拆解`
  });
}

async function startPlanJob() {
  if (retryBackgroundJobPoll("plan")) return;
  els.planBatchBtn.disabled = true;
  assertSeedanceReferenceAssetLimit();
  const estimateResult = state.estimate?.estimateId ? state.estimate : await estimateBatch();
  if (!estimateResult?.estimateId) {
    renderTasks();
    return;
  }
  const payload = {
    estimateId: estimateResult.estimateId,
    batchId: state.batchDetail?.batch?.batchId || state.batchDetail?.batchId,
    idempotencyKey: `wzv2-plan-${Date.now()}`,
    confirmationToken: estimateResult.confirmationToken,
    llmConfig: planLlmConfig(),
    knowledgeNotes: value($("#wzKnowledgeNotes")),
    draftSignatureInput: planSignatureInput()
  };
  const job = await api("/api/wangzhuan/batches/plan-jobs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  state.planJob = job;
  state.draftSignature = job.draftSignature;
  state.stalePlanPreview = false;
  log("Seedance prompt 任务已提交");
  setPlanUpstreamLocked(true);
  renderTasks();
  pollJob("plan", job.planJobId);
}

async function pollJob(type, jobId, options = {}) {
  const path = type === "decomposition"
    ? `/api/wangzhuan/reference-videos/decomposition-jobs/${encodeURIComponent(jobId)}`
    : `/api/wangzhuan/batches/plan-jobs/${encodeURIComponent(jobId)}`;
  const startedAt = Date.now();
  const maxWaitMs = type === "decomposition" ? (options.timeoutMs || decompositionJobTimeoutWindowMs()) : 0;
  const timer = setInterval(async () => {
    if (maxWaitMs && Date.now() - startedAt > maxWaitMs) {
      clearInterval(timer);
      markBackgroundJobTimeout(type, options.timeoutLabel || `任务超过 ${Math.round(maxWaitMs / 1000)} 秒仍未返回，后台可能仍在运行，请稍后刷新或重新提交拆解`, {
        code: "job_poll_timeout",
        jobId
      });
      return;
    }
    try {
      const job = await api(path);
      if (type === "decomposition") state.decompositionJob = job;
      if (type === "plan") state.planJob = job;
      if (job.status === "succeeded") {
        clearInterval(timer);
        if (type === "decomposition") {
          state.decompositionDraft = job.decomposition || {};
          renderDecompositionForm(state.decompositionDraft, { preserveUserInput: true });
          els.draftDecompositionBtn.disabled = hasGeneratedSeedancePlan();
          els.decompositionStatus.textContent = state.decompositionEditedFields.size
            ? "AI 结果可用，已回填未手动编辑字段，后续估算会直接读取当前表单；如需调整，可重新拆解。"
            : "AI 结果可用，已回填到页面，后续估算会直接读取当前表单；如需调整，可重新拆解。";
        } else {
          state.batchDetail = job.batch;
          state.draftSignature = job.draftSignature;
          renderPlanEditors(job.plans || []);
        }
        log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}完成`);
      }
      if (job.status === "failed") {
        clearInterval(timer);
        if (type === "plan") setPlanUpstreamLocked(false);
        failBackgroundJob(type, job.error?.message || "未知错误", {
          ...(job.error?.data || {}),
          code: job.error?.code || "job_failed",
          jobId
        });
        return;
      }
      renderTasks();
    } catch (error) {
      clearInterval(timer);
      markBackgroundJobPollFailure(type, error.message, {
        code: error.code || "job_poll_failed",
        jobId
      });
    }
  }, POLL_INTERVAL_MS);
}

async function loadBatchDetail(batchId) {
  if (!batchId) return null;
  const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  state.batchDetail = data;
  logTaskFailureDetails(data?.batch || data || {});
  renderTasks();
  return data;
}

function startBatchPolling(batchId) {
  window.clearTimeout(batchPollTimer);
  batchPollNetworkErrorActive = false;
  let lastStatus = "";
  const tick = async () => {
    try {
      const detail = await loadBatchDetail(batchId);
      if (batchPollNetworkErrorActive) {
        log("批次轮询已恢复");
        batchPollNetworkErrorActive = false;
      }
      const status = detail?.batch?.status;
      if (!TERMINAL_BATCH_STATUSES.has(status)) {
        batchPollTimer = window.setTimeout(tick, 2000);
      } else if (status && status !== lastStatus) {
        log(`批次已进入终态：${status}`);
      }
      lastStatus = status || lastStatus;
    } catch (error) {
      const isNetworkError = /failed to fetch|networkerror|load failed/i.test(String(error?.message || ""));
      if (isNetworkError) {
        if (!batchPollNetworkErrorActive) {
          log("批次轮询暂时断开，正在重连");
          batchPollNetworkErrorActive = true;
        }
      } else {
        log(`批次轮询失败：${error.message}`);
      }
      batchPollTimer = window.setTimeout(tick, 3000);
    }
  };
  batchPollTimer = window.setTimeout(tick, 1200);
}

async function restoreWorkbenchFromUrl() {
  const restoreRequest = readWorkbenchRestoreRequest();
  if (!restoreRequest?.id) return false;
  if (restoreRequest.type === "remix") {
    location.href = `/competitor-remix.html?restore=1&remixId=${encodeURIComponent(restoreRequest.id)}#remixNodeDelivery`;
    return true;
  }
  const detail = await loadBatchDetail(restoreRequest.id);
  const restored = restoreV2FromBatchDetail(detail);
  const batch = detail?.batch || detail || {};
  if (restored) {
    log(`已从任务管理恢复批次：${batch.batchId || restoreRequest.id}`);
    await restoreBackgroundJobFromRequest(restoreRequest);
    if (batch.batchId && !TERMINAL_BATCH_STATUSES.has(batch.status)) startBatchPolling(batch.batchId);
    if (location.hash) {
      requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: "start" }));
    }
  }
  return restored;
}

async function confirmPlanAndGenerate() {
  const batch = state.batchDetail?.batch || state.batchDetail;
  if (!batch?.batchId || state.stalePlanPreview || state.confirmPlanSubmitting) return;
  if (state.estimate?.confirmationRequired && !els.confirmLimits?.checked) {
    showError({ message: "请先确认本批次数量、时长和可能消耗" }, "确认 prompt 失败");
    return;
  }
  clearError();
  state.confirmPlanSubmitting = true;
  log("正在确认 prompt 并提交 Seedance...");
  setBusy(els.confirmPlanBtn, true, "提交中");
  renderTasks();
  const plans = collectEditablePlans();
  try {
    const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/confirm-plan`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `wzv2-confirm-${Date.now()}`,
        planIds: plans.map((plan) => plan.planId).filter(Boolean),
        confirmedPlanIds: plans.map((plan) => plan.planId).filter(Boolean),
        plans,
        branchDrafts: estimateRequest().branches,
        draftSignature: state.draftSignature,
        draftSignatureInput: planSignatureInput()
      })
    });
    state.batchDetail = data.batch ? data : { batch: data.confirmedBatch || batch };
    log("Seedance prompt 已确认，已提交 Seedance 生成");
    renderTasks();
    startBatchPolling(batch.batchId);
  } finally {
    state.confirmPlanSubmitting = false;
    setBusy(els.confirmPlanBtn, false);
    renderTasks();
  }
}

async function stopBatch() {
  const batch = state.batchDetail?.batch || state.batchDetail;
  if (!batch?.batchId) return;
  const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/stop`, {
    method: "POST",
    body: JSON.stringify({ reason: "wzv2_frontend_stop" })
  });
  state.batchDetail = data;
  window.clearTimeout(batchPollTimer);
  log("批次已停止");
  renderTasks();
}

async function runVideoQc() {
  const batch = state.batchDetail?.batch || state.batchDetail;
  if (!batch?.batchId) return;
  await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/qc`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await loadBatchDetail(batch.batchId);
  log("视频质检已执行");
}

function startNewTask() {
  window.clearTimeout(batchPollTimer);
  setPlanUpstreamLocked(false);
  state.referenceVideo = null;
  resetDecompositionDraft({ clearForm: true });
  state.estimate = null;
  state.planJob = null;
  state.batchDetail = null;
  state.rewriteConfirmed = false;
  state.activeBranchIndex = 0;
  state.branches = [defaultBranchDraft(0)];
  state.branchDraft = state.branches[0];
  state.draftSignature = "";
  state.stalePlanPreview = false;
  state.loggedTaskFailures = new Set();
  $("#wzBatchName").value = generatedBatchName();
  els.referenceFile.value = "";
  renderVideoPreview("");
  els.referenceBox.textContent = "未上传参考视频";
  els.referenceUploadStatus.textContent = "选中文件后自动上传、检查和预览。";
  els.draftDecompositionBtn.disabled = true;
  els.decompositionStatus.textContent = "上传参考视频后可启动后台拆解。";
  els.estimateBox.textContent = "估算结果：待估算。";
  renderPlanEditors([]);
  resetAssetInputDatasets();
  loadBranchToForm(state.branchDraft);
  renderBranchTabs();
  renderAssetReviewState();
  clearError();
  log("已开始新任务");
  renderTasks();
}

async function login() {
  setBusy(els.loginBtn, true, "登录中");
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: value(els.loginUsername), password: value(els.loginPassword) })
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "登录失败");
    await loadAuth();
    await loadTemplates().catch((error) => showError(error, "模板加载失败"));
  } catch (error) {
    const status = els.loginModal?.querySelector(".login-status");
    if (status) status.textContent = error.message || "登录失败";
  } finally {
    setBusy(els.loginBtn, false);
  }
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  await loadAuth();
}

async function estimateBatch() {
  clearError();
  const decomposition = currentDecomposition();
  if (!decomposition) {
    showError({ message: "请先完成 AI 拆解或手动填写脚本拆解" }, "生成 Seedance prompt 失败");
    return null;
  }
  if (!state.rewriteConfirmed) {
    showError({ message: "请先点击第 3 步「确认信息」" }, "生成 Seedance prompt 失败");
    return null;
  }
  assertSeedanceReferenceAssetLimit();
  await saveDraft("estimate");
  const request = estimateRequest();
  const data = await api("/api/wangzhuan/batches/estimate", {
    method: "POST",
    body: JSON.stringify(request)
  });
  state.estimate = data.estimate;
  els.estimateBox.textContent = `估算结果：${state.estimate.scriptCount || request.variantCount || 0} 条脚本 · ${state.estimate.seedanceSegmentCount || 0} 段 Seedance · ${request.branches.length} 个裂变子节点。预计时间：${expectedMinutes()} 分钟。`;
  els.planBatchBtn.disabled = false;
  renderTasks();
  log("估算完成");
  return state.estimate;
}

async function markPlanMaybeStale() {
  if (!state.draftSignature || !state.batchDetail) return;
  state.stalePlanPreview = state.draftSignature !== await clientPlanDraftSignature();
  renderTasks();
}

els.checkReferenceBtn?.addEventListener("click", () => els.referenceFile?.click());
els.referenceFile?.addEventListener("change", uploadReferenceVideo);
bindReferenceDropUpload();
els.decompositionForm?.addEventListener("input", (event) => {
  const field = event.target?.dataset?.decompositionField;
  if (field) state.decompositionEditedFields.add(field);
});
els.startNewTaskBtn?.addEventListener("click", startNewTask);
els.addBranchBtn?.addEventListener("click", addBranch);
els.removeBranchBtn?.addEventListener("click", removeActiveBranch);
els.branchTabs?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-branch-index]");
  if (!button) return;
  switchBranch(Number(button.dataset.branchIndex));
});
els.draftDecompositionBtn?.addEventListener("click", () => startDecompositionJob().catch((error) => showError(error, "AI 拆解提交失败")));
$("#wzLlmModel")?.addEventListener("change", syncGeminiDecompositionHint);
els.confirmRewriteBtn?.addEventListener("click", confirmRewriteInfo);
els.templateSelect?.addEventListener("change", () => {
  const selected = state.templates.find((template) => template.versionId === els.templateSelect.value);
  if (selected) applyTemplate(selected);
  else {
    state.selectedTemplate = null;
    syncTemplateActions();
  }
});
els.createTemplateBtn?.addEventListener("click", saveTemplate);
els.deleteTemplateBtn?.addEventListener("click", deleteSelectedTemplate);
$("#wzModelSelect")?.addEventListener("change", () => {
  syncSeedanceModel();
  markPlanMaybeStale();
});
els.materialDirection?.addEventListener("change", syncMaterialDirectionCustom);
els.promiseLevel?.addEventListener("change", syncTruthDetails);
els.currencySymbol?.addEventListener("change", syncCurrencyCustom);
els.truthFields?.addEventListener("input", markPlanMaybeStale);
els.truthFields?.addEventListener("change", markPlanMaybeStale);
$("#wzDisclaimerOverlayFile")?.addEventListener("change", () => uploadDisclaimerOverlayAsset().catch((error) => showError(error, "贴片上传失败")));
els.planBatchBtn?.addEventListener("click", () => startPlanJob().catch((error) => showError(error, "prompt 任务提交失败")));
els.confirmPlanBtn?.addEventListener("click", () => confirmPlanAndGenerate().catch((error) => showError(error, "确认 prompt 失败")));
els.stopBatchBtn?.addEventListener("click", () => stopBatch().catch((error) => showError(error, "停止失败")));
els.runQcBtn?.addEventListener("click", () => runVideoQc().catch((error) => showError(error, "视频质检失败")));
els.saveDraftBtn?.addEventListener("click", () => saveDraftBatch().catch((error) => showError(error, "草稿保存失败")));
els.uploadSeedanceAssetsBtn?.addEventListener("click", () => uploadSeedanceAssetsForReview().catch((error) => showError(error, "Seedance 素材上传失败")));
els.loadOlderLogsBtn?.addEventListener("click", loadOlderLogs);
els.refreshRecentBtn?.addEventListener("click", () => loadRecentResults(1).catch((error) => showError(error, "最近结果加载失败")));
for (const [assetKey, selector] of assetInputs) {
  $(selector)?.addEventListener("change", (event) => {
    if (!validateAssetInputLimit(event.target, assetKey)) return;
    const files = assetInputFiles(event.target, assetKey);
    pruneBranchAssetsForInput(assetKey, files.map((_, index) => assetEntryKey(assetKey, index)));
    renderAssetReviewState();
  });
}
els.recentResults?.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-recent-id]");
  if (!button) return;
  openRecentResult(button.dataset.recentType, button.dataset.recentId)
    .catch((error) => showError(error, "最近结果详情加载失败"));
});
els.recentPager?.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-recent-page]");
  if (!button || button.disabled) return;
  loadRecentResults(Number(button.dataset.recentPage) || 1)
    .catch((error) => showError(error, "最近结果加载失败"));
});
els.loginBtn?.addEventListener("click", login);
els.logoutBtn?.addEventListener("click", () => logout().catch((error) => showError(error, "退出失败")));

for (const el of [
  els.productName,
  els.productLink,
  els.targetChannel,
  els.targetRegion,
  els.language,
  els.materialDirection,
  els.materialDirectionCustom,
  els.voiceoverStyle,
  els.promiseLevel,
  els.currencySymbol,
  els.currencyCustom,
  els.cta,
  els.ending,
  els.variantPrompt,
  els.customPrompt,
  els.negativePrompt
]) {
  el?.addEventListener("change", markPlanMaybeStale);
  el?.addEventListener("input", markPlanMaybeStale);
}

for (const el of [
  $("#wzDisclaimerPreset"),
  $("#wzDisclaimerEnabled"),
  $("#wzDisclaimerOverlayPosition"),
  $("#wzDisclaimerOverlayBoxHeight"),
  $("#wzDisclaimerOverlayBottomMargin"),
  $("#wzDisclaimerOverlayHorizontalMargin")
]) {
  el?.addEventListener("change", () => {
    renderDisclaimerOverlayPreview();
    renderTasks();
    markPlanMaybeStale();
  });
  el?.addEventListener("input", () => {
    renderTasks();
    markPlanMaybeStale();
  });
}

for (const [, selector] of assetInputs) {
  const input = $(selector);
  input?.addEventListener("change", markPlanMaybeStale);
}

syncMaterialDirectionCustom();
syncCurrencyCustom();
syncTruthDetails();
syncGeminiDecompositionHint();
renderBranchTabs();
renderAssetReviewState();
renderPlanEditors([]);
renderDisclaimerOverlayPreview();
renderTasks();
renderLogs();
renderRecentResults();
renderTemplates();
loadAuth()
  .then(async (authenticated) => {
    if (!authenticated) return null;
    await loadTemplates();
    await Promise.all([
      loadRecentResults(1),
      restoreWorkbenchFromUrl()
    ]);
    return null;
  })
  .catch((error) => showError(error, "初始化失败"));
