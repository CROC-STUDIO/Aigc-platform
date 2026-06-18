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
  llmDefaults: null,
  activeLock: null,
  pollTimer: 0
};

const assetInputKeys = [
  ["productIcon", "productIconFile"],
  ["productScreenshot", "productScreenshotFile"],
  ["productRecording", "productRecordingFile"],
  ["endingAsset", "endingAssetFile"],
  ["personAsset", "personAssetFile"],
  ["rewardElement", "rewardElementFile"]
];

function syncMetrics() {
  els.templateCount.textContent = state.templates.length;
  els.ruleCount.textContent = state.channelRules.length;
  const batch = state.batchDetail?.batch;
  els.taskCount.textContent = batch?.tasks?.length || state.estimate?.estimate?.scriptCount || 0;
  els.downloadCount.textContent = state.batchDetail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
}

function renderTruthFields() {
  els.truthFields.innerHTML = strongTruthFields.map(([key, label]) => `
    <label>${escapeHtml(label)}
      <input data-truth-field="${escapeHtml(key)}" type="text" />
    </label>
  `).join("");
}

function draftFromForm() {
  const truthRules = {};
  for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
    truthRules[input.dataset.truthField] = input.value.trim();
  }
  const assetFileNames = {};
  for (const [key, elementKey] of assetInputKeys) {
    const file = els[elementKey]?.files?.[0];
    if (file?.name) assetFileNames[key] = file.name;
  }
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
    assetFileNames,
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
    truthRules
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
  `;
  els.draftDecompositionBtn.disabled = probe.status === "fail";
  els.decomposeBtn.disabled = !state.decomposition;
  els.decompositionStatus.className = probe.status === "fail" ? "wz-warning" : "wz-info";
  els.decompositionStatus.textContent = probe.status === "fail"
    ? "参考视频检查未通过，不能自动拆解。"
    : "视频信息已读取。点击“自动拆解参考视频”调用模型生成草稿。";
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
    els.estimateBox.textContent = "尚未估算";
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
    syncMetrics();
    return;
  }
  els.batchBadge.innerHTML = badge(batch.status, batchStatusLabels);
  els.stopBatchBtn.disabled = terminalBatchStatus(batch.status);
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
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
        ["QC 失败", batch.qcSummary?.failed || 0]
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
    els.galleryBox.textContent = "暂无可展示结果";
    syncMetrics();
    return;
  }
  els.galleryBox.className = "wz-gallery";
  els.galleryBox.innerHTML = gallery.items.map((item) => `
    <article class="wz-output">
      <div>
        <strong>${escapeHtml(item.outputId)}</strong>
        <small>${escapeHtml(item.kind)} · ${escapeHtml(item.qcStatus)} · ${escapeHtml(item.durationSec || "-")}s</small>
      </div>
      ${badge(item.qcStatus, { pass: "QC 通过", warn: "QC 警告", fail: "QC 失败", manual_required: "需人工确认", not_started: "未质检" })}
      ${item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">预览文件</a>` : ""}
    </article>
  `).join("");
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
  els.activeLockText.textContent = `当前占用：${state.activeLock.label}`;
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
  const draft = draftFromForm();
  const missing = missingStrongFields(draft);
  if (missing.length) {
    els.truthDetails.open = true;
    renderError(els.globalError, {
      code: "strong_rule_missing",
      message: "强承诺需要补齐真实收益规则",
      data: { missingFields: missing }
    }, "模板校验");
    return;
  }
  clearError(els.globalError);
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
    els.decomposeBtn.disabled = true;
    els.decompositionStatus.className = "wz-success";
    els.decompositionStatus.textContent = "脚本拆解已确认保存，可以继续估算生成批次。";
    els.referenceBox.insertAdjacentHTML("beforeend", `<div class="wz-success">脚本拆解已确认，可以继续估算生成批次。</div>`);
  } catch (error) {
    renderError(els.globalError, error, "拆解失败");
  } finally {
    setBusy(els.decomposeBtn, false);
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
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    try {
      const detail = await loadBatchDetail();
      await loadGallery();
      if (!detail?.batch || terminalBatchStatus(detail.batch.status) || attempts >= 10) return;
      state.pollTimer = window.setTimeout(tick, 2000);
    } catch (error) {
      renderError(els.globalError, error, "批次轮询失败");
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
    state.batchDetail = { batch: data.batch, events: [], downloadSummary: { outputsTotal: 0, downloadEligibleCount: 0, packageReady: false, missingFiles: [] } };
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

async function loadGallery() {
  const batchId = state.batchDetail?.batch?.batchId;
  const params = batchId ? `?${new URLSearchParams({ batchId })}` : "";
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
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
    els.decomposeBtn.disabled = !els.decompositionText.value.trim();
    els.decompositionStatus.className = "wz-info";
    els.decompositionStatus.textContent = "已修改拆解 JSON，请确认无误后保存。";
  });
  els.decomposeBtn.addEventListener("click", decomposeReferenceVideo);
  els.estimateBtn.addEventListener("click", estimateBatch);
  els.confirmLimits.addEventListener("change", renderEstimate);
  els.startBatchBtn.addEventListener("click", startBatch);
  els.stopBatchBtn.addEventListener("click", stopBatch);
  els.stopActiveLockBtn.addEventListener("click", stopActiveLock);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  els.includeSegments.addEventListener("change", renderBatch);
  els.downloadBtn.addEventListener("click", downloadPackage);
}

async function loadInitialData() {
  clearError(els.globalError);
  renderActiveLock(null);
  await loadLlmConfig();
  await loadTemplates();
  await loadRules();
  await loadGallery();
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
