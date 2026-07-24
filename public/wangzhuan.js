import {
  $,
  apiEnvelope,
  apiEnvelopeStream,
  badge,
  batchGenerationProgress,
  batchRuntimeSummary,
  formatTimestamp,
  batchGenerationTaskStatusLabels,
  batchStatusDisplayLabel,
  batchStatusLabels,
  branchPlanCoverage,
  formatWorkflowEvent,
  isBatchGenerationActive,
  isBatchQcRunnable,
  modelQcStatusLabel,
  renderGenerationTaskCards,
  bindLogin,
  channelLabels,
  clearError,
  confirmBatchPlanRequest,
  dataUrlFromFile,
  downloadZip,
  escapeHtml,
  flattenDecompositionFieldValue,
  idempotencyKey,
  inlineRetryHtml,
  promiseLabels,
  renderError,
  renderFailureReasons,
  renderKeyValues,
  bindPreviewInteractionGuard,
  galleryStateFingerprint,
  outputPreviewItemsFingerprint,
  patchOutputPreviewCards,
  restorePreviewPlayback,
  setBusy,
  showErrorModal,
  showLogin,
  showToast,
  notifyBatchQcResult,
  applyQcReportsToBatch,
  snapshotPreviewPlayback,
  syncActionHint,
  readWorkbenchRestoreRequest,
  taskSpaceHref,
  taskProgressHtml,
  strongTruthFields,
  terminalBatchStatus,
  activeLockLabel
} from "./wangzhuan-common.js";
import {
  clearActiveLockBanner,
  renderActiveLockBanner,
  showActiveLockFromError
} from "./wangzhuan-task-nav.js";

const LLM_MODEL_OPTIONS = Object.freeze(["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gemini-3.5-flash"]);
const DEFAULT_LLM_MODEL = "gpt-5.4";

function normalizeLlmModelChoice(value, fallback = DEFAULT_LLM_MODEL) {
  const text = String(value || "").trim().toLowerCase();
  return LLM_MODEL_OPTIONS.find((item) => item.toLowerCase() === text) || fallback;
}

function setLlmModelSelect(select, value) {
  if (!select) return;
  select.value = normalizeLlmModelChoice(value);
}

const lockHost = () => ({
  state,
  actions: els.activeLockActions,
  text: els.activeLockText
});

const els = {
  badge: $("#wzCurrentUserBadge"),
  logoutBtn: $("#wzLogoutBtn"),
  loginModal: $("#wzLoginModal"),
  globalError: $("#wzGlobalError"),
  activeLockActions: $("#wzActiveLockActions"),
  activeLockText: $("#wzActiveLockText"),
  templateCount: $("#wzTemplateCount"),
  ruleCount: $("#wzRuleCount"),
  taskCount: $("#wzTaskCount"),
  downloadCount: $("#wzDownloadCount"),
  branches: $("#wzBranches"),
  templateSelect: $("#wzTemplateSelect"),
  createTemplateBtn: $("#wzCreateTemplateBtn"),
  confirmRewriteBtn: $("#wzConfirmRewriteBtn"),
  addBranchBtn: $("#wzAddBranchBtn"),
  rewriteStatus: $("#wzRewriteStatus"),
  templateSaveStatus: $("#wzTemplateSaveStatus"),
  rewriteConfirmHint: $("#wzRewriteConfirmHint"),
  projectName: $("#wzProjectName"),
  generationMode: $("#wzGenerationMode"),
  batchName: $("#wzBatchName"),
  startNewTaskBtn: $("#wzStartNewTaskBtn"),
  displayName: $("#wzDisplayName"),
  productName: $("#wzProductName"),
  productLink: $("#wzProductLink"),
  inspectStoreBtn: $("#wzInspectStoreBtn"),
  storeCandidates: $("#wzStoreCandidates"),
  cta: $("#wzCta"),
  ending: $("#wzEnding"),
  currencySymbol: $("#wzCurrencySymbol"),
  language: $("#wzLanguage"),
  languages: $("#wzLanguages"),
  regions: $("#wzRegions"),
  templateChannel: $("#wzTemplateChannel"),
  defaultDuration: $("#wzDefaultDuration"),
  promiseLevel: $("#wzPromiseLevel"),
  productIconFile: $("#wzProductIconFile"),
  productScreenshotFile: $("#wzProductScreenshotFile"),
  productRecordingFile: $("#wzProductRecordingFile"),
  ctaAssetFile: $("#wzCtaAssetFile"),
  endingAssetFile: $("#wzEndingAssetFile"),
  personAssetFile: $("#wzPersonAssetFile"),
  rewardElementFile: $("#wzRewardElementFile"),
  truthDetails: $("#wzTruthDetails"),
  truthFields: $("#wzTruthFields"),
  targetChannel: $("#wzTargetChannel"),
  targetRegion: $("#wzTargetRegion"),
  targetRegions: $("#wzTargetRegions"),
  materialDirection: $("#wzMaterialDirection"),
  materialDirectionCustom: $("#wzMaterialDirectionCustom"),
  materialDirectionCustomWrap: $("#wzMaterialDirectionCustomWrap"),
  voiceoverStyle: $("#wzVoiceoverStyle"),
  disclaimerPreset: $("#wzDisclaimerPreset"),
  disclaimerEnabled: $("#wzDisclaimerEnabled"),
  disclaimer: $("#wzDisclaimer"),
  disclaimerOverlayPosition: $("#wzDisclaimerOverlayPosition"),
  disclaimerOverlayFontSize: $("#wzDisclaimerOverlayFontSize"),
  disclaimerOverlayBoxHeight: $("#wzDisclaimerOverlayBoxHeight"),
  disclaimerOverlayBottomMargin: $("#wzDisclaimerOverlayBottomMargin"),
  disclaimerOverlayHorizontalMargin: $("#wzDisclaimerOverlayHorizontalMargin"),
  llmProvider: $("#wzLlmProvider"),
  llmModel: $("#wzLlmModel"),
  llmEndpoint: $("#wzLlmEndpoint"),
  llmTemperature: $("#wzLlmTemperature"),
  planLlmProvider: $("#wzPlanLlmProvider"),
  planLlmModel: $("#wzPlanLlmModel"),
  planLlmEndpoint: $("#wzPlanLlmEndpoint"),
  planLlmTemperature: $("#wzPlanLlmTemperature"),
  planLlmServiceStatus: $("#wzPlanLlmServiceStatus"),
  knowledgeNotes: $("#wzKnowledgeNotes"),
  variantPrompt: $("#wzVariantPrompt"),
  customPrompt: $("#wzCustomPrompt"),
  negativePrompt: $("#wzNegativePrompt"),
  loadRulesBtn: $("#wzLoadRulesBtn"),
  rulesBox: $("#wzRulesBox"),
  referenceFile: $("#wzReferenceFile"),
  referenceUploadPanel: $("#wzReferenceUploadPanel"),
  referenceUploadStatus: $("#wzReferenceUploadStatus"),
  useSampleVideoBtn: $("#wzUseSampleVideoBtn"),
  checkReferenceBtn: $("#wzCheckReferenceBtn"),
  confirmReferenceBtn: $("#wzConfirmReferenceBtn"),
  draftDecompositionBtn: $("#wzDraftDecompositionBtn"),
  decomposeBtn: $("#wzDecomposeBtn"),
  decompositionForm: $("#wzDecompositionForm"),
  decompositionHint: $("#wzDecompositionHint"),
  decompositionStatus: $("#wzDecompositionStatus"),
  llmServiceStatus: $("#wzLlmServiceStatus"),
  referenceBox: $("#wzReferenceBox"),
  duration: $("#wzDuration"),
  outputRatio: $("#wzOutputRatio"),
  variantCount: $("#wzVariantCount"),
  concurrency: $("#wzConcurrency"),
  estimateBtn: $("#wzEstimateBtn"),
  batchReadiness: $("#wzBatchReadiness"),
  estimateHint: $("#wzEstimateHint"),
  planHint: $("#wzPlanHint"),
  estimateBox: $("#wzEstimateBox"),
  confirmLimits: $("#wzConfirmLimits"),
  modelSelect: $("#wzModelSelect"),
  seedanceModel: $("#wzSeedanceModel"),
  planBatchBtn: $("#wzPlanBatchBtn"),
  confirmPlanBtn: $("#wzConfirmPlanBtn"),
  planBox: $("#wzPlanBox"),
  stopBatchBtn: $("#wzStopBatchBtn"),
  runQcBtn: $("#wzRunQcBtn"),
  retryStitchBtn: $("#wzRetryStitchBtn"),
  batchBadge: $("#wzBatchBadge"),
  batchBox: $("#wzBatchBox"),
  batchOutputsBox: $("#wzBatchOutputsBox"),
  taskArchiveBox: $("#wzTaskArchiveBox"),
  taskDetailLink: $("#wzTaskDetailLink"),
  refreshGalleryBtn: $("#wzRefreshGalleryBtn"),
  galleryBox: $("#wzGalleryBox"),
  downloadBtn: $("#wzDownloadBtn"),
  includeSegments: $("#wzIncludeSegments")
};

const state = {
  user: null,
  templates: [],
  permissions: {},
  channelRules: [],
  selectedTemplate: null,
  referenceVideo: null,
  decomposition: null,
  decompositionDraft: null,
  estimate: null,
  capabilities: null,
  batchDetail: null,
  gallery: null,
  galleryPage: 1,
  galleryPageSize: 20,
  llmDefaults: null,
  activeLock: null,
  backgroundActiveBatchId: null,
  storeInspection: null,
  templateCommitted: false,
  rewriteConfirmed: false,
  suppressTemplateUnlock: false,
  pollTimer: 0,
  pollGeneration: 0,
  runtimeClockTimer: 0,
  pollIntervalMs: 2000
};

let galleryRenderFingerprint = "";
let batchRenderFingerprint = "";
let batchOutputsRenderFingerprint = "";

let referenceObjectUrl = "";

const assetInputKeys = [
  ["productIcon", "productIconFile"],
  ["productScreenshot", "productScreenshotFile"],
  ["productRecording", "productRecordingFile"],
  ["ctaAsset", "ctaAssetFile"],
  ["endingAsset", "endingAssetFile"],
  ["personAsset", "personAssetFile"],
  ["rewardElement", "rewardElementFile"]
];

const PLAN_REFERENCE_ASSET_ORDER = Object.freeze([
  "productIcon",
  "productScreenshot",
  "rewardElement",
  "productRecording",
  "ctaAsset",
  "endingAsset",
  "personAsset"
]);

const SEEDANCE_REFERENCE_CANVAS = Object.freeze({ cols: 5, rows: 2, slots: 10 });

const branchFieldIds = {
  productName: "wzProductName",
  productLink: "wzProductLink",
  cta: "wzCta",
  language: "wzLanguage",
  languages: "wzLanguages",
  targetChannel: "wzTargetChannel",
  targetRegion: "wzTargetRegion",
  targetRegions: "wzTargetRegions",
  materialDirection: "wzMaterialDirection",
  materialDirectionCustom: "wzMaterialDirectionCustom",
  voiceoverStyle: "wzVoiceoverStyle",
  promiseLevel: "wzPromiseLevel",
  projectName: "wzProjectName",
  batchName: "wzBatchName",
  templateSelect: "wzTemplateSelect",
  displayName: "wzDisplayName",
  generationMode: "wzGenerationMode",
  templateChannel: "wzTemplateChannel",
  regions: "wzRegions",
  defaultDuration: "wzDefaultDuration",
  ending: "wzEnding",
  currencySymbol: "wzCurrencySymbol",
  productIconFile: "wzProductIconFile",
  productScreenshotFile: "wzProductScreenshotFile",
  productRecordingFile: "wzProductRecordingFile",
  ctaAssetFile: "wzCtaAssetFile",
  endingAssetFile: "wzEndingAssetFile",
  personAssetFile: "wzPersonAssetFile",
  rewardElementFile: "wzRewardElementFile",
  variantPrompt: "wzVariantPrompt",
  customPrompt: "wzCustomPrompt",
  negativePrompt: "wzNegativePrompt",
  disclaimerPreset: "wzDisclaimerPreset",
  disclaimerEnabled: "wzDisclaimerEnabled",
  disclaimer: "wzDisclaimer",
  disclaimerOverlayPosition: "wzDisclaimerOverlayPosition",
  disclaimerOverlayFontSize: "wzDisclaimerOverlayFontSize",
  disclaimerOverlayBoxHeight: "wzDisclaimerOverlayBoxHeight",
  disclaimerOverlayBottomMargin: "wzDisclaimerOverlayBottomMargin",
  disclaimerOverlayHorizontalMargin: "wzDisclaimerOverlayHorizontalMargin"
};

const DISCLAIMER_PRESETS = {
  en: "Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.",
  pt: "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos",
  zh: "奖励结果受 App 内活动规则、用户资格、任务完成情况、地区限制和活动时间影响，不保证每位用户都能获得相同奖励",
  ar: "تخضع المكافآت لقواعد التطبيق، والأهلية، وإكمال المهام، والتوافر حسب المنطقة. النتائج غير مضمونة.",
  es: "Las recompensas están sujetas a las reglas de la aplicación, los requisitos de elegibilidad, la finalización de las tareas y la disponibilidad regional. Los resultados no están garantizados.",
  fr: "Les récompenses dépendent des règles de l’application, des conditions d’éligibilité, de l’accomplissement des tâches et de la disponibilité dans la région concernée. Les résultats ne sont pas garantis.",
  de: "Prämien hängen von den Regeln der App, der Teilnahmeberechtigung, dem Abschluss von Aufgaben und der regionalen Verfügbarkeit ab. Ergebnisse werden nicht garantiert.",
  id: "Hadiah bergantung pada aturan aplikasi, kelayakan pengguna, penyelesaian tugas, dan ketersediaan regional. Hasil tidak dijamin.",
  th: "รางวัลขึ้นอยู่กับกฎของแอป การมีสิทธิ์ได้รับรางวัล การทำภารกิจให้สำเร็จ และความพร้อมให้บริการในแต่ละภูมิภาค ไม่รับประกันผลลัพธ์",
  vi: "Phần thưởng phụ thuộc vào quy định của ứng dụng, điều kiện nhận thưởng, việc hoàn thành nhiệm vụ và tình trạng khả dụng tại từng khu vực. Kết quả không được đảm bảo."
};

const DECOMPOSITION_CONFIRMED_MESSAGE = "脚本拆解已确认，请继续填写第三步产品改写。";
const REWRITE_CONFIRMED_MESSAGE = "产品改写信息已确认，可进入第四步估算本批任务。";
const REWRITE_MULTI_CONFIRMED_MESSAGE = "全部裂变子节点已确认，可进入第四步估算本批任务。";
const TEMPLATE_SAVED_MESSAGE = "模板已保存，可在后续批次中复用。";
const ESTIMATE_BTN_LABEL = Object.freeze({
  first: "估算本批任务",
  refresh: "重新估算"
});
const WORKFLOW_SESSION_KEY = "wz_workflow_v1";

function defaultUserBatchName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `wangzhuan_batch_${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function batchNameFromBatch(batch = state.batchDetail?.batch) {
  if (!batch) return "";
  return batch.displayBatchName || batch.userBatchName || batch.estimate?.request?.batchName || batch.request?.batchName || batch.batchName || "";
}

function applyUserBatchName(value = "") {
  if (!els.batchName) return "";
  const name = String(value || "").trim();
  els.batchName.value = name;
  if (name) writeWorkflowSession({ batchName: name });
  return name;
}

function ensureNewTaskBatchName() {
  return applyUserBatchName(defaultUserBatchName());
}

function restoreUserBatchName() {
  const fromBatch = batchNameFromBatch();
  if (fromBatch) {
    applyUserBatchName(fromBatch);
    return true;
  }
  const session = readWorkflowSession();
  if (session?.batchName) {
    applyUserBatchName(session.batchName);
    return true;
  }
  if (els.batchName) els.batchName.value = "";
  return false;
}

function ensureUserBatchNameForSubmit() {
  const current = els.batchName?.value.trim() || "";
  if (current) return current;
  return ensureNewTaskBatchName();
}

function batchDisplayName(batch = state.batchDetail?.batch) {
  return batch?.displayBatchName || batch?.userBatchName || batch?.estimate?.request?.batchName || batch?.request?.batchName || batch?.batchName || batch?.batchId || "";
}

function selectedMaterialDirection() {
  if (els.materialDirection?.value === "other") {
    return els.materialDirectionCustom?.value.trim() || "跟随竞品";
  }
  return els.materialDirection?.value || "";
}

function syncMaterialDirectionCustom() {
  syncMaterialDirectionForNode(primaryBranchNode());
}

const DECOMPOSITION_REQUIRED_FIELDS = Object.freeze([
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality",
  "hook"
]);

const DECOMPOSITION_FORM_SECTIONS = Object.freeze([
  {
    title: "画面与动作",
    layout: "stack",
    fields: [
      { key: "scene", label: "scene", required: true, hint: "空间、时间段、App 页面或人物所在环境" },
      { key: "subject", label: "subject", required: true, hint: "人物职业/身份、外观、服装、手机或 UI 元素" },
      { key: "action", label: "action", required: true, hint: "按时间段拆分：动作、口播功能、字幕与奖励反馈" }
    ]
  },
  {
    title: "镜头与风格",
    layout: "grid",
    fields: [
      { key: "camera", label: "camera", required: true, hint: "景别、运镜、节奏" },
      { key: "lighting", label: "lighting", required: true, hint: "光线和画面氛围" },
      { key: "style", label: "style", required: true, hint: "真人口播、手持演示、UGC、App demo 等" },
      { key: "quality", label: "quality", required: true, hint: "清晰度与生成质量" }
    ]
  },
  {
    title: "脚本节奏",
    collapsible: true,
    layout: "stack",
    fields: [
      { key: "hook", label: "前三秒钩子", required: true, hint: "保留结构，不要照搬竞品文案" },
      { key: "cta", label: "行动号召", required: false, hint: "下载/安装引导结构（可选）" },
      { key: "disclaimer", label: "合规提醒", required: false, hint: "不能夸大的点（可选）" }
    ]
  },
  {
    title: "转化细节（可选）",
    layout: "grid",
    fields: [
      { key: "phoneUi", label: "手机/产品界面", required: false, hint: "界面展示重点" },
      { key: "rewardFeedback", label: "奖励反馈", required: false, hint: "金币、余额等反馈刺激点" }
    ]
  }
]);

const REQUIRED_DRAFT_FIELDS = Object.freeze([
  "displayName",
  "productName",
  "currencySymbol",
  "language",
  "regions",
  "targetChannels",
  "defaultOutputRatio",
  "defaultDurationSec",
  "promiseLevel"
]);

const REQUIRED_BRANCH_CONFIRM_FIELDS = Object.freeze([
  "productName"
]);

const BRANCH_MODULE_SUB = Object.freeze({
  template: "1",
  assets: "2",
  delivery: "3",
  prompts: "4"
});

const BRANCH_MODULE_LABELS = Object.freeze({
  template: "模板信息",
  assets: "产品素材",
  delivery: "投放设置",
  prompts: "提示词"
});

const DRAFT_FIELD_LABELS = Object.freeze({
  displayName: "模板名",
  productName: "产品名",
  productLink: "产品链接",
  currencySymbol: "币种",
  language: "语言",
  regions: "目标地区",
  targetChannels: "目标渠道",
  defaultOutputRatio: "输出比例",
  defaultDurationSec: "时长",
  promiseLevel: "承诺等级"
});

const DRAFT_FIELD_BRANCH_KEYS = Object.freeze({
  displayName: "displayName",
  productName: "productName",
  productLink: "productLink",
  cta: "cta",
  ending: "ending",
  currencySymbol: "currencySymbol",
  language: "language",
  languages: "languages",
  regions: "regions",
  targetChannels: "targetChannel",
  templateChannel: "templateChannel",
  defaultDurationSec: "defaultDuration",
  promiseLevel: "promiseLevel",
  materialDirection: "materialDirection",
  materialDirectionCustom: "materialDirectionCustom",
  voiceoverStyle: "voiceoverStyle"
});

function isDecompositionConfirmed() {
  return Boolean(state.decomposition?.referenceVideoId);
}

function readWorkflowSession() {
  try {
    const raw = sessionStorage.getItem(WORKFLOW_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeWorkflowSession(patch = {}) {
  const prev = readWorkflowSession() || {};
  sessionStorage.setItem(WORKFLOW_SESSION_KEY, JSON.stringify({
    ...prev,
    ...patch,
    updatedAt: Date.now()
  }));
}

function clearWorkflowSession({ preserveBatchName = false } = {}) {
  const preservedBatchName = preserveBatchName
    ? (readWorkflowSession()?.batchName || els.batchName?.value.trim() || "")
    : "";
  sessionStorage.removeItem(WORKFLOW_SESSION_KEY);
  if (preservedBatchName) writeWorkflowSession({ batchName: preservedBatchName });
}

function resetControlToDefault(control) {
  if (control instanceof HTMLSelectElement) {
    if (control.multiple) {
      for (const option of control.options) option.selected = option.defaultSelected;
      return;
    }
    const defaultIndex = [...control.options].findIndex((option) => option.defaultSelected);
    control.selectedIndex = defaultIndex >= 0 ? defaultIndex : (control.options.length ? 0 : -1);
    return;
  }
  if (control instanceof HTMLInputElement) {
    if (control.type === "file") {
      control.value = "";
      return;
    }
    if (control.type === "checkbox" || control.type === "radio") {
      control.checked = control.defaultChecked;
      return;
    }
    control.value = control.defaultValue || "";
    return;
  }
  if (control instanceof HTMLTextAreaElement) {
    control.value = control.defaultValue || "";
  }
}

function resetTransientFormState({ generateBatchName = false, clearSession = true } = {}) {
  if (clearSession) {
    stopPolling();
    clearWorkflowSession();
  }
  state.referenceVideo = null;
  state.decomposition = null;
  state.decompositionDraft = null;
  state.estimate = null;
  state.capabilities = null;
  state.batchDetail = null;
  state.activeLock = null;
  state.templateCommitted = false;
  state.rewriteConfirmed = false;
  state.selectedTemplate = null;
  state.suppressTemplateUnlock = false;
  const root = document.getElementById("wzCanvas");
  for (const control of root?.querySelectorAll("input, textarea, select") || []) {
    resetControlToDefault(control);
  }
  if (els.batchName) els.batchName.value = "";
  if (generateBatchName) ensureNewTaskBatchName();
  if (els.truthDetails) els.truthDetails.open = false;
}

function bootstrapWorkbenchUi() {
  state.referenceVideo = null;
  state.decomposition = null;
  state.decompositionDraft = null;
  state.estimate = null;
  state.capabilities = null;
  state.batchDetail = null;
  state.activeLock = null;
  state.templateCommitted = false;
  state.rewriteConfirmed = false;
  state.selectedTemplate = null;
  state.suppressTemplateUnlock = false;
  const root = document.getElementById("wzCanvas");
  for (const control of root?.querySelectorAll("input, textarea, select") || []) {
    if (control.id === "wzBatchName") continue;
    resetControlToDefault(control);
  }
  if (els.batchName) els.batchName.value = "";
  if (els.truthDetails) els.truthDetails.open = false;
}

function syncStartNewTaskButton() {
  if (!els.startNewTaskBtn) return;
  els.startNewTaskBtn.disabled = false;
  els.startNewTaskBtn.title = state.backgroundActiveBatchId
    ? "清空当前填写并生成新的批次名（不影响其他进行中的批次）"
    : "清空当前填写并生成新的批次名";
}

async function startNewTask() {
  resetTransientFormState({ generateBatchName: true, clearSession: true });
  clearReferenceObjectUrl();
  syncMaterialDirectionCustom();
  renderTruthFields();
  ensureDecompositionForm();
  renderDecompositionForm({});
  renderRewriteStatus();
  renderTemplateSaveStatus();
  renderBatchReadiness();
  renderReference();
  renderBatch();
  renderEstimate();
  await refreshBackgroundActiveBatchBanner();
  syncStartNewTaskButton();
  showToast(
    state.backgroundActiveBatchId
      ? "已开始新任务；上方仍有其他进行中的批次提醒"
      : "已开始新任务",
    { type: "success" }
  );
}

function persistWorkflowSession() {
  writeWorkflowSession({
    referenceVideoId: state.referenceVideo?.referenceVideoId || null,
    batchId: state.batchDetail?.batch?.batchId || null,
    templateVersionId: isTemplateCommitted() ? state.selectedTemplate?.versionId : null,
    templateCommitted: isTemplateCommitted(),
    rewriteConfirmed: isRewriteConfirmed()
  });
}

function restoreBatchDraftForm(batch = state.batchDetail?.batch) {
  const branchDrafts = Array.isArray(batch.branchDrafts) && batch.branchDrafts.length
    ? batch.branchDrafts
    : null;
  const draft = batch?.templateSnapshot?.draft;
  if (!draft && !branchDrafts) return false;
  const payload = draft
    ? { ...draft, branches: branchDrafts || draft.branches }
    : { branches: branchDrafts };
  state.suppressTemplateUnlock = true;
  applyBranches(payload);
  const request = batch.estimate?.request || batch.request || {};
  if (request.knowledgeNotes || draft?.knowledgeNotes) {
    els.knowledgeNotes.value = request.knowledgeNotes || draft?.knowledgeNotes || "";
  }
  if (request.durationSec || draft?.defaultDurationSec) {
    els.duration.value = String(request.durationSec || draft?.defaultDurationSec || els.duration.value || 15);
  }
  if (request.outputRatio || draft?.defaultOutputRatio) {
    setOptionalValue(els.outputRatio, request.outputRatio || draft?.defaultOutputRatio || "9:16");
  }
  if (request.variantCount) els.variantCount.value = String(request.variantCount);
  if (request.requestedConcurrency) els.concurrency.value = String(request.requestedConcurrency);
  applyPlanLlmConfigValues(request.planLlmConfig || request.llmConfig || draft?.planLlmConfig || draft?.llmConfig || {});
  state.suppressTemplateUnlock = false;
  return true;
}

function isRewriteConfirmed() {
  return Boolean(state.rewriteConfirmed);
}

function syncRewriteDomState() {
  const step3 = document.querySelector(".wz-col-branches[data-step=\"3\"]");
  const node = document.getElementById("wzNodeRewrite");
  if (step3) {
    if (isRewriteConfirmed()) step3.dataset.rewriteConfirmed = "1";
    else step3.removeAttribute("data-rewrite-confirmed");
  }
  if (node) {
    if (isRewriteConfirmed()) node.dataset.rewriteConfirmed = "1";
    else node.removeAttribute("data-rewrite-confirmed");
  }
  window.dispatchEvent(new CustomEvent("wz:rewrite-confirmed-changed"));
}

function invalidateEstimateFromEdit() {
  if (!state.estimate?.estimate) return;
  state.estimate = null;
  if (state.batchDetail?.batch?.status === "preview_required") {
    state.batchDetail = {
      ...state.batchDetail,
      batch: {
        ...state.batchDetail.batch,
        plans: []
      }
    };
  }
  renderEstimate();
}

function clearRewriteProgress({ clearEstimate = true } = {}) {
  if (isRewriteConfirmed()) setRewriteConfirmed(false);
  if (clearEstimate) invalidateEstimateFromEdit();
}

function restoreRewriteConfirmedFromBatch(batch = {}) {
  const request = batch.estimate?.request || batch.request || {};
  const sourceStep = String(request.sourceStep || batch.request?.sourceStep || "");
  if (batch.estimate?.estimateId || ["rewrite_confirmed", "estimate", "template_saved"].includes(sourceStep)) {
    state.rewriteConfirmed = true;
    syncRewriteDomState();
    return true;
  }
  return false;
}

function setRewriteConfirmed(confirmed) {
  state.rewriteConfirmed = Boolean(confirmed);
  syncRewriteDomState();
  renderRewriteStatus();
  renderBatchReadiness();
  persistWorkflowSession();
  syncFlowHints();
}

function syncDecompositionDomState() {
  const node = document.getElementById("wzNodeDecompose");
  if (!node) return;
  if (isDecompositionConfirmed()) node.dataset.decompositionConfirmed = "1";
  else node.removeAttribute("data-decomposition-confirmed");
  window.dispatchEvent(new CustomEvent("wz:decomposition-confirmed-changed"));
}

function applyRestoredTemplate(versionId, { lock = false } = {}) {
  if (!versionId || !state.templates.length) return false;
  const template = state.templates.find((item) => item.versionId === versionId);
  if (!template) return false;
  state.suppressTemplateUnlock = true;
  els.templateSelect.value = template.versionId;
  applyTemplate(template);
  state.suppressTemplateUnlock = false;
  if (lock) setTemplateCommitted(true, template);
  return true;
}

function referenceVideoIdFromBatch(batch = {}) {
  return String(
    batch.referenceVideo?.referenceVideoId
    || batch.decomposition?.referenceVideoId
    || batch.estimate?.request?.referenceVideoId
    || batch.request?.referenceVideoId
    || ""
  ).trim();
}

function restoreTemplateFromBatch(batch = {}) {
  const request = batch.estimate?.request || batch.request || {};
  const versionId = request.versionId || batch.templateSnapshot?.versionId || "";
  if (versionId && applyRestoredTemplate(versionId, { lock: true })) return true;
  const snapshot = batch.templateSnapshot;
  if (!snapshot?.draft) return false;
  state.suppressTemplateUnlock = true;
  applyTemplate(snapshot);
  setTemplateCommitted(true, snapshot);
  syncTemplateSelectValues(snapshot.versionId || "");
  state.suppressTemplateUnlock = false;
  return true;
}

async function hydrateReferenceWorkflowFromBatch(batch = {}) {
  const referenceVideoId = referenceVideoIdFromBatch(batch);
  if (!referenceVideoId) return false;
  if (batch.referenceVideo?.referenceVideoId) {
    state.referenceVideo = batch.referenceVideo;
  }
  if (batch.decomposition?.referenceVideoId) {
    state.decomposition = batch.decomposition;
    return true;
  }
  try {
    const data = await apiEnvelope(`/api/wangzhuan/reference-videos/${encodeURIComponent(referenceVideoId)}/workflow-state`);
    if (data.referenceVideo?.referenceVideoId) {
      state.referenceVideo = data.referenceVideo;
    }
    if (data.decompositionConfirmed && data.decomposition?.referenceVideoId) {
      state.decomposition = data.decomposition;
    }
  } catch {
    if (batch.referenceVideo?.referenceVideoId) {
      state.referenceVideo = batch.referenceVideo;
    }
  }
  return Boolean(state.referenceVideo?.referenceVideoId);
}

function restoreWorkflowFromBatch(detail) {
  const batch = detail?.batch;
  if (!batch) return false;
  let restored = false;
  const referenceVideoId = referenceVideoIdFromBatch(batch);
  if (batch.referenceVideo?.referenceVideoId) {
    state.referenceVideo = batch.referenceVideo;
  } else if (referenceVideoId && state.referenceVideo?.referenceVideoId === referenceVideoId) {
    restored = true;
  }
  const decomposition = batch.decomposition?.referenceVideoId
    ? batch.decomposition
    : (batch.request?.decomposition?.referenceVideoId || batch.request?.decomposition?.scene
      ? batch.request.decomposition
      : state.decomposition);
  if (decomposition?.referenceVideoId || decomposition?.scene) {
    state.decomposition = {
      ...decomposition,
      referenceVideoId: decomposition.referenceVideoId || referenceVideoId
    };
    restored = true;
  }
  restored = Boolean(state.referenceVideo?.referenceVideoId) || restored;
  if (restoreTemplateFromBatch(batch)) restored = true;
  if (batch.estimate?.estimateId || batch.estimate?.scriptCount) {
    state.estimate = {
      estimate: batch.estimate,
      capabilities: batch.capabilities || state.capabilities || null
    };
    state.capabilities = batch.capabilities || state.capabilities || null;
    restored = true;
  }
  restoreRewriteConfirmedFromBatch(batch);
  const draftRestored = restoreBatchDraftForm(batch);
  restoreUserBatchName();
  restored = restored || draftRestored || Boolean(batch.branchDrafts?.length);
  renderReference();
  syncDecompositionDomState();
  if (state.decomposition?.referenceVideoId) {
    renderDecompositionForm(state.decomposition);
  }
  renderRewriteStatus();
  renderTemplateSaveStatus();
  renderBatchReadiness();
  renderEstimate();
  syncFlowHints();
  if (restored) persistWorkflowSession();
  return restored;
}

async function restoreWorkflowSession() {
  const session = readWorkflowSession();
  const referenceVideoId = session?.referenceVideoId;
  if (!referenceVideoId) return false;
  try {
    const data = await apiEnvelope(`/api/wangzhuan/reference-videos/${encodeURIComponent(referenceVideoId)}/workflow-state`);
    if (data.referenceVideo?.referenceVideoId) {
      state.referenceVideo = data.referenceVideo;
    }
    if (data.decompositionConfirmed && data.decomposition?.referenceVideoId) {
      state.decomposition = data.decomposition;
    }
    renderReference();
    syncDecompositionDomState();
  } catch {
    return false;
  }
  if (session?.templateCommitted && session.templateVersionId) {
    applyRestoredTemplate(session.templateVersionId, { lock: true });
  }
  if (session?.rewriteConfirmed) {
    setRewriteConfirmed(true);
  } else if (state.batchDetail?.batch) {
    restoreRewriteConfirmedFromBatch(state.batchDetail.batch);
  } else {
    renderRewriteStatus();
  }
  renderTemplateSaveStatus();
  renderBatchReadiness();
  renderEstimate();
  restoreUserBatchName();
  return Boolean(state.referenceVideo?.referenceVideoId);
}

function renderBatchReadiness() {
  if (!els.batchReadiness) return;
  const batch = state.batchDetail?.batch;
  if (batch?.status === "stopped") {
    els.batchReadiness.hidden = false;
    els.batchReadiness.className = "wz-batch-readiness wz-info";
    els.batchReadiness.innerHTML = isUpstreamWorkflowLocked()
      ? "<span>批次已停止</span><span>前序步骤仍锁定；请点击顶部「开始新任务」重新填写</span>"
      : "<span>批次已停止</span><span>可修改前序步骤后重新估算，或点击顶部「开始新任务」清空重来</span>";
    return;
  }
  if (isUpstreamWorkflowLocked()) {
    els.batchReadiness.hidden = false;
    els.batchReadiness.className = "wz-batch-readiness wz-info";
    els.batchReadiness.innerHTML = "<span>Seedance 已提交生成</span><span>前序步骤已锁定；如需重新开始，请先停止当前批次或点击「开始新任务」</span>";
    return;
  }
  const decomp = isDecompositionConfirmed();
  const rewrite = isRewriteConfirmed();
  const estimate = state.estimate?.estimate;
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  if (!decomp && !rewrite && !estimate) {
    els.batchReadiness.hidden = true;
    els.batchReadiness.textContent = "";
    return;
  }
  els.batchReadiness.hidden = false;
  if (batch?.status === "preview_required" && plans.length) {
    els.batchReadiness.className = "wz-batch-readiness wz-success";
    els.batchReadiness.innerHTML = "<span>估算 ✓ · 预案已生成 ✓</span><span>下一步：确认预案并提交 Seedance 生成</span>";
    return;
  }
  if (decomp && rewrite && estimate) {
    els.batchReadiness.className = "wz-batch-readiness wz-success";
    els.batchReadiness.innerHTML = "<span>拆解 ✓ · 产品信息已确认 ✓ · 估算 ✓</span><span>下一步：点击「生成 Seedance 预案」</span>";
    return;
  }
  if (decomp && rewrite) {
    els.batchReadiness.className = "wz-batch-readiness wz-success";
    els.batchReadiness.innerHTML = "<span>拆解 ✓ · 产品信息已确认 ✓</span><span>下一步：点击「估算本批任务」</span>";
    return;
  }
  els.batchReadiness.className = "wz-batch-readiness wz-info";
  const parts = [
    decomp ? "拆解 ✓" : "拆解待完成",
    rewrite ? "产品信息已确认 ✓" : "产品信息待确认",
    estimate ? "估算 ✓" : ""
  ].filter(Boolean);
  const next = !decomp
    ? "请先完成脚本拆解"
    : !rewrite
      ? "请在第 3 步填写产品信息并点击「确认信息」"
      : "拆解与产品信息就绪后，可估算本批任务";
  els.batchReadiness.innerHTML = `<span>${parts.join(" · ")}</span><span>${next}</span>`;
}

function ensureDecompositionForm() {
  if (!els.decompositionForm || els.decompositionForm.dataset.wired === "1") return;
  els.decompositionForm.innerHTML = DECOMPOSITION_FORM_SECTIONS.map((section) => `
    <${section.collapsible ? "details" : "section"} class="wz-decomposition-section${section.collapsible ? " wz-details wz-advanced-settings" : ""}">
      ${section.collapsible ? `<summary>${escapeHtml(section.title)}</summary>` : `<h3>${escapeHtml(section.title)}</h3>`}
      <div class="wz-decomposition-fields${section.layout === "grid" ? " grid" : ""}">
        ${section.fields.map((field) => `
          <label class="wz-decomposition-field${field.required ? " required" : ""}">
            <span>${escapeHtml(field.label)}${field.required ? "" : "（可选）"}</span>
            <textarea
              data-decomposition-field="${escapeHtml(field.key)}"
              class="wz-decomposition-input"
              rows="3"
              spellcheck="false"
              placeholder="${escapeHtml(field.hint || "")}"
            ></textarea>
            ${field.hint ? `<small>${escapeHtml(field.hint)}</small>` : ""}
          </label>
        `).join("")}
      </div>
    </${section.collapsible ? "details" : "section"}>
  `).join("");
  els.decompositionForm.dataset.wired = "1";
  els.decompositionForm.addEventListener("input", onDecompositionFormInput);
}

function fitDecompositionTextareas() {
  if (!els.decompositionForm) return;
  for (const textarea of els.decompositionForm.querySelectorAll("textarea")) {
    textarea.style.height = "auto";
    const nextHeight = Math.max(84, textarea.scrollHeight + 2);
    textarea.style.height = `${nextHeight}px`;
  }
}

function wzFocusNodeId(id, step) {
  if (typeof window.wzFocusNode === "function") {
    window.wzFocusNode(id);
  } else {
    const node = document.getElementById(id);
    if (!node) return;
    node.classList.remove("collapsed");
    for (const item of document.querySelectorAll(".wz-canvas .wz-node")) {
      item.classList.toggle("focused", item === node);
      if (item !== node) item.classList.add("collapsed");
    }
    node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
  if (step) {
    for (const item of document.querySelectorAll("#wzStepbar .wz-stepbar-item")) {
      item.classList.toggle("active", item.dataset.step === String(step));
    }
  }
}

function focusDecomposeStep() {
  wzFocusNodeId("wzNodeDecompose", "2");
}

function decompositionFieldInput(key) {
  return els.decompositionForm?.querySelector(`[data-decomposition-field="${key}"]`) || null;
}

function collectDecompositionFromForm() {
  ensureDecompositionForm();
  const draft = { ...(state.decompositionDraft || {}) };
  for (const section of DECOMPOSITION_FORM_SECTIONS) {
    for (const field of section.fields) {
      const input = decompositionFieldInput(field.key);
      draft[field.key] = input ? String(input.value || "").trim() : "";
    }
  }
  return draft;
}

function hasDecompositionDraft() {
  const draft = collectDecompositionFromForm();
  return DECOMPOSITION_REQUIRED_FIELDS.some((field) => draft[field]);
}

function isDecompositionDraftComplete() {
  const draft = collectDecompositionFromForm();
  return DECOMPOSITION_REQUIRED_FIELDS.every((field) => draft[field]);
}

function setDecompositionFormLocked(locked) {
  if (!els.decompositionForm) return;
  for (const input of els.decompositionForm.querySelectorAll("input, textarea")) {
    input.disabled = locked;
    input.classList.toggle("wz-readonly", locked);
  }
}

function renderDecompositionForm(data = {}) {
  ensureDecompositionForm();
  if (!els.decompositionForm) return;
  for (const section of DECOMPOSITION_FORM_SECTIONS) {
    for (const field of section.fields) {
      const input = decompositionFieldInput(field.key);
      if (!input) continue;
      input.value = flattenDecompositionFieldValue(data[field.key] || "");
    }
  }
  const visible = hasDecompositionDraft() || isDecompositionConfirmed();
  els.decompositionForm.hidden = !visible;
  els.decompositionForm.classList.toggle("empty-line", !visible);
  if (els.decompositionHint) els.decompositionHint.hidden = !visible;
  document.getElementById("wzNodeDecompose")?.classList.toggle("wz-node-decompose-active", visible);
  setDecompositionFormLocked(isDecompositionConfirmed() || isUpstreamWorkflowLocked());
  fitDecompositionTextareas();
  syncDecompositionDomState();
  syncDecompositionControls();
}

function onDecompositionFormInput(event) {
  if (isDecompositionConfirmed() || isUpstreamWorkflowLocked()) return;
  if (event?.target instanceof HTMLTextAreaElement) {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.max(84, event.target.scrollHeight + 2)}px`;
  }
  state.decomposition = null;
  state.decompositionDraft = null;
  state.estimate = null;
  renderEstimate();
  syncDecompositionControls();
  els.decompositionStatus.className = "wz-info";
  els.decompositionStatus.textContent = "已修改解析结果，请确认无误后保存。";
}

function syncDecompositionControls() {
  const confirmed = isDecompositionConfirmed();
  const frozen = isUpstreamWorkflowLocked();
  const probeReady = Boolean(state.referenceVideo && state.referenceVideo.status !== "fail");
  const hasDraft = hasDecompositionDraft();
  const draftComplete = isDecompositionDraftComplete();
  const parseBusy = Boolean(els.draftDecompositionBtn?.dataset.originalText);
  const confirmBusy = Boolean(els.decomposeBtn?.dataset.originalText);

  if (els.draftDecompositionBtn) {
    els.draftDecompositionBtn.disabled = frozen || !probeReady || confirmed || parseBusy;
    if (!parseBusy) {
      els.draftDecompositionBtn.textContent = hasDraft ? "重新解析" : "开始解析";
    }
  }
  if (els.decomposeBtn) {
    els.decomposeBtn.disabled = frozen || confirmed || !draftComplete || confirmBusy;
  }
  if (els.knowledgeNotes) {
    els.knowledgeNotes.disabled = frozen || confirmed;
  }
  for (const input of [els.llmProvider, els.llmModel, els.llmEndpoint, els.llmTemperature]) {
    if (!input) continue;
    input.disabled = frozen;
    input.classList.toggle("wz-readonly", frozen);
  }
  syncFlowHints();
}

function syncReferenceHints() {
  const frozen = isUpstreamWorkflowLocked();
  const fileReady = Boolean(els.referenceFile?.files?.[0]);
  const uploaded = Boolean(state.referenceVideo?.referenceVideoId);
  const checking = Boolean(els.checkReferenceBtn?.dataset.originalText);
  const file = els.referenceFile?.files?.[0];
  if (els.referenceUploadPanel) {
    els.referenceUploadPanel.classList.toggle("has-file", fileReady || uploaded);
    els.referenceUploadPanel.classList.toggle("is-uploading", checking);
    els.referenceUploadPanel.classList.toggle("has-upload", uploaded);
  }
  if (els.checkReferenceBtn) els.checkReferenceBtn.disabled = frozen || checking;
  if (els.confirmReferenceBtn) els.confirmReferenceBtn.disabled = frozen || !uploaded || checking;
  if (els.referenceFile) els.referenceFile.disabled = frozen || checking;
  if (els.referenceUploadStatus && !checking) {
    els.referenceUploadStatus.textContent = uploaded
      ? `已读取 ${state.referenceVideo.fileName || "参考视频"}，可继续解析脚本。`
      : fileReady
        ? `已选择 ${file?.name || "参考视频"}，正在准备上传。`
        : "选中文件后会自动完成上传、格式检查和视频预览。";
  }
  syncActionHint(
    els.confirmReferenceBtn,
    uploaded ? "确认后进入脚本拆解" : "需先上传并读取参考视频",
    { tone: uploaded ? "muted" : "warn" }
  );
  if (uploaded) {
    syncActionHint(els.checkReferenceBtn, "");
    return;
  }
  syncActionHint(
    els.checkReferenceBtn,
    fileReady ? "已选择文件，正在等待自动上传" : "点击选择参考视频，选择后自动上传",
    { tone: fileReady ? "muted" : "warn" }
  );
}

function syncDecompositionHints() {
  const confirmed = isDecompositionConfirmed();
  const frozen = isUpstreamWorkflowLocked();
  const probeReady = Boolean(state.referenceVideo && state.referenceVideo.status !== "fail");
  const parseBusy = Boolean(els.draftDecompositionBtn?.dataset.originalText);
  const confirmBusy = Boolean(els.decomposeBtn?.dataset.originalText);
  if (els.draftDecompositionBtn && !parseBusy) {
    syncActionHint(
      els.draftDecompositionBtn,
      frozen
        ? "Seedance 已提交生成，前序步骤已锁定"
        : confirmed ? "脚本已确认，如需修改请重新上传参考视频" : !probeReady ? "需先上传并读取参考视频" : "",
      { tone: frozen || confirmed ? "warn" : "muted" }
    );
  }
  if (els.decomposeBtn && !confirmBusy) {
    syncActionHint(
      els.decomposeBtn,
      frozen
        ? "Seedance 已提交生成，前序步骤已锁定"
        : confirmed ? "脚本已确认，可进入第三步产品改写" : !isDecompositionDraftComplete() ? "请先完成解析并补全必填字段" : "确认后将锁定脚本并进入产品改写",
      { tone: frozen ? "warn" : confirmed ? "muted" : !isDecompositionDraftComplete() ? "warn" : "muted" }
    );
  }
}

function syncRewriteHints() {
  const frozen = isUpstreamWorkflowLocked();
  const hint = frozen
    ? "Seedance 已提交生成，前序步骤已锁定"
    : isRewriteConfirmed()
      ? "产品信息已确认，仍可修改；修改后建议重新估算"
      : branchNodes().length > 1
        ? "确认前需填写各子节点产品名称；若有素材将一并上传"
        : "确认前需填写产品名称；若有素材将一并上传";
  const tone = frozen ? "warn" : isRewriteConfirmed() ? "muted" : "warn";
  for (const button of confirmRewriteButtons()) {
    syncActionHint(button, hint, { tone });
  }
  syncActionHint(
    els.createTemplateBtn,
    isTemplateCommitted()
      ? "模板已保存，可复用于后续批次"
      : "保存模板是可选项，不保存也可以估算并生成批次",
    { tone: "muted" }
  );
}

function isBackgroundReminderBatch(batch) {
  if (!batch?.batchId || !shouldKeepBatchLive(batch)) return false;
  return !["draft", "checking"].includes(batch.status);
}

function activeLockFromBatchInfo(batch) {
  if (!isBackgroundReminderBatch(batch)) return null;
  const name = batchDisplayName(batch);
  return {
    type: "batch",
    id: batch.batchId,
    status: batch.status,
    label: activeLockLabel("batch", name || batch.batchId, batch.status)
  };
}

function isCurrentWorkbenchBatchBlocking(batch, stalePlanPreview = false) {
  if (!batch?.batchId || !shouldKeepBatchLive(batch)) return false;
  if (batch.status === "preview_required" && !stalePlanPreview) return false;
  return ["queued", "running", "stitching", "qc"].includes(batch.status);
}

function hasActivePipelineBatch() {
  return isCurrentWorkbenchBatchBlocking(state.batchDetail?.batch, isCurrentPlanPreviewStale(state.batchDetail?.batch));
}

function shouldKeepBatchLive(batch = {}) {
  return isBatchGenerationActive(batch, batch.tasks || []) || !terminalBatchStatus(batch.status);
}

async function refreshBackgroundActiveBatchBanner() {
  try {
    const detail = await apiEnvelope("/api/wangzhuan/batches/active");
    const batch = detail?.batch;
    const lock = activeLockFromBatchInfo(batch);
    state.backgroundActiveBatchId = lock?.id || null;
    if (lock) {
      renderActiveLockBanner(lockHost(), lock);
      return detail;
    }
    clearActiveLockBanner(lockHost());
    return null;
  } catch {
    return null;
  }
}

function isQcBatchPending(batch = state.batchDetail?.batch) {
  return batch?.status === "qc";
}

function isSeedancePlanConfirmed(batch = state.batchDetail?.batch) {
  if (!batch?.batchId) return false;
  if (batch.previewConfirmedAt) return true;
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  return plans.some((plan) => plan.status === "confirmed");
}

function currentPlanCoverage(batch = state.batchDetail?.batch) {
  return branchPlanCoverage(collectBranchDrafts(), Array.isArray(batch?.plans) ? batch.plans : []);
}

function isCurrentPlanPreviewStale(batch = state.batchDetail?.batch) {
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  if (batch?.status !== "preview_required" || !plans.length) return false;
  const coverage = currentPlanCoverage(batch);
  if (!coverage.ok) return true;
  return Boolean(batch.planBranchSignature && batch.planBranchSignature !== coverage.signature);
}

function isUpstreamWorkflowLocked() {
  return isSeedancePlanConfirmed();
}

function decompositionLlmConfig() {
  return {
    provider: els.llmProvider?.value.trim() || "",
    model: normalizeLlmModelChoice(els.llmModel?.value),
    endpoint: els.llmEndpoint?.value.trim() || "",
    temperature: Number(els.llmTemperature?.value || 0.2)
  };
}

function planLlmConfig() {
  const defaults = state.llmDefaults || {};
  return {
    provider: els.planLlmProvider?.value.trim() || defaults.provider || "skylink",
    model: normalizeLlmModelChoice(els.planLlmModel?.value, defaults.model || DEFAULT_LLM_MODEL),
    endpoint: els.planLlmEndpoint?.value.trim() || defaults.endpoint || "https://skylink-gateway.com/api/v1",
    temperature: Number(els.planLlmTemperature?.value ?? defaults.temperature ?? 0.2)
  };
}

function applyPlanLlmConfigValues(config = {}) {
  if (!config || typeof config !== "object") return;
  if (els.planLlmProvider && config.provider != null) els.planLlmProvider.value = config.provider;
  if (config.model != null) setLlmModelSelect(els.planLlmModel, config.model);
  if (els.planLlmEndpoint && config.endpoint != null) els.planLlmEndpoint.value = config.endpoint;
  if (els.planLlmTemperature && config.temperature != null) els.planLlmTemperature.value = String(config.temperature);
  renderPlanLlmServiceStatus();
}

function syncBatchParamControls() {
  const frozen = isUpstreamWorkflowLocked();
  for (const input of [els.modelSelect, els.duration, els.outputRatio, els.variantCount, els.concurrency, els.seedanceModel, els.planLlmProvider, els.planLlmModel, els.planLlmEndpoint, els.planLlmTemperature]) {
    if (!input) continue;
    input.disabled = frozen;
    input.classList.toggle("wz-readonly", frozen);
  }
  const uploadAssetsBtn = els.estimateBox?.querySelector("[data-action=upload-seedance-assets]");
  if (uploadAssetsBtn) uploadAssetsBtn.disabled = frozen;
}

function syncRewriteControls() {
  const frozen = isUpstreamWorkflowLocked();
  for (const node of branchNodes()) {
    for (const input of node.querySelectorAll("input, textarea, select")) {
      input.disabled = frozen;
      input.classList.toggle("wz-readonly", frozen);
    }
    for (const btn of node.querySelectorAll("button")) {
      btn.disabled = frozen;
    }
  }
  for (const btn of document.querySelectorAll(".wz-branch-remove")) {
    btn.disabled = frozen;
  }
  if (els.addBranchBtn) els.addBranchBtn.disabled = frozen;
  if (els.confirmRewriteBtn) els.confirmRewriteBtn.disabled = frozen;
  setSaveTemplateButtonsDisabled(frozen || isTemplateCommitted());
}

function syncUpstreamWorkflowLock() {
  const locked = isUpstreamWorkflowLocked();
  const canvas = document.getElementById("wzCanvas");
  if (canvas) {
    if (locked) canvas.dataset.workflowFrozen = "1";
    else delete canvas.dataset.workflowFrozen;
  }
  if (els.projectName) {
    els.projectName.disabled = locked;
    els.projectName.classList.toggle("wz-readonly", locked);
  }
  if (els.batchName) {
    els.batchName.disabled = locked;
    els.batchName.classList.toggle("wz-readonly", locked);
  }
  syncBatchParamControls();
  syncRewriteControls();
}

function activeLockFromBatch(batch) {
  return activeLockFromBatchInfo(batch);
}

function syncBatchActionButtons() {
  const estimate = state.estimate?.estimate;
  const batch = state.batchDetail?.batch;
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const stalePlanPreview = isCurrentPlanPreviewStale(batch);
  const locked = isCurrentWorkbenchBatchBlocking(batch, stalePlanPreview);
  const frozen = isUpstreamWorkflowLocked();
  const qcPending = isQcBatchPending(batch) && locked;

  if (!estimate) {
    els.planBatchBtn.disabled = true;
    els.confirmPlanBtn.disabled = true;
    return;
  }

  els.planBatchBtn.disabled = frozen
    || locked
    || qcPending
    || estimate.hardBlocked
    || (estimate.confirmationRequired && !els.confirmLimits.checked);
  els.confirmPlanBtn.disabled = frozen || stalePlanPreview || batch?.status !== "preview_required" || !plans.length;
}

function syncBatchActionHints() {
  const estimate = state.estimate?.estimate;
  const batch = state.batchDetail?.batch;
  const stalePlanPreview = isCurrentPlanPreviewStale(batch);
  const locked = isCurrentWorkbenchBatchBlocking(batch, stalePlanPreview);
  const frozen = isUpstreamWorkflowLocked();
  const qcPending = isQcBatchPending(batch) && locked;
  syncActionHint(
    els.estimateBtn,
    frozen
      ? "Seedance 已提交生成，前序步骤已锁定"
      : qcPending
      ? "当前批次已生成完成，请先运行视频质检或放弃批次"
      : !isDecompositionConfirmed()
        ? "需先完成脚本确认"
        : !isRewriteConfirmed()
          ? "需先在第 3 步确认产品改写信息"
          : estimate ? "可重新估算以刷新任务规模" : "前置步骤已完成，可以估算",
    { tone: frozen || qcPending || !isDecompositionConfirmed() || !isRewriteConfirmed() ? "warn" : "muted" }
  );
  syncActionHint(
    els.planBatchBtn,
    frozen
      ? "Seedance 已提交生成，前序步骤已锁定"
      : qcPending
      ? `当前批次 ${batchDisplayName(batch)} 待质检，请先运行视频质检或放弃批次`
      : stalePlanPreview
      ? "第 3 步裂变子节点已变化，请重新生成 Seedance 预案"
      : locked
      ? `当前批次 ${batchDisplayName(batch)} 进行中（${batchStatusLabels[batch.status] || batch.status}），请先确认预案、等待完成或停止后再新建`
      : !estimate ? "需先完成拆解和批次估算" : estimate.hardBlocked ? "当前估算存在硬阻塞，请检查渠道规则" : estimate.confirmationRequired && !els.confirmLimits.checked ? "请先勾选二次确认后再生成预案" : "",
    { tone: frozen || locked || qcPending || estimate?.hardBlocked ? "error" : "warn" }
  );
  syncActionHint(
    els.confirmPlanBtn,
    frozen
      ? "Seedance 已提交生成，前序步骤已锁定"
      : stalePlanPreview
      ? "当前预案未覆盖全部裂变子节点，请先重新生成 Seedance 预案"
      : batch?.status === "preview_required" ? "确认后将提交 Seedance 批量生成" : !estimate ? "需先生成 Seedance 预案" : "",
    { tone: frozen || stalePlanPreview ? "warn" : "muted" }
  );
}

function syncFlowHints() {
  syncReferenceHints();
  syncDecompositionHints();
  syncRewriteHints();
  syncBatchActionHints();
  syncUpstreamWorkflowLock();
}

function batchRuntimeKeyValues(batch, tasks, now = Date.now()) {
  const runtime = batchRuntimeSummary(batch, tasks, { now });
  return [
    ["创建时间", runtime.createdAt],
    ["执行进度", `${runtime.progressText}${runtime.percent === null ? "" : ` · ${runtime.percent}%`}`],
    ["已运行", runtime.elapsed],
    ["预估剩余", runtime.eta],
    ["更新时间", runtime.updatedAt]
  ];
}

function syncRuntimeClock() {
  window.clearInterval(state.runtimeClockTimer);
  state.runtimeClockTimer = 0;
  const batch = state.batchDetail?.batch;
  if (!batch || !shouldKeepBatchLive(batch)) return;
  const tick = () => {
    const currentBatch = state.batchDetail?.batch;
    if (!currentBatch || !shouldKeepBatchLive(currentBatch)) {
      window.clearInterval(state.runtimeClockTimer);
      state.runtimeClockTimer = 0;
      return;
    }
    const strip = document.querySelector(".wz-runtime-strip");
    if (!strip) return;
    strip.innerHTML = renderKeyValues(batchRuntimeKeyValues(currentBatch, currentBatch.tasks || [], Date.now()));
  };
  tick();
  state.runtimeClockTimer = window.setInterval(tick, 1000);
}

function stopRuntimeClock() {
  window.clearInterval(state.runtimeClockTimer);
  state.runtimeClockTimer = 0;
}

function batchProgressSection(batch, tasks, outputs = []) {
  if (!batch || !shouldKeepBatchLive(batch)) return "";
  const progress = batchGenerationProgress(batch, tasks);
  return `
    ${taskProgressHtml(progress)}
    <div class="wz-runtime-strip" aria-label="批次运行信息">
      ${renderKeyValues(batchRuntimeKeyValues(batch, tasks))}
    </div>
  `;
}

function clearDecompositionDraft() {
  renderDecompositionForm({});
  state.decomposition = null;
  state.decompositionDraft = null;
  clearRewriteProgress();
  syncDecompositionDomState();
  renderEstimate();
  renderBatchReadiness();
}

function focusBatchStep() {
  wzFocusNodeId("wzNodeBatch", "4");
  requestAnimationFrame(() => {
    els.estimateBtn?.focus({ preventScroll: true });
  });
}

function focusLogStep() {
  wzFocusNodeId("wzNodeLog", "5");
}

function primaryBranchNode() {
  return branchNodes()[0] || document.getElementById("wzNodeRewrite");
}

function draftFieldLabel(field, assetKey = "") {
  if (assetKey) return assetLabel(assetKey);
  return DRAFT_FIELD_LABELS[field] || field;
}

function branchValidationShape(node, branch, index) {
  return branchDraftToTemplateShape({
    ...branch,
    displayName: fieldValue(node, "displayName"),
    productName: fieldValue(node, "productName"),
    productLink: fieldValue(node, "productLink")
  }, index);
}

function validateBranchModules(node) {
  const issues = [];
  for (const field of REQUIRED_BRANCH_CONFIRM_FIELDS) {
    if (fieldValue(node, field)) continue;
    issues.push({
      module: "template",
      field,
      key: field,
      label: draftFieldLabel(field)
    });
  }
  return issues;
}

function focusBranchModule(node, module = "template") {
  const sub = BRANCH_MODULE_SUB[module] || "1";
  node?.querySelector(`.wz-subflow-nav-item[data-sub="${sub}"]`)?.click();
}

function focusRewriteStep(missingFields = [], branchNode = null, module = "") {
  const node = branchNode || primaryBranchNode() || document.getElementById("wzNodeRewrite");
  if (!node) return;
  const stepOpts = { center: false, branchNode: node };
  if (module) stepOpts.sub = BRANCH_MODULE_SUB[module] || "1";
  if (typeof window.wzActivateStep === "function") {
    window.wzActivateStep("3", stepOpts);
  } else if (typeof window.wzFocusNode === "function") {
    window.wzFocusNode(node, { center: false, sub: stepOpts.sub });
  } else if (node.id) {
    wzFocusNodeId(node.id, "3");
  } else {
    wzFocusNodeId("wzNodeRewrite", "3");
  }
  for (const branch of branchNodes()) {
    for (const input of branch.querySelectorAll(".wz-field-missing")) {
      input.classList.remove("wz-field-missing");
    }
    for (const slot of branch.querySelectorAll(".wz-asset-slot.wz-field-missing")) {
      slot.classList.remove("wz-field-missing");
    }
  }
  for (const item of document.querySelectorAll("#wzStepbar .wz-stepbar-item")) {
    item.classList.toggle("active", item.dataset.step === "3");
  }
  if (module && typeof window.wzActivateStep !== "function") {
    focusBranchModule(node, module);
  }
  let focusInput = null;
  for (const field of missingFields) {
    const branchKey = DRAFT_FIELD_BRANCH_KEYS[field];
    if (!branchKey) continue;
    const input = branchField(node, branchKey)
      || (field === "regions" ? branchField(node, "targetRegions") || branchField(node, "targetRegion") : null);
    if (input) {
      input.classList.add("wz-field-missing");
      if (!focusInput) focusInput = input;
    }
  }
  requestAnimationFrame(() => {
    focusInput?.focus({ preventScroll: true });
  });
}

function focusBranchValidationIssue(node, issue) {
  if (!node || !issue) return;
  focusRewriteStep([issue.field], node, issue.module);
  if (issue.assetKey) {
    const field = assetInputKeys.find(([key]) => key === issue.assetKey)?.[1];
    const input = field ? branchField(node, field) : null;
    const slot = input?.closest(".wz-asset-slot");
    if (slot) slot.classList.add("wz-field-missing");
    requestAnimationFrame(() => input?.focus({ preventScroll: true }));
    return;
  }
  const input = branchField(node, issue.field);
  if (input) {
    input.classList.add("wz-field-missing");
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }
}

function parseRegions(node) {
  const raw = fieldValue(node, "targetRegions")
    || fieldValue(node, "regions")
    || fieldValue(node, "targetRegion")
    || els.targetRegions?.value
    || els.regions?.value
    || "US";
  return splitMultiValue(raw, ["US"]);
}

function splitMultiValue(value, fallback = []) {
  if (value instanceof HTMLSelectElement && value.multiple) {
    const selected = [...value.selectedOptions].map((option) => String(option.value || "").trim()).filter(Boolean);
    return selected.length ? [...new Set(selected)] : fallback;
  }
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const values = source.map((item) => String(item || "").trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : fallback;
}

function primaryLanguage(node) {
  return splitMultiValue(
    fieldValue(node, "languages")
      || fieldValue(node, "language")
      || els.languages?.value
      || els.language?.value,
    ["en-US"]
  )[0];
}

function disclaimerPresetForLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("zh") || value.includes("chinese")) return "zh";
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("id")) return "id";
  if (value.startsWith("th")) return "th";
  if (value.startsWith("vi")) return "vi";
  return "en";
}

function mergeDisclaimerWithRequired(baseText = "", requiredList = []) {
  let text = String(baseText || "").trim();
  for (const item of requiredList) {
    const needle = String(item || "").trim();
    if (!needle) continue;
    if (text.toLowerCase().includes(needle.toLowerCase())) continue;
    text = text ? `${text} ${needle}` : needle;
  }
  return text;
}

function requiredDisclaimersForBranch(node = primaryBranchNode()) {
  const channel = splitMultiValue(
    fieldValue(node, "targetChannels") || els.targetChannel?.value || "generic",
    ["generic"]
  )[0];
  const promiseLevel = fieldValue(node, "promiseLevel") || els.promiseLevel?.value || "stable";
  return [...new Set(
    (state.channelRules || [])
      .filter((rule) => rule.channel === channel && rule.promiseLevel === promiseLevel)
      .flatMap((rule) => rule.requiredDisclaimers || [])
  )];
}

function effectiveDisclaimerText({
  language = "en-US",
  presetValue = "auto",
  customText = "",
  node = null
} = {}) {
  const manual = String(customText || "").trim();
  const presetKey = presetValue === "auto" ? disclaimerPresetForLanguage(language) : presetValue;
  const base = manual || (presetKey === "other" ? "" : (DISCLAIMER_PRESETS[presetKey] || DISCLAIMER_PRESETS.en));
  return mergeDisclaimerWithRequired(base, requiredDisclaimersForBranch(node));
}

function selectedDisclaimerPreset() {
  const selected = els.disclaimerPreset?.value || "auto";
  if (selected !== "auto") return selected;
  return disclaimerPresetForLanguage(splitMultiValue(els.languages?.value || els.language?.value, ["en-US"])[0]);
}

function applyDisclaimerPresetForNode(node = primaryBranchNode(), { force = false } = {}) {
  const disclaimerInput = branchField(node, "disclaimer") || els.disclaimer;
  const presetSelect = branchField(node, "disclaimerPreset") || els.disclaimerPreset;
  if (!disclaimerInput) return;
  const presetValue = presetSelect?.value || "auto";
  const language = fieldValue(node, "language")
    || fieldValue(node, "languages")
    || els.languages?.value
    || els.language?.value
    || "en-US";
  const presetKey = presetValue === "auto"
    ? disclaimerPresetForLanguage(language)
    : presetValue;
  if (presetKey === "other") return;
  const presetText = effectiveDisclaimerText({ language, presetValue, node });
  const current = disclaimerInput.value.trim();
  const knownText = Object.values(DISCLAIMER_PRESETS).includes(current);
  if (force || !current || knownText) {
    disclaimerInput.value = presetText;
  }
}

function applyDisclaimerPreset(options = {}) {
  applyDisclaimerPresetForNode(primaryBranchNode(), options);
}

function disclaimerRequestFields(node = primaryBranchNode()) {
  const presetSelect = branchField(node, "disclaimerPreset") || els.disclaimerPreset;
  const enabledInput = branchField(node, "disclaimerEnabled") || els.disclaimerEnabled;
  const disclaimerInput = branchField(node, "disclaimer") || els.disclaimer;
  const overlayPositionInput = branchField(node, "disclaimerOverlayPosition") || els.disclaimerOverlayPosition;
  const overlayFontSizeInput = branchField(node, "disclaimerOverlayFontSize") || els.disclaimerOverlayFontSize;
  const overlayBoxHeightInput = branchField(node, "disclaimerOverlayBoxHeight") || els.disclaimerOverlayBoxHeight;
  const overlayBottomMarginInput = branchField(node, "disclaimerOverlayBottomMargin") || els.disclaimerOverlayBottomMargin;
  const overlayHorizontalMarginInput = branchField(node, "disclaimerOverlayHorizontalMargin") || els.disclaimerOverlayHorizontalMargin;
  const enabled = enabledInput ? enabledInput.checked : true;
  const presetValue = presetSelect?.value || "auto";
  const presetKey = presetValue === "auto"
    ? disclaimerPresetForLanguage(fieldValue(node, "language") || fieldValue(node, "languages") || els.languages?.value || els.language?.value || "en-US")
    : presetValue;
  const languages = splitMultiValue(
    fieldValue(node, "languages") || fieldValue(node, "language") || els.languages?.value || els.language?.value,
    ["en-US"]
  );
  const fallbackText = presetKey === "other"
    ? mergeDisclaimerWithRequired(String(disclaimerInput?.value || "").trim(), requiredDisclaimersForBranch(node))
    : effectiveDisclaimerText({
      language: languages[0] || "en-US",
      presetValue,
      node
    });
  const disclaimerText = enabled ? (disclaimerInput?.value.trim() || fallbackText) : "";
  const overlayPosition = overlayPositionInput?.value || "bottom_center";
  const overlayFontSize = Number(overlayFontSizeInput?.value || 22);
  const overlayBoxHeight = Number(overlayBoxHeightInput?.value || 88);
  const overlayBottomMargin = Number(overlayBottomMarginInput?.value || 64);
  const overlayHorizontalMargin = Number(overlayHorizontalMarginInput?.value || 80);
  return {
    disclaimer: disclaimerText,
    disclaimerEnabled: enabled,
    disclaimerPresetId: presetValue,
    disclaimerPreset: presetValue,
    disclaimerLanguage: presetKey,
    disclaimerByLanguage: Object.fromEntries(languages.map((language) => [
      language,
      presetValue === "other"
        ? disclaimerText
        : effectiveDisclaimerText({
          language,
          presetValue,
          customText: disclaimerText
        })
    ])),
    disclaimerOverlay: {
      enabled,
      position: overlayPosition,
      fontSize: Number.isFinite(overlayFontSize) ? overlayFontSize : 22,
      boxHeight: Number.isFinite(overlayBoxHeight) ? overlayBoxHeight : 88,
      bottomMargin: Number.isFinite(overlayBottomMargin) ? overlayBottomMargin : 64,
      horizontalMargin: Number.isFinite(overlayHorizontalMargin) ? overlayHorizontalMargin : 50
    }
  };
}

function missingRequiredDraftFields(draft) {
  const missingFields = [];
  for (const field of REQUIRED_DRAFT_FIELDS) {
    const value = draft[field];
    if (Array.isArray(value)) {
      if (value.length === 0) missingFields.push(field);
    } else if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }
  return missingFields;
}

function syncMetrics() {
  els.templateCount.textContent = state.templates.length;
  els.ruleCount.textContent = state.channelRules.length;
  const batch = state.batchDetail?.batch;
  els.taskCount.textContent = batch?.tasks?.length || state.estimate?.estimate?.scriptCount || 0;
  els.downloadCount.textContent = state.batchDetail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
}

function clearReferenceObjectUrl() {
  if (!referenceObjectUrl) return;
  URL.revokeObjectURL(referenceObjectUrl);
  referenceObjectUrl = "";
}

function selectedReferencePreviewUrl() {
  const file = els.referenceFile?.files?.[0];
  if (!file) return "";
  clearReferenceObjectUrl();
  referenceObjectUrl = URL.createObjectURL(file);
  return referenceObjectUrl;
}

function referencePreviewUrl(probe) {
  return probe?.previewUrl || probe?.storageUrl || (probe?.storedPath ? `/file?path=${encodeURIComponent(probe.storedPath)}` : "");
}

function renderReferenceVideoPreview(url, label = "参考视频预览") {
  if (!url) return "";
  return `
    <div class="wz-source-preview wz-reference-preview" data-source-preview="video">
      <video src="${escapeHtml(url)}" controls preload="metadata" playsinline aria-label="${escapeHtml(label)}"></video>
    </div>
  `;
}

function renderPendingReference(file) {
  els.referenceBox.className = "wz-list";
  els.referenceBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <small>待上传 · ${escapeHtml(Math.max(1, Math.round(file.size / 1024 / 1024)))} MB</small>
      </div>
      ${badge("checking", { checking: "准备上传" })}
    </article>
    ${renderReferenceVideoPreview(selectedReferencePreviewUrl(), "本地参考视频预览")}
  `;
  syncReferenceHints();
}

function galleryPaginationHtml(gallery) {
  const pagination = gallery?.pagination || {
    page: state.galleryPage,
    pageSize: state.galleryPageSize,
    total: gallery?.counts?.total || gallery?.items?.length || 0,
    totalPages: gallery?.items?.length ? 1 : 0,
    hasPrev: false,
    hasNext: false
  };
  const totalPages = pagination.totalPages || 0;
  const pageLabel = totalPages ? `${pagination.page} / ${totalPages}` : "0 / 0";
  return `
    <div class="wz-gallery-pager">
      <span>共 ${escapeHtml(pagination.total || 0)} 条 · 第 ${escapeHtml(pageLabel)} 页</span>
      <div>
        <button type="button" class="ghost" data-gallery-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
        <button type="button" class="ghost" data-gallery-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
      </div>
    </div>
  `;
}

function renderTruthFields(root = els.truthFields) {
  if (!root) return;
  root.innerHTML = strongTruthFields.map(([key, label]) => `
    <label>${escapeHtml(label)}
      <input data-truth-field="${escapeHtml(key)}" type="text" />
    </label>
  `).join("");
  markBranchFields();
}

function renderTruthFieldsForBranch(node) {
  const container = node?.querySelector(".wz-truth-fields");
  if (!container || container.querySelector("[data-truth-field]")) return;
  container.innerHTML = strongTruthFields.map(([key, label]) => `
    <label>${escapeHtml(label)}
      <input data-truth-field="${escapeHtml(key)}" type="text" />
    </label>
  `).join("");
  markBranchFields(node.closest(".wz-branches") || els.branches);
}

function syncMaterialDirectionForNode(node = primaryBranchNode()) {
  const select = branchField(node, "materialDirection") || els.materialDirection;
  const wrap = node?.querySelector(".wz-material-direction-custom-wrap") || els.materialDirectionCustomWrap;
  const custom = branchField(node, "materialDirectionCustom") || els.materialDirectionCustom;
  const isOther = select?.value === "other";
  if (wrap) wrap.hidden = !isOther;
  if (isOther && custom && !custom.value.trim()) custom.value = "跟随竞品";
}

function markBranchFields(root = els.branches) {
  if (!root) return;
  for (const branchNode of root.querySelectorAll(".wz-node-branch")) {
    for (const [field, id] of Object.entries(branchFieldIds)) {
      const byId = branchNode.querySelector(`#${id}`);
      if (byId) byId.dataset.branchField = field;
    }
    for (const [assetKey, field] of assetInputKeys) {
      const input = branchNode.querySelector(`[data-branch-field="${field}"]`);
      if (input) input.dataset.assetKey = assetKey;
    }
  }
  const base = document.getElementById("wzNodeRewrite");
  if (base && !base.dataset.branchId) base.dataset.branchId = "branch_1";
}

function branchNodes() {
  markBranchFields();
  return [...(els.branches?.querySelectorAll(".wz-node-branch") || [])];
}

function confirmRewriteButtons() {
  return els.confirmRewriteBtn ? [els.confirmRewriteBtn] : [];
}

function setConfirmRewriteButtonsBusy(busy, label) {
  if (els.confirmRewriteBtn) setBusy(els.confirmRewriteBtn, busy, label);
}

function branchField(node, field) {
  return node?.querySelector(`[data-branch-field="${field}"]`) || null;
}

function saveTemplateButtons() {
  return [...(els.branches?.querySelectorAll(".wz-save-template-btn") || [])];
}

function templateSaveStatusNodes() {
  return [...(els.branches?.querySelectorAll(".wz-template-save-status") || [])];
}

function templateSelectFields() {
  const nodes = [...(els.branches?.querySelectorAll('[data-branch-field="templateSelect"]') || [])];
  if (els.templateSelect && !nodes.includes(els.templateSelect)) nodes.unshift(els.templateSelect);
  return nodes;
}

function syncTemplateSelectValues(versionId = els.templateSelect?.value || "") {
  for (const select of templateSelectFields()) {
    select.value = versionId;
  }
}

function setSaveTemplateButtonsDisabled(disabled) {
  for (const button of saveTemplateButtons()) {
    button.disabled = disabled;
    if (!button.dataset.originalText) {
      button.textContent = disabled && isTemplateCommitted() ? "模板已保存" : "保存模板";
    }
  }
}

function setSaveTemplateButtonsBusy(busy, label) {
  for (const button of saveTemplateButtons()) {
    setBusy(button, busy, label);
  }
}

function fieldValue(node, field) {
  const input = branchField(node, field);
  return input ? String(input.value || "").trim() : "";
}

function setFieldValue(node, field, value) {
  const input = branchField(node, field);
  if (!input || value === undefined || value === null) return;
  if (input.type === "checkbox") {
    input.checked = value === true || value === "true" || value === "1";
    return;
  }
  if (input instanceof HTMLSelectElement && input.multiple) {
    const selected = new Set(Array.isArray(value) ? value.map((item) => String(item)) : splitMultiValue(value, []));
    for (const option of input.options) option.selected = selected.has(option.value);
    return;
  }
  input.value = Array.isArray(value) ? value.join(",") : String(value);
}

function setMaterialDirectionValue(node, value) {
  const input = branchField(node, "materialDirection") || els.materialDirection;
  const custom = branchField(node, "materialDirectionCustom") || els.materialDirectionCustom;
  const text = String(value || "").trim();
  if (!input) return;
  const option = [...input.options].find((item) => item.value === text || item.textContent.trim() === text);
  if (option) {
    input.value = option.value;
    if (custom) custom.value = "";
  } else if (text) {
    input.value = "other";
    if (custom) custom.value = text;
  }
  syncMaterialDirectionCustom();
}

function setOptionalValue(input, value) {
  if (!input || value === undefined || value === null) return;
  if (input instanceof HTMLSelectElement && input.multiple) {
    const selected = new Set(Array.isArray(value) ? value.map((item) => String(item)) : splitMultiValue(value, []));
    for (const option of input.options) option.selected = selected.has(option.value);
    return;
  }
  input.value = Array.isArray(value) ? value.join(",") : String(value);
}

function renderStoreCandidates(node = primaryBranchNode()) {
  const box = node?.querySelector(".wz-store-candidates") || els.storeCandidates;
  if (!box) return;
  const result = state.storeInspection;
  if (!result) {
    box.className = "wz-list empty-line wz-store-candidates";
    box.textContent = "尚未读取商店页资产";
    return;
  }
  const candidates = result.candidates || {};
  const screenshots = Array.isArray(candidates.screenshots) ? candidates.screenshots : [];
  const warnings = result.warnings || [];
  box.className = "wz-list wz-store-candidates";
  box.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(candidates.productName || "未识别产品名")}</strong>
        <small>${escapeHtml(result.store || "store")} · ${escapeHtml(candidates.developer || "未知开发者")}</small>
      </div>
      <div class="wz-row-actions">
        ${candidates.productName ? `<button type="button" class="ghost" data-store-apply="productName">应用产品名</button>` : ""}
      </div>
    </article>
    ${candidates.description ? `
      <article class="wz-row">
        <div><strong>商店描述</strong><small>${escapeHtml(candidates.description)}</small></div>
        <button type="button" class="ghost" data-store-apply="description">应用产品描述</button>
      </article>
    ` : ""}
    ${candidates.icon?.url ? `
      <article class="wz-row">
        <div><strong>Icon 候选</strong><small>${escapeHtml(candidates.icon.url)}</small></div>
        <button type="button" class="ghost" data-store-apply="icon">使用此 icon</button>
      </article>
    ` : ""}
    ${screenshots.length ? `
      <article class="wz-row">
        <div><strong>截图候选</strong><small>${escapeHtml(screenshots.slice(0, 4).map((item) => item.label || item.url).join(", "))}</small></div>
        <button type="button" class="ghost" data-store-apply="screenshots">使用前 4 张截图</button>
      </article>
    ` : ""}
    ${warnings.map((item) => `<div class="wz-warning">${escapeHtml(item)}</div>`).join("")}
  `;
}

function applyStoreCandidate(kind, node = primaryBranchNode()) {
  const result = state.storeInspection;
  if (!result) return;
  const candidates = result.candidates || {};
  if (kind === "productName" && candidates.productName) {
    setFieldValue(node, "productName", candidates.productName);
  }
  if (kind === "description" && candidates.description) {
    const current = fieldValue(node, "customPrompt") || els.customPrompt?.value.trim() || "";
    const next = [current, `Store description: ${candidates.description}`].filter(Boolean).join("\n");
    setFieldValue(node, "customPrompt", next);
  }
  if (kind === "icon" && candidates.icon?.url) {
    const input = branchField(node, "productIconFile") || els.productIconFile;
    if (input) {
      input.dataset.storageUrl = candidates.icon.url;
      input.dataset.uploadedFileName = candidates.icon.fileName || "store-icon";
      input.dataset.storageKey = candidates.icon.storageKey || "";
    }
  }
  if (kind === "screenshots") {
    const screenshots = Array.isArray(candidates.screenshots) ? candidates.screenshots : [];
    const input = branchField(node, "productScreenshotFile") || els.productScreenshotFile;
    if (input && screenshots[0]?.url) {
      input.dataset.storageUrl = screenshots[0].url;
      input.dataset.uploadedFileName = screenshots[0].fileName || "store-screenshot";
      input.dataset.storageKey = screenshots[0].storageKey || "";
    }
    const current = fieldValue(node, "customPrompt") || els.customPrompt?.value.trim() || "";
    const refs = screenshots.slice(0, 4).map((item, index) => `Store screenshot ${index + 1}: ${item.url}`).join("\n");
    if (refs) setFieldValue(node, "customPrompt", [current, refs].filter(Boolean).join("\n"));
  }
  markTemplateDirtyFromEdit();
  showToast("已应用商店页候选信息", { type: "success" });
}

function branchTitle(node, index) {
  const explicit = node?.dataset.branchLabel || "";
  const title = node?.querySelector(".wz-branch-title")?.textContent?.trim() || "";
  return explicit || title || `改写 3.${index + 1}`;
}

function syncAssetInputMeta(input) {
  if (!input) return;
  const label = input.closest("label");
  if (!label) return;
  let meta = label.querySelector(".wz-file-meta");
  if (!meta) {
    meta = document.createElement("small");
    meta.className = "wz-file-meta";
    label.appendChild(meta);
  }
  const fileName = input.dataset.uploadedFileName || "";
  const status = input.dataset.reviewStatus || "";
  const reason = input.dataset.reviewReason || "";
  if (!fileName && !status && !reason) {
    meta.hidden = true;
    meta.textContent = "";
    return;
  }
  const statusText = formatAssetReviewStatus(status, reason);
  meta.hidden = false;
  meta.textContent = [fileName, statusText].filter(Boolean).join(" · ");
}

function formatAssetReviewStatus(status = "", reason = "") {
  const normalized = normalizeAssetReviewStatus(status);
  if (normalized === "approved") return "已通过审核";
  if (normalized === "rejected") return `审核未通过${reason ? `：${reason}` : ""}`;
  if (normalized === "failed") return `审核失败${reason ? `：${reason}` : ""}`;
  if (normalized === "running" || normalized === "processing") return `审核处理中${reason ? `：${reason}` : ""}`;
  if (normalized === "pending" || normalized === "queued") return `等待审核${reason ? `：${reason}` : ""}`;
  return normalized ? `审核状态 ${normalized}${reason ? `：${reason}` : ""}` : "";
}

function normalizeAssetReviewStatus(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (["approved", "active", "success", "succeeded", "pass", "passed"].includes(normalized)) return "approved";
  if (["rejected", "reject"].includes(normalized)) return "rejected";
  if (["failed", "fail", "error"].includes(normalized)) return "failed";
  if (["running", "processing", "pending", "queued"].includes(normalized)) return normalized;
  return normalized || "pending";
}

function isAssetReviewFailureStatus(status = "") {
  const normalized = normalizeAssetReviewStatus(status);
  return normalized === "rejected" || normalized === "failed";
}

function assetLabel(assetKey = "") {
  const labels = {
    productIcon: "产品 Logo",
    productScreenshot: "产品截图",
    productRecording: "产品录屏",
    ctaAsset: "CTA 素材",
    endingAsset: "结尾素材",
    personAsset: "人物素材",
    rewardElement: "奖励元素"
  };
  return labels[assetKey] || assetKey || "素材";
}

function applyAssetReviewResultToInputs(branches = []) {
  const branchMap = new Map((Array.isArray(branches) ? branches : []).map((branch) => [branch.branchId, branch]));
  for (const node of branchNodes()) {
    const branch = branchMap.get(node.dataset.branchId || "branch_1");
    if (!branch) continue;
    for (const [assetKey, field] of assetInputKeys) {
      const input = branchField(node, field);
      const review = branch.assetReviews?.[assetKey];
      if (!input || !review) continue;
      input.dataset.assetId = review.assetId || input.dataset.assetId || "";
      input.dataset.reviewStatus = review.status || input.dataset.reviewStatus || "";
      input.dataset.reviewReason = review.reviewReason || "";
      syncAssetInputMeta(input);
    }
  }
}

function isApprovedAssetReview(review = {}) {
  return normalizeAssetReviewStatus(review.status) === "approved" && Boolean(String(review.assetId || "").trim());
}

function hasConfirmedAssetReviews() {
  const batch = state.batchDetail?.batch || {};
  if (batch.assetReviewConfirmedAt || batch.request?.assetReviewConfirmed) return true;
  const branches = Array.isArray(batch.branchDrafts) ? batch.branchDrafts : [];
  const reviewedEntries = [];
  for (const branch of branches) {
    for (const [assetKey] of assetInputKeys) {
      if (!branch.assetUrls?.[assetKey] && !branch.assetStorageKeys?.[assetKey] && !branch.assetStoredPaths?.[assetKey]) continue;
      reviewedEntries.push(branch.assetReviews?.[assetKey]);
    }
  }
  return reviewedEntries.length > 0 && reviewedEntries.every(isApprovedAssetReview);
}

function buildAssetReviewFailureMessage(error) {
  const failures = Array.isArray(error?.data?.failures) ? error.data.failures : [];
  if (!failures.length) return error?.message || "产品素材审核未通过";
  return failures.map((item) => {
    const branch = item.branchLabel || item.branchId || "默认分支";
    const label = assetLabel(item.assetKey);
    const name = item.fileName || label;
    const status = formatAssetReviewStatus(item.status, item.reason);
    return `${branch} / ${label} / ${name}${status ? ` / ${status}` : ""}`;
  }).join("\n");
}

function applyAssetReviewFailureFromError(error) {
  const failures = Array.isArray(error?.data?.failures) ? error.data.failures : [];
  for (const node of branchNodes()) {
    const branchId = node.dataset.branchId || "branch_1";
    for (const failure of failures) {
      if (failure.branchId && failure.branchId !== branchId) continue;
      const field = assetInputKeys.find(([key]) => key === failure.assetKey)?.[1];
      const input = field ? branchField(node, field) : null;
      if (!input) continue;
      if (failure.assetId) input.dataset.assetId = failure.assetId;
      input.dataset.reviewStatus = failure.status || "pending";
      input.dataset.reviewReason = failure.reason || "";
      syncAssetInputMeta(input);
    }
  }
  renderError(els.globalError, {
    code: error?.code || "asset_review_pending",
    message: buildAssetReviewFailureMessage(error),
    data: error?.data || {}
  }, "产品素材审核未通过");
  renderEstimate();
  renderBatch();
}

async function uploadSeedanceAssetsForReview() {
  if (isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  setBusy(els.confirmPlanBtn, true, "上传审核中");
  try {
    await uploadBranchAssets();
    await saveDraftBatch({
      sourceStep: "seedance_assets_reviewed",
      templateSnapshot: { draft: draftFromForm() },
      branches: collectBranchDrafts(),
      decomposition: state.decomposition
    });
    renderEstimate();
    renderBatch();
    showToast("Seedance 素材已上传，审核通过后可确认预案", { type: "success" });
  } catch (error) {
    if (error?.code === "asset_review_pending") {
      applyAssetReviewFailureFromError(error);
      return;
    }
    renderError(els.globalError, error, "Seedance 素材上传失败");
  } finally {
    setBusy(els.confirmPlanBtn, false);
  }
}

async function confirmSeedanceAssetReviews() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId || isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  const button = els.planBox?.querySelector("[data-action=\"confirm-seedance-assets\"]");
  setBusy(button, true, "确认中");
  try {
    const data = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/confirm-assets`, {
      method: "POST",
      body: JSON.stringify({ branchDrafts: collectBranchDrafts() })
    });
    applyAssetReviewResultToInputs(data.branches || data.batch?.branchDrafts || []);
    state.batchDetail = data.batch ? { ...state.batchDetail, batch: data.batch } : await loadBatchDetail();
    renderEstimate();
    renderBatch();
    showToast("Seedance 素材审核结果已确认", { type: "success" });
  } catch (error) {
    if (error?.code === "asset_review_pending") {
      applyAssetReviewFailureFromError(error);
      return;
    }
    renderError(els.globalError, error, "确认审核结果失败");
  } finally {
    setBusy(button, false);
  }
}

function collectBranchAssets(node) {
  const assetFileNames = {};
  const assetUrls = {};
  const assetStorageKeys = {};
  const assetStoredPaths = {};
  const assetReviews = {};
  for (const [assetKey, field] of assetInputKeys) {
    const input = branchField(node, field);
    const file = input?.files?.[0];
    const savedName = input?.dataset.uploadedFileName || "";
    const savedUrl = input?.dataset.storageUrl || "";
    const savedStorageKey = input?.dataset.storageKey || "";
    const savedStoredPath = input?.dataset.storedPath || "";
    const savedAssetId = input?.dataset.assetId || "";
    const savedReviewStatus = input?.dataset.reviewStatus || "";
    const savedReviewReason = input?.dataset.reviewReason || "";
    const hasAsset = Boolean(file?.name || savedName || savedUrl || savedStorageKey || savedStoredPath);
    if (!hasAsset) continue;
    if (file?.name) assetFileNames[assetKey] = file.name;
    else if (savedName) assetFileNames[assetKey] = savedName;
    if (savedUrl) assetUrls[assetKey] = savedUrl;
    if (savedStorageKey) assetStorageKeys[assetKey] = savedStorageKey;
    if (savedStoredPath) assetStoredPaths[assetKey] = savedStoredPath;
    if (savedAssetId || savedReviewStatus || savedReviewReason) {
      assetReviews[assetKey] = {
        assetId: savedAssetId,
        status: savedReviewStatus || "pending",
        reviewReason: savedReviewReason
      };
    }
  }
  if (assetFileNames.endingAssetInline && !assetFileNames.endingAsset) assetFileNames.endingAsset = assetFileNames.endingAssetInline;
  if (assetUrls.endingAssetInline && !assetUrls.endingAsset) assetUrls.endingAsset = assetUrls.endingAssetInline;
  if (assetStorageKeys.endingAssetInline && !assetStorageKeys.endingAsset) assetStorageKeys.endingAsset = assetStorageKeys.endingAssetInline;
  if (assetStoredPaths.endingAssetInline && !assetStoredPaths.endingAsset) assetStoredPaths.endingAsset = assetStoredPaths.endingAssetInline;
  if (assetReviews.endingAssetInline && !assetReviews.endingAsset) assetReviews.endingAsset = assetReviews.endingAssetInline;
  return { assetFileNames, assetUrls, assetStorageKeys, assetStoredPaths, assetReviews };
}

function collectTruthRules(node) {
  const truthRules = {};
  for (const input of node.querySelectorAll("[data-truth-field]")) {
    truthRules[input.dataset.truthField] = input.value.trim();
  }
  return truthRules;
}

function collectAllBranchDrafts() {
  return branchNodes().map((node, index) => {
    const { assetFileNames, assetUrls, assetStorageKeys, assetStoredPaths, assetReviews } = collectBranchAssets(node);
    const targetChannel = fieldValue(node, "targetChannel") || fieldValue(node, "templateChannel") || "meta_ads";
    const regions = parseRegions(node);
    const languages = splitMultiValue(
      fieldValue(node, "languages") || fieldValue(node, "language") || els.languages?.value || els.language?.value,
      ["en-US"]
    );
    const disclaimerFields = disclaimerRequestFields(node);
    const branchId = node.dataset.branchId || `branch_${index + 1}`;
    return {
      branchId,
      branchIndex: index + 1,
      branchLabel: branchTitle(node, index),
      displayName: fieldValue(node, "displayName") || `改写 3.${index + 1}`,
      productName: fieldValue(node, "productName"),
      productLink: fieldValue(node, "productLink"),
      cta: fieldValue(node, "cta"),
      ending: fieldValue(node, "ending"),
      currencySymbol: fieldValue(node, "currencySymbol"),
      language: languages[0] || "en-US",
      languages,
      regions,
      targetChannels: [targetChannel],
      defaultOutputRatio: els.outputRatio?.value || "9:16",
      defaultDurationSec: Number(fieldValue(node, "defaultDuration") || 15),
      promiseLevel: fieldValue(node, "promiseLevel") || "stable",
      assetFileNames,
      assetUrls,
      assetStorageKeys,
      assetStoredPaths,
      assetReviews,
      materialDirection: fieldValue(node, "materialDirection") === "other"
        ? (fieldValue(node, "materialDirectionCustom") || "跟随竞品")
        : fieldValue(node, "materialDirection"),
      materialDirectionCustom: fieldValue(node, "materialDirectionCustom"),
      voiceoverStyle: fieldValue(node, "voiceoverStyle"),
      variantPrompt: fieldValue(node, "variantPrompt"),
      customPrompt: fieldValue(node, "customPrompt"),
      negativePrompt: fieldValue(node, "negativePrompt"),
      ...disclaimerFields,
      truthRules: collectTruthRules(node)
    };
  });
}

function collectBranchDrafts() {
  return collectAllBranchDrafts().filter((branch) => branch.productName || branch.cta || branch.materialDirection || Object.keys(branch.assetUrls).length);
}

function branchDraftToTemplateShape(branch, index = 0) {
  return {
    branchId: branch.branchId || `branch_${index + 1}`,
    branchLabel: branch.branchLabel || `改写 3.${index + 1}`,
    displayName: branch.displayName || `改写 3.${index + 1}`,
    productLink: branch.productLink,
    productName: branch.productName,
    cta: branch.cta,
    ending: branch.ending,
    currencySymbol: branch.currencySymbol,
    language: branch.language,
    languages: branch.languages,
    regions: branch.regions,
    targetChannels: branch.targetChannels,
    defaultOutputRatio: branch.defaultOutputRatio || "9:16",
    defaultDurationSec: branch.defaultDurationSec,
    promiseLevel: branch.promiseLevel,
    assetFileNames: branch.assetFileNames || {},
    assetUrls: branch.assetUrls || {},
    assetStorageKeys: branch.assetStorageKeys || {},
    assetStoredPaths: branch.assetStoredPaths || {},
    assetReviews: branch.assetReviews || {},
    materialDirection: branch.materialDirection || "",
    materialDirectionCustom: branch.materialDirectionCustom || "",
    voiceoverStyle: branch.voiceoverStyle || "",
    variantPrompt: branch.variantPrompt || "",
    customPrompt: branch.customPrompt || "",
    negativePrompt: branch.negativePrompt || "",
    disclaimer: branch.disclaimer,
    disclaimerEnabled: branch.disclaimerEnabled,
    disclaimerPreset: branch.disclaimerPreset,
    disclaimerLanguage: branch.disclaimerLanguage,
    disclaimerByLanguage: branch.disclaimerByLanguage,
    disclaimerOverlay: branch.disclaimerOverlay,
    truthRules: branch.truthRules || {}
  };
}

function findIncompleteBranchDraft() {
  const nodes = branchNodes();
  const branches = collectAllBranchDrafts();
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branches[index];
    const node = nodes[index];
    const issues = validateBranchModules(node);
    if (issues.length) {
      return {
        index,
        node,
        issues,
        issue: issues[0],
        module: issues[0].module,
        missingFields: issues.map((item) => item.key),
        missingLabels: issues.map((item) => item.label),
        kind: "required"
      };
    }
    const missingStrong = missingStrongFields(branchValidationShape(node, branch, index));
    if (missingStrong.length) {
      return {
        index,
        node,
        issues: missingStrong.map((label) => ({ module: "delivery", field: "truthRules", key: label, label })),
        issue: { module: "delivery", field: "truthRules", key: missingStrong[0], label: missingStrong[0] },
        module: "delivery",
        missingFields: missingStrong,
        missingLabels: missingStrong,
        kind: "strong"
      };
    }
  }
  return null;
}

function isTemplateCommitted() {
  return Boolean(state.templateCommitted && state.selectedTemplate?.versionId);
}

function setTemplateCommitted(committed, template = null) {
  state.templateCommitted = Boolean(committed);
  if (template) state.selectedTemplate = template;
  setSaveTemplateButtonsDisabled(isTemplateCommitted());
  renderTemplateSaveStatus();
  persistWorkflowSession();
  window.dispatchEvent(new CustomEvent("wz:template-commit-changed"));
}

function renderRewriteStatus() {
  if (!els.rewriteStatus) return;
  els.rewriteStatus.hidden = false;
  if (isRewriteConfirmed()) {
    els.rewriteStatus.className = "wz-template-status wz-success";
    els.rewriteStatus.textContent = branchNodes().length > 1
      ? REWRITE_MULTI_CONFIRMED_MESSAGE
      : REWRITE_CONFIRMED_MESSAGE;
    els.rewriteStatus.classList.remove("empty-line");
    return;
  }
  els.rewriteStatus.className = "wz-template-status wz-info";
  els.rewriteStatus.textContent = branchNodes().length > 1
    ? "填写全部裂变子节点（3.1 / 3.2 / 3.3…）后，在上方点击「确认信息」进入第四步估算。"
    : "填写产品改写信息后，在上方点击「确认信息」，即可进入第四步批次估算。";
  els.rewriteStatus.classList.remove("empty-line");
  if (els.rewriteConfirmHint) {
    els.rewriteConfirmHint.textContent = isUpstreamWorkflowLocked()
      ? "Seedance 已提交生成，第 1–4 步内容已锁定。"
      : isRewriteConfirmed()
        ? branchNodes().length > 1
          ? "全部裂变子节点已确认，仍可继续修改；修改后建议重新估算。"
          : "产品信息已确认，仍可继续修改第 3 节内容；修改后建议重新估算。"
        : branchNodes().length > 1
          ? "确认前需填写各子节点产品名称；若有素材将一并上传，之后可进入批次估算。"
          : "确认前需填写产品名称；若有素材将一并上传，确认后仍可继续修改第 3 节内容。";
  }
  if (els.confirmRewriteBtn && !els.confirmRewriteBtn.dataset.originalText) {
    els.confirmRewriteBtn.textContent = isRewriteConfirmed()
      ? (branchNodes().length > 1 ? "重新确认全部子节点" : "重新确认信息")
      : (branchNodes().length > 1 ? "确认全部子节点" : "确认信息");
  }
}

function renderTemplateSaveStatus() {
  const nodes = templateSaveStatusNodes();
  if (!nodes.length) return;
  let message = branchNodes().length > 1
    ? "保存模板是可选项；需要复用全部裂变子节点时再点击「保存模板」。"
    : "保存模板是可选项，不保存也可以估算并生成批次。";
  if (isTemplateCommitted()) {
    const name = state.selectedTemplate?.draft?.displayName || state.selectedTemplate?.templateId || "当前模板";
    message = `${TEMPLATE_SAVED_MESSAGE}（${name}）`;
  } else if (state.selectedTemplate?.templateId) {
    const nextVersion = (Number(state.selectedTemplate?.versionNumber) || 0) + 1;
    message = `正在编辑已保存模板，再次保存将写入新版本 v${nextVersion}。`;
  }
  for (const node of nodes) {
    node.textContent = message;
  }
}

function unlockTemplateEditing() {
  if (!state.templateCommitted) return;
  state.templateCommitted = false;
  setSaveTemplateButtonsDisabled(false);
  renderTemplateSaveStatus();
  persistWorkflowSession();
}

function markTemplateDirtyFromEdit() {
  if (isUpstreamWorkflowLocked()) return;
  if (state.suppressTemplateUnlock || !state.templateCommitted) return;
  unlockTemplateEditing();
}

function markRewriteDirtyFromEdit() {
  if (isUpstreamWorkflowLocked()) return;
  invalidateEstimateFromEdit();
}

function fillBranchDraft(node, draft = {}, index = 0) {
  if (!node) return;
  markBranchFields(node);
  node.dataset.branchId = draft.branchId || draft.id || node.dataset.branchId || `branch_${index + 1}`;
  node.dataset.branchLabel = draft.branchLabel || draft.label || draft.displayName || "";
  setFieldValue(node, "productName", draft.productName);
  setFieldValue(node, "productLink", draft.productLink);
  setFieldValue(node, "cta", draft.cta);
  setFieldValue(node, "language", draft.language);
  setFieldValue(node, "languages", Array.isArray(draft.languages) ? draft.languages.join(",") : (draft.language || draft.languages));
  setFieldValue(node, "targetChannel", draft.targetChannels?.[0] || draft.targetChannel);
  setFieldValue(node, "targetRegion", draft.regions?.[0] || draft.targetRegion);
  setFieldValue(node, "targetRegions", Array.isArray(draft.regions) ? draft.regions.join(",") : (draft.targetRegions || draft.targetRegion));
  setMaterialDirectionValue(node, draft.materialDirection);
  setFieldValue(node, "voiceoverStyle", draft.voiceoverStyle);
  setFieldValue(node, "promiseLevel", draft.promiseLevel);
  setFieldValue(node, "projectName", draft.projectName);
  setFieldValue(node, "batchName", draft.batchName);
  setFieldValue(node, "displayName", draft.displayName);
  setFieldValue(node, "generationMode", draft.generationMode);
  setFieldValue(node, "templateChannel", draft.targetChannels?.[0] || draft.templateChannel);
  setFieldValue(node, "regions", Array.isArray(draft.regions) ? draft.regions.join(",") : draft.regions);
  setFieldValue(node, "defaultDuration", draft.defaultDurationSec || draft.defaultDuration);
  setFieldValue(node, "ending", draft.ending);
  setFieldValue(node, "currencySymbol", draft.currencySymbol);
  setFieldValue(node, "variantPrompt", draft.variantPrompt);
  setFieldValue(node, "customPrompt", draft.customPrompt);
  setFieldValue(node, "negativePrompt", draft.negativePrompt);
  setFieldValue(node, "disclaimerPreset", draft.disclaimerPreset || draft.disclaimerPresetId || "auto");
  setFieldValue(node, "disclaimerEnabled", draft.disclaimerEnabled === false || draft.disclaimerOverlay?.enabled === false ? "false" : "true");
  setFieldValue(node, "disclaimer", draft.disclaimer || "");
  setFieldValue(node, "disclaimerOverlayPosition", draft.disclaimerOverlay?.position || "bottom_center");
  setFieldValue(node, "disclaimerOverlayFontSize", String(draft.disclaimerOverlay?.fontSize ?? 22));
  setFieldValue(node, "disclaimerOverlayBoxHeight", String(draft.disclaimerOverlay?.boxHeight ?? 88));
  setFieldValue(node, "disclaimerOverlayBottomMargin", String(draft.disclaimerOverlay?.bottomMargin ?? 64));
  setFieldValue(node, "disclaimerOverlayHorizontalMargin", String(draft.disclaimerOverlay?.horizontalMargin ?? 50));
  syncMaterialDirectionForNode(node);
  for (const [assetKey, field] of assetInputKeys) {
    const input = branchField(node, field);
    if (!input) continue;
    input.dataset.uploadedFileName = draft.assetFileNames?.[assetKey] || "";
    input.dataset.storageUrl = draft.assetUrls?.[assetKey] || "";
    input.dataset.storageKey = draft.assetStorageKeys?.[assetKey] || "";
    input.dataset.storedPath = draft.assetStoredPaths?.[assetKey] || "";
    input.dataset.assetId = draft.assetReviews?.[assetKey]?.assetId || "";
    input.dataset.reviewStatus = draft.assetReviews?.[assetKey]?.status || "";
    input.dataset.reviewReason = draft.assetReviews?.[assetKey]?.reviewReason || "";
    syncAssetInputMeta(input);
  }
  for (const input of node.querySelectorAll("[data-truth-field]")) {
    input.value = draft.truthRules?.[input.dataset.truthField] || "";
  }
}

function applyBranches(draft = {}) {
  const drafts = Array.isArray(draft.branches) && draft.branches.length ? draft.branches : [draft];
  const base = document.getElementById("wzNodeRewrite");
  for (const clone of els.branches?.querySelectorAll(".wz-node-branch:not(#wzNodeRewrite)") || []) clone.remove();
  if (base) fillBranchDraft(base, drafts[0] || draft, 0);
  for (let index = 1; index < drafts.length; index += 1) {
    const node = window.wzCreateBranchNode?.(drafts[index], { focus: false });
    fillBranchDraft(node, drafts[index], index);
  }
  window.dispatchEvent(new CustomEvent("wz:branches-applied"));
}

async function uploadBranchAssets() {
  for (const node of branchNodes()) {
    const branchId = node.dataset.branchId || "branch_1";
    for (const [assetKey, field] of assetInputKeys) {
      const input = branchField(node, field);
      const file = input?.files?.[0];
      if (!file) continue;
      if (input.dataset.uploadedFileName === file.name && input.dataset.storageUrl) continue;
      const content = await dataUrlFromFile(file);
      const data = await apiEnvelope("/api/wangzhuan/product-assets/upload", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          assetKey,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          content
        })
      });
      const asset = data.asset || {};
      const review = asset.review || {};
      input.dataset.uploadedFileName = asset.fileName || file.name;
      input.dataset.storageUrl = asset.storageUrl || asset.previewUrl || "";
      input.dataset.storageKey = asset.storageKey || "";
      input.dataset.storedPath = asset.storedPath || "";
      input.dataset.assetId = review.assetId || "";
      input.dataset.reviewStatus = review.status || "pending";
      input.dataset.reviewReason = review.reviewReason || "";
      syncAssetInputMeta(input);
    }
  }
}

function draftFromForm() {
  const node = primaryBranchNode();
  const truthRules = node ? collectTruthRules(node) : {};
  if (!Object.keys(truthRules).length) {
    for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
      truthRules[input.dataset.truthField] = input.value.trim();
    }
  }
  const branches = collectBranchDrafts();
  const primaryBranch = branches[0] || {};
  const multiBranch = branches.length > 1;
  const targetChannel = fieldValue(node, "templateChannel")
    || fieldValue(node, "targetChannel")
    || els.templateChannel?.value
    || "meta_ads";
  const languages = splitMultiValue(
    fieldValue(node, "languages") || fieldValue(node, "language") || els.languages?.value || els.language?.value,
    ["en-US"]
  );
  const disclaimerFields = disclaimerRequestFields();
  return {
    displayName: fieldValue(node, "displayName") || els.displayName?.value.trim() || "",
    productName: fieldValue(node, "productName") || els.productName?.value.trim() || "",
    productLink: fieldValue(node, "productLink") || els.productLink?.value.trim() || "",
    cta: fieldValue(node, "cta") || els.cta?.value.trim() || "",
    ending: fieldValue(node, "ending") || els.ending?.value.trim() || "",
    currencySymbol: fieldValue(node, "currencySymbol") || els.currencySymbol?.value.trim() || "",
    language: languages[0] || "en-US",
    languages,
    regions: parseRegions(node),
    targetChannels: [targetChannel],
    defaultOutputRatio: els.outputRatio?.value || "9:16",
    defaultDurationSec: Number(fieldValue(node, "defaultDuration") || els.defaultDuration?.value || 15),
    promiseLevel: fieldValue(node, "promiseLevel") || els.promiseLevel?.value || "stable",
    ...(multiBranch ? {} : {
      assetFileNames: primaryBranch.assetFileNames || {},
      assetUrls: primaryBranch.assetUrls || {},
      assetStorageKeys: primaryBranch.assetStorageKeys || {},
      assetReviews: primaryBranch.assetReviews || {}
    }),
    llmConfig: decompositionLlmConfig(),
    planLlmConfig: planLlmConfig(),
    knowledgeNotes: els.knowledgeNotes.value.trim(),
    variantPrompt: fieldValue(node, "variantPrompt") || els.variantPrompt?.value.trim() || "",
    seedanceModel: els.seedanceModel.value.trim(),
    materialDirection: selectedMaterialDirection() || fieldValue(node, "materialDirection") || "",
    materialDirectionCustom: fieldValue(node, "materialDirectionCustom") || els.materialDirectionCustom?.value.trim() || "",
    voiceoverStyle: fieldValue(node, "voiceoverStyle") || els.voiceoverStyle?.value.trim() || "",
    customPrompt: fieldValue(node, "customPrompt") || els.customPrompt?.value.trim() || "",
    negativePrompt: fieldValue(node, "negativePrompt") || els.negativePrompt?.value.trim() || "",
    ...disclaimerFields,
    truthRules,
    branches
  };
}

function missingStrongFields(draft) {
  if (draft.promiseLevel !== "strong_commitment") return [];
  const hasAnyRule = strongTruthFields.some(([key]) => String(draft.truthRules?.[key] || "").trim());
  return hasAnyRule ? [] : ["至少一条真实收益规则"];
}

function selectedTemplateNameChanged(draft = {}) {
  if (!state.selectedTemplate?.draft) return false;
  return String(draft.displayName || "").trim()
    && String(draft.displayName || "").trim() !== String(state.selectedTemplate.draft.displayName || "").trim();
}

function applyTemplate(template) {
  state.suppressTemplateUnlock = true;
  state.selectedTemplate = template || null;
  clearRewriteProgress();
  const draft = template?.draft;
  if (!draft) {
    state.suppressTemplateUnlock = false;
    return;
  }
  const primary = Array.isArray(draft.branches) && draft.branches.length ? draft.branches[0] : draft;
  els.displayName.value = primary.displayName || draft.displayName || "";
  els.productName.value = primary.productName || draft.productName || "";
  els.productLink.value = primary.productLink || draft.productLink || "";
  els.cta.value = primary.cta || draft.cta || "";
  els.ending.value = primary.ending || draft.ending || "";
  els.currencySymbol.value = primary.currencySymbol || draft.currencySymbol || "$";
  setOptionalValue(els.language, draft.language || draft.languages?.[0] || "en-US");
  setOptionalValue(els.languages, Array.isArray(draft.languages) ? draft.languages.join(",") : (draft.language || "en-US"));
  setOptionalValue(els.regions, Array.isArray(draft.regions) ? draft.regions.join(",") : "");
  setOptionalValue(els.targetRegions, Array.isArray(draft.regions) ? draft.regions.join(",") : "");
  setOptionalValue(els.templateChannel, draft.targetChannels?.[0] || "meta_ads");
  els.targetChannel.value = draft.targetChannels?.[0] || "meta_ads";
  setOptionalValue(els.defaultDuration, String(draft.defaultDurationSec || 15));
  els.duration.value = String(draft.defaultDurationSec || 15);
  setOptionalValue(els.outputRatio, draft.defaultOutputRatio || "9:16");
  els.promiseLevel.value = draft.promiseLevel || "stable";
  els.llmProvider.value = draft.llmConfig?.provider || "";
  setLlmModelSelect(els.llmModel, draft.llmConfig?.model || DEFAULT_LLM_MODEL);
  els.llmEndpoint.value = draft.llmConfig?.endpoint || state.llmDefaults?.endpoint || "";
  els.llmTemperature.value = String(draft.llmConfig?.temperature ?? 0.2);
  applyPlanLlmConfigValues(draft.planLlmConfig || draft.llmConfig || {});
  els.knowledgeNotes.value = draft.knowledgeNotes || "";
  els.variantPrompt.value = draft.variantPrompt || "";
  els.seedanceModel.value = draft.seedanceModel || els.modelSelect.value || "";
  setMaterialDirectionValue(primaryBranchNode(), primary.materialDirection || draft.materialDirection || "跟随竞品");
  els.voiceoverStyle.value = primary.voiceoverStyle || draft.voiceoverStyle || "遵循竞品";
  els.customPrompt.value = primary.customPrompt || draft.customPrompt || "";
  els.negativePrompt.value = primary.negativePrompt || draft.negativePrompt || "";
  if (els.disclaimerPreset) {
    els.disclaimerPreset.value = draft.disclaimerPreset || draft.disclaimerLanguage || "auto";
  }
  if (els.disclaimerEnabled) els.disclaimerEnabled.checked = draft.disclaimerEnabled !== false && draft.disclaimerOverlay?.enabled !== false;
  setOptionalValue(els.disclaimer, draft.disclaimer || "");
  if (els.disclaimerOverlayPosition) els.disclaimerOverlayPosition.value = draft.disclaimerOverlay?.position || "bottom_center";
  if (els.disclaimerOverlayFontSize) els.disclaimerOverlayFontSize.value = String(draft.disclaimerOverlay?.fontSize ?? 22);
  if (els.disclaimerOverlayBoxHeight) els.disclaimerOverlayBoxHeight.value = String(draft.disclaimerOverlay?.boxHeight ?? 88);
  if (els.disclaimerOverlayBottomMargin) els.disclaimerOverlayBottomMargin.value = String(draft.disclaimerOverlay?.bottomMargin ?? 64);
  if (els.disclaimerOverlayHorizontalMargin) els.disclaimerOverlayHorizontalMargin.value = String(draft.disclaimerOverlay?.horizontalMargin ?? 50);
  applyDisclaimerPreset({ force: !draft.disclaimer && els.disclaimerPreset?.value !== "other" });
  for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
    input.value = draft.truthRules?.[input.dataset.truthField] || "";
  }
  els.truthDetails.open = els.promiseLevel.value === "strong_commitment";
  applyBranches(draft);
  state.suppressTemplateUnlock = false;
}

function renderTemplates({ applySelection = true } = {}) {
  const emptyOption = `<option value="">不选择模板，直接填写本次批次</option>`;
  if (!state.templates.length) {
    for (const select of templateSelectFields()) {
      select.innerHTML = emptyOption;
    }
    state.selectedTemplate = null;
    applyLlmConfigDefaults();
    syncMetrics();
    return;
  }
  const optionsHtml = `
    ${emptyOption}
    ${state.templates.map((template) => `
      <option value="${escapeHtml(template.versionId)}">
        ${escapeHtml(template.draft?.displayName || template.templateId)} v${escapeHtml(template.versionNumber)}${template.isDefault ? " 默认" : ""}
      </option>
    `).join("")}
  `;
  for (const select of templateSelectFields()) {
    select.innerHTML = optionsHtml;
  }
  const selectedVersionId = state.selectedTemplate?.versionId || els.templateSelect?.value || "";
  syncTemplateSelectValues(selectedVersionId);
  const selected = state.templates.find((item) => item.versionId === selectedVersionId);
  if (applySelection && selected) applyTemplate(selected);
  else state.selectedTemplate = selected || null;
  applyLlmConfigDefaults();
  syncMetrics();
}

function renderLlmServiceStatus() {
  if (!els.llmServiceStatus) return;
  const config = state.llmDefaults;
  if (!config) {
    els.llmServiceStatus.className = "wz-info wz-service-pill";
    els.llmServiceStatus.textContent = "正在检查 AI 拆解服务…";
    return;
  }
  const modelLabel = els.llmModel?.value.trim() || config.model || "默认模型";
  if (config.hasApiKey) {
    els.llmServiceStatus.className = "wz-success wz-service-pill";
    els.llmServiceStatus.textContent = `拆解模型已就绪（${modelLabel}）`;
    return;
  }
  els.llmServiceStatus.className = "wz-warning wz-service-pill";
  els.llmServiceStatus.textContent = "拆解模型未配置 API Key，请联系管理员";
}

function renderPlanLlmServiceStatus() {
  if (!els.planLlmServiceStatus) return;
  const config = state.llmDefaults;
  if (!config) {
    els.planLlmServiceStatus.className = "wz-info wz-service-pill";
    els.planLlmServiceStatus.textContent = "正在检查提示词模型服务…";
    return;
  }
  const modelLabel = els.planLlmModel?.value.trim() || config.model || "默认模型";
  if (config.hasApiKey) {
    els.planLlmServiceStatus.className = "wz-success wz-service-pill";
    els.planLlmServiceStatus.textContent = `提示词模型已就绪（${modelLabel}）`;
    return;
  }
  els.planLlmServiceStatus.className = "wz-warning wz-service-pill";
  els.planLlmServiceStatus.textContent = "提示词模型未配置 API Key，请联系管理员";
}

function applyLlmConfigDefaults() {
  const config = state.llmDefaults;
  if (!config) return;
  if (!els.llmProvider.value.trim()) els.llmProvider.value = config.provider || "skylink";
  setLlmModelSelect(els.llmModel, els.llmModel?.value || config.model || DEFAULT_LLM_MODEL);
  if (!els.llmEndpoint.value.trim()) els.llmEndpoint.value = config.endpoint || "https://skylink-gateway.com/api/v1";
  if (!els.llmTemperature.value.trim()) els.llmTemperature.value = String(config.temperature ?? 0.2);
  if (els.planLlmProvider && !els.planLlmProvider.value.trim()) els.planLlmProvider.value = config.provider || "skylink";
  setLlmModelSelect(els.planLlmModel, els.planLlmModel?.value || config.model || DEFAULT_LLM_MODEL);
  if (els.planLlmEndpoint && !els.planLlmEndpoint.value.trim()) els.planLlmEndpoint.value = config.endpoint || "https://skylink-gateway.com/api/v1";
  if (els.planLlmTemperature && !els.planLlmTemperature.value.trim()) els.planLlmTemperature.value = String(config.temperature ?? 0.2);
  renderLlmServiceStatus();
  renderPlanLlmServiceStatus();
}

async function loadLlmConfig() {
  const data = await apiEnvelope("/api/wangzhuan/llm-config");
  state.llmDefaults = data.llmConfig || null;
  applyLlmConfigDefaults();
}

function rulesBoxes(node = null) {
  if (node) {
    const box = node.querySelector(".wz-branch-rules");
    return box ? [box] : [];
  }
  const boxes = [...document.querySelectorAll(".wz-branch-rules")];
  return boxes.length ? boxes : (els.rulesBox ? [els.rulesBox] : []);
}

function renderRules(response = {}, targetNode = null) {
  state.channelRules = response.rules || [];
  state.rulesWarnings = response.warnings || [];
  const warnings = state.rulesWarnings;
  const boxes = rulesBoxes(targetNode);
  if (!state.channelRules.length) {
    for (const box of boxes) {
      box.className = "wz-list empty-line wz-branch-rules";
      box.textContent = "没有命中渠道规则";
    }
    syncMetrics();
    return;
  }
  const html = `
    ${warnings.map((item) => `<div class="wz-warning">${escapeHtml(item.message)}</div>`).join("")}
    ${state.channelRules.map((rule) => `
      <article class="wz-row wz-rule-row">
        <div class="wz-rule-summary">
          <strong>${escapeHtml(channelLabels[rule.channel] || rule.channel)} · ${escapeHtml(promiseLabels[rule.promiseLevel] || rule.promiseLevel)}</strong>
          <small>当前渠道素材合规约束，不是账号权限。CTA 强度：${escapeHtml(rule.ctaStrength)}；规则版本：${escapeHtml(rule.version)}</small>
        </div>
        <div class="wz-rule-groups">
          <div>
            <b>必带提示</b>
            <div class="wz-chipline">
              ${(rule.requiredDisclaimers || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>无</span>"}
            </div>
          </div>
          <div>
            <b>禁用表述</b>
            <div class="wz-chipline">
              ${(rule.forbiddenTerms || []).map((item) => `<span class="danger">${escapeHtml(item)}</span>`).join("") || "<span>无</span>"}
            </div>
          </div>
        </div>
      </article>
    `).join("")}
  `;
  for (const box of boxes) {
    box.className = "wz-list wz-rule-list wz-branch-rules";
    box.innerHTML = html;
  }
  syncMetrics();
}

function renderReference() {
  const probe = state.referenceVideo;
  if (!probe) {
    if (!els.referenceFile?.files?.[0]) clearReferenceObjectUrl();
    els.referenceBox.className = "wz-list empty-line";
    els.referenceBox.textContent = "未上传参考视频";
    els.draftDecompositionBtn.disabled = true;
    clearDecompositionDraft();
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "先上传参考视频，再点击「开始解析」生成脚本草稿。";
    syncDecompositionControls();
    return;
  }
  els.referenceBox.className = "wz-list";
  els.referenceBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(probe.fileName)}</strong>
        <small>已读取视频信息 · ${escapeHtml(probe.referenceVideoId)}</small>
      </div>
      ${badge(probe.status, { pass: "通过", warn: "警告", fail: "失败" })}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["时长", `${probe.durationSec || "-"}s`],
        ["画幅", `${probe.width || "-"}x${probe.height || "-"} · ${probe.ratio || "-"}`],
        ["编码", probe.videoCodec || "-"],
        ["帧率", probe.fps ? `${probe.fps} fps` : "-"],
        ["码率", probe.bitRateBps ? `${Math.round(Number(probe.bitRateBps) / 1000)} kbps` : "-"],
        ["音轨", Number(probe.audioStreamCount || 0) > 0 ? "有音频" : "无音频"]
      ])}
    </div>
    ${(probe.issues || []).map((item) => `<div class="wz-warning">${escapeHtml(item.message)}</div>`).join("")}
    ${renderReferenceVideoPreview(referencePreviewUrl(probe))}
    ${referencePreviewUrl(probe) ? `<a href="${escapeHtml(referencePreviewUrl(probe))}" target="_blank" rel="noreferrer">打开参考视频</a>` : ""}
    ${isDecompositionConfirmed() ? `<div class="wz-success">${escapeHtml(DECOMPOSITION_CONFIRMED_MESSAGE)}</div>` : ""}
  `;
  if (isDecompositionConfirmed() && state.decomposition) {
    renderDecompositionForm(state.decomposition);
  }
  els.decompositionStatus.className = probe.status === "fail" ? "wz-warning" : "wz-info";
  if (probe.status === "fail") {
    els.decompositionStatus.textContent = "参考视频检查未通过，不能解析脚本。";
  } else if (isDecompositionConfirmed()) {
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = DECOMPOSITION_CONFIRMED_MESSAGE;
  } else if (hasDecompositionDraft()) {
    els.decompositionStatus.textContent = "解析结果已生成，请检查表单内容后确认；如需重做可点击「重新解析」。";
  } else {
    els.decompositionStatus.textContent = "参考视频已就绪，可填写素材经验后点击「开始解析」。";
  }
  syncDecompositionControls();
  syncFlowHints();
}

async function draftReferenceVideoDecomposition() {
  if (!state.referenceVideo || isDecompositionConfirmed() || isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  state.decomposition = null;
  state.decompositionDraft = null;
  state.estimate = null;
  renderEstimate();
  setBusy(els.draftDecompositionBtn, true, hasDecompositionDraft() ? "重新解析中" : "解析中");
  els.decompositionStatus.className = "wz-info";
  els.decompositionStatus.textContent = "正在分析参考视频并生成脚本草稿，请稍等。";
  try {
    const data = await apiEnvelopeStream("/api/wangzhuan/reference-videos/draft-decomposition/stream", {
      method: "POST",
      body: JSON.stringify({
        referenceVideoId: state.referenceVideo.referenceVideoId,
        knowledgeNotes: els.knowledgeNotes.value.trim(),
        llmConfig: decompositionLlmConfig()
      })
    }, { title: "脚本拆解 · LLM 控制台" });
    renderDecompositionForm(data.decomposition || {});
    state.decompositionDraft = data.decomposition || null;
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = "脚本草稿已生成，请检查表单内容后点击「确认脚本拆解」。";
    focusDecomposeStep();
    showToast("脚本草稿已生成", { type: "success" });
  } catch (error) {
    els.decompositionStatus.className = "wz-warning";
    els.decompositionStatus.textContent = error.data?.upstreamMessage
      ? `解析未完成：${error.data.upstreamMessage}`
      : error.data?.status
        ? `解析未完成：上游状态 ${error.data.status}`
        : error.message
          ? `解析未完成：${error.message}`
          : "解析未完成，请联系管理员检查 AI 服务配置，或稍后重试。";
    renderError(els.globalError, error, "脚本解析失败");
  } finally {
    setBusy(els.draftDecompositionBtn, false);
    syncDecompositionControls();
  }
}

function syncEstimateButtonLabel() {
  if (!els.estimateBtn || els.estimateBtn.dataset.originalText) return;
  els.estimateBtn.textContent = state.estimate?.estimate
    ? ESTIMATE_BTN_LABEL.refresh
    : ESTIMATE_BTN_LABEL.first;
}

function renderBatchStepProgress() {
  const estimate = state.estimate?.estimate;
  const batch = state.batchDetail?.batch;
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const steps = document.querySelectorAll(".wz-batch-step");
  if (!steps.length) return;
  const active = batch?.status === "preview_required" && plans.length
    ? "confirm"
    : estimate
      ? plans.length ? "confirm" : "plan"
      : "estimate";
  for (const step of steps) {
    const key = step.dataset.batchStep;
    step.classList.toggle("done", key === "estimate" ? Boolean(estimate) : key === "plan" ? plans.length > 0 : batch?.status === "queued" || batch?.status === "running");
    step.classList.toggle("active", key === active);
  }
}

function renderEstimate() {
  const estimate = state.estimate?.estimate;
  if (!estimate) {
    els.estimateBox.className = "wz-estimate empty-line";
    if (isDecompositionConfirmed() && isRewriteConfirmed()) {
      els.estimateBox.textContent = "前置步骤已完成，可直接估算本批任务；需要复用时可在 3.1.1 保存模板。";
      if (els.estimateHint) els.estimateHint.textContent = "前置步骤已完成，可以估算";
    } else if (isDecompositionConfirmed()) {
      els.estimateBox.textContent = "脚本已确认，请在第 3 步填写产品信息并点击「确认信息」。";
      if (els.estimateHint) els.estimateHint.textContent = "需先确认产品改写信息";
    } else {
      els.estimateBox.textContent = "完成前两步后，在此估算本批任务规模。";
      if (els.estimateHint) els.estimateHint.textContent = "需先完成拆解";
    }
    syncBatchActionButtons();
    if (els.planBox) {
      els.planBox.className = "wz-list empty-line";
      els.planBox.textContent = "尚未生成 Seedance 预案";
    }
    if (els.planHint) els.planHint.textContent = "需先完成估算";
    syncEstimateButtonLabel();
    syncMetrics();
    renderBatchReadiness();
    renderBatchStepProgress();
    syncFlowHints();
    return;
  }
  els.estimateBox.className = "wz-estimate wz-estimate-panel";
  els.estimateBox.innerHTML = `
    <div class="wz-estimate-total">
      <span>本批预计生成</span>
      <strong>${escapeHtml(estimate.scriptCount)}</strong>
      <span>条脚本 · ${escapeHtml(estimate.seedanceSegmentCount)} 段 Seedance · ${escapeHtml(estimate.branchCount || 1)} 个裂变子节点</span>
    </div>
    <div class="wz-kv-grid wz-estimate-grid">
      ${renderKeyValues([
        ["估算编号", estimate.estimateId],
        ["变体数", estimate.variantCount],
        ["输出时长", `${estimate.durationSec}s`],
        ["尺寸", estimate.outputRatio || "-"],
        ["拼接任务", estimate.stitchTaskCount],
        ["生图任务", estimate.imageTaskCount],
        ["同时生成数", estimate.requestedConcurrency],
        ["重试上限", estimate.maxRetryPerTask],
        ["二次确认", estimate.confirmationRequired ? "需要" : "不需要"]
      ])}
    </div>
    ${estimate.models?.length ? `<div class="wz-chipline">${estimate.models.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    ${renderEstimateReferencePreview()}
  `;
  if (els.estimateHint) {
    els.estimateHint.textContent = estimate.confirmationRequired
      ? "任务较多，请勾选确认后再生成预案"
      : "估算完成，可生成 Seedance 预案";
  }
  els.confirmLimits.checked = !estimate.confirmationRequired;
  els.confirmLimits.disabled = isUpstreamWorkflowLocked() || !estimate.confirmationRequired;
  renderPlanPreview(state.batchDetail?.batch);
  syncBatchActionButtons();
  syncEstimateButtonLabel();
  syncMetrics();
  renderBatchReadiness();
  renderBatchStepProgress();
  syncFlowHints();
}

function renderPlanPreview(batch) {
  if (!els.planBox) return;
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const coverage = branchPlanCoverage(collectBranchDrafts(), plans);
  const signatureChanged = Boolean(batch?.planBranchSignature && batch.planBranchSignature !== coverage.signature);
  const stalePlanPreview = batch?.status === "preview_required" && plans.length && (!coverage.ok || signatureChanged);
  if (!plans.length) {
    els.planBox.className = "wz-list empty-line";
    els.planBox.textContent = batch?.status === "preview_required"
      ? "批次已进入预案确认，但未读取到预案列表"
      : "尚未生成 Seedance 预案";
    if (els.planHint) {
      els.planHint.textContent = batch?.status === "preview_required"
        ? "请刷新页面或重新打开批次"
        : state.estimate?.estimate ? "点击「生成 Seedance 预案」" : "需先完成估算";
    }
    syncBatchActionButtons();
    renderBatchStepProgress();
    syncFlowHints();
    return;
  }
  if (els.planHint) {
    els.planHint.textContent = stalePlanPreview
      ? signatureChanged
        ? "第 3 步裂变子节点内容已变化，请重新生成 Seedance 预案"
        : `第 3 步已有 ${coverage.currentBranchCount} 个裂变子节点，当前预案只覆盖 ${coverage.planBranchCount} 个；请重新生成 Seedance 预案`
      : batch?.status === "preview_required"
        ? `共 ${plans.length} 条预案，确认后将提交 Seedance 生成`
        : `${plans.length} 条预案已生成`;
  }
  els.planBox.className = "wz-list";
  const staleNotice = stalePlanPreview
    ? `<div class="wz-warning">${signatureChanged ? "第 3 步裂变子节点内容已变化" : `当前预案未覆盖：${escapeHtml(coverage.missingBranchIds.join("、") || "最新分支")}`}。请点击「生成 Seedance 预案」刷新后再确认。</div>`
    : "";
  els.planBox.innerHTML = `${staleNotice}${plans.map((plan) => `
    <article class="wz-row wz-plan-editor" data-plan-id="${escapeHtml(plan.planId || "")}">
      <div>
        <strong>${escapeHtml(plan.branchLabel || plan.branchId || "分支")} / 变体 ${escapeHtml(plan.branchVariantIndex || plan.variantIndex || "-")} / 分段 ${escapeHtml(plan.segmentIndex || "-")}</strong>
        <small>${escapeHtml(plan.planId || "")}</small>
      </div>
      ${badge(plan.status || "drafted", { drafted: "待确认", confirmed: "已确认" })}
    </article>
    <div class="wz-plan-edit-grid" data-plan-id="${escapeHtml(plan.planId || "")}">
      <label>Hook
        <textarea data-plan-field="hook" rows="2" ${plan.status === "confirmed" ? "disabled" : ""}>${escapeHtml(plan.hook || "")}</textarea>
      </label>
      <label>口播
        <textarea data-plan-field="voiceover" rows="2" ${plan.status === "confirmed" ? "disabled" : ""}>${escapeHtml(plan.voiceover || "")}</textarea>
      </label>
      <label>Seedance Prompt
        <textarea data-plan-field="seedancePrompt" rows="5" ${plan.status === "confirmed" ? "disabled" : ""}>${escapeHtml(plan.seedancePrompt || "")}</textarea>
      </label>
      <label>Negative Prompt
        <textarea data-plan-field="negativePrompt" rows="3" ${plan.status === "confirmed" ? "disabled" : ""}>${escapeHtml(plan.negativePrompt || "")}</textarea>
      </label>
      <div class="wz-kv-grid">
        ${renderKeyValues([
          ["素材引用", Object.values(plan.mediaRefs || {}).filter(Boolean).join(", ") || "-"],
          ["合规提示", Array.isArray(plan.complianceNotes) ? plan.complianceNotes.join(" · ") : "-"]
        ])}
      </div>
      ${renderPlanReferencePreview(batch, plan)}
    </div>
  `).join("")}`;
  syncBatchActionButtons();
  renderBatchStepProgress();
  syncFlowHints();
}

function isPlanPreviewVideoUrl(url = "") {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(String(url));
}

function branchAssetPreviewUrl(branch, assetKey) {
  const url = String(branch?.assetUrls?.[assetKey] || "").trim();
  if (url) return url;
  const storedPath = String(branch?.assetStoredPaths?.[assetKey] || branch?.assetRelativePaths?.[assetKey] || "").trim();
  if (storedPath) return `/file?path=${encodeURIComponent(storedPath)}`;
  return "";
}

function branchDraftForPlan(batch, plan) {
  const live = collectBranchDrafts().find((item) => item.branchId === plan.branchId);
  if (live) return live;
  return (Array.isArray(batch?.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === plan.branchId) || null;
}

function renderPlanReferencePreview(batch, plan) {
  const branch = branchDraftForPlan(batch, plan);
  if (!branch) return "";
  let imageIndex = 0;
  let videoIndex = 0;
  const entries = [];
  for (const key of PLAN_REFERENCE_ASSET_ORDER) {
    const url = branchAssetPreviewUrl(branch, key);
    if (!url) continue;
    const isVideo = isPlanPreviewVideoUrl(url);
    const orderLabel = isVideo ? `视频${++videoIndex}` : `图片${++imageIndex}`;
    entries.push({
      branch: { branchLabel: plan.branchLabel || branch.branchLabel || plan.branchId },
      key,
      url,
      isVideo,
      orderLabel
    });
  }
  if (!entries.length) return `<div class="wz-plan-reference-empty">未上传参考图，不走素材审核与参考图映射。</div>`;
  return `
    <div class="wz-plan-reference-panel">
      <div class="wz-plan-reference-head">参考图位置确认</div>
      ${renderReferenceCanvasGrid(entries, { showReviewMeta: false })}
    </div>
  `;
}

function collectEstimateReferenceEntries() {
  const entries = [];
  for (const branch of collectAllBranchDrafts()) {
    let imageIndex = 0;
    let videoIndex = 0;
    for (const key of PLAN_REFERENCE_ASSET_ORDER) {
      const url = branchAssetPreviewUrl(branch, key);
      if (!url) continue;
      const isVideo = isPlanPreviewVideoUrl(url);
      const orderLabel = isVideo ? `视频${++videoIndex}` : `图片${++imageIndex}`;
      entries.push({
        branch,
        key,
        url,
        isVideo,
        orderLabel,
        review: branch.assetReviews?.[key] || {}
      });
    }
  }
  return entries;
}

function renderReferenceThumb(entry = {}, { showReviewMeta = false } = {}) {
  const { branch, key, url, isVideo, orderLabel, review = {} } = entry;
  const title = [
    branch?.branchLabel || branch?.displayName || branch?.branchId || "",
    orderLabel,
    assetLabel(key)
  ].filter(Boolean).join(" · ");
  const reviewClass = normalizeAssetReviewStatus(review.status) === "approved"
    ? "is-approved"
    : isAssetReviewFailureStatus(review.status)
      ? "is-failed"
      : "is-pending";
  return `
    <figure class="wz-plan-reference-thumb" title="${escapeHtml(title)}">
      <span class="wz-plan-reference-badge">${escapeHtml(orderLabel)}</span>
      ${isVideo
        ? `<video src="${escapeHtml(url)}" controls preload="metadata" playsinline></video>`
        : `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" />`}
      ${showReviewMeta && review.status
        ? `<span class="wz-plan-reference-review ${reviewClass}" title="${escapeHtml(formatAssetReviewStatus(review.status, review.reviewReason))}"></span>`
        : ""}
    </figure>
  `;
}

function renderReferenceCanvasGrid(entries = [], { showReviewMeta = false } = {}) {
  const visible = (Array.isArray(entries) ? entries : []).slice(0, SEEDANCE_REFERENCE_CANVAS.slots);
  if (!visible.length) return "";
  return `
    <div class="wz-plan-reference-grid wz-reference-canvas">
      ${visible.map((entry) => renderReferenceThumb(entry, { showReviewMeta })).join("")}
    </div>
  `;
}

function renderEstimateReferencePreview() {
  const entries = collectEstimateReferenceEntries();
  const confirmed = hasConfirmedAssetReviews();
  return `
    <div class="wz-plan-reference-panel wz-estimate-reference-panel">
      <div class="wz-plan-reference-toolbar">
        <div class="wz-plan-reference-head">Seedance 参考素材顺序确认</div>
        <button type="button" class="mini" data-action="upload-seedance-assets"${isUpstreamWorkflowLocked() ? " disabled" : ""}>上传 Seedance 素材并审核</button>
        ${entries.length
          ? `<button type="button" class="mini" data-action="confirm-seedance-assets"${isUpstreamWorkflowLocked() || confirmed ? " disabled" : ""}>${confirmed ? "审核结果已确认" : "确认审核结果"}</button>`
          : ""}
      </div>
      ${renderReferenceCanvasGrid(entries, { showReviewMeta: true })}
      ${entries.length
        ? `<div class="wz-plan-reference-empty">缩略图按 5 列排列，超过 5 个自动换到第二行；先确认审核结果拿到 assetId，再确认预案并生成视频。</div>`
        : `<div class="wz-plan-reference-empty">尚未上传参考素材；可先上传并审核，未上传时不走素材审核与参考图映射。</div>`}
    </div>
  `;
}

function collectEditablePlans() {
  const batchPlans = state.batchDetail?.batch?.plans || [];
  return batchPlans.map((plan) => {
    const editor = els.planBox?.querySelector(`[data-plan-id="${CSS.escape(plan.planId)}"].wz-plan-edit-grid`);
    const readField = (field) => editor?.querySelector(`[data-plan-field="${field}"]`)?.value.trim();
    return {
      ...plan,
      hook: readField("hook") ?? plan.hook,
      voiceover: readField("voiceover") ?? plan.voiceover,
      seedancePrompt: readField("seedancePrompt") ?? plan.seedancePrompt,
      negativePrompt: readField("negativePrompt") ?? plan.negativePrompt
    };
  });
}

function syncBatchNodeStatus(status = "") {
  const batchNode = document.getElementById("wzNodeBatch");
  if (!batchNode) return;
  if (status) batchNode.dataset.batchStatus = status;
  else delete batchNode.dataset.batchStatus;
}

function batchRenderFingerprintFrom(detail, tasks = [], outputs = [], events = []) {
  const batch = detail?.batch || {};
  return [
    batch.status || "",
    batch.batchId || "",
    outputPreviewItemsFingerprint(outputs),
    tasks.map((task) => [
      task.generationTaskId || "",
      task.status || "",
      task.progress ?? "",
      task.seedanceTaskId || "",
      task.errorMessage || ""
    ].join(":")).join("|"),
    events.length,
    detail?.downloadSummary?.packageReady ? "1" : "0",
    batch.qcSummary?.passed ?? "",
    batch.qcSummary?.failed ?? "",
    els.includeSegments?.checked ? "1" : "0"
  ].join("||");
}

function batchTaskArchiveMessage(batch = {}, detail = {}) {
  const summary = detail.downloadSummary || {};
  if (!batch.batchId) return "当前工作流提交为任务后，最终结果、质检报告、交付包和历史记录统一在任务管理中查看。";
  if (batch.status === "qc") return "视频已生成完成，请到任务管理中运行或查看质检，并在质检后下载交付包。";
  if (batch.status === "partial_failed") return "任务部分失败，请到任务管理中查看可用输出、下载可用分段或处理失败项。";
  if (batch.status === "succeeded") return "任务已完成，最终输出集合、质检报告和交付包已归口到任务管理。";
  if (batch.status === "failed") return "任务失败，请到任务管理查看失败原因、过程事件和可恢复动作。";
  if (summary.packageReady) return "交付包已就绪，请到任务管理查看最终结果并下载。";
  return "当前任务正在办理中，最终结果集合和交付包会统一归档到任务管理。";
}

function renderTaskArchive(batch = state.batchDetail?.batch) {
  if (!els.taskArchiveBox && !els.taskDetailLink) return;
  const detail = state.batchDetail || {};
  const batchId = batch?.batchId || "";
  const href = taskSpaceHref("batch", batchId);
  if (els.taskDetailLink) {
    els.taskDetailLink.href = href;
    els.taskDetailLink.classList.remove("disabled");
    els.taskDetailLink.removeAttribute("aria-disabled");
  }
  if (!els.taskArchiveBox) return;
  if (!batchId) {
    els.taskArchiveBox.className = "wz-list empty-line";
    els.taskArchiveBox.textContent = batchTaskArchiveMessage();
    return;
  }
  const summary = detail.downloadSummary || {};
  els.taskArchiveBox.className = "wz-list";
  els.taskArchiveBox.innerHTML = `
    <article class="wz-row wz-task-archive-card">
      <div>
        <strong>${escapeHtml(batchDisplayName(batch) || batchId)}</strong>
        <small>${escapeHtml(batchId)} · ${escapeHtml(batch.createdAt || "")}</small>
        <p>${escapeHtml(batchTaskArchiveMessage(batch, detail))}</p>
      </div>
      ${badge(batch.status, {
        ...batchStatusLabels,
        [batch.status]: batchStatusDisplayLabel(batch)
      })}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["输出总数", summary.outputsTotal ?? batch.outputs?.length ?? 0],
        ["可下载", summary.downloadEligibleCount ?? 0],
        ["交付包", summary.packageReady ? "ready" : "not_ready"],
        ["结果归口", "任务管理"]
      ])}
    </div>
    <div class="modal-actions wz-actions wz-task-archive-actions">
      <a class="mini" href="${escapeHtml(href)}">查看任务详情</a>
      <a class="mini ghost" href="${escapeHtml(taskSpaceHref("batch"))}">打开任务管理</a>
    </div>
  `;
}

function renderBatch() {
  const detail = state.batchDetail;
  const batch = detail?.batch;
  if (!batch) {
    syncBatchNodeStatus();
    els.batchBadge.textContent = "未开始";
    els.batchBox.className = "wz-list empty-line";
    els.batchBox.textContent = "暂无批次";
    batchRenderFingerprint = "";
    batchOutputsRenderFingerprint = "";
    if (els.batchOutputsBox) {
      els.batchOutputsBox.hidden = true;
      els.batchOutputsBox.innerHTML = "";
    }
    els.stopBatchBtn.disabled = true;
    els.runQcBtn.disabled = true;
    renderPlanPreview(null);
    renderTaskArchive(null);
    syncMetrics();
    renderBatchStepProgress();
    syncFlowHints();
    stopRuntimeClock();
    return;
  }
  syncBatchNodeStatus(batch.status);
  els.batchBadge.innerHTML = badge(batch.status, {
    ...batchStatusLabels,
    [batch.status]: batchStatusDisplayLabel(batch)
  });
  if (els.estimateBtn) els.estimateBtn.disabled = isQcBatchPending(batch) || isSeedancePlanConfirmed(batch);
  els.stopBatchBtn.disabled = terminalBatchStatus(batch.status);
  els.stopBatchBtn.textContent = isQcBatchPending(batch) ? "放弃批次" : "停止任务";
  els.retryStitchBtn.hidden = batch.status !== "partial_failed";
  els.retryStitchBtn.disabled = batch.status !== "partial_failed";
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
  const qcRunnable = isBatchQcRunnable(batch, tasks, outputs);
  els.runQcBtn.disabled = !qcRunnable;
  const generationActive = isBatchGenerationActive(batch, tasks);
  const logNode = document.getElementById("wzNodeLog");
  if (logNode) logNode.classList.toggle("wz-generation-live", generationActive);
  const renderFingerprint = batchRenderFingerprintFrom(detail, tasks, outputs, events);
  if (renderFingerprint === batchRenderFingerprint) {
    renderBatchOutputPreviews(outputs);
    if (els.downloadBtn && els.includeSegments) {
      els.downloadBtn.disabled = !detail.downloadSummary?.packageReady && !(batch.status === "partial_failed" && els.includeSegments.checked);
    }
    renderTaskArchive(batch);
    renderPlanPreview(batch);
    syncMetrics();
    renderBatchReadiness();
    renderBatchStepProgress();
    syncFlowHints();
    syncStartNewTaskButton();
    return;
  }
  const previewPlayback = snapshotPreviewPlayback(els.batchBox);
  els.batchBox.className = "wz-list";
  const retryActions = batch.status === "preview_required"
    ? [{ id: "re-estimate", label: "重新估算" }]
    : batch.status === "partial_failed"
    ? [{ id: "retry-stitch", label: "重试拼接" }, { id: "re-estimate", label: "重新估算" }]
    : batch.status === "failed"
      ? qcRunnable
        ? [{ id: "rerun-qc", label: "重新质检" }, { id: "re-estimate", label: "重新估算" }]
        : [{ id: "re-estimate", label: "重新估算" }]
      : [];
  els.batchBox.innerHTML = `
    ${batchProgressSection(batch, tasks, outputs)}
    ${batch.status === "qc" ? `<div class="wz-warning">视频已生成完成，下一步请运行视频质检；如不再交付本批次，可选择放弃批次。</div>` : ""}
    ${generationActive ? `<div class="wz-generation-panel is-live"><div class="wz-generation-head"><strong>Seedance 视频生成中</strong><span class="wz-badge neutral">实时刷新</span></div><p class="wz-generation-note">页面每 2 秒轮询一次上游任务状态；下方卡片展示每个分段的提交模式、上游任务 ID 与当前阶段。</p><div class="wz-generation-tasks">${renderGenerationTaskCards(tasks)}</div></div>` : ""}
    ${renderFailureReasons({ batch, tasks, outputs, providerJob: batch.providerJob })}
    <div class="wz-info">生成 Seedance 预案不会校验参考素材 assetId；请先点击「上传 Seedance 素材并审核」，确认预案并生成视频时会校验 assetId 与审核状态。未上传参考图时不走素材审核。确认后会按 <code>omni_reference</code> 提交 Seedance，预案确认区会展示参考图顺序，方便核对 图片n / 视频n 映射。</div>
    ${inlineRetryHtml({
      message: batch.status === "failed"
        ? (qcRunnable
          ? "视频已生成但质检未通过，可点击「运行视频质检」或「重新质检」重试，无需重新提交 Seedance"
          : "批次生成失败，可重新估算后再次提交")
        : batch.status === "partial_failed"
          ? "部分任务失败，可重试拼接或重新估算"
          : "",
      actions: retryActions
    })}
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(batchDisplayName(batch) || batch.batchId)}</strong>
        <small>${escapeHtml(batch.batchId)} · 创建 ${escapeHtml(formatTimestamp(batch.createdAt))} · 更新 ${escapeHtml(formatTimestamp(batch.updatedAt))} · ${tasks.length} 个任务 · ${escapeHtml(batch.estimate?.durationSec || "-")}s</small>
      </div>
      ${badge(batch.status, {
        ...batchStatusLabels,
        [batch.status]: batchStatusDisplayLabel(batch)
      })}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["输出总数", detail.downloadSummary?.outputsTotal || outputs.length || 0],
        ["可下载", detail.downloadSummary?.downloadEligibleCount || 0],
        ["包状态", detail.downloadSummary?.packageReady ? "ready" : "not_ready"],
        ["QC 通过", batch.qcSummary?.passed || 0],
        ["QC 失败", batch.qcSummary?.failed || 0],
        ["模型视频质检", modelQcStatusLabel(outputs, qcRunnable)]
      ])}
    </div>
    <div class="wz-task-list">
      ${tasks.slice(0, 12).map((task) => `
        <div>
          <span>${escapeHtml(task.generationTaskId)}</span>
          <strong>${escapeHtml(batchGenerationTaskStatusLabels[task.status] || task.status)}</strong>
          <small>${escapeHtml(task.errorMessage || task.seedanceTaskId || task.errorCode || "pending")}</small>
        </div>
      `).join("")}
    </div>
    ${events.length ? `<div class="wz-events"><strong>过程事件</strong>${events.slice(-8).map((event) => `<small>${escapeHtml(formatWorkflowEvent(event))} · ${escapeHtml(formatTimestamp(event.createdAt))}</small>`).join("")}</div>` : ""}
  `;
  restorePreviewPlayback(previewPlayback, els.batchBox);
  batchRenderFingerprint = renderFingerprint;
  renderBatchOutputPreviews(outputs);
  if (els.downloadBtn && els.includeSegments) {
    els.downloadBtn.disabled = !detail.downloadSummary?.packageReady && !(batch.status === "partial_failed" && els.includeSegments.checked);
  }
  renderTaskArchive(batch);
  renderPlanPreview(batch);
  syncMetrics();
  renderBatchReadiness();
  renderBatchStepProgress();
  syncFlowHints();
  syncStartNewTaskButton();
  if (terminalBatchStatus(batch.status)) stopRuntimeClock();
  else syncRuntimeClock();
}

function renderBatchOutputPreviews(outputs = [], { force = false } = {}) {
  const box = els.batchOutputsBox;
  if (!box) return;
  const items = Array.isArray(outputs) ? outputs.filter(Boolean) : [];
  const fingerprint = outputPreviewItemsFingerprint(items);
  if (!force && fingerprint === batchOutputsRenderFingerprint) return;
  batchOutputsRenderFingerprint = fingerprint;
  if (!items.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  patchOutputPreviewCards(box, items, { emptyText: "Seedance 输出生成后会显示在这里" });
}

function renderGallery({ force = false } = {}) {
  if (!els.galleryBox) {
    syncMetrics();
    return;
  }
  const gallery = state.gallery;
  const fingerprint = galleryStateFingerprint(gallery);
  if (!force && fingerprint === galleryRenderFingerprint) return;
  galleryRenderFingerprint = fingerprint;
  if (!gallery?.items?.length) {
    els.galleryBox.className = "wz-gallery empty-line";
    els.galleryBox.innerHTML = `
      <span>暂无可展示结果</span>
      ${galleryPaginationHtml(gallery)}
    `;
    syncMetrics();
    return;
  }
  els.galleryBox.className = "wz-gallery";
  let hasPreviewRoot = false;
  for (const child of els.galleryBox.children) {
    if (child.classList.contains("wz-output-previews") && !child.classList.contains("empty-line")) {
      hasPreviewRoot = true;
      break;
    }
  }
  if (!hasPreviewRoot) {
    for (const node of [...els.galleryBox.children]) {
      if (!node.classList.contains("wz-gallery-pager")) node.remove();
    }
  }
  patchOutputPreviewCards(els.galleryBox, gallery.items);
  let pager = null;
  for (const child of els.galleryBox.children) {
    if (child.classList.contains("wz-gallery-pager")) {
      pager = child;
      break;
    }
  }
  const pagerHtml = galleryPaginationHtml(gallery);
  if (pager) pager.outerHTML = pagerHtml;
  else els.galleryBox.insertAdjacentHTML("beforeend", pagerHtml);
  syncMetrics();
}

function isVideoPreviewItem(item = {}) {
  const kind = String(item.kind || "").toLowerCase();
  const url = String(item.previewUrl || item.storageUrl || "").toLowerCase();
  return kind.includes("video") || /\.(mp4|webm|mov)(\?|#|$)/.test(url);
}

function renderOutputPreview(item = {}) {
  const safeUrl = escapeHtml(item.previewUrl || item.storageUrl || "");
  if (!safeUrl) return "";
  if (isVideoPreviewItem(item)) {
    return `<div class="wz-output-preview"><video src="${safeUrl}" controls preload="metadata" playsinline></video></div>`;
  }
  return `<a href="${safeUrl}" target="_blank" rel="noreferrer">预览文件</a>`;
}

function renderStartError(error) {
  if (error?.code === "asset_review_pending") {
    applyAssetReviewFailureFromError(error);
    return;
  }
  renderError(els.globalError, error, "批次启动失败");
  showActiveLockFromError(lockHost(), error);
}

async function loadTemplates() {
  const data = await apiEnvelope("/api/wangzhuan/templates");
  state.templates = data.templates || [];
  state.permissions = data.permissions || {};
  renderTemplates();
}

async function loadRules(node = primaryBranchNode()) {
  const params = new URLSearchParams({
    channel: fieldValue(node, "targetChannel") || els.targetChannel?.value || "meta_ads",
    promiseLevel: fieldValue(node, "promiseLevel") || els.promiseLevel?.value || "stable"
  });
  renderRules(await apiEnvelope(`/api/wangzhuan/channel-rules?${params}`), node);
  applyDisclaimerPresetForNode(node, { force: false });
}

function showBranchDraftValidationError(validation) {
  if (!validation) return false;
  if (validation.incompleteBranch) {
    const { incompleteBranch } = validation;
    const branchMissing = incompleteBranch.missingFields;
    const branchLabels = incompleteBranch.missingLabels || branchMissing;
    const moduleLabel = BRANCH_MODULE_LABELS[incompleteBranch.module] || "改写信息";
    if (incompleteBranch.kind === "strong") {
      focusRewriteStep([], incompleteBranch.node, "delivery");
      incompleteBranch.node?.querySelector(".wz-truth-details")?.setAttribute("open", "");
      renderError(els.globalError, {
        code: "strong_rule_missing",
        message: `改写 3.${incompleteBranch.index + 1} · ${moduleLabel}：强承诺需要补齐真实收益规则（${branchLabels.join("、")}）`,
        data: { missingFields: branchMissing }
      }, "模板校验");
    } else {
      focusBranchValidationIssue(incompleteBranch.node, incompleteBranch.issue);
      renderError(els.globalError, {
        code: "validation_error",
        message: `改写 3.${incompleteBranch.index + 1} · ${moduleLabel}：请先补齐 ${branchLabels.join("、")}`,
        data: { missingFields: branchMissing, module: incompleteBranch.module }
      }, "模板校验");
    }
    incompleteBranch.node?.classList.remove("collapsed");
    if (!window.matchMedia("(min-width: 981px)").matches) {
      incompleteBranch.node?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
    return true;
  }
  if (validation.missingStrong?.length) {
    focusRewriteStep();
    els.truthDetails.open = true;
    renderError(els.globalError, {
      code: "strong_rule_missing",
      message: "强承诺需要补齐真实收益规则",
      data: { missingFields: validation.missingStrong }
    }, "模板校验");
    return true;
  }
  return false;
}

function resolveBranchDraftValidationError() {
  const incompleteBranch = findIncompleteBranchDraft();
  if (incompleteBranch) return { incompleteBranch, missingStrong: null };
  const missingStrong = missingStrongFields(draftFromForm());
  if (missingStrong.length) return { incompleteBranch: null, missingStrong };
  return null;
}

async function confirmRewriteInfo() {
  if (isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  if (showBranchDraftValidationError(resolveBranchDraftValidationError())) return;
  setConfirmRewriteButtonsBusy(true, "上传素材");
  try {
    await uploadBranchAssets();
  } catch (error) {
    setConfirmRewriteButtonsBusy(false);
    renderError(els.globalError, error, "产品素材上传失败");
    return;
  }
  try {
    invalidateEstimateFromEdit();
    const draft = draftFromForm();
    await saveDraftBatch({
      status: "checking",
      sourceStep: "rewrite_confirmed",
      templateSnapshot: { draft },
      branches: draft.branches || [],
      decomposition: state.decomposition
    });
    setRewriteConfirmed(true);
    focusBatchStep();
    showToast(
      branchNodes().length > 1 ? "全部裂变子节点已确认，可开始估算批次" : "产品信息已确认，可开始估算批次",
      { type: "success" }
    );
  } catch (error) {
    renderError(els.globalError, error, "产品信息确认失败");
  } finally {
    setConfirmRewriteButtonsBusy(false);
  }
}

async function saveTemplate() {
  if (isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  if (isTemplateCommitted()) {
    showToast("模板已保存；修改内容后会自动解锁再次保存", { type: "info" });
    return;
  }
  if (showBranchDraftValidationError(resolveBranchDraftValidationError())) return;
  setSaveTemplateButtonsBusy(true, "上传素材");
  try {
    await uploadBranchAssets();
  } catch (error) {
    setSaveTemplateButtonsBusy(false);
    renderError(els.globalError, error, "产品素材上传失败");
    return;
  }
  setSaveTemplateButtonsBusy(true, "保存中");
  try {
    const draft = draftFromForm();
    const body = state.selectedTemplate
      ? selectedTemplateNameChanged(draft)
        ? { mode: "copy", copyFromVersionId: state.selectedTemplate.versionId, draft }
        : { mode: "edit_new_version", templateId: state.selectedTemplate.templateId, draft }
      : { mode: "create", draft };
    const data = await apiEnvelope("/api/wangzhuan/templates", { method: "POST", body: JSON.stringify(body) });
    await saveDraftBatch({
      status: "checking",
      sourceStep: "template_saved",
      templateSnapshot: { draft: data.template?.draft || draft },
      branches: data.template?.draft?.branches || draft.branches || [],
      decomposition: state.decomposition
    });
    await loadTemplates();
    syncTemplateSelectValues(data.template.versionId);
    applyTemplate(data.template);
    setTemplateCommitted(true, data.template);
    showToast("产品模板已保存，可在后续批次中复用", { type: "success" });
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    const serverMissing = Array.isArray(error?.data?.missingFields) ? error.data.missingFields : [];
    if (serverMissing.length) focusRewriteStep(serverMissing);
    renderError(els.globalError, error, "模板保存失败");
  } finally {
    setSaveTemplateButtonsBusy(false);
  }
}

async function checkReferenceVideo() {
  clearError(els.globalError);
  setBusy(els.checkReferenceBtn, true, "检查中");
  if (els.referenceUploadStatus) {
    els.referenceUploadStatus.textContent = "正在上传并读取视频信息，请稍等。";
  }
  syncReferenceHints();
  try {
    const file = els.referenceFile.files?.[0];
    if (!file) {
      state.referenceVideo = null;
      renderReference();
      throw {
        code: "file_required",
        message: "请选择一个真实参考视频文件，系统会读取时长、画幅和音轨信息"
      };
    }
    const content = await dataUrlFromFile(file);
    const data = await apiEnvelope("/api/wangzhuan/reference-videos/check", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        content
      })
    });
    state.referenceVideo = data.referenceVideo;
    clearDecompositionDraft();
    await saveDraftBatch({
      status: "checking",
      sourceStep: "reference_checked",
      referenceVideo: data.referenceVideo
    });
    persistWorkflowSession();
    clearReferenceObjectUrl();
    renderReference();
    showToast("参考视频信息已读取，请确认后进入脚本拆解", { type: "success" });
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    if (els.referenceUploadStatus) {
      els.referenceUploadStatus.textContent = "上传或检查失败，请重新选择参考视频。";
    }
    renderError(els.globalError, error, "参考视频检查失败");
  } finally {
    setBusy(els.checkReferenceBtn, false);
    syncReferenceHints();
  }
}

async function decomposeReferenceVideo() {
  if (!state.referenceVideo || isDecompositionConfirmed() || isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  const draft = collectDecompositionFromForm();
  const missingFields = DECOMPOSITION_REQUIRED_FIELDS.filter((field) => !draft[field]);
  if (missingFields.length) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "脚本拆解缺少必填字段",
      data: { missingFields }
    }, "脚本确认失败");
    return;
  }
  setBusy(els.decomposeBtn, true, "确认中");
  try {
    const data = await apiEnvelope("/api/wangzhuan/reference-videos/decompose", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("decompose"),
        referenceVideoId: state.referenceVideo.referenceVideoId,
        decomposition: draft
      })
    });
    state.decomposition = data.decomposition;
    state.decompositionDraft = null;
    state.estimate = null;
    await saveDraftBatch({
      status: "checking",
      sourceStep: "decomposition_confirmed",
      decomposition: data.decomposition
    });
    renderDecompositionForm(data.decomposition || draft);
    renderReference();
    renderEstimate();
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = DECOMPOSITION_CONFIRMED_MESSAGE;
    persistWorkflowSession();
    renderBatchReadiness();
    focusRewriteStep();
    showToast("脚本拆解已确认，请继续产品改写", { type: "success" });
  } catch (error) {
    renderError(els.globalError, error, "拆解确认失败");
  } finally {
    setBusy(els.decomposeBtn, false);
    syncDecompositionControls();
  }
}

async function inspectStorePage(node = primaryBranchNode()) {
  clearError(els.globalError);
  const url = fieldValue(node, "productLink") || els.productLink?.value.trim();
  if (!url) {
    renderError(els.globalError, { code: "validation_error", message: "请先填写产品链接" }, "商店页读取失败");
    return;
  }
  const button = node?.querySelector(".wz-inspect-store-btn") || els.inspectStoreBtn;
  setBusy(button, true, "读取中");
  try {
    state.storeInspection = await apiEnvelope("/api/wangzhuan/store-page/inspect", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    renderStoreCandidates(node);
    showToast("商店页候选信息已读取", { type: "success" });
  } catch (error) {
    renderError(els.globalError, error, "商店页读取失败");
  } finally {
    setBusy(button, false);
  }
}

function branchNodeFromEvent(event) {
  return event.target instanceof Element ? event.target.closest(".wz-node-branch") : null;
}

function estimateRequest(draft = draftFromForm()) {
  const template = state.selectedTemplate;
  const node = primaryBranchNode();
  const languages = splitMultiValue(
    fieldValue(node, "languages")
      || fieldValue(node, "language")
      || els.languages?.value
      || els.language?.value,
    ["en-US"]
  );
  const targetRegions = splitMultiValue(
    fieldValue(node, "targetRegions")
      || fieldValue(node, "regions")
      || fieldValue(node, "targetRegion")
      || els.targetRegions?.value
      || els.regions?.value,
    ["US"]
  );
  const disclaimerFields = disclaimerRequestFields();
  const targetChannel = draft.targetChannels?.[0]
    || fieldValue(node, "targetChannel")
    || els.targetChannel.value
    || "meta_ads";
  const promiseLevel = draft.promiseLevel
    || fieldValue(node, "promiseLevel")
    || els.promiseLevel.value
    || "stable";
  const branches = draft.branches || collectBranchDrafts();
  return {
    batchId: currentBatchId() || undefined,
    templateId: template?.templateId,
    versionId: template?.versionId,
    projectName: els.projectName.value.trim(),
    batchName: ensureUserBatchNameForSubmit(),
    generationMode: els.generationMode.value,
    model: els.modelSelect.value,
    seedanceModel: els.seedanceModel.value.trim(),
    referenceVideoId: state.referenceVideo?.referenceVideoId,
    targetChannel,
    targetRegion: targetRegions[0] || "US",
    targetRegions,
    language: languages[0] || "en-US",
    languages,
    promiseLevel,
    durationSec: Number(els.duration.value),
    variantCount: Number(els.variantCount.value),
    requestedConcurrency: Number(els.concurrency.value),
    outputRatio: els.outputRatio?.value || "9:16",
    branches,
    templateSnapshot: {
      versionId: template?.versionId,
      draft
    },
    llmConfig: decompositionLlmConfig(),
    planLlmConfig: planLlmConfig(),
    knowledgeNotes: els.knowledgeNotes.value.trim(),
    variantPrompt: els.variantPrompt.value.trim(),
    ...disclaimerFields
  };
}

function estimateRequestSignature() {
  const request = estimateRequest();
  delete request.templateSnapshot;
  delete request.llmConfig;
  delete request.planLlmConfig;
  return JSON.stringify(request);
}

function currentBatchId() {
  return state.batchDetail?.batch?.batchId || "";
}

async function saveDraftBatch({ status, sourceStep = "", referenceVideo, decomposition, templateSnapshot, branches, estimate } = {}) {
  const nextReferenceVideo = referenceVideo || state.referenceVideo;
  if (!nextReferenceVideo?.referenceVideoId) return null;
  const draft = draftFromForm();
  const payload = {
    batchId: currentBatchId() || undefined,
    ...(status ? { status } : {}),
    sourceStep,
    batchName: ensureUserBatchNameForSubmit(),
    productName: draft.productName || "",
    productLink: draft.productLink || "",
    knowledgeNotes: els.knowledgeNotes?.value.trim() || "",
    llmConfig: decompositionLlmConfig(),
    planLlmConfig: planLlmConfig(),
    targetChannel: els.targetChannel?.value || "",
    targetRegion: els.targetRegion?.value || "",
    targetRegions: splitMultiValue(els.targetRegions?.value || els.regions?.value || "", []),
    language: splitMultiValue(els.languages?.value || els.language?.value, ["en-US"])[0] || "en-US",
    languages: splitMultiValue(els.languages?.value || els.language?.value, ["en-US"]),
    promiseLevel: els.promiseLevel?.value || "",
    durationSec: Number(els.duration?.value || 0) || undefined,
    outputRatio: els.outputRatio?.value || "",
    variantCount: Number(els.variantCount?.value || 0) || undefined,
    requestedConcurrency: Number(els.concurrency?.value || 0) || undefined,
    templateId: state.selectedTemplate?.templateId,
    versionId: state.selectedTemplate?.versionId,
    templateSnapshot: templateSnapshot ?? (isTemplateCommitted() ? { draft } : undefined),
    branches: branches ?? draft.branches ?? [],
    branchDrafts: branches ?? draft.branches ?? [],
    decomposition: decomposition ?? state.decomposition,
    referenceVideo: nextReferenceVideo,
    ...(estimate ? { estimate } : {}),
    ...disclaimerRequestFields()
  };
  const detail = await apiEnvelope("/api/wangzhuan/batches/draft", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (detail?.batch?.batchId) {
    state.batchDetail = detail;
    renderBatch();
  }
  return detail;
}

async function estimateBatch() {
  if (isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  if (!state.referenceVideo || !state.decomposition) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先上传参考视频并确认脚本拆解"
    }, "估算前置条件");
    return;
  }
  if (!isRewriteConfirmed()) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先在第 3 步填写产品信息并点击「确认信息」"
    }, "估算前置条件");
    focusRewriteStep();
    return;
  }
  const draft = draftFromForm();
  if (showBranchDraftValidationError(resolveBranchDraftValidationError())) return;
  setBusy(els.estimateBtn, true, "估算中");
  try {
    await saveDraftBatch({
      status: "checking",
      sourceStep: "estimate",
      templateSnapshot: { draft },
      branches: draft.branches || [],
      decomposition: state.decomposition
    });
    const data = await apiEnvelope("/api/wangzhuan/batches/estimate", {
      method: "POST",
      body: JSON.stringify(estimateRequest(draft))
    });
    state.estimate = data;
    state.estimate.requestSignature = estimateRequestSignature();
    state.capabilities = data.capabilities || null;
    await saveDraftBatch({
      sourceStep: "estimate",
      templateSnapshot: { draft },
      branches: draft.branches || [],
      decomposition: state.decomposition,
      estimate: data.estimate
    });
    renderEstimate();
    showToast("批次估算完成", { type: "success" });
  } catch (error) {
    if (error.code === "strong_rule_missing") els.truthDetails.open = true;
    state.estimate = null;
    renderEstimate();
    if (error?.code === "batch_already_running") {
      renderStartError(error);
    } else {
      renderError(els.globalError, error, "估算失败");
    }
  } finally {
    setBusy(els.estimateBtn, false);
  }
}

async function loadBatchDetail({ quiet = false } = {}) {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return null;
  const data = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  if (state.batchDetail?.batch?.batchId !== batchId) return null;
  state.batchDetail = data;
  renderBatch();
  return data;
}

function stopPolling() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.pollGeneration += 1;
}

function startPolling() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  const generation = state.pollGeneration;
  const tick = async () => {
    if (generation !== state.pollGeneration) return;
    try {
      const previousStatus = state.batchDetail?.batch?.status;
      const detail = await loadBatchDetail();
      if (generation !== state.pollGeneration) return;
      await loadGallerySafely();
      if (generation !== state.pollGeneration) return;
      const batch = detail?.batch;
      if (!batch || !shouldKeepBatchLive(batch)) {
        if (batch) {
          renderBatchOutputPreviews(batch.outputs || [], { force: true });
          await loadGallery({ force: true }).catch(() => {});
        }
        if (batch && batch.status !== previousStatus) {
          if (batch.status === "succeeded") {
            showToast("批次生成完成，可下载交付包", { type: "success" });
          } else if (batch.status === "partial_failed" || batch.status === "failed") {
            showToast("批次未完全成功，可在步骤 5 查看日志或在任务管理中重试", { type: "info", duration: 5200 });
          }
        }
        return;
      }
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    } catch (error) {
      if (generation !== state.pollGeneration) return;
      if (state.batchDetail?.batch) {
        renderBatchOutputPreviews(state.batchDetail.batch.outputs || [], { force: true });
      }
      if (error?.code !== "internal_error" || !state.batchDetail?.batch) {
        renderError(els.globalError, error, "批次轮询失败");
      }
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    }
  };
  state.pollTimer = window.setTimeout(tick, 1200);
}

async function planBatch() {
  if (isUpstreamWorkflowLocked()) return;
  if (!isRewriteConfirmed()) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先在第 3 步填写产品信息并点击「确认信息」"
    }, "生成预案前置条件");
    focusRewriteStep();
    return;
  }
  if (!state.estimate?.estimate || state.estimate.requestSignature !== estimateRequestSignature()) {
    await estimateBatch();
  }
  const estimate = state.estimate?.estimate;
  if (!estimate) return;
  if (estimate.confirmationRequired && !els.confirmLimits.checked) {
    renderError(els.globalError, {
      code: "limit_confirmation_required",
      message: "请先确认估算中的任务数和分段数"
    }, "生成预案前确认");
    return;
  }
  clearError(els.globalError);
  clearActiveLockBanner(lockHost());
  setBusy(els.planBatchBtn, true, "生成中");
  try {
    const data = await apiEnvelopeStream("/api/wangzhuan/batches/plan/stream", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("batch_plan"),
        ...(currentBatchId() ? { batchId: currentBatchId() } : {}),
        estimateId: estimate.estimateId,
        llmConfig: planLlmConfig(),
        knowledgeNotes: els.knowledgeNotes.value.trim(),
        ...(estimate.confirmationToken ? { confirmationToken: estimate.confirmationToken } : {})
      })
    }, { title: "Seedance 预案 · LLM 控制台" });
    const planBranchSignature = branchPlanCoverage(collectBranchDrafts(), data.batch?.plans || data.plans || []).signature;
    if (data.batch) data.batch.planBranchSignature = planBranchSignature;
    state.batchDetail = {
      batch: data.batch,
      events: [],
      downloadSummary: { outputsTotal: 0, downloadEligibleCount: 0, packageReady: false, missingFiles: [] }
    };
    if (data.batch?.batchId) {
      state.batchDetail = await loadBatchDetail();
      if (state.batchDetail?.batch) state.batchDetail.batch.planBranchSignature = planBranchSignature;
    }
    renderBatch();
    focusBatchStep();
    showToast("Seedance 预案已生成，请确认后提交", { type: "success" });
  } catch (error) {
    renderStartError(error);
  } finally {
    setBusy(els.planBatchBtn, false);
    renderEstimate();
  }
}

async function confirmPlanBatch() {
  const batchId = state.batchDetail?.batch?.batchId;
  const plans = state.batchDetail?.batch?.plans || [];
  if (!batchId || !plans.length) return;
  if (isUpstreamWorkflowLocked()) return;
  clearError(els.globalError);
  if (isCurrentPlanPreviewStale()) {
    const coverage = currentPlanCoverage();
    renderError(els.globalError, {
      code: "stale_seedance_plan",
      message: "第 3 步裂变子节点已变化，请重新生成 Seedance 预案后再确认生成",
      data: {
        missingFields: coverage.missingBranchIds,
        currentBranchCount: coverage.currentBranchCount,
        planBranchCount: coverage.planBranchCount
      }
    }, "预案已过期");
    renderPlanPreview(state.batchDetail?.batch);
    return;
  }
  setBusy(els.confirmPlanBtn, true, "确认中");
  try {
    try {
      await uploadBranchAssets();
    } catch (error) {
      renderError(els.globalError, error, "产品素材上传失败");
      return;
    }
    await saveDraftBatch({
      sourceStep: "seedance_assets_reviewed",
      templateSnapshot: { draft: draftFromForm() },
      branches: collectBranchDrafts(),
      decomposition: state.decomposition
    });
    const data = await confirmBatchPlanRequest(batchId, collectEditablePlans(), "", collectBranchDrafts(), {
      assetReviewConfirmed: hasConfirmedAssetReviews()
    });
    if (data.batch?.batchId) {
      state.batchDetail = await loadBatchDetail();
    } else {
      state.batchDetail = {
        batch: data.confirmedBatch || data.batch,
        events: [],
        downloadSummary: { outputsTotal: 0, downloadEligibleCount: 0, packageReady: false, missingFiles: [] }
      };
    }
    renderBatch();
    startPolling();
    focusLogStep();
    showToast("批次已提交 Seedance 生成，正在轮询上游进度", { type: "success" });
  } catch (error) {
    if (error?.code === "asset_review_pending") {
      applyAssetReviewFailureFromError(error);
      return;
    }
    renderError(els.globalError, error, "确认预案失败");
  } finally {
    setBusy(els.confirmPlanBtn, false);
    renderEstimate();
  }
}

async function stopBatch() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return;
  setBusy(els.stopBatchBtn, true, "停止中");
  try {
    state.batchDetail = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ reason: "frontend_stop" })
    });
    stopPolling();
    renderBatch();
    await refreshBackgroundActiveBatchBanner();
    syncStartNewTaskButton();
    showToast("批次已停止", { type: "success" });
  } catch (error) {
    renderError(els.globalError, error, "停止失败");
  } finally {
    setBusy(els.stopBatchBtn, false);
  }
}

async function retryStitch() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return;
  clearError(els.globalError);
  setBusy(els.retryStitchBtn, true, "重试中");
  try {
    state.batchDetail = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/retry-stitch`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: idempotencyKey("retry_stitch") })
    });
    renderBatch();
    await loadGallery();
    if (shouldKeepBatchLive(state.batchDetail?.batch)) startPolling();
  } catch (error) {
    renderError(els.globalError, error, "重试拼接失败");
  } finally {
    setBusy(els.retryStitchBtn, false);
  }
}

async function loadBatchById(batchId) {
  const data = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  state.batchDetail = data;
  renderBatch();
  if (shouldKeepBatchLive(data.batch)) startPolling();
  return data;
}

async function loadActiveBatch() {
  const detail = await apiEnvelope("/api/wangzhuan/batches/active");
  if (!detail?.batch) {
    state.batchDetail = null;
    renderBatch();
    return null;
  }
  state.batchDetail = detail;
  renderBatch();
  await loadGallerySafely();
  if (shouldKeepBatchLive(detail.batch)) startPolling();
  return detail;
}

function focusWorkbenchFromHash() {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "wzNodeBatch") {
    focusBatchStep();
    return;
  }
  if (hash === "wzNodeLog") {
    focusLogStep();
    return;
  }
  if (hash) wzFocusNodeId(hash);
}

async function restoreBatchWorkbenchFromTasks(batchId) {
  const data = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  if (!data?.batch) return false;
  state.batchDetail = data;
  await hydrateReferenceWorkflowFromBatch(data.batch);
  restoreWorkflowFromBatch(data);
  renderBatch();
  if (shouldKeepBatchLive(data.batch)) startPolling();
  if (isBackgroundReminderBatch(data.batch)) {
    const lock = activeLockFromBatchInfo(data.batch);
    if (lock) renderActiveLockBanner(lockHost(), lock);
    renderBatchOutputPreviews(data.batch.outputs || [], { force: true });
  }
  await loadGallerySafely();
  focusWorkbenchFromHash();
  return true;
}

async function runVideoQc() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return;
  clearError(els.globalError);
  setBusy(els.runQcBtn, true, "质检中");
  try {
    const qcResult = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/qc`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.batchDetail = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
    if (state.batchDetail?.batch && qcResult?.batch) {
      applyQcReportsToBatch(state.batchDetail.batch, qcResult.reports || []);
    }
    renderBatch();
    await loadGallery();
    notifyBatchQcResult(qcResult);
  } catch (error) {
    renderError(els.globalError, error, "视频质检失败");
  } finally {
    setBusy(els.runQcBtn, false);
    renderBatch();
  }
}

function emptyGalleryState() {
  return {
    items: [],
    filters: { sourceType: "pipeline", page: 1, pageSize: state.galleryPageSize },
    counts: { total: 0, downloadEligible: 0, byQcStatus: {}, byKind: {} },
    pagination: { page: 1, pageSize: state.galleryPageSize, total: 0, totalPages: 0 }
  };
}

async function loadGallery(options = {}) {
  if (!els.galleryBox) {
    state.gallery = emptyGalleryState();
    syncMetrics();
    return;
  }
  const requestedPage = Number(options.page || state.galleryPage || 1);
  state.galleryPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const query = new URLSearchParams({
    page: String(state.galleryPage),
    pageSize: String(state.galleryPageSize),
    sourceType: "pipeline"
  });
  const params = `?${query}`;
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
  state.galleryPage = state.gallery?.pagination?.page || state.galleryPage;
  renderGallery({ force: Boolean(options.force) });
}

async function loadGallerySafely(options = {}) {
  if (!els.galleryBox) return;
  try {
    await loadGallery(options);
  } catch (error) {
    state.gallery = emptyGalleryState();
    renderGallery();
    renderError(els.globalError, error, "图库加载失败");
  }
}

async function downloadPackage() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId || !els.downloadBtn || !els.includeSegments) return;
  clearError(els.globalError);
  setBusy(els.downloadBtn, true, "打包中");
  try {
    await downloadZip({
      batchIds: [batchId],
      includeSegments: els.includeSegments.checked,
      includeFailed: false,
      includeRemoteUrls: false
    });
  } catch (error) {
    renderError(els.globalError, error, "下载失败");
  } finally {
    setBusy(els.downloadBtn, false);
    renderBatch();
  }
}

function handleTemplateSelectChange(versionId = els.templateSelect?.value || "") {
  unlockTemplateEditing();
  syncTemplateSelectValues(versionId);
  const selected = state.templates.find((item) => item.versionId === versionId);
  if (selected) applyTemplate(selected);
  else state.selectedTemplate = null;
  loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败"));
}

function bindEvents() {
  els.branches?.addEventListener("change", (event) => {
    const select = event.target.closest('[data-branch-field="templateSelect"]');
    if (!select) return;
    handleTemplateSelectChange(select.value);
  });
  els.templateSelect.addEventListener("change", () => {
    handleTemplateSelectChange(els.templateSelect.value);
  });
  els.promiseLevel.addEventListener("change", () => {
    els.truthDetails.open = els.promiseLevel.value === "strong_commitment";
    loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败"));
  });
  els.targetChannel.addEventListener("change", () => loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败")));
  els.materialDirection?.addEventListener("change", syncMaterialDirectionCustom);
  els.branches?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const node = branchNodeFromEvent(event);
    if (event.target.closest(".wz-save-template-btn")) {
      saveTemplate();
      return;
    }
    if (event.target.closest(".wz-inspect-store-btn") && node) {
      inspectStorePage(node);
      return;
    }
    if (event.target.closest(".wz-load-rules-btn") && node) {
      loadRules(node).catch((error) => renderError(els.globalError, error, "规则刷新失败"));
      return;
    }
    const storeApply = event.target.closest("[data-store-apply]");
    if (storeApply && node) {
      applyStoreCandidate(storeApply.dataset.storeApply, node);
    }
  });
  els.branches?.addEventListener("change", (event) => {
    if (!(event.target instanceof Element)) return;
    const node = branchNodeFromEvent(event);
    if (!node) return;
    if (event.target.matches('[data-branch-field="materialDirection"]')) {
      syncMaterialDirectionForNode(node);
    }
    if (event.target.matches('[data-branch-field="promiseLevel"]')) {
      node.querySelector(".wz-truth-details")?.toggleAttribute("open", event.target.value === "strong_commitment");
    }
    if (event.target.matches('[data-branch-field="disclaimerPreset"]')) {
      applyDisclaimerPresetForNode(node, { force: true });
    }
    if (event.target.matches('[data-branch-field="languages"], [data-branch-field="language"]')) {
      const preset = branchField(node, "disclaimerPreset");
      if (preset?.value === "auto") applyDisclaimerPresetForNode(node);
    }
  });
  els.inspectStoreBtn?.addEventListener("click", () => inspectStorePage(primaryBranchNode()));
  els.storeCandidates?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-store-apply]");
    if (!button) return;
    applyStoreCandidate(button.dataset.storeApply, primaryBranchNode());
  });
  els.disclaimerPreset?.addEventListener("change", () => {
    applyDisclaimerPreset({ force: true });
    markTemplateDirtyFromEdit();
  });
  els.languages?.addEventListener("change", () => {
    if (els.disclaimerPreset?.value === "auto") applyDisclaimerPreset();
  });
  els.createTemplateBtn?.addEventListener("click", saveTemplate);
  els.confirmRewriteBtn?.addEventListener("click", confirmRewriteInfo);
  els.branches?.addEventListener("input", (event) => {
    markTemplateDirtyFromEdit();
    markRewriteDirtyFromEdit();
    clearRewriteProgress();
  }, true);
  els.branches?.addEventListener("change", (event) => {
    markTemplateDirtyFromEdit();
    markRewriteDirtyFromEdit();
    clearRewriteProgress();
  }, true);
  window.addEventListener("wz:branch-created", (event) => {
    const node = event.detail?.node;
    markBranchFields();
    if (node) {
      renderTruthFieldsForBranch(node);
      syncMaterialDirectionForNode(node);
      if (state.channelRules?.length || state.rulesWarnings?.length) {
        renderRules({ rules: state.channelRules, warnings: state.rulesWarnings }, node);
      } else {
        loadRules(node).catch(() => {});
      }
    }
    renderTemplates({ applySelection: false });
    setSaveTemplateButtonsDisabled(isTemplateCommitted());
    renderTemplateSaveStatus();
    if (!state.suppressTemplateUnlock) clearRewriteProgress();
    renderRewriteStatus();
    syncRewriteHints();
    renderPlanPreview(state.batchDetail?.batch);
  });
  window.addEventListener("wz:branch-removed", () => {
    markBranchFields();
    if (!state.suppressTemplateUnlock) clearRewriteProgress();
    renderTemplates({ applySelection: false });
    setSaveTemplateButtonsDisabled(isTemplateCommitted());
    renderTemplateSaveStatus();
    renderRewriteStatus();
    syncRewriteHints();
    renderPlanPreview(state.batchDetail?.batch);
  });
  els.loadRulesBtn.addEventListener("click", () => loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败")));
  els.useSampleVideoBtn?.addEventListener("click", () => {
    els.referenceFile.value = "";
    els.referenceFile.click();
  });
  els.checkReferenceBtn.addEventListener("click", () => {
    els.referenceFile.value = "";
    els.referenceFile.click();
  });
  els.confirmReferenceBtn?.addEventListener("click", () => {
    if (!state.referenceVideo || state.referenceVideo.status === "fail") return;
    focusDecomposeStep();
  });
  els.referenceFile.addEventListener("change", () => {
    state.referenceVideo = null;
    clearWorkflowSession({ preserveBatchName: true });
    clearRewriteProgress();
    clearDecompositionDraft();
    els.draftDecompositionBtn.disabled = true;
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "先上传参考视频，再点击「开始解析」生成脚本草稿。";
    clearError(els.globalError);
    const file = els.referenceFile.files?.[0];
    if (!file) {
      clearReferenceObjectUrl();
      renderReference();
      return;
    }
    renderPendingReference(file);
    checkReferenceVideo();
  });
  els.batchBox?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-inline-retry]");
    if (!btn) return;
    if (btn.dataset.inlineRetry === "retry-stitch") els.retryStitchBtn?.click();
    if (btn.dataset.inlineRetry === "re-estimate") els.estimateBtn?.click();
    if (btn.dataset.inlineRetry === "rerun-qc") els.runQcBtn?.click();
  });
  els.draftDecompositionBtn.addEventListener("click", draftReferenceVideoDecomposition);
  els.decomposeBtn.addEventListener("click", decomposeReferenceVideo);
  els.estimateBtn.addEventListener("click", estimateBatch);
  els.estimateBox?.addEventListener("click", (event) => {
    if (event.target.closest("[data-action=upload-seedance-assets]")) {
      uploadSeedanceAssetsForReview().catch((error) => renderError(els.globalError, error, "Seedance 素材上传失败"));
    }
    if (event.target.closest("[data-action=confirm-seedance-assets]")) {
      confirmSeedanceAssetReviews().catch((error) => renderError(els.globalError, error, "确认审核结果失败"));
    }
  });
  els.confirmLimits.addEventListener("change", renderEstimate);
  els.planBatchBtn.addEventListener("click", planBatch);
  els.confirmPlanBtn.addEventListener("click", confirmPlanBatch);
  els.stopBatchBtn.addEventListener("click", stopBatch);
  els.startNewTaskBtn?.addEventListener("click", () => {
    startNewTask().catch((error) => renderError(els.globalError, error, "开始新任务失败"));
  });
  els.batchName?.addEventListener("input", () => {
    writeWorkflowSession({ batchName: els.batchName.value.trim() });
  });
  els.batchName?.addEventListener("change", () => {
    writeWorkflowSession({ batchName: els.batchName.value.trim() });
  });
  els.runQcBtn.addEventListener("click", runVideoQc);
  els.retryStitchBtn.addEventListener("click", retryStitch);
  els.refreshGalleryBtn?.addEventListener("click", () => loadGallery({ force: true }).catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  bindPreviewInteractionGuard(els.batchBox);
  bindPreviewInteractionGuard(els.batchOutputsBox);
  if (els.galleryBox) {
    bindPreviewInteractionGuard(els.galleryBox);
    els.galleryBox.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-gallery-page]");
      if (!button || button.disabled) return;
      loadGallery({ page: Number(button.dataset.galleryPage) })
        .catch((error) => renderError(els.globalError, error, "图库刷新失败"));
    });
  }
  els.includeSegments?.addEventListener("change", renderBatch);
  els.downloadBtn?.addEventListener("click", downloadPackage);
}

async function loadInitialData() {
  clearError(els.globalError);
  clearActiveLockBanner(lockHost());

  await loadLlmConfig();
  await loadTemplates();
  await loadRules();

  const restoreRequest = readWorkbenchRestoreRequest();
  if (restoreRequest?.type === "batch" && restoreRequest.id) {
    clearWorkflowSession();
    const restored = await restoreBatchWorkbenchFromTasks(restoreRequest.id);
    if (restored) {
      renderReference();
      renderRewriteStatus();
      renderEstimate();
      renderBatchReadiness();
      syncStartNewTaskButton();
      syncMetrics();
      return;
    }
  }

  clearWorkflowSession();

  // Page refresh starts a fresh workflow form. Show in-progress batches as a top
  // reminder only — never attach them to the current workbench steps 1-4.
  await refreshBackgroundActiveBatchBanner();
  stopPolling();
  state.batchDetail = null;
  batchRenderFingerprint = "";
  batchOutputsRenderFingerprint = "";
  renderBatch();
  if (els.batchOutputsBox) {
    els.batchOutputsBox.hidden = true;
    els.batchOutputsBox.innerHTML = "";
  }
  await loadGallerySafely();

  ensureNewTaskBatchName();
  renderReference();
  renderRewriteStatus();
  renderEstimate();
  renderBatchReadiness();
  syncStartNewTaskButton();
  syncMetrics();
}

async function init() {
  bootstrapWorkbenchUi();
  syncMaterialDirectionCustom();
  renderTruthFields();
  ensureDecompositionForm();
  renderDecompositionForm({});
  renderRewriteStatus();
  renderTemplateSaveStatus();
  renderBatchReadiness();
  renderReference();
  syncStartNewTaskButton();
  bindEvents();
  await bindLogin({
    modal: els.loginModal,
    badge: els.badge,
    logoutBtn: els.logoutBtn,
    onAuthed: (user) => {
      state.user = user;
      loadInitialData().catch((error) => {
        renderError(els.globalError, error, "页面初始化失败");
      });
    }
  });
}

init();
