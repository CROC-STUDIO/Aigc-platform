import { WangzhuanApiError, isBatchQcRunnable, readWorkbenchRestoreRequest, strongTruthFields, switchProjectScope } from "./wangzhuan-common.js";
import { branchHasReferenceAsset, pruneOrphanAssetReviews } from "./wangzhuan-branch-assets.js";
import { createSegmentRecoveryController, hasPendingSegmentRecovery } from "./wangzhuan-segment-recovery.js";

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
  "outputTemplateMode",
  "sliceStrategy",
  "targetSegmentCount",
  "moneyVisuals",
  "subtitleWorkflow",
  "decomposition",
  "branches",
  "voiceoverStyle",
  "promiseLevel",
  "truthRules",
  "currencySymbol",
  "cta",
  "ending",
  "variantPrompt",
  "customPrompt",
  "negativePrompt"
];
const signatureBranchFields = [
  "branchId",
  "branchIndex",
  "branchLabel",
  "displayName",
  "productName",
  "productLink",
  "targetChannel",
  "targetChannels",
  "targetRegion",
  "targetRegions",
  "regions",
  "language",
  "languages",
  "currencySymbol",
  "materialDirection",
  "materialDirectionCustom",
  "outputTemplateMode",
  "sliceStrategy",
  "targetSegmentCount",
  "moneyVisuals",
  "subtitleWorkflow",
  "voiceoverStyle",
  "promiseLevel",
  "truthRules",
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
  targetRegionCustom: $("#wzTargetRegionCustom"),
  language: $("#wzLanguage"),
  languageCustom: $("#wzLanguageCustom"),
  currencySymbol: $("#wzCurrencySymbol"),
  currencyCustom: $("#wzCurrencyCustom"),
  productName: $("#wzProductName"),
  productLink: $("#wzProductLink"),
  productLibrarySelect: $("#wzProductLibrarySelect"),
  applyProductLibraryBtn: $("#wzApplyProductLibraryBtn"),
  productLibraryDetail: $("#wzProductLibraryDetail"),
  materialDirection: $("#wzMaterialDirection"),
  materialDirectionCustom: $("#wzMaterialDirectionCustom"),
  outputTemplateMode: $("#wzOutputTemplateMode"),
  sliceStrategy: $("#wzSliceStrategy"),
  moneyVisuals: $("#wzMoneyVisuals"),
  subtitleWorkflow: $("#wzSubtitleWorkflow"),
  voiceoverStyle: $("#wzVoiceoverStyle"),
  promiseLevel: $("#wzPromiseLevel"),
  truthDetails: $("#wzTruthDetails"),
  truthFields: $("#wzTruthFields"),
  codexTestStoreLink: $("#wzCodexTestStoreLink"),
  cta: $("#wzCta"),
  ending: $("#wzEnding"),
  uploadSeedanceAssetsBtn: $("#wzUploadSeedanceAssetsBtn"),
  variantPrompt: $("#wzVariantPrompt"),
  customPrompt: $("#wzCustomPrompt"),
  negativePrompt: $("#wzNegativePrompt"),
  postProcessEndingFile: $("#wzPostProcessEndingFile"),
  postProcessSubtitles: $("#wzPostProcessSubtitles"),
  subtitleFontSizeRange: $("#wzSubtitleFontSizeRange"),
  subtitleFontSizeNumber: $("#wzSubtitleFontSizeNumber"),
  subtitleCenterYRange: $("#wzSubtitleCenterYRange"),
  subtitleCenterYNumber: $("#wzSubtitleCenterYNumber"),
  subtitleTextColor: $("#wzSubtitleTextColor"),
  postProcessEndingRemove: $("#wzPostProcessEndingRemove"),
  postProcessEndingPreview: $("#wzPostProcessEndingPreview"),
  expansionCustomWidth: $("#wzExpansionCustomWidth"),
  expansionCustomHeight: $("#wzExpansionCustomHeight"),
  expansionAddCustom: $("#wzExpansionAddCustom"),
  expansionSelectedSizes: $("#wzExpansionSelectedSizes"),
  estimateBox: $("#wzEstimateBox"),
  confirmLimits: $("#wzConfirmLimits"),
  planLlmProvider: $("#wzPlanLlmProvider"),
  planLlmModel: $("#wzPlanLlmModel"),
  planLlmEndpoint: $("#wzPlanLlmEndpoint"),
  planLlmTemperature: $("#wzPlanLlmTemperature"),
  codexPromptTestBtn: $("#wzCodexPromptTestBtn"),
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
  segmentRecovery: $("#wzSegmentRecovery"),
  segmentRecoveryState: $("#wzSegmentRecoveryState"),
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
  referenceVideoCheckJob: null,
  decompositionJob: null,
  decompositionDraft: null,
  estimate: null,
  planJob: null,
  codexPromptTestJob: null,
  codexPromptTestResult: null,
  batchDetail: null,
  currentUserId: "",
  templates: [],
  selectedTemplate: null,
  rewriteConfirmed: false,
  activeBranchIndex: 0,
  branches: [{ branchId: "branch_1", branchIndex: 1, branchLabel: "改写 3.1", assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetContentHashes: {}, assetReviews: {} }],
  branchDraft: { branchId: "branch_1", branchIndex: 1, branchLabel: "改写 3.1", assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetContentHashes: {}, assetReviews: {} },
  draftSignature: "",
  stalePlanPreview: false,
  decompositionEditedFields: new Set(),
  visibleLogs: [],
  archivedLogs: [],
  recentResults: [],
  recentPagination: null,
  recentPage: 1,
  recentLoading: false,
  productLibraryItems: [],
  productLibraryDetails: new Map(),
  productLibraryLoading: false,
  pendingAssetFiles: new Map(),
  disclaimerOverlayAsset: null,
  postProcessEndingAsset: null,
  expansionSizes: [],
  confirmPlanSubmitting: false,
  loggedTaskFailures: new Set()
};

let batchPollTimer = 0;
let batchPollOwner = 0;
let batchDetailLoadOwner = 0;
let batchPollNetworkErrorActive = false;
const DECOMPOSITION_LLM_TIMEOUT_MS = 180_000;
const GEMINI_DECOMPOSITION_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1500;
const POLL_RETRY_BASE_MS = 2_000;
const POLL_RETRY_MAX_MS = 10_000;
// 软超时：过了预期窗口不停止轮询，只降频继续查，直到后端真正返回终态。
const SLOW_POLL_INTERVAL_MS = 5_000;
const VISIBLE_LOG_LIMIT = 50;
const OLDER_LOG_PAGE_SIZE = 50;
const RECENT_PAGE_SIZE = 5;
const DEFAULT_SEEDANCE_MODEL = "dreamina-seedance-2-0-fast-260128";
const AUTO_OUTPUT_TEMPLATE_MODE = "reference_fission";
const AUTO_SLICE_STRATEGY = "auto_10_15s_multi_slice";
const FOLLOW_DECOMPOSITION_SEGMENT_COUNT = "follow_decomposition";
const DEFAULT_MONEY_VISUALS = ["cash", "coin_burst", "cash_rain", "reward_number_growth", "withdrawal_success", "arrival_animation", "withdrawal_record"];
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
  "#wzProductLibrarySelect",
  "#wzApplyProductLibraryBtn",
  "#wzCreateTemplateBtn",
  "#wzAddBranchBtn",
  "#wzRemoveBranchBtn",
  "#wzTargetChannel",
  "#wzTargetRegion",
  "#wzLanguage",
  "#wzMaterialDirection",
  "#wzMaterialDirectionCustom",
  "#wzOutputTemplateMode",
  "#wzSliceStrategy",
  "#wzMoneyVisuals",
  "#wzSubtitleWorkflow",
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
  "#wzSubtitleFontSizeRange",
  "#wzSubtitleFontSizeNumber",
  "#wzSubtitleCenterYRange",
  "#wzSubtitleCenterYNumber",
  "#wzSubtitleTextColor",
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

function selectedValues(select) {
  return Array.from(select?.selectedOptions || []).map((option) => option.value).filter(Boolean);
}

function setSelectedValues(select, values = []) {
  if (!select) return;
  const set = new Set(Array.isArray(values) ? values : []);
  for (const option of Array.from(select.options || [])) {
    option.selected = set.has(option.value);
  }
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

function regionValue() {
  return value(els.targetRegion) === "custom" ? value(els.targetRegionCustom) : value(els.targetRegion);
}

function languageValue() {
  return value(els.language) === "custom" ? value(els.languageCustom) : value(els.language);
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

function setRegionValue(region = "US") {
  const clean = String(region || "US").trim() || "US";
  const option = [...(els.targetRegion?.options || [])].find((item) => item.value === clean);
  if (option) {
    els.targetRegion.value = clean;
    if (els.targetRegionCustom) els.targetRegionCustom.value = "";
  } else {
    els.targetRegion.value = "custom";
    if (els.targetRegionCustom) els.targetRegionCustom.value = clean;
  }
  syncRegionCustom();
}

function setLanguageValue(language = "en-US") {
  const clean = String(language || "en-US").trim() || "en-US";
  const option = [...(els.language?.options || [])].find((item) => item.value === clean);
  if (option) {
    els.language.value = clean;
    if (els.languageCustom) els.languageCustom.value = "";
  } else {
    els.language.value = "custom";
    if (els.languageCustom) els.languageCustom.value = clean;
  }
  syncLanguageCustom();
}

function syncRegionCustom() {
  const wrap = $("#wzTargetRegionCustomWrap");
  if (wrap) wrap.hidden = value(els.targetRegion) !== "custom";
}

function syncLanguageCustom() {
  const wrap = $("#wzLanguageCustomWrap");
  if (wrap) wrap.hidden = value(els.language) !== "custom";
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
  return isGeminiDecompositionModel(model) ? 3 : 2;
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
  return { assetFileNames: {}, assetUrls: {}, assetStorageKeys: {}, assetStoredPaths: {}, assetContentHashes: {}, assetReviews: {} };
}

function assetEntryKey(assetKey, index = 0) {
  return index > 0 ? `${assetKey}_${index + 1}` : assetKey;
}

function assetInputFiles(input, assetKey) {
  const files = Array.from(input?.files || []);
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  return files.slice(0, limit);
}

function nextAssetEntryKey(branch = activeBranch(), assetKey = "") {
  const used = new Set(branchAssetEntryKeys(branch, assetKey));
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  for (let index = 0; index < limit; index += 1) {
    const entryKey = assetEntryKey(assetKey, index);
    if (!used.has(entryKey)) return entryKey;
  }
  return "";
}

function pendingAppendFiles(input, assetKey) {
  const branch = activeBranch();
  const existingCount = branchAssetEntryKeys(branch, assetKey).length;
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  const files = Array.from(input?.files || []);
  return files.slice(0, Math.max(0, limit - existingCount));
}

function pendingAssetFileKey(branchId, entryKey) {
  return `${branchId || ""}::${entryKey || ""}`;
}

function setPendingAssetFile(branchId, entryKey, file) {
  if (!entryKey || !file) return;
  state.pendingAssetFiles.set(pendingAssetFileKey(branchId, entryKey), file);
}

function getPendingAssetFile(branchId, entryKey) {
  return state.pendingAssetFiles.get(pendingAssetFileKey(branchId, entryKey)) || null;
}

function clearPendingAssetFile(branchId, entryKey) {
  state.pendingAssetFiles.delete(pendingAssetFileKey(branchId, entryKey));
}

function syncAssetInputDataset(input, branch, entryKey) {
  if (!input) return;
  input.dataset.uploadedFileName = branch.assetFileNames?.[entryKey] || "";
  input.dataset.storageUrl = branch.assetUrls?.[entryKey] || "";
  input.dataset.storageKey = branch.assetStorageKeys?.[entryKey] || "";
  input.dataset.storedPath = branch.assetStoredPaths?.[entryKey] || "";
  input.dataset.contentHash = branch.assetContentHashes?.[entryKey] || "";
  input.dataset.assetId = branch.assetReviews?.[entryKey]?.assetId || "";
  input.dataset.reviewStatus = branch.assetReviews?.[entryKey]?.status || "";
  input.dataset.reviewReason = branch.assetReviews?.[entryKey]?.reviewReason || "";
}

function commitSelectedAssetFiles(input, assetKey) {
  const branch = activeBranch();
  const files = pendingAppendFiles(input, assetKey);
  if (!files.length) {
    input.value = "";
    renderAssetReviewState();
    return;
  }
  const uploadedKeys = [];
  for (const file of files) {
    const entryKey = nextAssetEntryKey(branch, assetKey);
    if (!entryKey) break;
    updateBranchAsset(entryKey, { fileName: file.name });
    setPendingAssetFile(branch.branchId, entryKey, file);
    uploadedKeys.push(entryKey);
  }
  input.value = "";
  const lastKey = uploadedKeys.at(-1) || branchAssetEntryKeys(branch, assetKey).at(-1) || "";
  syncAssetInputDataset(input, branch, lastKey);
  renderAssetReviewState();
  markPlanMaybeStale();
}

function validateAssetAppendLimit(input, assetKey) {
  const branch = activeBranch();
  const existingCount = branchAssetEntryKeys(branch, assetKey).length;
  const selectedCount = input?.files?.length || 0;
  const limit = MULTI_ASSET_LIMITS[assetKey] || 1;
  if (existingCount + selectedCount <= limit) return true;
  showError({
    message: `${input.closest(".wz-asset-slot")?.textContent?.trim() || assetKey} 最多 ${limit} 个，当前已有 ${existingCount} 个，只能继续添加 ${Math.max(0, limit - existingCount)} 个`
  }, "素材数量超限");
  input.value = "";
  renderAssetReviewState();
  return false;
}

function validateImageOnlyEndingAsset(input, assetKey) {
  if (!["ctaAsset", "endingAsset"].includes(assetKey)) return true;
  const invalid = Array.from(input?.files || []).find((file) => !String(file.type || "").startsWith("image/"));
  if (!invalid) return true;
  showError({
    code: "invalid_material",
    message: `${assetKey === "ctaAsset" ? "CTA 图" : "Ending 图"}只能上传图片，不能上传视频`
  }, "素材格式不支持");
  input.value = "";
  renderAssetReviewState();
  return false;
}

function targetSegmentCountValue() {
  const raw = value(els.duration) || FOLLOW_DECOMPOSITION_SEGMENT_COUNT;
  if (raw === FOLLOW_DECOMPOSITION_SEGMENT_COUNT) return FOLLOW_DECOMPOSITION_SEGMENT_COUNT;
  const count = Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 5 ? count : FOLLOW_DECOMPOSITION_SEGMENT_COUNT;
}

function compatibleDurationSecValue() {
  return 15;
}

function defaultBranchDraft(index = 0, seed = {}) {
  const branchIndex = index + 1;
  return pruneOrphanAssetReviews({
    branchId: seed.branchId || `branch_${branchIndex}`,
    branchIndex,
    branchLabel: seed.branchLabel || `改写 3.${branchIndex}`,
    ...emptyAssetMaps(),
    ...seed,
    assetFileNames: { ...(seed.assetFileNames || {}) },
    assetUrls: { ...(seed.assetUrls || {}) },
    assetStorageKeys: { ...(seed.assetStorageKeys || {}) },
    assetStoredPaths: { ...(seed.assetStoredPaths || {}) },
    assetContentHashes: { ...(seed.assetContentHashes || {}) },
    assetReviews: { ...(seed.assetReviews || {}) }
  });
}

function activeBranch() {
  if (!state.branches.length) state.branches = [defaultBranchDraft(0)];
  if (state.activeBranchIndex < 0 || state.activeBranchIndex >= state.branches.length) state.activeBranchIndex = 0;
  state.branchDraft = state.branches[state.activeBranchIndex];
  return state.branchDraft;
}

function formatAssetReviewFailure(item = {}) {
  const branch = item.branchLabel || item.branchId || "默认分支";
  const file = item.fileName || item.assetKey || "未命名素材";
  const status = item.status || "pending";
  const reason = item.reason || item.reviewReason || (item.assetId ? "等待审核完成" : "缺少 Seedance assetId");
  return `${branch} / ${item.assetKey || "asset"} / ${file}：${status}，${reason}`;
}

function formatAssetReviewErrorDetails(error = {}) {
  if (error?.code !== "asset_review_pending") return "";
  const failures = Array.isArray(error.data?.failures) ? error.data.failures : [];
  if (failures.length) {
    return `\n未通过素材：\n${failures.map((item, index) => `${index + 1}. ${formatAssetReviewFailure(item)}`).join("\n")}`;
  }
  const assetsByBranch = Array.isArray(error.data?.assetsByBranch) ? error.data.assetsByBranch : [];
  const pendingAssets = assetsByBranch.flatMap((branch) => (Array.isArray(branch.assets) ? branch.assets : [])
    .filter((asset) => !isAssetReviewApproved(asset.status))
    .map((asset) => formatAssetReviewFailure({
      ...asset,
      branchId: branch.branchId,
      branchLabel: branch.branchLabel,
      assetKey: asset.key,
      fileName: asset.fileName,
      reason: asset.reason
    })));
  return pendingAssets.length
    ? `\n未通过素材：\n${pendingAssets.map((text, index) => `${index + 1}. ${text}`).join("\n")}`
    : "";
}

function showError(error, title = "操作失败") {
  const message = error?.message || String(error || "未知错误");
  const requestId = String(error?.requestId || "").trim();
  const extra = formatAssetReviewErrorDetails(error);
  const detail = `${message}${extra}${requestId ? `\nrequestId: ${requestId}` : ""}`;
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

function cleanSignatureString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function signatureAssetIdentity(asset = {}) {
  const assetKey = cleanSignatureString(asset.assetKey || asset.key || asset.category);
  const assetId = cleanSignatureString(asset.assetId);
  const identity = cleanSignatureString(asset.contentHash)
    || cleanSignatureString(asset.storageKey)
    || cleanSignatureString(asset.storedPath)
    || cleanSignatureString(asset.url)
    || cleanSignatureString(asset.fileName)
    || assetId;
  if (!assetKey || !identity) return null;
  return {
    branchId: cleanSignatureString(asset.branchId),
    assetKey,
    identity
  };
}

function canonicalSignatureAssets(assets = []) {
  return (Array.isArray(assets) ? assets : [])
    .map(signatureAssetIdentity)
    .filter(Boolean)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function canonicalSignatureBranch(branch = {}) {
  const normalized = Object.fromEntries(
    signatureBranchFields.map((field) => [field, branch[field]])
  );
  const assetKeys = new Set([
    ...Object.keys(branch.assetFileNames || {}),
    ...Object.keys(branch.assetUrls || {}),
    ...Object.keys(branch.assetStorageKeys || {}),
    ...Object.keys(branch.assetStoredPaths || {}),
    ...Object.keys(branch.assetRelativePaths || {}),
    ...Object.keys(branch.assetContentHashes || {})
  ]);
  normalized.assets = canonicalSignatureAssets([...assetKeys].map((assetKey) => ({
    branchId: branch.branchId,
    assetKey,
    fileName: branch.assetFileNames?.[assetKey],
    url: branch.assetUrls?.[assetKey],
    storageKey: branch.assetStorageKeys?.[assetKey],
    storedPath: branch.assetStoredPaths?.[assetKey] || branch.assetRelativePaths?.[assetKey],
    contentHash: branch.assetContentHashes?.[assetKey],
    assetId: branch.assetReviews?.[assetKey]?.assetId
  })));
  return normalized;
}

function canonicalPlanSignaturePayload(input = {}) {
  const payload = Object.fromEntries(signatureFields.map((field) => [field, input[field]]));
  payload.assets = canonicalSignatureAssets(input.assets);
  payload.branches = (Array.isArray(input.branches) ? input.branches : []).map(canonicalSignatureBranch);
  return payload;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  return sha256BytesHex(bytes);
}

async function fileSha256Hex(file) {
  const bytes = await file.arrayBuffer();
  return sha256BytesHex(bytes);
}

async function sha256BytesHex(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return hexFromBytes(new Uint8Array(hash));
  }
  return sha256BytesHexFallback(new Uint8Array(bytes));
}

function hexFromBytes(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rotateRight32(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256BytesHexFallback(inputBytes) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hashWords = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const bitLength = inputBytes.length * 8;
  const paddedLength = (((inputBytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(inputBytes);
  padded[inputBytes.length] = 0x80;
  const dataView = new DataView(padded.buffer);
  dataView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  dataView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const messageSchedule = new Uint32Array(64);
  for (let chunkOffset = 0; chunkOffset < paddedLength; chunkOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      messageSchedule[index] = dataView.getUint32(chunkOffset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const smallSigma0 = rotateRight32(messageSchedule[index - 15], 7) ^ rotateRight32(messageSchedule[index - 15], 18) ^ (messageSchedule[index - 15] >>> 3);
      const smallSigma1 = rotateRight32(messageSchedule[index - 2], 17) ^ rotateRight32(messageSchedule[index - 2], 19) ^ (messageSchedule[index - 2] >>> 10);
      messageSchedule[index] = (messageSchedule[index - 16] + smallSigma0 + messageSchedule[index - 7] + smallSigma1) >>> 0;
    }

    let wordA = hashWords[0];
    let wordB = hashWords[1];
    let wordC = hashWords[2];
    let wordD = hashWords[3];
    let wordE = hashWords[4];
    let wordF = hashWords[5];
    let wordG = hashWords[6];
    let wordH = hashWords[7];

    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight32(wordE, 6) ^ rotateRight32(wordE, 11) ^ rotateRight32(wordE, 25);
      const choice = (wordE & wordF) ^ (~wordE & wordG);
      const temp1 = (wordH + bigSigma1 + choice + constants[index] + messageSchedule[index]) >>> 0;
      const bigSigma0 = rotateRight32(wordA, 2) ^ rotateRight32(wordA, 13) ^ rotateRight32(wordA, 22);
      const majority = (wordA & wordB) ^ (wordA & wordC) ^ (wordB & wordC);
      const temp2 = (bigSigma0 + majority) >>> 0;
      wordH = wordG;
      wordG = wordF;
      wordF = wordE;
      wordE = (wordD + temp1) >>> 0;
      wordD = wordC;
      wordC = wordB;
      wordB = wordA;
      wordA = (temp1 + temp2) >>> 0;
    }

    hashWords[0] = (hashWords[0] + wordA) >>> 0;
    hashWords[1] = (hashWords[1] + wordB) >>> 0;
    hashWords[2] = (hashWords[2] + wordC) >>> 0;
    hashWords[3] = (hashWords[3] + wordD) >>> 0;
    hashWords[4] = (hashWords[4] + wordE) >>> 0;
    hashWords[5] = (hashWords[5] + wordF) >>> 0;
    hashWords[6] = (hashWords[6] + wordG) >>> 0;
    hashWords[7] = (hashWords[7] + wordH) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hashWords.forEach((word, index) => outputView.setUint32(index * 4, word, false));
  return hexFromBytes(output);
}

async function clientPlanDraftSignature(input = planSignatureInput()) {
  return `plansig_${await sha256Hex(stableJson(canonicalPlanSignaturePayload(input)))}`;
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

async function downloadRecoveryZip(path, payload, fileName = "wangzhuan-segments.zip", signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    let errorPayload = {};
    try {
      errorPayload = await response.json();
    } catch {
      errorPayload = { message: "下载失败" };
    }
    throw new WangzhuanApiError(errorPayload, response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const segmentRecoveryController = createSegmentRecoveryController({
  root: els.segmentRecovery,
  request: api,
  downloadZip: downloadRecoveryZip,
  showToast: (message) => log(message),
  getScope: () => ({
    userId: state.currentUserId || "current-user",
    projectKey: new URLSearchParams(location.search).get("projectKey")
      || value($("#wzProjectName"))
      || "current-project"
  }),
  onDetail: (detail) => {
    const batchId = detail?.batch?.batchId || detail?.batchId;
    if (batchId) void loadBatchDetail(batchId).catch((error) => log(`片段恢复详情刷新失败：${error.message}`));
  },
  onRetrySubmitted: (batchId) => startBatchPolling(batchId, { followSegmentRecovery: true }),
  onError: (error, title) => showError(error, title)
});

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

function disclaimerPresetForLanguage(language = "") {
  const normalized = String(language || "").trim().toLowerCase();
  if (normalized.startsWith("pt")) return "pt";
  if (normalized.startsWith("zh") || normalized.includes("chinese")) return "zh";
  if (normalized.startsWith("ar")) return "ar";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("id")) return "id";
  if (normalized.startsWith("th")) return "th";
  if (normalized.startsWith("vi")) return "vi";
  return "en";
}

function disclaimerTemplateUrl(preset = "auto", language = "") {
  const selected = String(preset || "auto").trim();
  const key = selected === "auto" ? disclaimerPresetForLanguage(language) : selected;
  return ["en", "pt", "zh", "ar", "es", "fr", "de", "id", "th", "vi"].includes(key)
    ? `/assets/wangzhuan/disclaimers/${key}.png`
    : "";
}

function disclaimerOverlayAssetFromState() {
  return state.disclaimerOverlayAsset && typeof state.disclaimerOverlayAsset === "object" ? state.disclaimerOverlayAsset : {};
}

function renderDisclaimerOverlayPreview() {
  const box = $("#wzDisclaimerOverlayPreview");
  if (!box) return;
  const asset = disclaimerOverlayAssetFromState();
  const preset = value($("#wzDisclaimerPreset")) || "auto";
  const url = asset.previewUrl || asset.storageUrl || fileUrlFromStoredPath(asset.storedPath) || disclaimerTemplateUrl(preset, languageValue());
  const label = asset.fileName ? `已上传：${escapeHtml(asset.fileName)}` : "使用内置透明 PNG 模板";
  if (!url) {
    box.textContent = "请选择内置模板或上传透明 PNG。";
    return;
  }
  box.innerHTML = `<span>${label}</span><img src="${escapeHtml(url)}" alt="免责声明贴片预览" style="display:block;width:min(100%,360px);height:auto;margin-top:6px;background:#222;" />`;
}

function normalizeExpansionSize(width, height) {
  const targetWidth = Number(width);
  const targetHeight = Number(height);
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)
    || targetWidth < 256 || targetHeight < 256
    || targetWidth > 4096 || targetHeight > 4096
    || targetWidth % 2 || targetHeight % 2) {
    throw new Error("扩展尺寸的宽高必须是 256-4096 之间的偶数");
  }
  return { targetWidth, targetHeight, sizeKey: `${targetWidth}x${targetHeight}` };
}

function addExpansionSize(width, height) {
  const next = normalizeExpansionSize(width, height);
  if (!state.expansionSizes.some((item) => item.sizeKey === next.sizeKey)) {
    state.expansionSizes.push(next);
  }
  renderExpansionSizes();
}

function removeExpansionSize(sizeKey) {
  state.expansionSizes = state.expansionSizes.filter((item) => item.sizeKey !== sizeKey);
  renderExpansionSizes();
}

function renderExpansionSizes() {
  const selected = new Set(state.expansionSizes.map((item) => item.sizeKey));
  for (const input of document.querySelectorAll("[data-expansion-preset]")) {
    input.checked = selected.has(input.dataset.expansionPreset || "");
  }
  if (!els.expansionSelectedSizes) return;
  if (!state.expansionSizes.length) {
    els.expansionSelectedSizes.classList.add("empty-line");
    els.expansionSelectedSizes.textContent = "未选择扩展尺寸";
    return;
  }
  els.expansionSelectedSizes.classList.remove("empty-line");
  els.expansionSelectedSizes.innerHTML = state.expansionSizes.map((item) => `
    <span>${escapeHtml(item.sizeKey)}<button type="button" aria-label="移除 ${escapeHtml(item.sizeKey)}" data-remove-expansion-size="${escapeHtml(item.sizeKey)}">×</button></span>
  `).join("");
}

function renderPostProcessEndingPreview() {
  if (!els.postProcessEndingPreview) return;
  const asset = state.postProcessEndingAsset || {};
  const url = asset.previewUrl || asset.storageUrl || fileUrlFromStoredPath(asset.storedPath);
  if (!asset.fileName || !url) {
    els.postProcessEndingPreview.classList.add("empty-line");
    els.postProcessEndingPreview.textContent = "未添加 Ending";
    if (els.postProcessEndingRemove) els.postProcessEndingRemove.hidden = true;
    return;
  }
  const media = asset.mediaType === "video"
    ? `<video src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>`
    : `<img src="${escapeHtml(url)}" alt="追加 Ending 预览" />`;
  els.postProcessEndingPreview.classList.remove("empty-line");
  els.postProcessEndingPreview.innerHTML = `<span>${escapeHtml(asset.fileName)}</span>${media}`;
  if (els.postProcessEndingRemove) els.postProcessEndingRemove.hidden = false;
}

function postProcessRequestFields() {
  return {
    ending: state.postProcessEndingAsset ? { ...state.postProcessEndingAsset, enabled: true, imageDurationSec: 1 } : null,
    subtitles: {
      enabled: els.postProcessSubtitles?.checked !== false,
      fontSize: Number(els.subtitleFontSizeNumber?.value || 40),
      centerY: Number(els.subtitleCenterYNumber?.value || 960),
      textColor: els.subtitleTextColor?.value || "white"
    },
    expansionSizes: state.expansionSizes.map(({ targetWidth, targetHeight }) => ({ targetWidth, targetHeight }))
  };
}

function subtitleControlValue(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function syncSubtitleStyleControls(settings = {}, changed = null) {
  const fontSource = changed === els.subtitleFontSizeRange || changed === els.subtitleFontSizeNumber
    ? changed.value
    : settings.fontSize ?? els.subtitleFontSizeNumber?.value ?? 40;
  const centerYSource = changed === els.subtitleCenterYRange || changed === els.subtitleCenterYNumber
    ? changed.value
    : settings.centerY ?? els.subtitleCenterYNumber?.value ?? 960;
  const fontSize = subtitleControlValue(fontSource, 20, 60, 40);
  const centerY = subtitleControlValue(centerYSource, 0, 1280, 960);
  const textColor = settings.textColor || els.subtitleTextColor?.value || "white";
  for (const control of [els.subtitleFontSizeRange, els.subtitleFontSizeNumber]) {
    if (control) control.value = String(fontSize);
  }
  for (const control of [els.subtitleCenterYRange, els.subtitleCenterYNumber]) {
    if (control) control.value = String(centerY);
  }
  if (els.subtitleTextColor) els.subtitleTextColor.value = textColor === "yellow" ? "yellow" : "white";
  const disabled = els.postProcessSubtitles?.checked === false;
  for (const control of [els.subtitleFontSizeRange, els.subtitleFontSizeNumber, els.subtitleCenterYRange, els.subtitleCenterYNumber, els.subtitleTextColor]) {
    if (control) control.disabled = disabled;
  }
}

async function uploadPostProcessEnding() {
  const file = els.postProcessEndingFile?.files?.[0];
  if (!file) return;
  const content = await fileToDataUrl(file);
  const data = await api("/api/wangzhuan/postprocess-assets/ending", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", content })
  });
  state.postProcessEndingAsset = data.asset || null;
  if (els.postProcessEndingFile) els.postProcessEndingFile.value = "";
  renderPostProcessEndingPreview();
  renderTasks();
  log("成片 Ending 已上传");
}

function removePostProcessEnding() {
  state.postProcessEndingAsset = null;
  if (els.postProcessEndingFile) els.postProcessEndingFile.value = "";
  renderPostProcessEndingPreview();
  renderTasks();
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
      contentHash: branch.assetContentHashes?.[entryKey] || input?.dataset.contentHash || "",
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
  if (asset.contentHash) branch.assetContentHashes[assetKey] = asset.contentHash;
  else delete branch.assetContentHashes[assetKey];
  branch.assetReviews[assetKey] = asset.review || {};
}

function pruneBranchAssetsForInput(assetKey, keepKeys = []) {
  const branch = activeBranch();
  const keep = new Set(keepKeys);
  for (const key of branchAssetEntryKeys(branch, assetKey)) {
    if (keep.has(key)) continue;
    clearPendingAssetFile(branch.branchId, key);
    delete branch.assetFileNames[key];
    delete branch.assetUrls[key];
    delete branch.assetStorageKeys[key];
    delete branch.assetStoredPaths[key];
    delete branch.assetContentHashes[key];
    delete branch.assetReviews[key];
  }
}

function removeBranchAssetEntry(entryKey) {
  const branch = activeBranch();
  if (!entryKey || !branch.assetFileNames?.[entryKey]) return;
  clearPendingAssetFile(branch.branchId, entryKey);
  delete branch.assetFileNames[entryKey];
  delete branch.assetUrls[entryKey];
  delete branch.assetStorageKeys[entryKey];
  delete branch.assetStoredPaths[entryKey];
  delete branch.assetContentHashes[entryKey];
  delete branch.assetReviews[entryKey];
  const baseKey = String(entryKey).replace(/_\d+$/, "");
  const selector = assetInputs.find(([key]) => key === baseKey)?.[1];
  const input = selector ? $(selector) : null;
  const lastKey = branchAssetEntryKeys(branch, baseKey).at(-1) || "";
  syncAssetInputDataset(input, branch, lastKey);
  renderAssetReviewState();
  markPlanMaybeStale();
}

function disclaimerRequestFields() {
  const language = languageValue() || "en-US";
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
  const region = regionValue();
  const language = languageValue();
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
    outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
    sliceStrategy: AUTO_SLICE_STRATEGY,
    targetSegmentCount: targetSegmentCountValue(),
    moneyVisuals: branch.moneyVisuals || DEFAULT_MONEY_VISUALS,
    subtitleWorkflow: value(els.subtitleWorkflow),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    currencySymbol: currencyValue(),
    truthRules: collectTruthRules(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    defaultDurationSec: compatibleDurationSecValue(),
    defaultOutputRatio: value(els.outputRatio) || "9:16",
    ...disclaimerRequestFields(),
    assetFileNames: { ...(branch.assetFileNames || {}) },
    assetUrls: { ...(branch.assetUrls || {}) },
    assetStorageKeys: { ...(branch.assetStorageKeys || {}) },
    assetStoredPaths: { ...(branch.assetStoredPaths || {}) },
    assetContentHashes: { ...(branch.assetContentHashes || {}) },
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
    delete input.dataset.contentHash;
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
  if (els.productLibrarySelect && branch.productInfoId) els.productLibrarySelect.value = branch.productInfoId;
  els.cta.value = branch.cta || "";
  els.ending.value = branch.ending || "";
  setCurrencyValue(branch.currencySymbol || "$");
  els.targetChannel.value = branch.targetChannel || branch.targetChannels?.[0] || "meta_ads";
  setRegionValue(branch.targetRegion || branch.targetRegions?.[0] || branch.regions?.[0] || "US");
  setLanguageValue(branch.language || branch.languages?.[0] || "en-US");
  els.duration.value = String(branch.targetSegmentCount || FOLLOW_DECOMPOSITION_SEGMENT_COUNT);
  els.outputRatio.value = branch.defaultOutputRatio || "9:16";
  els.promiseLevel.value = branch.promiseLevel || "strong_conversion";
  applyTruthRules(branch.truthRules || {});
  els.materialDirection.value = branch.materialDirection || "other";
  els.materialDirectionCustom.value = branch.materialDirectionCustom || "跟随竞品";
  if (els.outputTemplateMode) els.outputTemplateMode.value = AUTO_OUTPUT_TEMPLATE_MODE;
  if (els.sliceStrategy) els.sliceStrategy.value = AUTO_SLICE_STRATEGY;
  setSelectedValues(els.moneyVisuals, branch.moneyVisuals || DEFAULT_MONEY_VISUALS);
  if (els.subtitleWorkflow) els.subtitleWorkflow.value = branch.subtitleWorkflow || "post_process";
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
    input.dataset.contentHash = branch.assetContentHashes?.[assetKey] || "";
    input.dataset.assetId = branch.assetReviews?.[assetKey]?.assetId || "";
    input.dataset.reviewStatus = branch.assetReviews?.[assetKey]?.status || "";
    input.dataset.reviewReason = branch.assetReviews?.[assetKey]?.reviewReason || "";
  }
  syncMaterialDirectionCustom();
  renderAssetReviewState();
  showSelectedProductLibraryDetail().catch(() => {});
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
  const postProcess = request.postProcess || draft.postProcess || {};
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
    els.decompositionStatus.hidden = false;
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
  if (els.duration) {
    els.duration.value = String(request.targetSegmentCount || draft.targetSegmentCount || FOLLOW_DECOMPOSITION_SEGMENT_COUNT);
  }
  if (request.outputRatio && els.outputRatio) els.outputRatio.value = request.outputRatio;
  if (request.seedanceModel && $("#wzModelSelect")) $("#wzModelSelect").value = request.seedanceModel;
  syncSeedanceModel();
  if (request.variantCount && els.variantCount) els.variantCount.value = String(request.variantCount);
  if (request.requestedConcurrency && els.requestedConcurrency) els.requestedConcurrency.value = String(request.requestedConcurrency);
  state.postProcessEndingAsset = postProcess.ending || null;
  if (els.postProcessSubtitles) els.postProcessSubtitles.checked = postProcess.subtitles?.enabled !== false;
  syncSubtitleStyleControls({
    fontSize: postProcess.subtitles?.fontSize ?? 40,
    centerY: postProcess.subtitles?.centerY ?? 960,
    textColor: postProcess.subtitles?.textColor ?? "white"
  });
  state.expansionSizes = [];
  for (const item of Array.isArray(postProcess.expansionSizes) ? postProcess.expansionSizes : []) {
    try {
      addExpansionSize(item.targetWidth ?? item.width, item.targetHeight ?? item.height);
    } catch {
      // Ignore stale invalid dimensions while restoring an older draft.
    }
  }
  renderPostProcessEndingPreview();
  renderExpansionSizes();
  const latestPlanJob = detail.backgroundJobs?.latestPlanJob || null;
  state.planJob = latestPlanJob;
  state.draftSignature = latestPlanJob?.draftSignature || batch.draftSignature || "";
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
  renderBatchDetail(detail);
  void markPlanMaybeStale();
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
    outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
    sliceStrategy: AUTO_SLICE_STRATEGY,
    targetSegmentCount: source.targetSegmentCount || targetSegmentCountValue(),
    moneyVisuals: source.moneyVisuals,
    subtitleWorkflow: source.subtitleWorkflow,
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
  const active = branches[state.activeBranchIndex] || primary;
  return {
    displayName: value(els.displayName) || value(els.productName) || "未命名模板",
    productName: primary.productName || value(els.productName),
    productLink: primary.productLink || value(els.productLink),
    currencySymbol: primary.currencySymbol || currencyValue() || "$",
    targetChannels: [value(els.targetChannel) || "meta_ads"],
    targetRegions: [regionValue() || "US"],
    regions: [regionValue() || "US"],
    language: languageValue() || "en-US",
    languages: [languageValue() || "en-US"],
    materialDirection: effectiveMaterialDirection(),
    materialDirectionCustom: value(els.materialDirectionCustom),
    outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
    sliceStrategy: AUTO_SLICE_STRATEGY,
    targetSegmentCount: targetSegmentCountValue(),
    moneyVisuals: active.moneyVisuals || DEFAULT_MONEY_VISUALS,
    subtitleWorkflow: active.subtitleWorkflow || value(els.subtitleWorkflow),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    truthRules: collectTruthRules(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    defaultDurationSec: compatibleDurationSecValue(),
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
    const storedItems = keys
      .map((key) => ({ key, name: branch.assetFileNames[key] }))
      .filter((item) => item.name);
    const names = storedItems.map((item) => item.name);
    const pendingCount = storedItems.filter((item) => getPendingAssetFile(branch.branchId, item.key) && !branch.assetStorageKeys?.[item.key]).length;
    const failed = keys
      .map((key) => branch.assetReviews?.[key])
      .filter((review) => review?.status && !isAssetReviewApproved(review.status));
    const countLabel = names.length ? `${names.length} 个文件` : "未选择";
    const stateLabel = failed.length
      ? "有审核风险"
      : (keys.length
        ? (pendingCount ? "已记录，待上传" : "已记录")
        : "");
    status.textContent = stateLabel ? `${countLabel} · ${stateLabel}` : countLabel;
    fileList.innerHTML = names.length
      ? storedItems.map((item) => `
          <span class="wz-v2-asset-file">
            <span>${escapeHtml(item.name)}</span>
            <button type="button" class="wz-v2-asset-remove" data-remove-asset-key="${escapeHtml(item.key)}" aria-label="删除 ${escapeHtml(item.name)}">×</button>
          </span>
        `).join("")
      : "";
    slot.dataset.hasAsset = names.length ? "1" : "0";
  }
}

function selectedProductLibraryId() {
  return value(els.productLibrarySelect) || activeBranch().productInfoId || "";
}

function renderProductLibrarySelect() {
  if (!els.productLibrarySelect) return;
  const items = state.productLibraryItems || [];
  if (state.productLibraryLoading) {
    els.productLibrarySelect.innerHTML = `<option value="">加载产品库中...</option>`;
    els.productLibrarySelect.disabled = true;
    if (els.applyProductLibraryBtn) els.applyProductLibraryBtn.disabled = true;
    return;
  }
  els.productLibrarySelect.disabled = false;
  els.productLibrarySelect.innerHTML = [
    `<option value="">选择本地产品库</option>`,
    ...items.map((item) => {
      const summary = item.assetSummary || {};
      const label = `${item.productName || item.productId} · 图标${summary.iconCount || 0}/截图${summary.screenshotCount || 0}`;
      return `<option value="${escapeHtml(item.productId)}">${escapeHtml(label)}</option>`;
    })
  ].join("");
  const branchProductId = activeBranch().productInfoId || "";
  if (branchProductId && items.some((item) => item.productId === branchProductId)) {
    els.productLibrarySelect.value = branchProductId;
  }
  if (els.applyProductLibraryBtn) els.applyProductLibraryBtn.disabled = !selectedProductLibraryId();
}

function productLibraryDetailHtml(product = null) {
  if (!product) return "选择产品后，会自动带出可用图片、描述和卖点。";
  const assets = Array.isArray(product.assets) ? product.assets : [];
  const description = product.description || "暂无描述";
  const sellingPoints = Array.isArray(product.coreSellingPoints) ? product.coreSellingPoints : [];
  const imageAssets = assets.filter((asset) => asset.assetKey === "productIcon" || asset.assetKey === "productScreenshot").slice(0, 8);
  const preview = imageAssets.length
    ? `<div class="wz-product-library-assets">${imageAssets.map((asset) => `
        <figure>
          <img src="${escapeHtml(asset.previewUrl)}" alt="${escapeHtml(asset.fileName)}" loading="lazy" />
          <figcaption>${escapeHtml(asset.assetKey === "productIcon" ? "Logo" : asset.fileName)}</figcaption>
        </figure>
      `).join("")}</div>`
    : `<div class="wz-muted">暂无可用图片</div>`;
  return `
    <div class="wz-product-library-card">
      <div class="wz-product-library-title">
        <strong>${escapeHtml(product.productName || product.productId || "未命名产品")}</strong>
        ${product.sourceUrl ? `<small>${escapeHtml(product.sourceUrl)}</small>` : ""}
      </div>
      <p>${escapeHtml(description)}</p>
      <div class="wz-product-library-points">
        ${sellingPoints.length ? sellingPoints.map((point) => `<span>${escapeHtml(point)}</span>`).join("") : "<span>暂无核心卖点</span>"}
      </div>
      ${preview}
    </div>
  `;
}

function renderProductLibraryDetail(product = null) {
  if (!els.productLibraryDetail) return;
  els.productLibraryDetail.classList.toggle("empty-line", !product);
  els.productLibraryDetail.innerHTML = productLibraryDetailHtml(product);
}

async function loadProductLibrary() {
  if (!els.productLibrarySelect) return;
  state.productLibraryLoading = true;
  renderProductLibrarySelect();
  try {
    const data = await api("/api/wangzhuan/product-info");
    state.productLibraryItems = data.items || [];
  } finally {
    state.productLibraryLoading = false;
    renderProductLibrarySelect();
    await showSelectedProductLibraryDetail();
  }
}

async function getProductLibraryDetail(productId) {
  if (!productId) return null;
  if (state.productLibraryDetails.has(productId)) return state.productLibraryDetails.get(productId);
  const data = await api(`/api/wangzhuan/product-info/${encodeURIComponent(productId)}`);
  const product = data.product || null;
  if (product) state.productLibraryDetails.set(productId, product);
  return product;
}

async function showSelectedProductLibraryDetail() {
  const productId = selectedProductLibraryId();
  if (!productId) {
    renderProductLibraryDetail(null);
    if (els.applyProductLibraryBtn) els.applyProductLibraryBtn.disabled = true;
    return;
  }
  if (els.applyProductLibraryBtn) els.applyProductLibraryBtn.disabled = false;
  const product = await getProductLibraryDetail(productId);
  renderProductLibraryDetail(product);
}

function appendProductPromptContext(product = {}) {
  const lines = [
    `产品信息：${product.productName || ""}`.trim(),
    product.description ? `产品描述：${product.description}` : "",
    Array.isArray(product.coreSellingPoints) && product.coreSellingPoints.length
      ? `核心卖点：${product.coreSellingPoints.join("；")}`
      : ""
  ].filter(Boolean);
  if (!lines.length) return;
  const marker = "[产品库信息]";
  const existing = value(els.customPrompt);
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutOldProductBlock = existing.replace(new RegExp(`\\n?${escapedMarker}[\\s\\S]*?(?=\\n\\[[^\\n]+\\]|$)`, "g"), "").trim();
  els.customPrompt.value = [withoutOldProductBlock, `${marker}\n${lines.join("\n")}`].filter(Boolean).join("\n\n");
}

function applyProductAssetToBranch(assetKey, asset = {}) {
  updateBranchAsset(assetKey, {
    fileName: asset.fileName,
    storageUrl: asset.storageUrl || asset.previewUrl,
    previewUrl: asset.previewUrl,
    storageKey: asset.storageKey,
    storedPath: asset.storedPath,
    contentHash: asset.contentHash,
    review: {}
  });
}

function applyProductLibraryAssets(product = {}) {
  const assets = Array.isArray(product.assets) ? product.assets : [];
  const grouped = {
    productIcon: assets.filter((asset) => asset.assetKey === "productIcon").slice(0, MULTI_ASSET_LIMITS.productIcon),
    productScreenshot: assets.filter((asset) => asset.assetKey === "productScreenshot").slice(0, MULTI_ASSET_LIMITS.productScreenshot),
    productRecording: assets.filter((asset) => asset.assetKey === "productRecording").slice(0, MULTI_ASSET_LIMITS.productRecording)
  };
  for (const [baseKey, items] of Object.entries(grouped)) {
    if (!items.length) continue;
    pruneBranchAssetsForInput(baseKey, items.map((_, index) => assetEntryKey(baseKey, index)));
    for (const [index, asset] of items.entries()) {
      applyProductAssetToBranch(assetEntryKey(baseKey, index), asset);
    }
  }
}

async function applySelectedProductLibrary() {
  const productId = selectedProductLibraryId();
  if (!productId) return;
  const product = await getProductLibraryDetail(productId);
  if (!product) return;
  const branch = activeBranch();
  branch.productInfoId = product.productId || productId;
  branch.productBrief = product.productBrief || {
    productName: product.productName || "",
    description: product.description || "",
    coreSellingPoints: product.coreSellingPoints || []
  };
  branch.productDescription = product.description || "";
  branch.coreSellingPoints = product.coreSellingPoints || [];
  els.productName.value = product.productName || "";
  els.productLink.value = product.sourceUrl || "";
  applyProductLibraryAssets(product);
  appendProductPromptContext(product);
  saveActiveBranchFromForm();
  loadBranchToForm(activeBranch());
  renderProductLibraryDetail(product);
  renderAssetReviewState();
  markPlanMaybeStale();
  log(`已应用产品库：${product.productName || productId}`);
}

function isAssetReviewApproved(status = "") {
  return ["approved", "active", "success", "succeeded", "pass", "passed"].includes(String(status || "").trim().toLowerCase());
}

function planListValue(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function planJsonListValue(value) {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function sliceDiversityValue(value = {}) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {}, null, 2);
}

function escapeAttribute(value = "") {
  return escapeHtml(String(value || "")).replace(/"/g, "&quot;");
}

function renderCodexPromptTestResult() {
  const result = state.codexPromptTestResult;
  if (!result) return "";
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const checks = Array.isArray(result.complianceChecks) ? result.complianceChecks : [];
  const approvedKeys = Array.isArray(result.approvedAssetKeysUsed) ? result.approvedAssetKeysUsed : [];
  const meta = [
    result.mode ? `模式：${result.mode}` : "",
    Number.isFinite(Number(result.approvedAssetCount)) ? `审核通过素材：${result.approvedAssetCount}` : "",
    Number.isFinite(Number(result.referencedAssetCount)) ? `引用素材总数：${result.referencedAssetCount}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <section class="wz-v2-plan-editor wz-v2-plan-editor-test" data-test-prompt="codex">
      <h3>测试版 Seedance Prompt</h3>
      ${meta ? `<div class="wz-muted">${escapeHtml(meta)}</div>` : ""}
      <label>标题 <input value="${escapeAttribute(result.title || "")}" readonly /></label>
      <label>Seedance Prompt <textarea class="wz-json-box compact" readonly>${escapeHtml(result.prompt || "")}</textarea></label>
      <label>Negative Prompt <textarea class="wz-json-box compact" readonly>${escapeHtml(result.negativePrompt || "")}</textarea></label>
      <label>生成说明 <textarea class="wz-json-box compact" readonly>${escapeHtml(result.reasoningSummary || "")}</textarea></label>
      <label>合规检查 <textarea class="wz-json-box compact" readonly>${escapeHtml(checks.join("\n"))}</textarea></label>
      <label>Warnings <textarea class="wz-json-box compact" readonly>${escapeHtml(warnings.join("\n"))}</textarea></label>
      <label>已引用素材 Key <textarea class="wz-json-box compact" readonly>${escapeHtml(approvedKeys.join("\n"))}</textarea></label>
    </section>
  `;
}

function renderPlanEditors(plans = []) {
  const testBlock = renderCodexPromptTestResult();
  if (!plans.length) {
    if (testBlock) {
      els.planBox.className = "wz-list";
      els.planBox.innerHTML = testBlock;
      return;
    }
    els.planBox.className = "wz-list empty-line";
    els.planBox.textContent = "尚未生成 Seedance prompt";
    return;
  }
  els.planBox.className = "wz-list";
  els.planBox.innerHTML = `${testBlock}${plans.map((plan, index) => `
    <section class="wz-v2-plan-editor" data-plan-id="${plan.planId || ""}">
      <h3>Prompt ${index + 1}${plan.branchLabel ? ` · ${plan.branchLabel}` : ""}</h3>
      <label>Hook <textarea data-plan-field="hook" class="wz-json-box compact">${escapeHtml(plan.hook || "")}</textarea></label>
      <label>正文脚本 <textarea data-plan-field="body" class="wz-json-box compact">${escapeHtml(plan.body || "")}</textarea></label>
      <label>口播 <textarea data-plan-field="voiceover" class="wz-json-box compact">${escapeHtml(plan.voiceover || "")}</textarea></label>
      <label>字幕脚本（后处理） <textarea data-plan-field="subtitles" class="wz-json-box compact">${escapeHtml(planListValue(plan.subtitles))}</textarea></label>
      <label>CTA <textarea data-plan-field="cta" class="wz-json-box compact">${escapeHtml(plan.cta || "")}</textarea></label>
      <label>Ending <textarea data-plan-field="ending" class="wz-json-box compact">${escapeHtml(plan.ending || "")}</textarea></label>
      <label>首帧 Image Prompt <textarea data-plan-field="imagePrompt" class="wz-json-box compact">${escapeHtml(plan.imagePrompt || "")}</textarea></label>
      <label>Seedance Prompt <textarea data-plan-field="seedancePrompt" class="wz-json-box compact">${escapeHtml(plan.seedancePrompt || "")}</textarea></label>
      <label>切片角色 <input data-plan-field="segmentRole" value="${escapeHtml(plan.segmentRole || "")}" placeholder="hook_slice / proof_slice / withdrawal_slice" /></label>
      <label>切片时长（秒） <input data-plan-field="sliceDurationSec" type="number" min="5" max="30" value="${escapeHtml(plan.sliceDurationSec || "")}" /></label>
      <label>Story Segment <input data-plan-field="storySegmentIndex" type="number" min="1" value="${escapeHtml(plan.storySegmentIndex || "")}" /></label>
      <label>Seedance Slice <input data-plan-field="seedanceSliceIndex" type="number" min="1" value="${escapeHtml(plan.seedanceSliceIndex || "")}" /></label>
      <label>拆解决定模板 <input data-plan-field="outputTemplateMode" value="${escapeHtml(plan.outputTemplateMode || "")}" placeholder="reference_fission" readonly /></label>
      <label>转化特效机会 <textarea data-plan-field="conversionEffectOpportunities" class="wz-json-box compact">${escapeHtml(planJsonListValue(plan.conversionEffectOpportunities))}</textarea></label>
      <label>提现展示 <textarea data-plan-field="withdrawalVisual" class="wz-json-box compact">${escapeHtml(plan.withdrawalVisual || "")}</textarea></label>
      <label>字幕后处理 <select data-plan-field="postSubtitleRequired">
        <option value="true"${planSubtitlePostRequired(plan.subtitleWorkflow) ? " selected" : ""}>需要后处理字幕</option>
        <option value="false"${!planSubtitlePostRequired(plan.subtitleWorkflow) ? " selected" : ""}>不做后处理字幕</option>
      </select></label>
      <label>字幕服务商 <input data-plan-field="subtitleProvider" value="${escapeHtml(plan.subtitleWorkflow?.provider || "pixel_tech")}" /></label>
      <label>后处理字幕 <textarea data-plan-field="subtitleScript" class="wz-json-box compact">${escapeHtml(planListValue(plan.subtitleWorkflow?.subtitleScript))}</textarea></label>
      <label>切片差异 JSON <textarea data-plan-field="sliceDiversity" class="wz-json-box compact">${escapeHtml(sliceDiversityValue(plan.sliceDiversity))}</textarea></label>
      <label>Negative Prompt <textarea data-plan-field="negativePrompt" class="wz-json-box compact">${escapeHtml(plan.negativePrompt || "")}</textarea></label>
    </section>
  `).join("")}`;
}

function hasConfirmedVideoGeneration(batch = state.batchDetail?.batch || state.batchDetail || {}) {
  if (batch?.previewConfirmedAt) return true;
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  return tasks.some((task) => task?.status && task.status !== "pending_preview");
}

function shouldValidatePlanSignature(batch = state.batchDetail?.batch || state.batchDetail || {}) {
  return !hasConfirmedVideoGeneration(batch);
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

function splitLines(value = "") {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function planSubtitlePostRequired(subtitleWorkflow) {
  if (typeof subtitleWorkflow === "string") {
    const mode = subtitleWorkflow.trim().toLowerCase();
    return !["none", "off", "no_post_process"].includes(mode);
  }
  if (subtitleWorkflow && typeof subtitleWorkflow === "object") {
    return subtitleWorkflow.postSubtitleRequired !== false;
  }
  return true;
}

function parsePlanBoolean(value, fallback = true) {
  if (value === undefined) return fallback;
  const text = String(value || "").trim().toLowerCase();
  if (["false", "0", "no", "none", "off", "no_post_process"].includes(text)) return false;
  if (["true", "1", "yes", "post_process", "on"].includes(text)) return true;
  return fallback;
}

function parsePlanJsonObject(value, fallback = {}) {
  if (value === undefined) return fallback;
  if (!String(value || "").trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parsePlanJsonList(value, fallback) {
  if (value === undefined) return fallback;
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return splitLines(text);
  }
}

function collectEditablePlans() {
  const batch = state.batchDetail?.batch || state.batchDetail || {};
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  return plans.map((plan) => {
    const editor = els.planBox?.querySelector(`[data-plan-id="${CSS.escape(plan.planId || "")}"]`);
    const fieldValue = (field) => {
      const fieldEl = editor?.querySelector(`[data-plan-field="${field}"]`);
      return fieldEl ? fieldEl.value.trim() : undefined;
    };
    const read = (field) => fieldValue(field);
    const readList = (field) => {
      const text = fieldValue(field);
      return text === undefined ? undefined : splitLines(text);
    };
    const readJsonList = (field) => parsePlanJsonList(fieldValue(field), undefined);
    const subtitles = readList("subtitles");
    const moneyVisuals = readList("moneyVisuals");
    const conversionEffectOpportunities = readJsonList("conversionEffectOpportunities");
    const subtitleScript = readList("subtitleScript");
    const sliceDurationSecText = read("sliceDurationSec");
    const storySegmentIndexText = read("storySegmentIndex");
    const seedanceSliceIndexText = read("seedanceSliceIndex");
    const subtitleWorkflow = plan.subtitleWorkflow && typeof plan.subtitleWorkflow === "object" && !Array.isArray(plan.subtitleWorkflow)
      ? plan.subtitleWorkflow
      : {};
    const postSubtitleRequired = parsePlanBoolean(read("postSubtitleRequired"), planSubtitlePostRequired(plan.subtitleWorkflow));
    return {
      ...plan,
      hook: read("hook") ?? plan.hook,
      body: read("body") ?? plan.body,
      voiceover: read("voiceover") ?? plan.voiceover,
      subtitles: subtitles ?? plan.subtitles,
      cta: read("cta") ?? plan.cta,
      ending: read("ending") ?? plan.ending,
      imagePrompt: read("imagePrompt") ?? plan.imagePrompt,
      seedancePrompt: read("seedancePrompt") ?? plan.seedancePrompt,
      segmentRole: read("segmentRole") ?? plan.segmentRole,
      sliceDurationSec: sliceDurationSecText === undefined ? plan.sliceDurationSec : Number(sliceDurationSecText),
      storySegmentIndex: storySegmentIndexText === undefined ? plan.storySegmentIndex : Number(storySegmentIndexText),
      seedanceSliceIndex: seedanceSliceIndexText === undefined ? plan.seedanceSliceIndex : Number(seedanceSliceIndexText),
      mandatoryMoneyVisualCarrier: parsePlanBoolean(read("mandatoryMoneyVisualCarrier"), Boolean(plan.mandatoryMoneyVisualCarrier)),
      outputTemplateMode: read("outputTemplateMode") ?? plan.outputTemplateMode,
      moneyVisuals: moneyVisuals ?? plan.moneyVisuals,
      conversionEffectOpportunities: conversionEffectOpportunities ?? plan.conversionEffectOpportunities,
      withdrawalVisual: read("withdrawalVisual") ?? plan.withdrawalVisual,
      subtitleWorkflow: {
        ...subtitleWorkflow,
        burnedInSubtitles: false,
        postSubtitleRequired,
        provider: read("subtitleProvider") ?? subtitleWorkflow.provider ?? "pixel_tech",
        subtitleScript: subtitleScript ?? (subtitleWorkflow.subtitleScript || plan.subtitles || [])
      },
      sliceDiversity: parsePlanJsonObject(read("sliceDiversity"), plan.sliceDiversity),
      negativePrompt: read("negativePrompt") ?? plan.negativePrompt
    };
  });
}

async function pollReferenceVideoCheckJob(jobId, localPreviewUrl = "") {
  if (!jobId) throw new Error("参考视频检查任务缺少 jobId");
  let consecutivePollFailures = 0;
  return new Promise((resolve, reject) => {
    let stopped = false;
    let timer = null;
    const stop = () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
    const schedule = (delay) => {
      if (stopped) return;
      timer = window.setTimeout(tick, delay);
    };
    async function tick() {
      if (stopped) return;
      try {
        const job = await api(`/api/wangzhuan/reference-videos/check-jobs/${encodeURIComponent(jobId)}`);
        state.referenceVideoCheckJob = job;
        if (consecutivePollFailures > 0) {
          log("参考视频检查查询已恢复");
          consecutivePollFailures = 0;
        }
        const progressText = Number.isFinite(Number(job.progress)) ? `（${job.progress}%）` : "";
        els.referenceUploadStatus.textContent = job.message
          ? `${job.message}${progressText}`
          : `参考视频后台检查中${progressText}`;
        if (job.status === "succeeded") {
          stop();
          const referenceVideo = job.referenceVideo || job.result?.referenceVideo;
          if (!referenceVideo?.referenceVideoId) {
            reject(new Error("参考视频检查完成但缺少 referenceVideoId"));
            return;
          }
          resolve(referenceVideo);
          return;
        }
        if (job.status === "failed") {
          stop();
          reject(new Error(job.error?.message || "参考视频检查失败"));
          return;
        }
        schedule(POLL_INTERVAL_MS);
      } catch (error) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= 3) {
          stop();
          reject(error);
          return;
        }
        els.referenceUploadStatus.textContent = `参考视频检查查询失败，正在重试：${error.message}`;
        schedule(pollRetryDelayMs(consecutivePollFailures));
      }
    }
    els.referenceUploadStatus.textContent = "视频已上传，正在后台检查参考视频...";
    renderVideoPreview(localPreviewUrl);
    schedule(300);
  });
}

async function uploadReferenceVideo() {
  const file = els.referenceFile?.files?.[0];
  if (!file) return;
  const localUrl = URL.createObjectURL(file);
  renderVideoPreview(localUrl);
  els.referenceUploadStatus.textContent = "正在计算文件指纹...";
  log(`参考视频已选择，正在上传：${file.name || "未命名视频"}`);
  renderTasks();
  try {
    const fileHash = await fileSha256Hex(file);
    els.referenceUploadStatus.textContent = "正在检查是否可复用已有参考视频...";
    const reuse = await api("/api/wangzhuan/reference-videos/reuse-check", {
      method: "POST",
      body: JSON.stringify({
        fileHash,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size
      })
    });
    if (reuse?.hit && reuse.referenceVideo) {
      state.referenceVideo = reuse.referenceVideo;
      resetDecompositionDraft({ clearForm: true });
      ensureBatchName();
      renderVideoPreview(state.referenceVideo.previewUrl || localUrl);
      els.referenceUploadStatus.textContent = "已复用已有参考视频";
      els.referenceBox.textContent = `${state.referenceVideo.referenceVideoId} · ${state.referenceVideo.durationSec || "-"}s · ${state.referenceVideo.ratio || "-"}`;
      els.draftDecompositionBtn.disabled = false;
      renderTasks();
      log(`参考视频已复用：${state.referenceVideo.referenceVideoId}`);
      startDecompositionJob().catch((error) => {
        els.decompositionStatus.hidden = false;
        els.decompositionStatus.textContent = `自动启动拆解失败：${error.message}`;
        log(`自动启动拆解失败：${error.message}`);
        renderTasks();
      });
      return;
    }

    els.referenceUploadStatus.textContent = "正在上传参考视频...";
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("fileName", file.name);
    form.append("mimeType", file.type || "application/octet-stream");
    form.append("fileHash", fileHash);
    form.append("sizeBytes", String(file.size || 0));
    els.referenceUploadStatus.textContent = "正在上传参考视频，上传完成后将转入后台检查...";
    const job = await api("/api/wangzhuan/reference-videos/check-jobs", {
      method: "POST",
      headers: {},
      body: form
    });
    state.referenceVideoCheckJob = job;
    log("参考视频上传完成，后台检查任务已提交");
    const referenceVideo = await pollReferenceVideoCheckJob(job.referenceVideoCheckJobId || job.id, localUrl);
    state.referenceVideo = referenceVideo;
    resetDecompositionDraft({ clearForm: true });
    ensureBatchName();
    renderVideoPreview(state.referenceVideo.previewUrl || localUrl);
    els.referenceUploadStatus.textContent = "参考视频已上传并检查完成";
    els.referenceBox.textContent = `${state.referenceVideo.referenceVideoId} · ${state.referenceVideo.durationSec || "-"}s · ${state.referenceVideo.ratio || "-"}`;
    els.draftDecompositionBtn.disabled = false;
    renderTasks();
    log("参考视频检查完成");
    startDecompositionJob().catch((error) => {
      els.decompositionStatus.hidden = false;
      els.decompositionStatus.textContent = `自动启动拆解失败：${error.message}`;
      log(`自动启动拆解失败：${error.message}`);
      renderTasks();
    });
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
  return validateImageOnlyEndingAsset(input, assetKey) && validateAssetAppendLimit(input, assetKey);
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
  const region = regionValue();
  const language = languageValue();
  const branches = collectBranchDrafts();
  const active = branches[state.activeBranchIndex] || branches[0] || {};
  return {
    productName: value(els.productName),
    productLink: value(els.productLink),
    assets: branches.flatMap((branch) => Object.keys(branch.assetFileNames || {}).map((assetKey) => ({
      branchId: branch.branchId,
      assetKey,
      fileName: branch.assetFileNames?.[assetKey] || "",
      storageKey: branch.assetStorageKeys?.[assetKey] || "",
      storedPath: branch.assetStoredPaths?.[assetKey] || "",
      contentHash: branch.assetContentHashes?.[assetKey] || "",
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
    outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
    sliceStrategy: AUTO_SLICE_STRATEGY,
    targetSegmentCount: targetSegmentCountValue(),
    moneyVisuals: active.moneyVisuals || DEFAULT_MONEY_VISUALS,
    subtitleWorkflow: active.subtitleWorkflow || value(els.subtitleWorkflow),
    voiceoverStyle: value(els.voiceoverStyle),
    promiseLevel: value(els.promiseLevel),
    truthRules: collectTruthRules(),
    currencySymbol: currencyValue(),
    decomposition: currentDecomposition(),
    cta: value(els.cta),
    ending: value(els.ending),
    variantPrompt: value(els.variantPrompt),
    customPrompt: value(els.customPrompt),
    negativePrompt: value(els.negativePrompt),
    branches
  };
}

function estimateRequest() {
  const region = regionValue();
  const language = languageValue();
  const disclaimerFields = disclaimerRequestFields();
  const branches = collectBranchDrafts();
  const active = branches[state.activeBranchIndex] || branches[0] || {};
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
    durationSec: compatibleDurationSecValue(),
    targetSegmentCount: targetSegmentCountValue(),
    variantCount: variantCountValue(),
    requestedConcurrency: Number(value(els.requestedConcurrency) || 1),
    outputRatio: value(els.outputRatio),
    seedanceModel: selectedSeedanceModel(),
    decomposition: currentDecomposition(),
    postProcess: postProcessRequestFields(),
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
        outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
        sliceStrategy: AUTO_SLICE_STRATEGY,
        targetSegmentCount: targetSegmentCountValue(),
        moneyVisuals: active.moneyVisuals || DEFAULT_MONEY_VISUALS,
        subtitleWorkflow: active.subtitleWorkflow || value(els.subtitleWorkflow),
        voiceoverStyle: value(els.voiceoverStyle),
        promiseLevel: value(els.promiseLevel),
        truthRules: collectTruthRules(),
        currencySymbol: currencyValue(),
        cta: value(els.cta),
        ending: value(els.ending),
        variantPrompt: value(els.variantPrompt),
        customPrompt: value(els.customPrompt),
        negativePrompt: value(els.negativePrompt),
        defaultDurationSec: compatibleDurationSecValue(),
        defaultOutputRatio: value(els.outputRatio) || "9:16",
        seedanceModel: selectedSeedanceModel(),
        postProcess: postProcessRequestFields(),
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
    targetSegmentCount: branch.targetSegmentCount || draft.targetSegmentCount || FOLLOW_DECOMPOSITION_SEGMENT_COUNT,
    defaultOutputRatio: branch.defaultOutputRatio || draft.defaultOutputRatio || "9:16",
    promiseLevel: branch.promiseLevel || draft.promiseLevel || "stable",
    truthRules: branch.truthRules || draft.truthRules || {},
    materialDirection: branch.materialDirection || draft.materialDirection || "other",
    materialDirectionCustom: branch.materialDirectionCustom || draft.materialDirectionCustom || "跟随竞品",
    outputTemplateMode: AUTO_OUTPUT_TEMPLATE_MODE,
    sliceStrategy: AUTO_SLICE_STRATEGY,
    moneyVisuals: branch.moneyVisuals || draft.moneyVisuals || DEFAULT_MONEY_VISUALS,
    subtitleWorkflow: branch.subtitleWorkflow || draft.subtitleWorkflow || "post_process",
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
  els.duration.value = String(draft.targetSegmentCount || FOLLOW_DECOMPOSITION_SEGMENT_COUNT);
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
    state.currentUserId = data.user?.userId || data.user?.username || "current-user";
    els.badge.textContent = data.user?.displayName || data.user?.username || "已登录";
    els.logoutBtn.hidden = false;
    hideLogin();
    return true;
  } else {
    state.currentUserId = "";
    els.badge.textContent = "未登录";
    els.logoutBtn.hidden = true;
    showLogin();
    return false;
  }
}

function renderBatchDetail(detail) {
  segmentRecoveryController.update(detail);
  const batch = detail?.batch || detail || null;
  if (els.segmentRecoveryState) {
    const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
    const ready = tasks.filter((task) => ["ready", "replacement_ready"].includes(task.availability)).length;
    els.segmentRecoveryState.textContent = batch?.batchId ? `${ready}/${tasks.length} 个片段可用` : "";
  }
  renderTasks();
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
  const planUpstreamLocked = hasConfirmedVideoGeneration(batch);
  setPlanUpstreamLocked(planUpstreamLocked);
  const planRetryable = isRecoverableBackgroundJob(state.planJob);
  const planJobRunning = ["queued", "running"].includes(state.planJob?.status);
  const codexTestRunning = ["queued", "running"].includes(state.codexPromptTestJob?.status);
  const planBlockedByRewrite = !state.rewriteConfirmed;
  const planBlockedByDecomposition = !decompositionReady;
  const planDisabled = planRetryable
    ? false
    : (planJobRunning || planUpstreamLocked || planBlockedByRewrite || planBlockedByDecomposition || codexTestRunning);
  els.planBatchBtn.disabled = planDisabled;
  if (planRetryable) {
    els.planBatchBtn.title = "后台任务可能仍在运行，可重试查询 prompt 结果";
  } else if (planJobRunning) {
    els.planBatchBtn.title = state.planJob?.message || "Seedance prompt 正在生成";
  } else if (codexTestRunning) {
    els.planBatchBtn.title = "测试版 Seedance prompt 正在生成，请等待完成后再走正式生成";
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
  if (els.codexPromptTestBtn) {
    els.codexPromptTestBtn.disabled = codexTestRunning || !state.referenceVideo?.referenceVideoId || !value(els.productName) || !decompositionReady;
    els.codexPromptTestBtn.textContent = codexTestRunning ? "测试版 Seedance 生成中..." : "测试生成 Seedance Prompt";
    if (codexTestRunning) {
      els.codexPromptTestBtn.title = state.codexPromptTestJob?.message || "测试版 Seedance prompt 任务进行中";
    } else if (!state.referenceVideo?.referenceVideoId) {
      els.codexPromptTestBtn.title = "请先上传参考视频";
    } else if (!value(els.productName)) {
      els.codexPromptTestBtn.title = "请先填写产品名";
    } else if (!decompositionReady) {
      els.codexPromptTestBtn.title = "请先完成 AI 拆解或手动填写脚本拆解";
    } else {
      els.codexPromptTestBtn.title = "测试入口，不会替换正式 Seedance prompt 流程";
    }
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
  stopBatchPolling();
  const detail = await loadBatchDetail(id);
  if (!detail) return;
  restoreV2FromBatchDetail(detail);
  const batch = state.batchDetail?.batch || state.batchDetail || {};
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  els.runStatusBox.textContent = `${batch.batchId || id} · ${batch.status || "-"} · ${tasks.length} 子任务 · ${outputs.length} 输出`;
  log(`已加载最近结果摘要详情：${id}`);
  const followSegmentRecovery = hasPendingSegmentRecovery(detail);
  if (!TERMINAL_BATCH_STATUSES.has(batch.status) || followSegmentRecovery) {
    startBatchPolling(batch.batchId || id, { followSegmentRecovery });
  }
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
    els.decompositionStatus.hidden = false;
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

function isRecoverableJobPollError(error) {
  const status = Number(error?.status || 0);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function pollRetryDelayMs(consecutiveFailures) {
  const exponent = Math.max(0, Math.min(3, Number(consecutiveFailures || 1) - 1));
  const delay = POLL_RETRY_BASE_MS * (2 ** exponent);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(POLL_RETRY_MAX_MS, delay + jitter);
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
    els.decompositionStatus.hidden = false;
    els.decompositionStatus.textContent = recoverableMessage;
  } else {
    state.planJob = job;
    els.planBatchBtn.disabled = false;
  }
  log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}查询中断：${recoverableMessage}`);
  renderTasks();
}

function markBackgroundJobSlow(type, message, data = {}) {
  // 软超时降级提示：轮询仍在后台继续，不标记为可恢复/需重试，避免误导用户手动干预。
  const existing = type === "decomposition" ? state.decompositionJob : state.planJob;
  const job = {
    id: data.jobId || existing?.id || "",
    type,
    status: "running",
    progress: type === "decomposition" ? 30 : 90,
    message: message || "后台任务仍在运行，正在继续等待结果…",
    error: null,
    result: null,
    events: []
  };
  if (type === "decomposition") {
    state.decompositionJob = job;
    els.decompositionStatus.hidden = false;
    els.decompositionStatus.textContent = message || "AI 拆解耗时较长，后台仍在运行，正在继续等待结果…";
  } else {
    state.planJob = job;
  }
  log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}耗时较长，仍在后台运行：${message}`);
  renderTasks();
}

function syncBackgroundJobActionButtons() {
  const planRetryable = isRecoverableBackgroundJob(state.planJob);
  const decompositionRetryable = isRecoverableBackgroundJob(state.decompositionJob);
  if (els.planBatchBtn) {
    els.planBatchBtn.textContent = planRetryable
      ? backgroundJobRetryLabel("plan")
      : state.stalePlanPreview ? "重新生成 Seedance prompt" : "生成 Seedance prompt";
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
    els.decompositionStatus.hidden = false;
    els.decompositionStatus.textContent = "正在重新查询拆解结果";
    renderTasks();
    pollJob("decomposition", job.id, {
      timeoutMs: decompositionJobTimeoutWindowMs(model),
      timeoutLabel: isGeminiDecompositionModel(model)
        ? "Gemini 拆解耗时较长，后台仍在运行，正在继续等待结果…"
        : `任务已超过 ${Math.round(decompositionJobTimeoutWindowMs(model) / 1000)} 秒，后台仍在运行，正在继续等待结果…`
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
    els.decompositionStatus.hidden = false;
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
    .filter(([assetKey, review]) => branchHasReferenceAsset(branch, assetKey) && review?.status && !isAssetReviewApproved(review.status))
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
      const keys = branchAssetEntryKeys(branch, assetKey);
      const uploadedKeys = [];
      for (const entryKey of keys) {
        if (branch.assetStorageKeys?.[entryKey]) {
          clearPendingAssetFile(branch.branchId, entryKey);
          continue;
        }
        const file = getPendingAssetFile(branch.branchId, entryKey);
        if (!file) continue;
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
        clearPendingAssetFile(branch.branchId, entryKey);
        uploadedKeys.push(entryKey);
        log(`${entryKey} 已上传并完成审核状态记录`);
      }
      const lastKey = uploadedKeys.at(-1) || keys.at(-1) || "";
      syncAssetInputDataset(input, branch, lastKey);
      if (input) input.value = "";
      renderAssetReviewState();
    }
    await markPlanMaybeStale();
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
  renderBatchDetail(state.batchDetail);
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
  renderBatchDetail(state.batchDetail);
}

async function startDecompositionJob() {
  if (retryBackgroundJobPoll("decomposition")) return;
  if (!state.referenceVideo?.referenceVideoId) return;
  if (["queued", "running"].includes(state.decompositionJob?.status)) return;
  const model = selectedDecompositionModel();
  const timeoutMs = decompositionTimeoutMs(model);
  const maxRetries = decompositionMaxRetries(model);
  state.decompositionEditedFields.clear();
  els.draftDecompositionBtn.disabled = true;
  els.decompositionStatus.hidden = true;
  els.decompositionStatus.textContent = "";
  const job = await api("/api/wangzhuan/reference-videos/decomposition-jobs", {
    method: "POST",
    body: JSON.stringify({
      referenceVideoId: state.referenceVideo.referenceVideoId,
      batchId: currentBatchId() || undefined,
      fileHash: state.referenceVideo.fileHash || "",
      language: languageValue(),
      targetRegion: regionValue(),
      targetRegions: [regionValue()].filter(Boolean),
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
      ? "Gemini 拆解耗时较长，后台仍在运行，正在继续等待结果…"
      : `任务已超过 ${Math.round(decompositionJobTimeoutWindowMs(model) / 1000)} 秒，后台仍在运行，正在继续等待结果…`
  });
}

async function startPlanJob() {
  if (retryBackgroundJobPoll("plan")) return;
  els.planBatchBtn.disabled = true;
  assertSeedanceReferenceAssetLimit();
  const estimateResult = state.stalePlanPreview || !state.estimate?.estimateId
    ? await estimateBatch()
    : state.estimate;
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
  renderTasks();
  pollJob("plan", job.planJobId);
}

async function startCodexPromptTestJob() {
  clearError();
  if (!state.referenceVideo?.referenceVideoId) {
    showError({ message: "请先上传参考视频" }, "测试版 Seedance prompt 提交失败");
    return;
  }
  if (!value(els.productName)) {
    showError({ message: "请先填写产品名" }, "测试版 Seedance prompt 提交失败");
    return;
  }
  if (!currentDecomposition()) {
    showError({ message: "请先完成 AI 拆解或手动填写脚本拆解" }, "测试版 Seedance prompt 提交失败");
    return;
  }
  if (["queued", "running"].includes(state.codexPromptTestJob?.status)) return;
  await uploadSeedanceAssetsForReview();
  const draft = await saveDraftBatch("codex_prompt_test");
  const batchId = draft?.batch?.batchId || currentBatchId();
  if (!batchId) {
    throw new WangzhuanApiError({
      code: "batch_not_found",
      message: "当前批次不存在，无法发起测试版 Seedance prompt 生成"
    }, 404);
  }
  const body = {
    requestId: `wzv2-codex-test-${Date.now()}`,
    productLink: value(els.codexTestStoreLink) || value(els.productLink)
  };
  const job = await api(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/auto-seedance-prompt-jobs`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  state.codexPromptTestJob = job;
  log("测试版 Seedance prompt 任务已提交");
  renderTasks();
  pollCodexPromptTestJob(batchId, job.autoSeedancePromptJobId);
}

async function pollCodexPromptTestJob(batchId, jobId) {
  const path = `/api/wangzhuan/batches/${encodeURIComponent(batchId)}/auto-seedance-prompt-jobs/${encodeURIComponent(jobId)}`;
  const timer = setInterval(async () => {
    try {
      const job = await api(path);
      state.codexPromptTestJob = job;
      if (job.status === "succeeded") {
        clearInterval(timer);
        state.codexPromptTestResult = {
          ...(job.promptDraft || job.result?.promptDraft || {}),
          mode: job.result?.mode || "",
          approvedAssetCount: job.result?.approvedAssetCount,
          referencedAssetCount: job.result?.referencedAssetCount
        };
        renderPlanEditors(Array.isArray((state.batchDetail?.batch || state.batchDetail || {}).plans) ? (state.batchDetail?.batch || state.batchDetail || {}).plans : []);
        log("测试版 Seedance prompt 完成");
      } else if (job.status === "failed") {
        clearInterval(timer);
        state.codexPromptTestResult = null;
        log(`测试版 Seedance prompt 失败：${job.error?.message || "未知错误"}`);
      }
      renderTasks();
    } catch (error) {
      clearInterval(timer);
      state.codexPromptTestJob = {
        id: jobId,
        status: "failed",
        message: error.message || "请求失败",
        error: {
          code: error.code || "job_poll_failed",
          message: error.message || "请求失败"
        }
      };
      state.codexPromptTestResult = null;
      log(`测试版 Seedance prompt 查询失败：${error.message}`);
      renderTasks();
    }
  }, POLL_INTERVAL_MS);
}

async function pollJob(type, jobId, options = {}) {
  const path = type === "decomposition"
    ? `/api/wangzhuan/reference-videos/decomposition-jobs/${encodeURIComponent(jobId)}`
    : `/api/wangzhuan/batches/plan-jobs/${encodeURIComponent(jobId)}`;
  const startedAt = Date.now();
  const softTimeoutMs = type === "decomposition" ? (options.timeoutMs || decompositionJobTimeoutWindowMs()) : 0;
  let stopped = false;
  let slowNoticeShown = false;
  let consecutivePollFailures = 0;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
  };
  const schedule = (delay) => {
    if (stopped) return;
    timer = window.setTimeout(tick, delay);
  };

  async function tick() {
    if (stopped) return;
    // 软超时：过窗后不放弃，只在首次跨过时给一次降级提示，然后降频继续轮询。
    const overSoftWindow = Boolean(softTimeoutMs) && Date.now() - startedAt > softTimeoutMs;
    if (overSoftWindow && !slowNoticeShown) {
      slowNoticeShown = true;
      markBackgroundJobSlow(type, options.timeoutLabel || `任务已超过 ${Math.round(softTimeoutMs / 1000)} 秒，后台仍在运行，正在继续等待结果…`, { jobId });
    }
    try {
      const job = await api(path);
      if (consecutivePollFailures > 0) {
        log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}查询已恢复`);
        consecutivePollFailures = 0;
      }
      if (type === "decomposition") state.decompositionJob = job;
      if (type === "plan") state.planJob = job;
      if (job.status === "succeeded") {
        stop();
        if (type === "decomposition") {
          state.decompositionDraft = job.decomposition || {};
          renderDecompositionForm(state.decompositionDraft, { preserveUserInput: true });
          els.draftDecompositionBtn.disabled = hasConfirmedVideoGeneration();
          els.decompositionStatus.hidden = false;
          els.decompositionStatus.textContent = state.decompositionEditedFields.size
            ? "AI 结果可用，已回填未手动编辑字段，后续估算会直接读取当前表单；如需调整，可重新拆解。"
            : "AI 结果可用，已回填到页面，后续估算会直接读取当前表单；如需调整，可重新拆解。";
          if (job.result?.draft?.source === "cache") {
            els.decompositionStatus.textContent = "命中拆解缓存，已快速回填到页面；如需调整，可重新拆解。";
          }
        } else {
          const plans = Array.isArray(job.plans) && job.plans.length
            ? job.plans
            : (Array.isArray(job.batch?.plans) ? job.batch.plans : []);
          if (job.batch) {
            state.batchDetail = {
              ...(state.batchDetail && typeof state.batchDetail === "object" ? state.batchDetail : {}),
              batch: {
                ...job.batch,
                plans: plans.length ? plans : (job.batch.plans || [])
              }
            };
          }
          state.draftSignature = job.draftSignature || state.draftSignature;
          state.stalePlanPreview = state.draftSignature !== await clientPlanDraftSignature();
          renderPlanEditors(plans);
        }
        log(`${type === "decomposition" ? "AI 拆解" : "Seedance prompt"}完成`);
        if (type === "plan" && job.batch) renderBatchDetail(state.batchDetail);
        else renderTasks();
        return;
      }
      if (job.status === "failed") {
        stop();
        if (type === "plan") setPlanUpstreamLocked(false);
        failBackgroundJob(type, job.error?.message || "未知错误", {
          ...(job.error?.data || {}),
          code: job.error?.code || "job_failed",
          jobId
        });
        return;
      }
      renderTasks();
      schedule(overSoftWindow ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    } catch (error) {
      if (!isRecoverableJobPollError(error)) {
        stop();
        markBackgroundJobPollFailure(type, error.message, {
          code: error.code || "job_poll_failed",
          jobId
        });
        return;
      }
      consecutivePollFailures += 1;
      const label = type === "decomposition" ? "AI 拆解" : "Seedance prompt";
      const message = `${label}查询暂时断开，正在自动重试（第 ${consecutivePollFailures} 次）`;
      const existing = type === "decomposition" ? state.decompositionJob : state.planJob;
      const retryingJob = {
        ...(existing || {}),
        id: jobId,
        type,
        status: "running",
        message,
        error: null
      };
      if (type === "decomposition") state.decompositionJob = retryingJob;
      if (type === "plan") state.planJob = retryingJob;
      if (consecutivePollFailures === 1) log(message);
      renderTasks();
      schedule(pollRetryDelayMs(consecutivePollFailures));
    }
  }

  schedule(POLL_INTERVAL_MS);
}

function applyBatchDetail(data) {
  state.batchDetail = data;
  logTaskFailureDetails(data?.batch || data || {});
  renderBatchDetail(data);
}

async function loadBatchDetail(batchId, options = {}) {
  if (!batchId) return null;
  const loadOwner = options.apply === false ? 0 : ++batchDetailLoadOwner;
  const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  if (options.apply !== false && loadOwner !== batchDetailLoadOwner) return null;
  if (options.apply !== false && loadOwner === batchDetailLoadOwner) applyBatchDetail(data);
  return data;
}

function startBatchPolling(batchId, options = {}) {
  window.clearTimeout(batchPollTimer);
  const pollOwner = ++batchPollOwner;
  batchPollNetworkErrorActive = false;
  let lastStatus = "";
  const tick = async () => {
    try {
      const detail = await loadBatchDetail(batchId, { apply: false });
      if (pollOwner !== batchPollOwner) return;
      applyBatchDetail(detail);
      if (batchPollNetworkErrorActive) {
        log("批次轮询已恢复");
        batchPollNetworkErrorActive = false;
      }
      const status = detail?.batch?.status;
      const followSegmentRecovery = options.followSegmentRecovery && hasPendingSegmentRecovery(detail);
      if (!TERMINAL_BATCH_STATUSES.has(status) || followSegmentRecovery) {
        batchPollTimer = window.setTimeout(tick, 2000);
      } else if (status && status !== lastStatus) {
        log(`批次已进入终态：${status}`);
      }
      lastStatus = status || lastStatus;
    } catch (error) {
      if (pollOwner !== batchPollOwner) return;
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

function stopBatchPolling() {
  batchPollOwner += 1;
  window.clearTimeout(batchPollTimer);
  batchPollTimer = 0;
}

async function restoreWorkbenchFromUrl() {
  const restoreRequest = readWorkbenchRestoreRequest();
  if (!restoreRequest?.id) return false;
  if (restoreRequest.type === "remix") {
    const projectParam = restoreRequest.projectKey ? `&projectKey=${encodeURIComponent(restoreRequest.projectKey)}` : "";
    location.href = `/competitor-remix.html?restore=1&remixId=${encodeURIComponent(restoreRequest.id)}${projectParam}#remixNodeDelivery`;
    return true;
  }
  stopBatchPolling();
  await switchProjectScope(restoreRequest.projectKey);
  const detail = await loadBatchDetail(restoreRequest.id);
  if (!detail) return false;
  const restored = restoreV2FromBatchDetail(detail);
  const batch = detail?.batch || detail || {};
  if (restored) {
    log(`已从任务管理恢复批次：${batch.batchId || restoreRequest.id}`);
    await restoreBackgroundJobFromRequest(restoreRequest);
    const followSegmentRecovery = hasPendingSegmentRecovery(detail);
    if (batch.batchId && (!TERMINAL_BATCH_STATUSES.has(batch.status) || followSegmentRecovery)) {
      startBatchPolling(batch.batchId, { followSegmentRecovery });
    }
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
  const validateDraftSignature = shouldValidatePlanSignature(batch);
  try {
    const data = await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/confirm-plan`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `wzv2-confirm-${Date.now()}`,
        planIds: plans.map((plan) => plan.planId).filter(Boolean),
        confirmedPlanIds: plans.map((plan) => plan.planId).filter(Boolean),
        plans,
        branchDrafts: estimateRequest().branches,
        postProcess: postProcessRequestFields(),
        draftSignature: validateDraftSignature ? state.draftSignature : undefined,
        draftSignatureInput: validateDraftSignature ? planSignatureInput() : undefined
      })
    });
    state.batchDetail = data.batch ? data : { batch: data.confirmedBatch || batch };
    log("Seedance prompt 已确认，已提交 Seedance 生成");
    renderBatchDetail(state.batchDetail);
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
  batchDetailLoadOwner += 1;
  await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/stop`, {
    method: "POST",
    body: JSON.stringify({ reason: "wzv2_frontend_stop" })
  });
  const currentBatch = state.batchDetail?.batch || state.batchDetail;
  if (currentBatch?.batchId !== batch.batchId) return;
  stopBatchPolling();
  const detail = await loadBatchDetail(batch.batchId);
  if (!detail) return;
  log("批次已停止");
}

async function runVideoQc() {
  const batch = state.batchDetail?.batch || state.batchDetail;
  if (!batch?.batchId) return;
  batchDetailLoadOwner += 1;
  await api(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/qc`, {
    method: "POST",
    body: JSON.stringify({})
  });
  const currentBatch = state.batchDetail?.batch || state.batchDetail;
  if (currentBatch?.batchId !== batch.batchId) return;
  const detail = await loadBatchDetail(batch.batchId);
  if (!detail) return;
  log("视频质检已执行");
}

function startNewTask() {
  stopBatchPolling();
  batchDetailLoadOwner += 1;
  setPlanUpstreamLocked(false);
  state.referenceVideo = null;
  resetDecompositionDraft({ clearForm: true });
  state.estimate = null;
  state.planJob = null;
  state.codexPromptTestJob = null;
  state.codexPromptTestResult = null;
  state.batchDetail = null;
  state.rewriteConfirmed = false;
  state.activeBranchIndex = 0;
  state.branches = [defaultBranchDraft(0)];
  state.branchDraft = state.branches[0];
  state.draftSignature = "";
  state.stalePlanPreview = false;
  state.loggedTaskFailures = new Set();
  state.postProcessEndingAsset = null;
  if (els.postProcessSubtitles) els.postProcessSubtitles.checked = true;
  syncSubtitleStyleControls({ fontSize: 40, centerY: 960, textColor: "white" });
  state.expansionSizes = [];
  $("#wzBatchName").value = generatedBatchName();
  els.referenceFile.value = "";
  renderVideoPreview("");
  els.referenceBox.textContent = "未上传参考视频";
  els.referenceUploadStatus.textContent = "选中文件后自动上传、检查和预览。";
  els.draftDecompositionBtn.disabled = true;
  els.decompositionStatus.hidden = false;
  els.decompositionStatus.textContent = "上传参考视频后可启动后台拆解。";
  els.estimateBox.textContent = "估算结果：待估算。";
  renderPlanEditors([]);
  resetAssetInputDatasets();
  loadBranchToForm(state.branchDraft);
  renderBranchTabs();
  renderAssetReviewState();
  renderPostProcessEndingPreview();
  renderExpansionSizes();
  clearError();
  log("已开始新任务");
  renderBatchDetail(null);
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
  if (!shouldValidatePlanSignature()) {
    state.stalePlanPreview = false;
    renderTasks();
    return;
  }
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
  markPlanMaybeStale();
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
els.targetRegion?.addEventListener("change", syncRegionCustom);
els.language?.addEventListener("change", syncLanguageCustom);
els.truthFields?.addEventListener("input", markPlanMaybeStale);
els.truthFields?.addEventListener("change", markPlanMaybeStale);
$("#wzDisclaimerOverlayFile")?.addEventListener("change", () => uploadDisclaimerOverlayAsset().catch((error) => showError(error, "贴片上传失败")));
els.postProcessEndingFile?.addEventListener("change", () => uploadPostProcessEnding().catch((error) => showError(error, "Ending 上传失败")));
els.postProcessEndingRemove?.addEventListener("click", removePostProcessEnding);
for (const input of document.querySelectorAll("[data-expansion-preset]")) {
  input.addEventListener("change", () => {
    const [width, height] = String(input.dataset.expansionPreset || "").split("x").map(Number);
    if (input.checked) addExpansionSize(width, height);
    else removeExpansionSize(input.dataset.expansionPreset || "");
  });
}
els.expansionAddCustom?.addEventListener("click", () => {
  try {
    addExpansionSize(value(els.expansionCustomWidth), value(els.expansionCustomHeight));
    els.expansionCustomWidth.value = "";
    els.expansionCustomHeight.value = "";
  } catch (error) {
    showError(error, "添加扩展尺寸失败");
  }
});
els.expansionSelectedSizes?.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-remove-expansion-size]");
  if (button) removeExpansionSize(button.dataset.removeExpansionSize || "");
});
els.planBatchBtn?.addEventListener("click", () => startPlanJob().catch((error) => showError(error, "prompt 任务提交失败")));
els.codexPromptTestBtn?.addEventListener("click", () => startCodexPromptTestJob().catch((error) => showError(error, "测试版 Seedance prompt 提交失败")));
els.confirmPlanBtn?.addEventListener("click", () => confirmPlanAndGenerate().catch((error) => showError(error, "确认 prompt 失败")));
els.stopBatchBtn?.addEventListener("click", () => stopBatch().catch((error) => showError(error, "停止失败")));
els.runQcBtn?.addEventListener("click", () => runVideoQc().catch((error) => showError(error, "视频质检失败")));
els.saveDraftBtn?.addEventListener("click", () => saveDraftBatch().catch((error) => showError(error, "草稿保存失败")));
els.postProcessSubtitles?.addEventListener("change", () => syncSubtitleStyleControls());
els.subtitleTextColor?.addEventListener("change", () => syncSubtitleStyleControls());
for (const control of [
  els.subtitleFontSizeRange,
  els.subtitleFontSizeNumber,
  els.subtitleCenterYRange,
  els.subtitleCenterYNumber
]) {
  control?.addEventListener("input", () => syncSubtitleStyleControls({}, control));
  control?.addEventListener("change", () => syncSubtitleStyleControls({}, control));
}
els.uploadSeedanceAssetsBtn?.addEventListener("click", () => uploadSeedanceAssetsForReview().catch((error) => showError(error, "Seedance 素材上传失败")));
els.loadOlderLogsBtn?.addEventListener("click", loadOlderLogs);
els.refreshRecentBtn?.addEventListener("click", () => loadRecentResults(1).catch((error) => showError(error, "最近结果加载失败")));
els.productLibrarySelect?.addEventListener("change", () => {
  showSelectedProductLibraryDetail().catch((error) => showError(error, "产品库详情加载失败"));
});
els.applyProductLibraryBtn?.addEventListener("click", () => {
  applySelectedProductLibrary().catch((error) => showError(error, "应用产品库失败"));
});
for (const [assetKey, selector] of assetInputs) {
  const input = $(selector);
  input?.addEventListener("change", (event) => {
    if (!validateAssetInputLimit(event.target, assetKey)) return;
    commitSelectedAssetFiles(event.target, assetKey);
  });
  input?.closest(".wz-asset-slot")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-remove-asset-key]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    removeBranchAssetEntry(button.dataset.removeAssetKey || "");
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
  els.targetRegionCustom,
  els.materialDirection,
  els.materialDirectionCustom,
  els.outputTemplateMode,
  els.sliceStrategy,
  els.moneyVisuals,
  els.subtitleWorkflow,
  els.voiceoverStyle,
  els.promiseLevel,
  els.currencySymbol,
  els.currencyCustom,
  els.languageCustom,
  els.cta,
  els.ending,
  els.variantPrompt,
  els.customPrompt,
  els.negativePrompt
]) {
  el?.addEventListener("change", markPlanMaybeStale);
  el?.addEventListener("input", markPlanMaybeStale);
}

els.language?.addEventListener("change", () => {
  renderDisclaimerOverlayPreview();
  renderTasks();
  markPlanMaybeStale();
});
for (const el of [els.languageCustom]) {
  el?.addEventListener("change", () => {
    renderDisclaimerOverlayPreview();
    renderTasks();
    markPlanMaybeStale();
  });
  el?.addEventListener("input", () => {
    renderDisclaimerOverlayPreview();
    renderTasks();
    markPlanMaybeStale();
  });
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
syncRegionCustom();
syncLanguageCustom();
syncCurrencyCustom();
syncTruthDetails();
syncGeminiDecompositionHint();
renderBranchTabs();
renderAssetReviewState();
renderPlanEditors([]);
renderDisclaimerOverlayPreview();
renderPostProcessEndingPreview();
syncSubtitleStyleControls({ fontSize: 40, centerY: 960, textColor: "white" });
renderExpansionSizes();
renderTasks();
renderLogs();
renderRecentResults();
renderTemplates();
renderProductLibrarySelect();
renderProductLibraryDetail(null);
loadAuth()
  .then(async (authenticated) => {
    if (!authenticated) return null;
    await loadTemplates();
    await Promise.all([
      loadProductLibrary(),
      loadRecentResults(1),
      restoreWorkbenchFromUrl()
    ]);
    return null;
  })
  .catch((error) => showError(error, "初始化失败"));
