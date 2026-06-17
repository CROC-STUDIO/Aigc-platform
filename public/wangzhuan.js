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
  terminalBatchStatus,
  tinyVideoDataUrl
} from "./wangzhuan-common.js";

const els = {
  badge: $("#wzCurrentUserBadge"),
  logoutBtn: $("#wzLogoutBtn"),
  loginModal: $("#wzLoginModal"),
  envelopeBadge: $("#wzEnvelopeBadge"),
  capabilityBadge: $("#wzCapabilityBadge"),
  globalError: $("#wzGlobalError"),
  templateCount: $("#wzTemplateCount"),
  ruleCount: $("#wzRuleCount"),
  taskCount: $("#wzTaskCount"),
  downloadCount: $("#wzDownloadCount"),
  templateSelect: $("#wzTemplateSelect"),
  createTemplateBtn: $("#wzCreateTemplateBtn"),
  displayName: $("#wzDisplayName"),
  productName: $("#wzProductName"),
  cta: $("#wzCta"),
  ending: $("#wzEnding"),
  currencySymbol: $("#wzCurrencySymbol"),
  language: $("#wzLanguage"),
  regions: $("#wzRegions"),
  templateChannel: $("#wzTemplateChannel"),
  defaultDuration: $("#wzDefaultDuration"),
  promiseLevel: $("#wzPromiseLevel"),
  truthDetails: $("#wzTruthDetails"),
  truthFields: $("#wzTruthFields"),
  targetChannel: $("#wzTargetChannel"),
  targetRegion: $("#wzTargetRegion"),
  loadRulesBtn: $("#wzLoadRulesBtn"),
  rulesBox: $("#wzRulesBox"),
  referenceFile: $("#wzReferenceFile"),
  referenceDuration: $("#wzReferenceDuration"),
  referenceWidth: $("#wzReferenceWidth"),
  referenceHeight: $("#wzReferenceHeight"),
  useSampleVideoBtn: $("#wzUseSampleVideoBtn"),
  checkReferenceBtn: $("#wzCheckReferenceBtn"),
  decomposeBtn: $("#wzDecomposeBtn"),
  decompositionText: $("#wzDecompositionText"),
  referenceBox: $("#wzReferenceBox"),
  duration: $("#wzDuration"),
  variantCount: $("#wzVariantCount"),
  concurrency: $("#wzConcurrency"),
  estimateBtn: $("#wzEstimateBtn"),
  estimateBox: $("#wzEstimateBox"),
  confirmLimits: $("#wzConfirmLimits"),
  startBatchBtn: $("#wzStartBatchBtn"),
  stopBatchBtn: $("#wzStopBatchBtn"),
  batchBadge: $("#wzBatchBadge"),
  batchBox: $("#wzBatchBox"),
  refreshGalleryBtn: $("#wzRefreshGalleryBtn"),
  galleryBox: $("#wzGalleryBox"),
  downloadBtn: $("#wzDownloadBtn"),
  includeSegments: $("#wzIncludeSegments")
};

const defaultDecomposition = {
  scene: "Phone app reward screen",
  subject: "Hand holding phone",
  action: "User taps a reward task",
  camera: "Close-up vertical shot",
  lighting: "Bright indoor lighting",
  style: "Clean app demo",
  quality: "HD",
  hook: "Earn rewards with daily tasks",
  cta: "Install today"
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
  usingSample: false,
  pollTimer: 0
};

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
  return {
    displayName: els.displayName.value.trim(),
    productName: els.productName.value.trim(),
    cta: els.cta.value.trim(),
    ending: els.ending.value.trim(),
    currencySymbol: els.currencySymbol.value.trim(),
    language: els.language.value.trim(),
    regions: els.regions.value.split(",").map((item) => item.trim()).filter(Boolean),
    targetChannels: [els.templateChannel.value],
    defaultOutputRatio: "9:16",
    defaultDurationSec: Number(els.defaultDuration.value),
    promiseLevel: els.promiseLevel.value,
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
  for (const input of els.truthFields.querySelectorAll("[data-truth-field]")) {
    input.value = draft.truthRules?.[input.dataset.truthField] || "";
  }
  els.truthDetails.open = els.promiseLevel.value === "strong_commitment";
}

function renderTemplates() {
  if (!state.templates.length) {
    els.templateSelect.innerHTML = `<option value="">暂无模板，保存当前草稿后继续</option>`;
    state.selectedTemplate = null;
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

function renderRules(response = {}) {
  state.channelRules = response.rules || [];
  const warnings = response.warnings || [];
  if (!state.channelRules.length) {
    els.rulesBox.className = "wz-list empty-line";
    els.rulesBox.textContent = "没有命中渠道规则";
    syncMetrics();
    return;
  }
  els.rulesBox.className = "wz-list";
  els.rulesBox.innerHTML = `
    ${warnings.map((item) => `<div class="wz-warning">${escapeHtml(item.message)}</div>`).join("")}
    ${state.channelRules.map((rule) => `
      <article class="wz-row">
        <div>
          <strong>${escapeHtml(channelLabels[rule.channel] || rule.channel)} / ${escapeHtml(promiseLabels[rule.promiseLevel] || rule.promiseLevel)}</strong>
          <small>CTA 强度：${escapeHtml(rule.ctaStrength)}；版本：${escapeHtml(rule.version)}</small>
        </div>
        <div class="wz-chipline">
          ${(rule.requiredDisclaimers || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
          ${(rule.forbiddenTerms || []).map((item) => `<span class="danger">${escapeHtml(item)}</span>`).join("")}
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
    els.decomposeBtn.disabled = true;
    return;
  }
  els.referenceBox.className = "wz-list";
  els.referenceBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(probe.fileName)}</strong>
        <small>${escapeHtml(probe.referenceVideoId)} · ${escapeHtml(probe.durationSec)}s · ${escapeHtml(probe.width)}x${escapeHtml(probe.height)} · ${escapeHtml(probe.ratio || "-")}</small>
      </div>
      ${badge(probe.status, { pass: "通过", warn: "警告", fail: "失败" })}
    </article>
    ${(probe.issues || []).map((item) => `<div class="wz-warning">${escapeHtml(item.message)}</div>`).join("")}
  `;
  els.decomposeBtn.disabled = probe.status === "fail";
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
    const content = file ? await dataUrlFromFile(file) : tinyVideoDataUrl("reference");
    const data = await apiEnvelope("/api/wangzhuan/reference-videos/check", {
      method: "POST",
      body: JSON.stringify({
        fileName: file?.name || "sample-reference.mp4",
        mimeType: file?.type || "video/mp4",
        content,
        durationSec: Number(els.referenceDuration.value),
        width: Number(els.referenceWidth.value),
        height: Number(els.referenceHeight.value),
        canExtractFrame: true
      })
    });
    state.referenceVideo = data.referenceVideo;
    state.usingSample = !file;
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
    els.referenceBox.insertAdjacentHTML("beforeend", `<div class="wz-success">拆解已保存：${escapeHtml(data.decomposition.referenceVideoId)}</div>`);
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
    referenceVideoId: state.referenceVideo?.referenceVideoId,
    targetChannel: els.targetChannel.value,
    targetRegion: els.targetRegion.value.trim() || "US",
    language: els.language.value.trim() || "en-US",
    promiseLevel: els.promiseLevel.value,
    durationSec: Number(els.duration.value),
    variantCount: Number(els.variantCount.value),
    requestedConcurrency: Number(els.concurrency.value),
    outputRatio: "9:16"
  };
}

async function estimateBatch() {
  clearError(els.globalError);
  if (!state.selectedTemplate || !state.referenceVideo || !state.decomposition) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先保存模板、检查参考视频并保存拆解"
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
    renderError(els.globalError, error, "批次启动失败");
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
    els.referenceFile.value = "";
    state.usingSample = true;
    els.referenceBox.className = "wz-list empty-line";
    els.referenceBox.textContent = "将使用小型 data URL 样例验证上传边界，不代表真实媒体可播放";
  });
  els.checkReferenceBtn.addEventListener("click", checkReferenceVideo);
  els.decomposeBtn.addEventListener("click", decomposeReferenceVideo);
  els.estimateBtn.addEventListener("click", estimateBatch);
  els.confirmLimits.addEventListener("change", renderEstimate);
  els.startBatchBtn.addEventListener("click", startBatch);
  els.stopBatchBtn.addEventListener("click", stopBatch);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  els.includeSegments.addEventListener("change", renderBatch);
  els.downloadBtn.addEventListener("click", downloadPackage);
}

async function loadInitialData() {
  clearError(els.globalError);
  await loadTemplates();
  await loadRules();
  await loadGallery();
  els.envelopeBadge.textContent = "Envelope: ok";
  syncMetrics();
}

async function init() {
  renderTruthFields();
  els.decompositionText.value = JSON.stringify(defaultDecomposition, null, 2);
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
