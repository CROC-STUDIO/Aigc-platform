import {
  $,
  apiEnvelope,
  badge,
  batchGenerationProgress,
  batchGenerationTaskStatusLabels,
  batchStatusDisplayLabel,
  batchStatusLabels,
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
  renderKeyValues,
  setBusy,
  showLogin,
  showToast,
  syncActionHint,
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
  addBranchBtn: $("#wzAddBranchBtn"),
  templateStatus: $("#wzTemplateStatus"),
  projectName: $("#wzProjectName"),
  generationMode: $("#wzGenerationMode"),
  batchName: $("#wzBatchName"),
  displayName: $("#wzDisplayName"),
  productName: $("#wzProductName"),
  productLink: $("#wzProductLink"),
  cta: $("#wzCta"),
  ending: $("#wzEnding"),
  currencySymbol: $("#wzCurrencySymbol"),
  language: $("#wzLanguage"),
  regions: $("#wzRegions"),
  templateChannel: $("#wzTemplateChannel"),
  defaultDuration: $("#wzDefaultDuration"),
  promiseLevel: $("#wzPromiseLevel"),
  productIconFile: $("#wzProductIconFile"),
  productScreenshotFile: $("#wzProductScreenshotFile"),
  productRecordingFile: $("#wzProductRecordingFile"),
  endingAssetFile: $("#wzEndingAssetFile"),
  personAssetFile: $("#wzPersonAssetFile"),
  rewardElementFile: $("#wzRewardElementFile"),
  truthDetails: $("#wzTruthDetails"),
  truthFields: $("#wzTruthFields"),
  targetChannel: $("#wzTargetChannel"),
  targetRegion: $("#wzTargetRegion"),
  materialDirection: $("#wzMaterialDirection"),
  voiceoverStyle: $("#wzVoiceoverStyle"),
  llmProvider: $("#wzLlmProvider"),
  llmModel: $("#wzLlmModel"),
  llmEndpoint: $("#wzLlmEndpoint"),
  llmTemperature: $("#wzLlmTemperature"),
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
  draftDecompositionBtn: $("#wzDraftDecompositionBtn"),
  decomposeBtn: $("#wzDecomposeBtn"),
  decompositionForm: $("#wzDecompositionForm"),
  decompositionHint: $("#wzDecompositionHint"),
  decompositionStatus: $("#wzDecompositionStatus"),
  llmServiceStatus: $("#wzLlmServiceStatus"),
  referenceBox: $("#wzReferenceBox"),
  duration: $("#wzDuration"),
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
  estimate: null,
  capabilities: null,
  batchDetail: null,
  gallery: null,
  galleryPage: 1,
  galleryPageSize: 20,
  llmDefaults: null,
  activeLock: null,
  templateCommitted: false,
  suppressTemplateUnlock: false,
  pollTimer: 0,
  pollIntervalMs: 2000
};

let referenceObjectUrl = "";

const assetInputKeys = [
  ["productIcon", "productIconFile"],
  ["productScreenshot", "productScreenshotFile"],
  ["productRecording", "productRecordingFile"],
  ["endingAsset", "endingAssetFile"],
  ["personAsset", "personAssetFile"],
  ["rewardElement", "rewardElementFile"]
];

const branchFieldIds = {
  productName: "wzProductName",
  productLink: "wzProductLink",
  cta: "wzCta",
  language: "wzLanguage",
  targetChannel: "wzTargetChannel",
  targetRegion: "wzTargetRegion",
  materialDirection: "wzMaterialDirection",
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
  endingAssetFile: "wzEndingAssetFile",
  personAssetFile: "wzPersonAssetFile",
  rewardElementFile: "wzRewardElementFile",
  variantPrompt: "wzVariantPrompt",
  customPrompt: "wzCustomPrompt",
  negativePrompt: "wzNegativePrompt"
};

const DECOMPOSITION_CONFIRMED_MESSAGE = "脚本拆解已确认，请继续填写第三步产品改写。";
const TEMPLATE_SAVED_MESSAGE = "模板已保存，请点击第四步「估算本批任务」继续。";
const ESTIMATE_BTN_LABEL = Object.freeze({
  first: "估算本批任务",
  refresh: "重新估算"
});
const WORKFLOW_SESSION_KEY = "wz_workflow_v1";

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
      { key: "scene", label: "场景", required: true, hint: "空间、App 页面或人物所在环境" },
      { key: "subject", label: "画面主体", required: true, hint: "人物、手机、产品 UI 或奖励元素" },
      { key: "action", label: "核心动作", required: true, hint: "用户行为、镜头推进和转折" }
    ]
  },
  {
    title: "镜头与风格",
    layout: "grid",
    fields: [
      { key: "camera", label: "镜头语言", required: true, hint: "景别、运镜、节奏" },
      { key: "lighting", label: "光线氛围", required: true, hint: "光线和画面氛围" },
      { key: "style", label: "素材风格", required: true, hint: "真人口播、手持演示、UGC、App demo 等" },
      { key: "quality", label: "画质要求", required: true, hint: "清晰度与生成质量" }
    ]
  },
  {
    title: "脚本节奏",
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
  "cta",
  "ending",
  "currencySymbol",
  "language",
  "regions",
  "targetChannels",
  "defaultOutputRatio",
  "defaultDurationSec",
  "promiseLevel"
]);

const DRAFT_FIELD_BRANCH_KEYS = Object.freeze({
  displayName: "displayName",
  productName: "productName",
  cta: "cta",
  ending: "ending",
  currencySymbol: "currencySymbol",
  language: "language",
  regions: "regions",
  targetChannels: "templateChannel",
  defaultDurationSec: "defaultDuration",
  promiseLevel: "promiseLevel"
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

function clearWorkflowSession() {
  sessionStorage.removeItem(WORKFLOW_SESSION_KEY);
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

function resetTransientFormState() {
  clearWorkflowSession();
  state.referenceVideo = null;
  state.decomposition = null;
  state.estimate = null;
  state.capabilities = null;
  state.batchDetail = null;
  state.activeLock = null;
  state.templateCommitted = false;
  state.selectedTemplate = null;
  state.suppressTemplateUnlock = false;
  const root = document.getElementById("wzCanvas");
  for (const control of root?.querySelectorAll("input, textarea, select") || []) {
    resetControlToDefault(control);
  }
  if (els.truthDetails) els.truthDetails.open = false;
}

function persistWorkflowSession() {
  writeWorkflowSession({
    referenceVideoId: state.referenceVideo?.referenceVideoId || null,
    templateVersionId: isTemplateCommitted() ? state.selectedTemplate?.versionId : null,
    templateCommitted: isTemplateCommitted()
  });
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
  if (lock) setTemplateFormLocked(true);
  return true;
}

function restoreWorkflowFromBatch(detail) {
  const batch = detail?.batch;
  if (!batch) return false;
  let restored = false;
  if (batch.referenceVideo?.referenceVideoId) {
    state.referenceVideo = batch.referenceVideo;
    if (batch.decomposition?.referenceVideoId) {
      state.decomposition = batch.decomposition;
    }
    restored = true;
  }
  const request = batch.estimate?.request || {};
  if (request.versionId) {
    restored = applyRestoredTemplate(request.versionId, { lock: true }) || restored;
  }
  if (batch.estimate?.estimateId) {
    state.estimate = { estimate: batch.estimate, capabilities: batch.capabilities || null };
    state.capabilities = batch.capabilities || null;
  }
  if (restored) {
    renderReference();
    syncDecompositionDomState();
    renderBatchReadiness();
    renderEstimate();
    persistWorkflowSession();
  }
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
  renderBatchReadiness();
  renderEstimate();
  return Boolean(state.referenceVideo?.referenceVideoId);
}

function renderBatchReadiness() {
  if (!els.batchReadiness) return;
  const decomp = isDecompositionConfirmed();
  const tmpl = isTemplateCommitted();
  if (!decomp && !tmpl) {
    els.batchReadiness.hidden = true;
    els.batchReadiness.textContent = "";
    return;
  }
  els.batchReadiness.hidden = false;
  if (decomp && tmpl) {
    els.batchReadiness.className = "wz-batch-readiness wz-success";
    els.batchReadiness.innerHTML = "<span>拆解 ✓ · 模板 ✓</span><span>下一步：点击「估算本批任务」</span>";
    return;
  }
  els.batchReadiness.className = "wz-batch-readiness wz-info";
  const parts = [
    decomp ? "拆解 ✓" : "拆解待完成",
    tmpl ? "模板 ✓" : "模板待保存"
  ];
  els.batchReadiness.innerHTML = `<span>${parts.join(" · ")}</span><span>完成前两步后再估算本批任务</span>`;
}

function ensureDecompositionForm() {
  if (!els.decompositionForm || els.decompositionForm.dataset.wired === "1") return;
  els.decompositionForm.innerHTML = DECOMPOSITION_FORM_SECTIONS.map((section) => `
    <section class="wz-decomposition-section">
      <h3>${escapeHtml(section.title)}</h3>
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
    </section>
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
  const draft = {};
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
  setDecompositionFormLocked(isDecompositionConfirmed());
  fitDecompositionTextareas();
  syncDecompositionDomState();
  if (visible && !isDecompositionConfirmed()) focusDecomposeStep();
  syncDecompositionControls();
}

function onDecompositionFormInput(event) {
  if (isDecompositionConfirmed()) return;
  if (event?.target instanceof HTMLTextAreaElement) {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.max(84, event.target.scrollHeight + 2)}px`;
  }
  state.decomposition = null;
  state.estimate = null;
  renderEstimate();
  syncDecompositionControls();
  els.decompositionStatus.className = "wz-info";
  els.decompositionStatus.textContent = "已修改解析结果，请确认无误后保存。";
}

function syncDecompositionControls() {
  const confirmed = isDecompositionConfirmed();
  const probeReady = Boolean(state.referenceVideo && state.referenceVideo.status !== "fail");
  const hasDraft = hasDecompositionDraft();
  const draftComplete = isDecompositionDraftComplete();
  const parseBusy = Boolean(els.draftDecompositionBtn?.dataset.originalText);
  const confirmBusy = Boolean(els.decomposeBtn?.dataset.originalText);

  if (els.draftDecompositionBtn) {
    els.draftDecompositionBtn.disabled = !probeReady || confirmed || parseBusy;
    if (!parseBusy) {
      els.draftDecompositionBtn.textContent = hasDraft ? "重新解析" : "开始解析";
    }
  }
  if (els.decomposeBtn) {
    els.decomposeBtn.disabled = confirmed || !draftComplete || confirmBusy;
  }
  if (els.knowledgeNotes) {
    els.knowledgeNotes.disabled = confirmed;
  }
  syncFlowHints();
}

function syncReferenceHints() {
  const fileReady = Boolean(els.referenceFile?.files?.[0]);
  const uploaded = Boolean(state.referenceVideo?.referenceVideoId);
  const checking = Boolean(els.checkReferenceBtn?.dataset.originalText);
  const file = els.referenceFile?.files?.[0];
  if (els.referenceUploadPanel) {
    els.referenceUploadPanel.classList.toggle("has-file", fileReady || uploaded);
    els.referenceUploadPanel.classList.toggle("is-uploading", checking);
    els.referenceUploadPanel.classList.toggle("has-upload", uploaded);
  }
  if (els.checkReferenceBtn) els.checkReferenceBtn.disabled = checking;
  if (els.referenceFile) els.referenceFile.disabled = checking;
  if (els.referenceUploadStatus && !checking) {
    els.referenceUploadStatus.textContent = uploaded
      ? `已读取 ${state.referenceVideo.fileName || "参考视频"}，可继续解析脚本。`
      : fileReady
        ? `已选择 ${file?.name || "参考视频"}，正在准备上传。`
        : "选中文件后会自动完成上传、格式检查和视频预览。";
  }
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
  const probeReady = Boolean(state.referenceVideo && state.referenceVideo.status !== "fail");
  const parseBusy = Boolean(els.draftDecompositionBtn?.dataset.originalText);
  const confirmBusy = Boolean(els.decomposeBtn?.dataset.originalText);
  if (els.draftDecompositionBtn && !parseBusy) {
    syncActionHint(
      els.draftDecompositionBtn,
      confirmed ? "脚本已确认，如需修改请重新上传参考视频" : !probeReady ? "需先上传并读取参考视频" : "",
      { tone: confirmed ? "warn" : "muted" }
    );
  }
  if (els.decomposeBtn && !confirmBusy) {
    syncActionHint(
      els.decomposeBtn,
      confirmed ? "脚本已确认，可进入第三步产品改写" : !isDecompositionDraftComplete() ? "请先完成解析并补全必填字段" : "确认后将锁定脚本并进入产品改写",
      { tone: confirmed ? "muted" : !isDecompositionDraftComplete() ? "warn" : "muted" }
    );
  }
}

function syncTemplateHints() {
  syncActionHint(
    els.createTemplateBtn,
    !isDecompositionConfirmed() ? "需先确认脚本拆解" : isTemplateCommitted() ? "模板已保存，可进入第四步估算" : "填写完成后保存模板",
    { tone: !isDecompositionConfirmed() ? "warn" : "muted" }
  );
}

function hasActivePipelineBatch() {
  const batch = state.batchDetail?.batch;
  return Boolean(batch?.batchId && !terminalBatchStatus(batch.status));
}

function isQcBatchPending(batch = state.batchDetail?.batch) {
  return batch?.status === "qc";
}

function activeLockFromBatch(batch) {
  if (!batch?.batchId || terminalBatchStatus(batch.status)) return null;
  return {
    type: "batch",
    id: batch.batchId,
    status: batch.status,
    label: activeLockLabel("batch", batch.batchId, batch.status)
  };
}

function syncBatchActionButtons() {
  const estimate = state.estimate?.estimate;
  const batch = state.batchDetail?.batch;
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  const locked = hasActivePipelineBatch();
  const qcPending = isQcBatchPending(batch);

  if (!estimate) {
    els.planBatchBtn.disabled = true;
    els.confirmPlanBtn.disabled = true;
    return;
  }

  els.planBatchBtn.disabled = locked
    || qcPending
    || estimate.hardBlocked
    || (estimate.confirmationRequired && !els.confirmLimits.checked);
  els.confirmPlanBtn.disabled = batch?.status !== "preview_required" || !plans.length;
}

function syncBatchActionHints() {
  const estimate = state.estimate?.estimate;
  const batch = state.batchDetail?.batch;
  const locked = hasActivePipelineBatch();
  const qcPending = isQcBatchPending(batch);
  syncActionHint(
    els.estimateBtn,
    qcPending
      ? "当前批次已生成完成，请先运行视频质检或放弃批次"
      : !isDecompositionConfirmed() || !isTemplateCommitted() ? "需先完成脚本确认与模板保存" : estimate ? "可重新估算以刷新任务规模" : "前置步骤已完成，可以估算",
    { tone: qcPending || !isDecompositionConfirmed() || !isTemplateCommitted() ? "warn" : "muted" }
  );
  syncActionHint(
    els.planBatchBtn,
    qcPending
      ? `当前批次 ${batch.batchId} 待质检，请先运行视频质检或放弃批次`
      : locked
      ? `当前批次 ${batch.batchId} 进行中（${batchStatusLabels[batch.status] || batch.status}），请先确认预案、等待完成或停止后再新建`
      : !estimate ? "需先完成拆解、模板保存和批次估算" : estimate.hardBlocked ? "当前估算存在硬阻塞，请检查渠道规则" : estimate.confirmationRequired && !els.confirmLimits.checked ? "请先勾选二次确认后再生成预案" : "",
    { tone: locked || qcPending || estimate?.hardBlocked ? "error" : "warn" }
  );
  syncActionHint(
    els.confirmPlanBtn,
    batch?.status === "preview_required" ? "确认后将提交 Seedance 批量生成" : !estimate ? "需先生成 Seedance 预案" : "",
    { tone: "muted" }
  );
}

function syncFlowHints() {
  syncReferenceHints();
  syncDecompositionHints();
  syncTemplateHints();
  syncBatchActionHints();
}

function batchProgressSection(batch, tasks, outputs = []) {
  if (!batch || terminalBatchStatus(batch.status)) return "";
  const progress = batchGenerationProgress(batch, tasks);
  return taskProgressHtml(progress);
}

function clearDecompositionDraft() {
  renderDecompositionForm({});
  state.decomposition = null;
  state.estimate = null;
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

function focusRewriteStep(missingFields = []) {
  const rewriteNode = document.getElementById("wzNodeRewrite");
  if (!rewriteNode) return;
  wzFocusNodeId("wzNodeRewrite", "3");
  for (const input of rewriteNode.querySelectorAll(".wz-field-missing")) {
    input.classList.remove("wz-field-missing");
  }
  const node = primaryBranchNode() || rewriteNode;
  let focusInput = null;
  for (const field of missingFields) {
    const branchKey = DRAFT_FIELD_BRANCH_KEYS[field];
    if (!branchKey) continue;
    const input = branchField(node, branchKey)
      || (field === "regions" ? branchField(node, "targetRegion") : null);
    if (input) {
      input.classList.add("wz-field-missing");
      if (!focusInput) focusInput = input;
    }
  }
  requestAnimationFrame(() => {
    focusInput?.focus({ preventScroll: true });
  });
}

function parseRegions(node) {
  const raw = fieldValue(node, "regions")
    || fieldValue(node, "targetRegion")
    || els.regions?.value
    || "US";
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
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

function renderTruthFields() {
  els.truthFields.innerHTML = strongTruthFields.map(([key, label]) => `
    <label>${escapeHtml(label)}
      <input data-truth-field="${escapeHtml(key)}" type="text" />
    </label>
  `).join("");
  markBranchFields();
}

function markBranchFields(root = els.branches) {
  if (!root) return;
  for (const [field, id] of Object.entries(branchFieldIds)) {
    const node = root.querySelector(`#${id}`);
    if (node) node.dataset.branchField = field;
  }
  for (const [assetKey, field] of assetInputKeys) {
    const input = root.querySelector(`[data-branch-field="${field}"]`);
    if (input) input.dataset.assetKey = assetKey;
  }
  const base = document.getElementById("wzNodeRewrite");
  if (base && !base.dataset.branchId) base.dataset.branchId = "branch_1";
}

function branchNodes() {
  markBranchFields();
  return [...(els.branches?.querySelectorAll(".wz-node-branch") || [])];
}

function branchField(node, field) {
  return node?.querySelector(`[data-branch-field="${field}"]`) || null;
}

function fieldValue(node, field) {
  const input = branchField(node, field);
  return input ? String(input.value || "").trim() : "";
}

function setFieldValue(node, field, value) {
  const input = branchField(node, field);
  if (!input || value === undefined || value === null) return;
  input.value = Array.isArray(value) ? value.join(",") : String(value);
}

function branchTitle(node, index) {
  const explicit = node?.dataset.branchLabel || "";
  const title = node?.querySelector(".wz-branch-title")?.textContent?.trim() || "";
  return explicit || title || `改写 3.${index + 1}`;
}

function collectBranchAssets(node) {
  const assetFileNames = {};
  const assetUrls = {};
  const assetStorageKeys = {};
  for (const [assetKey, field] of assetInputKeys) {
    const input = branchField(node, field);
    const file = input?.files?.[0];
    const savedName = input?.dataset.uploadedFileName || "";
    const savedUrl = input?.dataset.storageUrl || "";
    const savedStorageKey = input?.dataset.storageKey || "";
    if (file?.name) assetFileNames[assetKey] = file.name;
    else if (savedName) assetFileNames[assetKey] = savedName;
    if (savedUrl) assetUrls[assetKey] = savedUrl;
    if (savedStorageKey) assetStorageKeys[assetKey] = savedStorageKey;
  }
  return { assetFileNames, assetUrls, assetStorageKeys };
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
    const { assetFileNames, assetUrls, assetStorageKeys } = collectBranchAssets(node);
    const targetChannel = fieldValue(node, "targetChannel") || fieldValue(node, "templateChannel") || "meta_ads";
    const regions = (fieldValue(node, "regions") || fieldValue(node, "targetRegion") || "US")
      .split(",").map((item) => item.trim()).filter(Boolean);
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
      language: fieldValue(node, "language") || "en-US",
      regions,
      targetChannels: [targetChannel],
      defaultOutputRatio: "9:16",
      defaultDurationSec: Number(fieldValue(node, "defaultDuration") || 15),
      promiseLevel: fieldValue(node, "promiseLevel") || "stable",
      assetFileNames,
      assetUrls,
      assetStorageKeys,
      materialDirection: fieldValue(node, "materialDirection"),
      voiceoverStyle: fieldValue(node, "voiceoverStyle"),
      variantPrompt: fieldValue(node, "variantPrompt"),
      customPrompt: fieldValue(node, "customPrompt"),
      negativePrompt: fieldValue(node, "negativePrompt"),
      truthRules: collectTruthRules(node)
    };
  });
}

function collectBranchDrafts() {
  return collectAllBranchDrafts().filter((branch) => branch.productName || branch.cta || branch.materialDirection || Object.keys(branch.assetUrls).length);
}

function branchDraftToTemplateShape(branch, index = 0) {
  return {
    displayName: branch.displayName || `改写 3.${index + 1}`,
    productName: branch.productName,
    cta: branch.cta,
    ending: branch.ending,
    currencySymbol: branch.currencySymbol,
    language: branch.language,
    regions: branch.regions,
    targetChannels: branch.targetChannels,
    defaultOutputRatio: branch.defaultOutputRatio || "9:16",
    defaultDurationSec: branch.defaultDurationSec,
    promiseLevel: branch.promiseLevel,
    truthRules: branch.truthRules || {}
  };
}

function findIncompleteBranchDraft() {
  const nodes = branchNodes();
  const branches = collectAllBranchDrafts();
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branches[index];
    const missingRequired = missingRequiredDraftFields(branchDraftToTemplateShape(branch, index));
    if (missingRequired.length) {
      return { index, node: nodes[index], missingFields: missingRequired, kind: "required" };
    }
    const missingStrong = missingStrongFields(branchDraftToTemplateShape(branch, index));
    if (missingStrong.length) {
      return { index, node: nodes[index], missingFields: missingStrong, kind: "strong" };
    }
  }
  return null;
}

function isTemplateCommitted() {
  return Boolean(state.templateCommitted && state.selectedTemplate?.versionId);
}

function setTemplateFormLocked(locked) {
  state.templateCommitted = locked;
  for (const node of branchNodes()) {
    for (const input of node.querySelectorAll("input, textarea, select")) {
      input.disabled = locked;
    }
    for (const button of node.querySelectorAll(".wz-save-branch")) {
      button.disabled = locked;
    }
    node.classList.toggle("state-done", locked);
    if (locked) node.dataset.templateCommitted = "1";
    else node.removeAttribute("data-template-committed");
  }
  if (els.createTemplateBtn) {
    els.createTemplateBtn.disabled = locked;
    if (!els.createTemplateBtn.dataset.originalText) {
      els.createTemplateBtn.textContent = locked ? "模板已保存" : "保存模板";
    }
  }
  if (els.addBranchBtn) els.addBranchBtn.disabled = locked;
  document.getElementById("wzNodeRewrite")?.toggleAttribute("data-template-committed", locked);
  renderTemplateStatus();
  renderBatchReadiness();
  window.dispatchEvent(new CustomEvent("wz:template-commit-changed"));
}

function renderTemplateStatus() {
  if (!els.templateStatus) return;
  if (isTemplateCommitted()) {
    const name = state.selectedTemplate?.draft?.displayName || state.selectedTemplate?.templateId || "当前模板";
    els.templateStatus.hidden = false;
    els.templateStatus.className = "wz-template-status wz-success";
    els.templateStatus.textContent = `${TEMPLATE_SAVED_MESSAGE}（${name}）`;
    els.templateStatus.classList.remove("empty-line");
    return;
  }
  els.templateStatus.hidden = false;
  els.templateStatus.className = "wz-template-status wz-info";
  els.templateStatus.textContent = branchNodes().length > 1
    ? "请完成全部裂变子节点后，点击「保存模板」。"
    : "填写完成后点击「保存模板」，保存后将进入第四步。";
  els.templateStatus.classList.remove("empty-line");
}

function unlockTemplateEditing() {
  if (!state.templateCommitted) return;
  const nextVersion = (Number(state.selectedTemplate?.versionNumber) || 0) + 1;
  state.templateCommitted = false;
  setTemplateFormLocked(false);
  if (els.templateStatus && state.selectedTemplate?.templateId) {
    els.templateStatus.hidden = false;
    els.templateStatus.className = "wz-template-status wz-warning";
    els.templateStatus.textContent = `正在编辑已保存模板，再次保存将写入新版本 v${nextVersion}。`;
  }
  renderBatchReadiness();
  syncDecompositionControls();
}

function markTemplateDirtyFromEdit() {
  if (state.suppressTemplateUnlock || !state.templateCommitted) return;
  unlockTemplateEditing();
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
  setFieldValue(node, "targetChannel", draft.targetChannels?.[0] || draft.targetChannel);
  setFieldValue(node, "targetRegion", draft.regions?.[0] || draft.targetRegion);
  setFieldValue(node, "materialDirection", draft.materialDirection);
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
  for (const [assetKey, field] of assetInputKeys) {
    const input = branchField(node, field);
    if (!input) continue;
    input.dataset.uploadedFileName = draft.assetFileNames?.[assetKey] || "";
    input.dataset.storageUrl = draft.assetUrls?.[assetKey] || "";
    input.dataset.storageKey = draft.assetStorageKeys?.[assetKey] || "";
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
      input.dataset.uploadedFileName = asset.fileName || file.name;
      input.dataset.storageUrl = asset.storageUrl || asset.previewUrl || "";
      input.dataset.storageKey = asset.storageKey || "";
      input.dataset.storedPath = asset.storedPath || "";
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
  const targetChannel = fieldValue(node, "templateChannel")
    || fieldValue(node, "targetChannel")
    || els.templateChannel?.value
    || "meta_ads";
  return {
    displayName: fieldValue(node, "displayName") || els.displayName?.value.trim() || "",
    productName: fieldValue(node, "productName") || els.productName?.value.trim() || "",
    productLink: fieldValue(node, "productLink") || els.productLink?.value.trim() || "",
    cta: fieldValue(node, "cta") || els.cta?.value.trim() || "",
    ending: fieldValue(node, "ending") || els.ending?.value.trim() || "",
    currencySymbol: fieldValue(node, "currencySymbol") || els.currencySymbol?.value.trim() || "",
    language: fieldValue(node, "language") || els.language?.value.trim() || "",
    regions: parseRegions(node),
    targetChannels: [targetChannel],
    defaultOutputRatio: "9:16",
    defaultDurationSec: Number(fieldValue(node, "defaultDuration") || els.defaultDuration?.value || 15),
    promiseLevel: fieldValue(node, "promiseLevel") || els.promiseLevel?.value || "stable",
    assetFileNames: primaryBranch.assetFileNames || {},
    assetUrls: primaryBranch.assetUrls || {},
    assetStorageKeys: primaryBranch.assetStorageKeys || {},
    llmConfig: {
      provider: els.llmProvider.value.trim(),
      model: els.llmModel.value.trim(),
      endpoint: els.llmEndpoint.value.trim(),
      temperature: Number(els.llmTemperature.value)
    },
    knowledgeNotes: els.knowledgeNotes.value.trim(),
    variantPrompt: fieldValue(node, "variantPrompt") || els.variantPrompt?.value.trim() || "",
    seedanceModel: els.seedanceModel.value.trim(),
    materialDirection: fieldValue(node, "materialDirection") || els.materialDirection?.value || "",
    voiceoverStyle: fieldValue(node, "voiceoverStyle") || els.voiceoverStyle?.value.trim() || "",
    customPrompt: fieldValue(node, "customPrompt") || els.customPrompt?.value.trim() || "",
    negativePrompt: fieldValue(node, "negativePrompt") || els.negativePrompt?.value.trim() || "",
    truthRules,
    branches
  };
}

function missingStrongFields(draft) {
  if (draft.promiseLevel !== "strong_commitment") return [];
  return strongTruthFields
    .filter(([key]) => !draft.truthRules[key])
    .map(([key, label]) => label || key);
}

function applyTemplate(template) {
  state.suppressTemplateUnlock = true;
  state.selectedTemplate = template || null;
  const draft = template?.draft;
  if (!draft) {
    state.suppressTemplateUnlock = false;
    return;
  }
  els.displayName.value = draft.displayName || "";
  els.productName.value = draft.productName || "";
  els.productLink.value = draft.productLink || "";
  els.cta.value = draft.cta || "";
  els.ending.value = draft.ending || "";
  els.currencySymbol.value = draft.currencySymbol || "$";
  els.language.value = draft.language || "en-US";
  els.regions.value = Array.isArray(draft.regions) ? draft.regions.join(",") : "";
  els.templateChannel.value = draft.targetChannels?.[0] || "meta_ads";
  els.targetChannel.value = draft.targetChannels?.[0] || "meta_ads";
  els.defaultDuration.value = String(draft.defaultDurationSec || 15);
  els.duration.value = String(draft.defaultDurationSec || 15);
  els.promiseLevel.value = draft.promiseLevel || "stable";
  els.llmProvider.value = draft.llmConfig?.provider || "";
  els.llmModel.value = draft.llmConfig?.model || "";
  els.llmEndpoint.value = draft.llmConfig?.endpoint || state.llmDefaults?.endpoint || "";
  els.llmTemperature.value = String(draft.llmConfig?.temperature ?? 0.2);
  els.knowledgeNotes.value = draft.knowledgeNotes || "";
  els.variantPrompt.value = draft.variantPrompt || "";
  els.seedanceModel.value = draft.seedanceModel || els.modelSelect.value || "";
  els.materialDirection.value = draft.materialDirection || "余额刺激";
  els.voiceoverStyle.value = draft.voiceoverStyle || "Natural local host";
  els.customPrompt.value = draft.customPrompt || "";
  els.negativePrompt.value = draft.negativePrompt || "";
  for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
    input.value = draft.truthRules?.[input.dataset.truthField] || "";
  }
  els.truthDetails.open = els.promiseLevel.value === "strong_commitment";
  applyBranches(draft);
  state.suppressTemplateUnlock = false;
}

function renderTemplates() {
  if (!state.templates.length) {
    els.templateSelect.innerHTML = `<option value="">暂无模板，保存当前草稿后继续</option>`;
    state.selectedTemplate = null;
    applyLlmConfigDefaults();
    syncMetrics();
    return;
  }
  els.templateSelect.innerHTML = state.templates.map((template) => `
    <option value="${escapeHtml(template.versionId)}">
      ${escapeHtml(template.draft?.displayName || template.templateId)} v${escapeHtml(template.versionNumber)}
      ${template.isDefault ? " 默认" : ""}
    </option>
  `).join("");
  const selected = state.templates.find((item) => item.versionId === els.templateSelect.value)
    || state.templates.find((item) => item.isDefault)
    || state.templates[0];
  els.templateSelect.value = selected.versionId;
  applyTemplate(selected);
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
  const modelLabel = config.model || "默认模型";
  if (config.hasApiKey) {
    els.llmServiceStatus.className = "wz-success wz-service-pill";
    els.llmServiceStatus.textContent = `AI 拆解服务已就绪（${modelLabel}）`;
    return;
  }
  els.llmServiceStatus.className = "wz-warning wz-service-pill";
  els.llmServiceStatus.textContent = "AI 拆解服务未配置，请联系管理员设置 API Key";
}

function applyLlmConfigDefaults() {
  const config = state.llmDefaults;
  if (!config) return;
  if (!els.llmProvider.value.trim()) els.llmProvider.value = config.provider || "skylink";
  if (!els.llmModel.value.trim()) els.llmModel.value = config.model || "gpt-5.4";
  if (!els.llmEndpoint.value.trim()) els.llmEndpoint.value = config.endpoint || "https://skylink-gateway.com/api/v1";
  if (!els.llmTemperature.value.trim()) els.llmTemperature.value = String(config.temperature ?? 0.2);
  renderLlmServiceStatus();
}

async function loadLlmConfig() {
  const data = await apiEnvelope("/api/wangzhuan/llm-config");
  state.llmDefaults = data.llmConfig || null;
  applyLlmConfigDefaults();
}

function renderRules(response = {}) {
  state.channelRules = response.rules || [];
  const warnings = response.warnings || [];
  if (!state.channelRules.length) {
    els.rulesBox.className = "wz-list empty-line";
    els.rulesBox.textContent = "没有命中渠道规则";
    syncMetrics();
    return;
  }
  els.rulesBox.className = "wz-list wz-rule-list";
  els.rulesBox.innerHTML = `
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
  if (!state.referenceVideo || isDecompositionConfirmed()) return;
  clearError(els.globalError);
  state.decomposition = null;
  state.estimate = null;
  renderEstimate();
  setBusy(els.draftDecompositionBtn, true, hasDecompositionDraft() ? "重新解析中" : "解析中");
  els.decompositionStatus.className = "wz-info";
  els.decompositionStatus.textContent = "正在分析参考视频并生成脚本草稿，请稍等。";
  try {
    const data = await apiEnvelope("/api/wangzhuan/reference-videos/draft-decomposition", {
      method: "POST",
      body: JSON.stringify({
        referenceVideoId: state.referenceVideo.referenceVideoId,
        knowledgeNotes: els.knowledgeNotes.value.trim(),
        llmConfig: {
          provider: els.llmProvider.value.trim(),
          model: els.llmModel.value.trim(),
          endpoint: els.llmEndpoint.value.trim(),
          temperature: Number(els.llmTemperature.value)
        }
      })
    });
    renderDecompositionForm(data.decomposition || {});
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = "脚本草稿已生成，请检查表单内容后点击「确认脚本拆解」。";
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
    if (isTemplateCommitted() && isDecompositionConfirmed()) {
      els.estimateBox.textContent = "拆解与模板已就绪，请点击「估算本批任务」查看任务数和消耗。";
      if (els.estimateHint) els.estimateHint.textContent = "前置步骤已完成，可以估算";
    } else if (isDecompositionConfirmed()) {
      els.estimateBox.textContent = "脚本已确认，请先完成第三步产品改写并保存模板，再估算本批任务。";
      if (els.estimateHint) els.estimateHint.textContent = "请先保存模板";
    } else {
      els.estimateBox.textContent = "完成前两步后，在此估算本批任务规模。";
      if (els.estimateHint) els.estimateHint.textContent = "需先完成拆解与模板";
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
        ["拼接任务", estimate.stitchTaskCount],
        ["生图任务", estimate.imageTaskCount],
        ["并发", estimate.requestedConcurrency],
        ["重试上限", estimate.maxRetryPerTask],
        ["二次确认", estimate.confirmationRequired ? "需要" : "不需要"]
      ])}
    </div>
    ${estimate.models?.length ? `<div class="wz-chipline">${estimate.models.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
  `;
  if (els.estimateHint) {
    els.estimateHint.textContent = estimate.confirmationRequired
      ? "任务较多，请勾选确认后再生成预案"
      : "估算完成，可生成 Seedance 预案";
  }
  els.confirmLimits.checked = !estimate.confirmationRequired;
  els.confirmLimits.disabled = !estimate.confirmationRequired;
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
    els.planHint.textContent = batch?.status === "preview_required"
      ? `共 ${plans.length} 条预案，确认后将提交 Seedance 生成`
      : `${plans.length} 条预案已生成`;
  }
  els.planBox.className = "wz-list";
  els.planBox.innerHTML = plans.map((plan) => `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(plan.branchLabel || plan.branchId || "分支")} / 变体 ${escapeHtml(plan.branchVariantIndex || plan.variantIndex || "-")} / 分段 ${escapeHtml(plan.segmentIndex || "-")}</strong>
        <small>${escapeHtml(plan.planId || "")}</small>
      </div>
      ${badge(plan.status || "drafted", { drafted: "待确认", confirmed: "已确认" })}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["Hook", plan.hook],
        ["口播", plan.voiceover || "-"],
        ["Seedance Prompt", plan.seedancePrompt],
        ["Negative Prompt", plan.negativePrompt || "-"],
        ["素材引用", Object.values(plan.mediaRefs || {}).filter(Boolean).join(", ") || "-"],
        ["合规提示", Array.isArray(plan.complianceNotes) ? plan.complianceNotes.join(" · ") : "-"]
      ])}
    </div>
  `).join("");
  syncBatchActionButtons();
  renderBatchStepProgress();
  syncFlowHints();
}

function syncBatchNodeStatus(status = "") {
  const batchNode = document.getElementById("wzNodeBatch");
  if (!batchNode) return;
  if (status) batchNode.dataset.batchStatus = status;
  else delete batchNode.dataset.batchStatus;
}

function renderBatch() {
  const detail = state.batchDetail;
  const batch = detail?.batch;
  if (!batch) {
    syncBatchNodeStatus();
    els.batchBadge.textContent = "未开始";
    els.batchBox.className = "wz-list empty-line";
    els.batchBox.textContent = "暂无批次";
    els.stopBatchBtn.disabled = true;
    els.runQcBtn.disabled = true;
    renderPlanPreview(null);
    syncMetrics();
    renderBatchStepProgress();
    syncFlowHints();
    return;
  }
  syncBatchNodeStatus(batch.status);
  els.batchBadge.innerHTML = badge(batch.status, {
    ...batchStatusLabels,
    [batch.status]: batchStatusDisplayLabel(batch)
  });
  if (els.estimateBtn) els.estimateBtn.disabled = isQcBatchPending(batch);
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
  els.batchBox.className = "wz-list";
  const retryActions = batch.status === "partial_failed"
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
    <div class="wz-info">产品素材已在第 3 步上传至对象存储；确认预案后会把素材 URL 作为 <code>omni_reference</code> 引用提交 Seedance（与 OMS 先审后用的 asset_id 链路不同）。过程追踪文件见批次目录 <code>00-brief.json</code> ~ <code>05-video-tasks.json</code>。</div>
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
        <strong>${escapeHtml(batch.batchId)}</strong>
        <small>${escapeHtml(batch.createdAt || "")} · ${tasks.length} 个任务 · ${escapeHtml(batch.estimate?.durationSec || "-")}s</small>
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
          <small>${escapeHtml(task.seedanceTaskId || task.errorCode || "pending")}</small>
        </div>
      `).join("")}
    </div>
    ${events.length ? `<div class="wz-events"><strong>过程事件</strong>${events.slice(-8).map((event) => `<small>${escapeHtml(formatWorkflowEvent(event))} · ${escapeHtml(event.createdAt || "")}</small>`).join("")}</div>` : ""}
  `;
  els.downloadBtn.disabled = !detail.downloadSummary?.packageReady && !(batch.status === "partial_failed" && els.includeSegments.checked);
  renderPlanPreview(batch);
  syncMetrics();
  renderBatchStepProgress();
  syncFlowHints();
}

function renderGallery() {
  const gallery = state.gallery;
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
  els.galleryBox.innerHTML = `
    ${gallery.items.map((item) => `
    <article class="wz-output">
      <div>
        <strong>${escapeHtml(item.outputId)}</strong>
        <small>${escapeHtml(item.kind)} · ${escapeHtml(item.qcStatus)} · ${escapeHtml(item.durationSec || "-")}s</small>
      </div>
      ${badge(item.qcStatus, { pass: "QC 通过", warn: "QC 警告", fail: "QC 失败", manual_required: "需人工确认", not_started: "未质检" })}
      ${item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">预览文件</a>` : ""}
      ${item.modelQcSummary ? `<small>模型质检 ${escapeHtml(item.modelQcSummary.score ?? "-")} · ${escapeHtml(item.modelQcSummary.summary || "")}</small>` : ""}
    </article>
  `).join("")}
    ${galleryPaginationHtml(gallery)}
  `;
  syncMetrics();
}

function renderStartError(error) {
  renderError(els.globalError, error, "批次启动失败");
  showActiveLockFromError(lockHost(), error);
}

async function loadTemplates() {
  const data = await apiEnvelope("/api/wangzhuan/templates");
  state.templates = data.templates || [];
  state.permissions = data.permissions || {};
  renderTemplates();
}

async function loadRules() {
  const params = new URLSearchParams({
    channel: els.targetChannel.value,
    promiseLevel: els.promiseLevel.value
  });
  renderRules(await apiEnvelope(`/api/wangzhuan/channel-rules?${params}`));
}

async function saveTemplate() {
  clearError(els.globalError);
  if (isTemplateCommitted()) return;
  const incompleteBranch = findIncompleteBranchDraft();
  if (incompleteBranch) {
    const branchMissing = incompleteBranch.missingFields;
    focusRewriteStep(incompleteBranch.kind === "required" ? branchMissing : []);
    if (incompleteBranch.kind === "strong") {
      els.truthDetails.open = true;
      renderError(els.globalError, {
        code: "strong_rule_missing",
        message: `改写 3.${incompleteBranch.index + 1} 强承诺需要补齐真实收益规则`,
        data: { missingFields: branchMissing }
      }, "模板校验");
    } else {
      renderError(els.globalError, {
        code: "validation_error",
        message: `改写 3.${incompleteBranch.index + 1} 缺少必填字段`,
        data: { missingFields: branchMissing }
      }, "模板校验");
    }
    incompleteBranch.node?.classList.remove("collapsed");
    incompleteBranch.node?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    return;
  }
  const draft = draftFromForm();
  const missingStrong = missingStrongFields(draft);
  if (missingStrong.length) {
    focusRewriteStep();
    els.truthDetails.open = true;
    renderError(els.globalError, {
      code: "strong_rule_missing",
      message: "强承诺需要补齐真实收益规则",
      data: { missingFields: missingStrong }
    }, "模板校验");
    return;
  }
  setBusy(els.createTemplateBtn, true, "上传素材");
  try {
    await uploadBranchAssets();
  } catch (error) {
    setBusy(els.createTemplateBtn, false);
    renderError(els.globalError, error, "产品素材上传失败");
    return;
  }
  setBusy(els.createTemplateBtn, true, "保存中");
  try {
    const body = state.selectedTemplate
      ? { mode: "edit_new_version", templateId: state.selectedTemplate.templateId, draft }
      : { mode: "create", draft };
    const data = await apiEnvelope("/api/wangzhuan/templates", { method: "POST", body: JSON.stringify(body) });
    state.selectedTemplate = data.template;
    await loadTemplates();
    els.templateSelect.value = data.template.versionId;
    applyTemplate(data.template);
    setTemplateFormLocked(true);
    persistWorkflowSession();
    focusBatchStep();
    showToast("产品模板已保存，可开始估算批次", { type: "success" });
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    const serverMissing = Array.isArray(error?.data?.missingFields) ? error.data.missingFields : [];
    if (serverMissing.length) focusRewriteStep(serverMissing);
    renderError(els.globalError, error, "模板保存失败");
  } finally {
    setBusy(els.createTemplateBtn, false);
    if (isTemplateCommitted()) {
      if (els.createTemplateBtn) {
        els.createTemplateBtn.disabled = true;
        els.createTemplateBtn.textContent = "模板已保存";
      }
    }
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
    persistWorkflowSession();
    clearReferenceObjectUrl();
    renderReference();
    showToast("参考视频信息已读取", { type: "success" });
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
  if (!state.referenceVideo || isDecompositionConfirmed()) return;
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
    state.estimate = null;
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

function estimateRequest() {
  const template = state.selectedTemplate;
  return {
    templateId: template?.templateId,
    versionId: template?.versionId,
    projectName: els.projectName.value.trim(),
    batchName: els.batchName.value.trim(),
    generationMode: els.generationMode.value,
    model: els.modelSelect.value,
    seedanceModel: els.seedanceModel.value.trim(),
    referenceVideoId: state.referenceVideo?.referenceVideoId,
    targetChannel: els.targetChannel.value,
    targetRegion: els.targetRegion.value.trim() || "US",
    language: els.language.value.trim() || "en-US",
    promiseLevel: els.promiseLevel.value,
    durationSec: Number(els.duration.value),
    variantCount: Number(els.variantCount.value),
    requestedConcurrency: Number(els.concurrency.value),
    outputRatio: "9:16",
    branches: collectBranchDrafts(),
    templateSnapshot: {
      versionId: template?.versionId,
      draft: draftFromForm()
    },
    llmConfig: {
      provider: els.llmProvider.value.trim(),
      model: els.llmModel.value.trim(),
      endpoint: els.llmEndpoint.value.trim(),
      temperature: Number(els.llmTemperature.value)
    },
    knowledgeNotes: els.knowledgeNotes.value.trim(),
    variantPrompt: els.variantPrompt.value.trim()
  };
}

async function estimateBatch() {
  clearError(els.globalError);
  if (!state.selectedTemplate || !state.referenceVideo || !state.decomposition) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先保存产品模板，上传参考视频并确认脚本拆解"
    }, "估算前置条件");
    return;
  }
  setBusy(els.estimateBtn, true, "估算中");
  try {
    const data = await apiEnvelope("/api/wangzhuan/batches/estimate", {
      method: "POST",
      body: JSON.stringify(estimateRequest())
    });
    state.estimate = data;
    state.capabilities = data.capabilities || null;
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

async function loadBatchDetail() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return null;
  const data = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}`);
  state.batchDetail = data;
  renderBatch();
  return data;
}

function startPolling() {
  window.clearTimeout(state.pollTimer);
  const tick = async () => {
    try {
      const previousStatus = state.batchDetail?.batch?.status;
      const detail = await loadBatchDetail();
      await loadGallerySafely();
      const batch = detail?.batch;
      if (!batch || terminalBatchStatus(batch.status)) {
        if (batch && batch.status !== previousStatus) {
          if (batch.status === "succeeded") {
            showToast("批次生成完成，可下载交付包", { type: "success" });
          } else if (batch.status === "partial_failed" || batch.status === "failed") {
            showToast("批次未完全成功，可在任务详情中重试", { type: "error" });
          }
        }
        return;
      }
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    } catch (error) {
      renderError(els.globalError, error, "批次轮询失败");
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    }
  };
  state.pollTimer = window.setTimeout(tick, 1200);
}

async function planBatch() {
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
    const llmDefaults = state.llmDefaults || {};
    const data = await apiEnvelope("/api/wangzhuan/batches/plan", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("batch_plan"),
        estimateId: estimate.estimateId,
        llmConfig: {
          provider: els.llmProvider.value.trim() || llmDefaults.provider || "skylink",
          model: els.llmModel.value.trim() || llmDefaults.model || "gpt-5.4",
          endpoint: els.llmEndpoint.value.trim() || llmDefaults.endpoint || "https://skylink-gateway.com/api/v1",
          temperature: Number(els.llmTemperature.value || llmDefaults.temperature || 0.2)
        },
        knowledgeNotes: els.knowledgeNotes.value.trim(),
        ...(estimate.confirmationToken ? { confirmationToken: estimate.confirmationToken } : {})
      })
    });
    state.batchDetail = {
      batch: data.batch,
      events: [],
      downloadSummary: { outputsTotal: 0, downloadEligibleCount: 0, packageReady: false, missingFiles: [] }
    };
    if (data.batch?.batchId) {
      state.batchDetail = await loadBatchDetail();
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
  clearError(els.globalError);
  setBusy(els.confirmPlanBtn, true, "确认中");
  try {
    const data = await confirmBatchPlanRequest(batchId, plans);
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
    renderBatch();
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
    if (!terminalBatchStatus(state.batchDetail?.batch?.status)) startPolling();
  } catch (error) {
    renderError(els.globalError, error, "重试拼接失败");
  } finally {
    setBusy(els.retryStitchBtn, false);
  }
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
  if (!terminalBatchStatus(detail.batch.status)) startPolling();
  return detail;
}

async function runVideoQc() {
  const batchId = state.batchDetail?.batch?.batchId;
  if (!batchId) return;
  clearError(els.globalError);
  setBusy(els.runQcBtn, true, "质检中");
  try {
    state.batchDetail = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/qc`, {
      method: "POST",
      body: JSON.stringify({})
    });
    renderBatch();
    await loadGallery();
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
  renderGallery();
}

async function loadGallerySafely(options = {}) {
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
  if (!batchId) return;
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

function bindEvents() {
  els.templateSelect.addEventListener("change", () => {
    unlockTemplateEditing();
    applyTemplate(state.templates.find((item) => item.versionId === els.templateSelect.value));
    loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败"));
  });
  els.promiseLevel.addEventListener("change", () => {
    els.truthDetails.open = els.promiseLevel.value === "strong_commitment";
    loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败"));
  });
  els.targetChannel.addEventListener("change", () => loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败")));
  els.createTemplateBtn.addEventListener("click", saveTemplate);
  els.branches?.addEventListener("click", (event) => {
    if (!event.target.closest(".wz-save-branch")) return;
    saveTemplate();
  });
  els.branches?.addEventListener("input", markTemplateDirtyFromEdit, true);
  els.branches?.addEventListener("change", markTemplateDirtyFromEdit, true);
  window.addEventListener("wz:branch-created", () => {
    unlockTemplateEditing();
    renderTemplateStatus();
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
  els.referenceFile.addEventListener("change", () => {
    state.referenceVideo = null;
    clearWorkflowSession();
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
  els.confirmLimits.addEventListener("change", renderEstimate);
  els.planBatchBtn.addEventListener("click", planBatch);
  els.confirmPlanBtn.addEventListener("click", confirmPlanBatch);
  els.stopBatchBtn.addEventListener("click", stopBatch);
  els.runQcBtn.addEventListener("click", runVideoQc);
  els.retryStitchBtn.addEventListener("click", retryStitch);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  els.galleryBox.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-gallery-page]");
    if (!button || button.disabled) return;
    loadGallery({ page: Number(button.dataset.galleryPage) })
      .catch((error) => renderError(els.globalError, error, "图库刷新失败"));
  });
  els.includeSegments.addEventListener("change", renderBatch);
  els.downloadBtn.addEventListener("click", downloadPackage);
}

async function loadInitialData() {
  clearError(els.globalError);
  clearActiveLockBanner(lockHost());
  await loadLlmConfig();
  await loadTemplates();
  await loadRules();
  await loadActiveBatch();
  if (state.batchDetail?.batch) {
    restoreWorkflowFromBatch(state.batchDetail);
    const lock = activeLockFromBatch(state.batchDetail.batch);
    if (lock) renderActiveLockBanner(lockHost(), lock);
  } else {
    await restoreWorkflowSession();
  }
  if (!state.batchDetail) await loadGallerySafely();
  renderBatchReadiness();
  syncMetrics();
}

async function init() {
  resetTransientFormState();
  renderTruthFields();
  ensureDecompositionForm();
  renderDecompositionForm({});
  renderTemplateStatus();
  renderBatchReadiness();
  renderReference();
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
