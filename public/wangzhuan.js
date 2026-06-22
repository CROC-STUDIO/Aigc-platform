import {
  $,
  apiEnvelope,
  badge,
  batchStatusLabels,
  bindLogin,
  channelLabels,
  clearError,
  dataUrlFromFile,
  downloadZip,
  escapeHtml,
  idempotencyKey,
  promiseLabels,
  renderError,
  renderKeyValues,
  setBusy,
  showLogin,
  strongTruthFields,
  terminalBatchStatus
} from "./wangzhuan-common.js";

const els = {
  badge: $("#wzCurrentUserBadge"),
  logoutBtn: $("#wzLogoutBtn"),
  loginModal: $("#wzLoginModal"),
  envelopeBadge: $("#wzEnvelopeBadge"),
  capabilityBadge: $("#wzCapabilityBadge"),
  globalError: $("#wzGlobalError"),
  activeLockActions: $("#wzActiveLockActions"),
  activeLockText: $("#wzActiveLockText"),
  stopActiveLockBtn: $("#wzStopActiveLockBtn"),
  templateCount: $("#wzTemplateCount"),
  ruleCount: $("#wzRuleCount"),
  taskCount: $("#wzTaskCount"),
  downloadCount: $("#wzDownloadCount"),
  branches: $("#wzBranches"),
  templateSelect: $("#wzTemplateSelect"),
  createTemplateBtn: $("#wzCreateTemplateBtn"),
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
  useSampleVideoBtn: $("#wzUseSampleVideoBtn"),
  checkReferenceBtn: $("#wzCheckReferenceBtn"),
  draftDecompositionBtn: $("#wzDraftDecompositionBtn"),
  decomposeBtn: $("#wzDecomposeBtn"),
  decompositionText: $("#wzDecompositionText"),
  decompositionStatus: $("#wzDecompositionStatus"),
  referenceBox: $("#wzReferenceBox"),
  duration: $("#wzDuration"),
  variantCount: $("#wzVariantCount"),
  concurrency: $("#wzConcurrency"),
  estimateBtn: $("#wzEstimateBtn"),
  estimateBox: $("#wzEstimateBox"),
  confirmLimits: $("#wzConfirmLimits"),
  modelSelect: $("#wzModelSelect"),
  seedanceModel: $("#wzSeedanceModel"),
  startBatchBtn: $("#wzStartBatchBtn"),
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
  pollTimer: 0,
  pollIntervalMs: 2000
};

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

const DECOMPOSITION_CONFIRMED_MESSAGE = "脚本拆解已确认，下一步点击“重新估算”生成批次预估。";

function isDecompositionConfirmed() {
  return Boolean(state.decomposition?.referenceVideoId || (state.decomposition && state.referenceVideo?.referenceVideoId));
}

function focusBatchStep() {
  const batchNode = document.getElementById("wzNodeBatch");
  if (!batchNode) return;
  for (const node of document.querySelectorAll(".wz-canvas .wz-node")) {
    node.classList.toggle("focused", node === batchNode);
  }
  for (const item of document.querySelectorAll("#wzStepbar .wz-stepbar-item")) {
    item.classList.toggle("active", item.dataset.step === "4");
  }
  requestAnimationFrame(() => {
    batchNode.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    els.estimateBtn?.focus({ preventScroll: true });
  });
}

function syncMetrics() {
  els.templateCount.textContent = state.templates.length;
  els.ruleCount.textContent = state.channelRules.length;
  const batch = state.batchDetail?.batch;
  els.taskCount.textContent = batch?.tasks?.length || state.estimate?.estimate?.scriptCount || 0;
  els.downloadCount.textContent = state.batchDetail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
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

function collectBranchDrafts() {
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
  }).filter((branch) => branch.productName || branch.cta || branch.materialDirection || Object.keys(branch.assetUrls).length);
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
  const truthRules = {};
  for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
    truthRules[input.dataset.truthField] = input.value.trim();
  }
  const branches = collectBranchDrafts();
  const primaryBranch = branches[0] || {};
  return {
    displayName: els.displayName.value.trim(),
    productName: els.productName.value.trim(),
    productLink: els.productLink.value.trim(),
    cta: els.cta.value.trim(),
    ending: els.ending.value.trim(),
    currencySymbol: els.currencySymbol.value.trim(),
    language: els.language.value.trim(),
    regions: els.regions.value.split(",").map((item) => item.trim()).filter(Boolean),
    targetChannels: [els.templateChannel.value],
    defaultOutputRatio: "9:16",
    defaultDurationSec: Number(els.defaultDuration.value),
    promiseLevel: els.promiseLevel.value,
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
    variantPrompt: els.variantPrompt.value.trim(),
    seedanceModel: els.seedanceModel.value.trim(),
    materialDirection: els.materialDirection.value,
    voiceoverStyle: els.voiceoverStyle.value.trim(),
    customPrompt: els.customPrompt.value.trim(),
    negativePrompt: els.negativePrompt.value.trim(),
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
  state.selectedTemplate = template || null;
  const draft = template?.draft;
  if (!draft) return;
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

function applyLlmConfigDefaults() {
  const config = state.llmDefaults;
  if (!config) return;
  if (!els.llmProvider.value.trim()) els.llmProvider.value = config.provider || "skylink";
  if (!els.llmModel.value.trim()) els.llmModel.value = config.model || "gpt-5.4";
  if (!els.llmEndpoint.value.trim()) els.llmEndpoint.value = config.endpoint || "https://skylink-gateway.com/api/v1";
  if (!els.llmTemperature.value.trim()) els.llmTemperature.value = String(config.temperature ?? 0.2);
  if (!els.knowledgeNotes.value.trim() && config.endpoint) {
    els.knowledgeNotes.placeholder = `LLM endpoint: ${config.endpoint}${config.hasApiKey ? "；API key 已在服务端配置" : "；API key 未配置"}`;
  }
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
    els.referenceBox.className = "wz-list empty-line";
    els.referenceBox.textContent = "未上传参考视频";
    els.draftDecompositionBtn.disabled = true;
    els.decomposeBtn.disabled = true;
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "先读取参考视频信息，再调用模型生成拆解草稿。";
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
    ${isDecompositionConfirmed() ? `<div class="wz-success">${escapeHtml(DECOMPOSITION_CONFIRMED_MESSAGE)}</div>` : ""}
  `;
  els.draftDecompositionBtn.disabled = probe.status === "fail";
  els.decomposeBtn.disabled = probe.status === "fail" || isDecompositionConfirmed() || !els.decompositionText.value.trim();
  els.decompositionStatus.className = probe.status === "fail" ? "wz-warning" : "wz-info";
  if (probe.status === "fail") {
    els.decompositionStatus.textContent = "参考视频检查未通过，不能自动拆解。";
  } else if (isDecompositionConfirmed()) {
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = DECOMPOSITION_CONFIRMED_MESSAGE;
  } else {
    els.decompositionStatus.textContent = "视频信息已读取。点击“自动拆解参考视频”调用模型生成草稿。";
  }
}

async function draftReferenceVideoDecomposition() {
  if (!state.referenceVideo) return;
  clearError(els.globalError);
  state.decomposition = null;
  els.decomposeBtn.disabled = true;
  setBusy(els.draftDecompositionBtn, true, "模型拆解中");
  els.decompositionStatus.className = "wz-info";
  els.decompositionStatus.textContent = "正在调用模型拆解参考视频，请稍等。";
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
    els.decompositionText.value = JSON.stringify(data.decomposition, null, 2);
    els.decomposeBtn.disabled = false;
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = "模型已生成拆解草稿，请检查 JSON 后点击“确认脚本拆解”保存。";
  } catch (error) {
    els.decompositionStatus.className = "wz-warning";
    els.decompositionStatus.textContent = error.data?.upstreamMessage
      ? `模型拆解未完成：${error.data.upstreamMessage}`
      : error.data?.status
        ? `模型拆解未完成：上游状态 ${error.data.status}`
        : error.message
          ? `模型拆解未完成：${error.message}`
          : "模型拆解未完成，请检查模型配置或稍后重试。";
    renderError(els.globalError, error, "自动拆解失败");
  } finally {
    setBusy(els.draftDecompositionBtn, false);
    els.draftDecompositionBtn.disabled = !state.referenceVideo || state.referenceVideo.status === "fail";
  }
}

function renderEstimate() {
  const estimate = state.estimate?.estimate;
  if (!estimate) {
    els.estimateBox.className = "wz-estimate empty-line";
    els.estimateBox.textContent = isDecompositionConfirmed()
      ? "脚本已确认，点击“重新估算”查看本批任务数和消耗。"
      : "尚未估算";
    els.startBatchBtn.disabled = true;
    syncMetrics();
    return;
  }
  const capability = state.capabilities?.stitcher;
  els.capabilityBadge.textContent = capability
    ? `Stitcher: ${capability.status}${capability.provider ? ` / ${capability.provider}` : ""}`
    : "Provider: not required";
  els.estimateBox.className = "wz-estimate";
  els.estimateBox.innerHTML = `
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["estimateId", estimate.estimateId],
        ["裂变子节点", estimate.branchCount || 1],
        ["脚本", estimate.scriptCount],
        ["Seedance 分段", estimate.seedanceSegmentCount],
        ["拼接任务", estimate.stitchTaskCount],
        ["生图任务", estimate.imageTaskCount],
        ["并发", estimate.requestedConcurrency],
        ["重试上限", estimate.maxRetryPerTask],
        ["二次确认", estimate.confirmationRequired ? "需要" : "不需要"]
      ])}
    </div>
    ${estimate.models?.length ? `<div class="wz-chipline">${estimate.models.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
  `;
  els.confirmLimits.checked = !estimate.confirmationRequired;
  els.confirmLimits.disabled = !estimate.confirmationRequired;
  els.startBatchBtn.disabled = estimate.hardBlocked || (estimate.confirmationRequired && !els.confirmLimits.checked);
  syncMetrics();
}

function renderBatch() {
  const detail = state.batchDetail;
  const batch = detail?.batch;
  if (!batch) {
    els.batchBadge.textContent = "未开始";
    els.batchBox.className = "wz-list empty-line";
    els.batchBox.textContent = "暂无批次";
    els.stopBatchBtn.disabled = true;
    els.runQcBtn.disabled = true;
    syncMetrics();
    return;
  }
  els.batchBadge.innerHTML = badge(batch.status, batchStatusLabels);
  els.stopBatchBtn.disabled = terminalBatchStatus(batch.status);
  els.retryStitchBtn.hidden = batch.status !== "partial_failed";
  els.retryStitchBtn.disabled = batch.status !== "partial_failed";
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
  const qcRunnable = batch.status === "qc" || outputs.some((output) => output.qcStatus === "not_started");
  els.runQcBtn.disabled = !qcRunnable;
  els.batchBox.className = "wz-list";
  els.batchBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(batch.batchId)}</strong>
        <small>${escapeHtml(batch.createdAt || "")} · ${tasks.length} 个任务 · ${escapeHtml(batch.estimate?.durationSec || "-")}s</small>
      </div>
      ${badge(batch.status, batchStatusLabels)}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["输出总数", detail.downloadSummary?.outputsTotal || 0],
        ["可下载", detail.downloadSummary?.downloadEligibleCount || 0],
        ["包状态", detail.downloadSummary?.packageReady ? "ready" : "not_ready"],
        ["QC 通过", batch.qcSummary?.passed || 0],
        ["QC 失败", batch.qcSummary?.failed || 0],
        ["模型视频质检", outputs.some((output) => output.modelQcSummary) ? "已执行" : "待执行"]
      ])}
    </div>
    <div class="wz-task-list">
      ${tasks.slice(0, 12).map((task) => `
        <div>
          <span>${escapeHtml(task.generationTaskId)}</span>
          <strong>${escapeHtml(task.status)}</strong>
          <small>${escapeHtml(task.seedanceTaskId || task.errorCode || "pending")}</small>
        </div>
      `).join("")}
    </div>
    ${events.length ? `<div class="wz-events">${events.slice(-5).map((event) => `<small>${escapeHtml(event.event)} · ${escapeHtml(event.createdAt)}</small>`).join("")}</div>` : ""}
  `;
  els.downloadBtn.disabled = !detail.downloadSummary?.packageReady && !(batch.status === "partial_failed" && els.includeSegments.checked);
  syncMetrics();
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

function activeLockFromError(error) {
  if (error?.code !== "batch_already_running") return null;
  const data = error.data || {};
  if (data.remixId) {
    return {
      type: "remix",
      id: data.remixId,
      status: data.status || "",
      label: `竞品改造任务 ${data.remixId}${data.status ? ` · ${data.status}` : ""}`
    };
  }
  if (data.batchId) {
    return {
      type: "batch",
      id: data.batchId,
      status: data.status || "",
      label: `素材管线批次 ${data.batchId}${data.status ? ` · ${data.status}` : ""}`
    };
  }
  return null;
}

function renderActiveLock(lock = state.activeLock) {
  if (!els.activeLockActions) return;
  state.activeLock = lock || null;
  if (!state.activeLock) {
    els.activeLockActions.hidden = true;
    if (els.activeLockText) els.activeLockText.textContent = "";
    return;
  }
  els.activeLockActions.hidden = false;
  const href = state.activeLock.type === "remix"
    ? "/competitor-remix.html"
    : "/wangzhuan.html";
  els.activeLockText.innerHTML = `当前占用：${escapeHtml(state.activeLock.label)} · <a href="${href}">打开任务页</a>`;
  els.stopActiveLockBtn.disabled = false;
}

function renderStartError(error) {
  renderError(els.globalError, error, "批次启动失败");
  renderActiveLock(activeLockFromError(error));
}

async function loadTemplates() {
  const data = await apiEnvelope("/api/wangzhuan/templates");
  state.templates = data.templates || [];
  state.permissions = data.permissions || {};
  els.envelopeBadge.textContent = "Envelope: ok";
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
  setBusy(els.createTemplateBtn, true, "上传素材");
  try {
    await uploadBranchAssets();
  } catch (error) {
    setBusy(els.createTemplateBtn, false);
    renderError(els.globalError, error, "产品素材上传失败");
    return;
  }
  const draft = draftFromForm();
  const missing = missingStrongFields(draft);
  if (missing.length) {
    setBusy(els.createTemplateBtn, false);
    els.truthDetails.open = true;
    renderError(els.globalError, {
      code: "strong_rule_missing",
      message: "强承诺需要补齐真实收益规则",
      data: { missingFields: missing }
    }, "模板校验");
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
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    renderError(els.globalError, error, "模板保存失败");
  } finally {
    setBusy(els.createTemplateBtn, false);
  }
}

async function checkReferenceVideo() {
  clearError(els.globalError);
  setBusy(els.checkReferenceBtn, true, "检查中");
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
    state.decomposition = null;
    els.decompositionText.value = "";
    renderReference();
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    renderError(els.globalError, error, "参考视频检查失败");
  } finally {
    setBusy(els.checkReferenceBtn, false);
  }
}

async function decomposeReferenceVideo() {
  if (!state.referenceVideo) return;
  clearError(els.globalError);
  setBusy(els.decomposeBtn, true, "保存中");
  try {
    const decomposition = JSON.parse(els.decompositionText.value || "{}");
    const data = await apiEnvelope("/api/wangzhuan/reference-videos/decompose", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("decompose"),
        referenceVideoId: state.referenceVideo.referenceVideoId,
        decomposition
      })
    });
    state.decomposition = data.decomposition;
    state.estimate = null;
    renderReference();
    renderEstimate();
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = DECOMPOSITION_CONFIRMED_MESSAGE;
    focusBatchStep();
  } catch (error) {
    renderError(els.globalError, error, "拆解失败");
  } finally {
    setBusy(els.decomposeBtn, false);
    els.decomposeBtn.disabled = isDecompositionConfirmed() || !els.decompositionText.value.trim();
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
  } catch (error) {
    if (error.code === "stitcher_unavailable") els.capabilityBadge.textContent = "Stitcher: unsupported";
    if (error.code === "strong_rule_missing") els.truthDetails.open = true;
    state.estimate = null;
    renderEstimate();
    renderError(els.globalError, error, "估算失败");
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
      const detail = await loadBatchDetail();
      await loadGallery();
      if (!detail?.batch || terminalBatchStatus(detail.batch.status)) return;
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    } catch (error) {
      renderError(els.globalError, error, "批次轮询失败");
      state.pollTimer = window.setTimeout(tick, state.pollIntervalMs);
    }
  };
  state.pollTimer = window.setTimeout(tick, 1200);
}

async function startBatch() {
  const estimate = state.estimate?.estimate;
  if (!estimate) return;
  if (estimate.confirmationRequired && !els.confirmLimits.checked) {
    renderError(els.globalError, {
      code: "limit_confirmation_required",
      message: "请先确认估算中的任务数和分段数"
    }, "启动前确认");
    return;
  }
  clearError(els.globalError);
  renderActiveLock(null);
  setBusy(els.startBatchBtn, true, "启动中");
  try {
    const data = await apiEnvelope("/api/wangzhuan/batches/start", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("batch_start"),
        estimateId: estimate.estimateId,
        ...(estimate.confirmationToken ? { confirmationToken: estimate.confirmationToken } : {})
      })
    });
    if (data.batch?.batchId) {
      state.batchDetail = await loadBatchDetail();
    } else {
      state.batchDetail = {
        batch: data.startedBatch,
        events: [],
        downloadSummary: { outputsTotal: 0, downloadEligibleCount: 0, packageReady: false, missingFiles: [] }
      };
    }
    renderBatch();
    startPolling();
  } catch (error) {
    renderStartError(error);
  } finally {
    setBusy(els.startBatchBtn, false);
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
  await loadGallery();
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

async function stopActiveLock() {
  const lock = state.activeLock;
  if (!lock) return;
  const url = lock.type === "remix"
    ? `/api/wangzhuan/remix/${encodeURIComponent(lock.id)}/stop`
    : `/api/wangzhuan/batches/${encodeURIComponent(lock.id)}/stop`;
  setBusy(els.stopActiveLockBtn, true, "停止中");
  try {
    const data = await apiEnvelope(url, {
      method: "POST",
      body: JSON.stringify({ reason: "frontend_stop_active_lock" })
    });
    if (lock.type === "batch") {
      state.batchDetail = data;
      renderBatch();
    }
    renderActiveLock(null);
    clearError(els.globalError);
    els.capabilityBadge.textContent = "占用任务已停止";
  } catch (error) {
    renderError(els.globalError, error, "停止占用任务失败");
  } finally {
    setBusy(els.stopActiveLockBtn, false);
    if (!state.activeLock) els.stopActiveLockBtn.disabled = true;
  }
}

async function loadGallery(options = {}) {
  const requestedPage = Number(options.page || state.galleryPage || 1);
  state.galleryPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const batchId = state.batchDetail?.batch?.batchId;
  const query = new URLSearchParams({
    page: String(state.galleryPage),
    pageSize: String(state.galleryPageSize)
  });
  if (batchId) query.set("batchId", batchId);
  const params = `?${query}`;
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
  state.galleryPage = state.gallery?.pagination?.page || state.galleryPage;
  renderGallery();
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
  els.loadRulesBtn.addEventListener("click", () => loadRules().catch((error) => renderError(els.globalError, error, "规则刷新失败")));
  els.useSampleVideoBtn.addEventListener("click", () => {
    els.referenceFile.click();
  });
  els.referenceFile.addEventListener("change", () => {
    state.referenceVideo = null;
    state.decomposition = null;
    els.decompositionText.value = "";
    els.draftDecompositionBtn.disabled = true;
    els.decomposeBtn.disabled = true;
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "先读取参考视频信息，再调用模型生成拆解草稿。";
    clearError(els.globalError);
    const file = els.referenceFile.files?.[0];
    if (!file) {
      renderReference();
      return;
    }
    els.referenceBox.className = "wz-list empty-line";
    els.referenceBox.textContent = `已选择 ${file.name}，请点击“读取视频信息”继续`;
  });
  els.checkReferenceBtn.addEventListener("click", checkReferenceVideo);
  els.draftDecompositionBtn.addEventListener("click", draftReferenceVideoDecomposition);
  els.decompositionText.addEventListener("input", () => {
    if (!state.referenceVideo || state.referenceVideo.status === "fail") return;
    state.decomposition = null;
    state.estimate = null;
    renderEstimate();
    els.decomposeBtn.disabled = isDecompositionConfirmed() || !els.decompositionText.value.trim();
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "已修改拆解 JSON，请确认无误后保存。";
  });
  els.decomposeBtn.addEventListener("click", decomposeReferenceVideo);
  els.estimateBtn.addEventListener("click", estimateBatch);
  els.confirmLimits.addEventListener("change", renderEstimate);
  els.startBatchBtn.addEventListener("click", startBatch);
  els.stopBatchBtn.addEventListener("click", stopBatch);
  els.runQcBtn.addEventListener("click", runVideoQc);
  els.retryStitchBtn.addEventListener("click", retryStitch);
  els.stopActiveLockBtn.addEventListener("click", stopActiveLock);
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
  renderActiveLock(null);
  await loadLlmConfig();
  await loadTemplates();
  await loadRules();
  await loadActiveBatch();
  if (!state.batchDetail) await loadGallery();
  els.envelopeBadge.textContent = "Envelope: ok";
  syncMetrics();
}

async function init() {
  renderTruthFields();
  els.decompositionText.value = "";
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
