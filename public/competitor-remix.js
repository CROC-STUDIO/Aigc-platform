import {
  $,
  apiEnvelope,
  badge,
  bindLogin,
  channelLabels,
  clearError,
  dataUrlFromFile,
  downloadZip,
  escapeHtml,
  idempotencyKey,
  operationLabels,
  remixStatusLabels,
  renderError,
  renderKeyValues,
  setBusy,
  showLogin,
  terminalRemixStatus,
  tinyVideoDataUrl
} from "./wangzhuan-common.js";

const els = {
  badge: $("#remixCurrentUserBadge"),
  logoutBtn: $("#remixLogoutBtn"),
  loginModal: $("#remixLoginModal"),
  envelopeBadge: $("#remixEnvelopeBadge"),
  capabilityBadge: $("#remixCapabilityBadge"),
  globalError: $("#remixGlobalError"),
  templateCount: $("#remixTemplateCount"),
  regionCount: $("#remixRegionCount"),
  outputCount: $("#remixOutputCount"),
  downloadCount: $("#remixDownloadCount"),
  sourceFile: $("#remixSourceFile"),
  sourceDuration: $("#remixDuration"),
  sourceWidth: $("#remixWidth"),
  sourceHeight: $("#remixHeight"),
  useSampleBtn: $("#remixUseSampleBtn"),
  uploadBtn: $("#remixUploadBtn"),
  sourceBox: $("#remixSourceBox"),
  templateSelect: $("#remixTemplateSelect"),
  operationType: $("#remixOperationType"),
  targetChannel: $("#remixTargetChannel"),
  addRegionBtn: $("#remixAddRegionBtn"),
  defaultRegionBtn: $("#remixDefaultRegionBtn"),
  regionsBox: $("#remixRegionsBox"),
  regionRect: $("#remixRegionRect"),
  estimateBtn: $("#remixEstimateBtn"),
  estimateBox: $("#remixEstimateBox"),
  startBtn: $("#remixStartBtn"),
  statusBadge: $("#remixStatusBadge"),
  detailBox: $("#remixDetailBox"),
  confirmBtn: $("#remixConfirmBtn"),
  downloadBtn: $("#remixDownloadBtn"),
  refreshGalleryBtn: $("#remixRefreshGalleryBtn"),
  galleryBox: $("#remixGalleryBox")
};

const state = {
  user: null,
  templates: [],
  source: null,
  regions: [{
    regionId: "reg_watermark",
    type: "bbox",
    label: "watermark",
    bbox: { x: 0.62, y: 0.84, width: 0.24, height: 0.08 }
  }],
  estimate: null,
  detail: null,
  gallery: null,
  usingSample: false,
  pollTimer: 0
};

function selectedTemplate() {
  return state.templates.find((item) => item.versionId === els.templateSelect.value) || null;
}

function syncMetrics() {
  els.templateCount.textContent = state.templates.length;
  els.regionCount.textContent = state.regions.length;
  els.outputCount.textContent = state.detail?.remix?.outputs?.length || state.gallery?.counts?.total || 0;
  els.downloadCount.textContent = state.detail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
}

function renderTemplates() {
  if (!state.templates.length) {
    els.templateSelect.innerHTML = `<option value="">请先到网赚素材管线保存产品模板</option>`;
    syncMetrics();
    return;
  }
  els.templateSelect.innerHTML = state.templates.map((template) => `
    <option value="${escapeHtml(template.versionId)}">
      ${escapeHtml(template.draft?.displayName || template.templateId)} v${escapeHtml(template.versionNumber)}
    </option>
  `).join("");
  const defaultTemplate = state.templates.find((item) => item.isDefault) || state.templates[0];
  els.templateSelect.value = defaultTemplate.versionId;
  syncMetrics();
}

function normalizeRegionsFromForm() {
  return [...els.regionsBox.querySelectorAll(".wz-region-item")].map((row, index) => {
    const type = row.querySelector("[data-region-type]").value;
    const label = row.querySelector("[data-region-label]").value.trim() || `region_${index + 1}`;
    const regionId = row.dataset.regionId || `region_${index + 1}`;
    if (type === "description") {
      return {
        regionId,
        type,
        label,
        description: row.querySelector("[data-region-description]").value.trim()
      };
    }
    return {
      regionId,
      type: "bbox",
      label,
      bbox: {
        x: Number(row.querySelector("[data-region-x]").value),
        y: Number(row.querySelector("[data-region-y]").value),
        width: Number(row.querySelector("[data-region-width]").value),
        height: Number(row.querySelector("[data-region-height]").value)
      }
    };
  });
}

function renderRegionRect() {
  const first = state.regions.find((item) => item.type === "bbox") || state.regions[0];
  if (!first?.bbox) {
    els.regionRect.hidden = true;
    return;
  }
  els.regionRect.hidden = false;
  els.regionRect.style.left = `${first.bbox.x * 100}%`;
  els.regionRect.style.top = `${first.bbox.y * 100}%`;
  els.regionRect.style.width = `${first.bbox.width * 100}%`;
  els.regionRect.style.height = `${first.bbox.height * 100}%`;
}

function renderRegions() {
  els.regionsBox.innerHTML = state.regions.map((region, index) => `
    <article class="wz-region-item" data-region-id="${escapeHtml(region.regionId || `region_${index + 1}`)}">
      <div class="wz-inline-form">
        <label>类型
          <select data-region-type>
            <option value="bbox" ${region.type !== "description" ? "selected" : ""}>bbox</option>
            <option value="description" ${region.type === "description" ? "selected" : ""}>描述</option>
          </select>
        </label>
        <label>标签 <input data-region-label type="text" value="${escapeHtml(region.label || "region")}" /></label>
      </div>
      <div class="wz-inline-form">
        <label>x <input data-region-x type="number" step="0.01" min="0" max="1" value="${escapeHtml(region.bbox?.x ?? 0.62)}" /></label>
        <label>y <input data-region-y type="number" step="0.01" min="0" max="1" value="${escapeHtml(region.bbox?.y ?? 0.84)}" /></label>
        <label>w <input data-region-width type="number" step="0.01" min="0" max="1" value="${escapeHtml(region.bbox?.width ?? 0.24)}" /></label>
        <label>h <input data-region-height type="number" step="0.01" min="0" max="1" value="${escapeHtml(region.bbox?.height ?? 0.08)}" /></label>
      </div>
      <label>描述 <input data-region-description type="text" value="${escapeHtml(region.description || "cover competitor watermark area")}" /></label>
      <button class="mini ghost" data-remove-region type="button">移除</button>
    </article>
  `).join("");
  for (const input of els.regionsBox.querySelectorAll("input, select")) {
    input.addEventListener("input", () => {
      state.regions = normalizeRegionsFromForm();
      renderRegionRect();
      syncMetrics();
    });
  }
  for (const button of els.regionsBox.querySelectorAll("[data-remove-region]")) {
    button.addEventListener("click", () => {
      state.regions = normalizeRegionsFromForm().filter((item) => item.regionId !== button.closest(".wz-region-item").dataset.regionId);
      renderRegions();
    });
  }
  renderRegionRect();
  syncMetrics();
}

function renderSource() {
  if (!state.source) {
    els.sourceBox.className = "wz-list empty-line";
    els.sourceBox.textContent = "未上传源素材";
    return;
  }
  const probe = state.source.probe;
  els.sourceBox.className = "wz-list";
  els.sourceBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(probe.fileName)}</strong>
        <small>${escapeHtml(probe.sourceId)} · ${escapeHtml(probe.kind)} · ${escapeHtml(probe.durationSec)}s · ${escapeHtml(probe.ratio || "-")}</small>
      </div>
      ${badge(probe.status, { pass: "通过", fail: "失败", warn: "警告" })}
    </article>
    ${state.source.previewUrl ? `<a href="${escapeHtml(state.source.previewUrl)}" target="_blank" rel="noreferrer">打开源文件预览</a>` : ""}
    ${state.usingSample ? `<div class="wz-warning">样例 data URL 只用于验证上传边界，不代表真实媒体可播放。</div>` : ""}
  `;
}

function renderEstimate() {
  const estimate = state.estimate;
  if (!estimate) {
    els.estimateBox.className = "wz-estimate empty-line";
    els.estimateBox.textContent = "尚未估算";
    els.startBtn.disabled = true;
    syncMetrics();
    return;
  }
  const capability = estimate.capability || {};
  els.capabilityBadge.textContent = `Provider: ${capability.status || "unknown"} / ${capability.provider || "unknown"}`;
  els.estimateBox.className = "wz-estimate";
  els.estimateBox.innerHTML = `
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["estimateId", estimate.estimateId],
        ["能力状态", capability.status || "unknown"],
        ["provider", capability.provider || "unknown"],
        ["操作", operationLabels[els.operationType.value] || els.operationType.value],
        ["二次确认", estimate.confirmationRequired ? "需要" : "不需要"]
      ])}
    </div>
    ${capability.supportedOperations?.length ? `<div class="wz-chipline">${capability.supportedOperations.map((item) => `<span>${escapeHtml(operationLabels[item] || item)}</span>`).join("")}</div>` : ""}
    ${capability.unsupportedReason ? `<div class="wz-warning">${escapeHtml(capability.unsupportedReason)}</div>` : ""}
  `;
  els.startBtn.disabled = capability.status !== "supported" && capability.status !== "degraded";
  syncMetrics();
}

function renderDetail() {
  const remix = state.detail?.remix;
  if (!remix) {
    els.statusBadge.textContent = "未开始";
    els.detailBox.className = "wz-list empty-line";
    els.detailBox.textContent = "暂无改造任务";
    els.confirmBtn.disabled = true;
    els.downloadBtn.disabled = true;
    syncMetrics();
    return;
  }
  els.statusBadge.innerHTML = badge(remix.status, remixStatusLabels);
  const output = remix.outputs?.[0];
  els.confirmBtn.disabled = remix.status !== "preview_required" || !output;
  els.downloadBtn.disabled = !state.detail.downloadSummary?.packageReady;
  els.detailBox.className = "wz-list";
  els.detailBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(remix.remixId)}</strong>
        <small>${escapeHtml(operationLabels[remix.operationType] || remix.operationType)} · ${escapeHtml(channelLabels[remix.targetChannel] || remix.targetChannel)}</small>
      </div>
      ${badge(remix.status, remixStatusLabels)}
    </article>
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["输出", remix.outputs?.length || 0],
        ["可下载", state.detail.downloadSummary?.downloadEligibleCount || 0],
        ["QC 通过", remix.qcSummary?.passed || 0],
        ["QC 失败", remix.qcSummary?.failed || 0],
        ["预览确认", output?.previewConfirmed ? "已确认" : "未确认"]
      ])}
    </div>
    ${output ? `
      <article class="wz-output">
        <div>
          <strong>${escapeHtml(output.outputId)}</strong>
          <small>${escapeHtml(output.kind)} · ${escapeHtml(output.qcStatus)}</small>
        </div>
        ${badge(output.qcStatus, { pass: "QC 通过", manual_required: "需人工确认", fail: "QC 失败" })}
        ${output.previewUrl ? `<a href="${escapeHtml(output.previewUrl)}" target="_blank" rel="noreferrer">打开预览</a>` : ""}
      </article>
    ` : ""}
  `;
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
        <small>${escapeHtml(item.kind)} · ${escapeHtml(item.qcStatus)} · ${escapeHtml(item.productName || "")}</small>
      </div>
      ${badge(item.qcStatus, { pass: "QC 通过", manual_required: "需人工确认", fail: "QC 失败" })}
      ${item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">预览文件</a>` : ""}
    </article>
  `).join("");
  syncMetrics();
}

async function loadTemplates() {
  const data = await apiEnvelope("/api/wangzhuan/templates");
  state.templates = data.templates || [];
  els.envelopeBadge.textContent = "Envelope: ok";
  renderTemplates();
}

async function uploadSource() {
  clearError(els.globalError);
  setBusy(els.uploadBtn, true, "上传中");
  try {
    const file = els.sourceFile.files?.[0];
    const content = file ? await dataUrlFromFile(file) : tinyVideoDataUrl("competitor");
    const data = await apiEnvelope("/api/wangzhuan/remix/upload", {
      method: "POST",
      body: JSON.stringify({
        fileName: file?.name || "sample-competitor.mp4",
        mimeType: file?.type || "video/mp4",
        content,
        durationSec: Number(els.sourceDuration.value),
        width: Number(els.sourceWidth.value),
        height: Number(els.sourceHeight.value)
      })
    });
    state.source = data;
    state.usingSample = !file;
    renderSource();
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    renderError(els.globalError, error, "源素材上传失败");
  } finally {
    setBusy(els.uploadBtn, false);
  }
}

function estimateRequest() {
  const template = selectedTemplate();
  state.regions = normalizeRegionsFromForm();
  return {
    sourceId: state.source?.sourceId,
    templateId: template?.templateId,
    versionId: template?.versionId,
    operationType: els.operationType.value,
    regions: state.regions,
    targetChannel: els.targetChannel.value
  };
}

async function estimateRemix() {
  clearError(els.globalError);
  if (!state.source || !selectedTemplate()) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先上传源素材并选择产品模板"
    }, "估算前置条件");
    return;
  }
  if (!normalizeRegionsFromForm().length) {
    renderError(els.globalError, {
      code: "region_required",
      message: "请至少添加一个 bbox 或描述区域"
    }, "区域校验");
    return;
  }
  setBusy(els.estimateBtn, true, "估算中");
  try {
    state.estimate = await apiEnvelope("/api/wangzhuan/remix/estimate", {
      method: "POST",
      body: JSON.stringify(estimateRequest())
    });
    renderEstimate();
  } catch (error) {
    state.estimate = null;
    if (error.code === "unsupported_capability") {
      els.startBtn.disabled = true;
    }
    els.capabilityBadge.textContent = error.data?.capability
      ? `Provider: ${error.data.capability.status} / ${error.data.capability.provider}`
      : "Provider: unsupported";
    renderEstimate();
    renderError(els.globalError, error, "能力估算失败");
  } finally {
    setBusy(els.estimateBtn, false);
  }
}

async function loadRemixDetail() {
  const remixId = state.detail?.remix?.remixId;
  if (!remixId) return null;
  state.detail = await apiEnvelope(`/api/wangzhuan/remix/${encodeURIComponent(remixId)}`);
  renderDetail();
  return state.detail;
}

function startPolling() {
  window.clearTimeout(state.pollTimer);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    try {
      const detail = await loadRemixDetail();
      await loadGallery();
      if (!detail?.remix || terminalRemixStatus(detail.remix.status) || attempts >= 8) return;
      state.pollTimer = window.setTimeout(tick, 2000);
    } catch (error) {
      renderError(els.globalError, error, "改造轮询失败");
    }
  };
  state.pollTimer = window.setTimeout(tick, 1200);
}

async function startRemix() {
  if (!state.estimate?.estimateId) return;
  clearError(els.globalError);
  setBusy(els.startBtn, true, "启动中");
  try {
    state.detail = await apiEnvelope("/api/wangzhuan/remix/start", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("remix_start"),
        estimateId: state.estimate.estimateId
      })
    });
    renderDetail();
    startPolling();
  } catch (error) {
    renderError(els.globalError, error, "改造启动失败");
  } finally {
    setBusy(els.startBtn, false);
  }
}

async function confirmPreview() {
  const remix = state.detail?.remix;
  const output = remix?.outputs?.[0];
  if (!remix || !output) return;
  clearError(els.globalError);
  setBusy(els.confirmBtn, true, "确认中");
  try {
    state.detail = await apiEnvelope(`/api/wangzhuan/remix/${encodeURIComponent(remix.remixId)}/preview-confirm`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("preview_confirm"),
        outputId: output.outputId,
        notes: "frontend preview confirmed"
      })
    });
    renderDetail();
    await loadGallery();
  } catch (error) {
    renderError(els.globalError, error, "预览确认失败");
  } finally {
    setBusy(els.confirmBtn, false);
  }
}

async function loadGallery() {
  const remixId = state.detail?.remix?.remixId;
  const params = remixId ? `?${new URLSearchParams({ remixId })}` : "";
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
  renderGallery();
}

async function downloadRemixPackage() {
  const remixId = state.detail?.remix?.remixId;
  if (!remixId) return;
  clearError(els.globalError);
  setBusy(els.downloadBtn, true, "打包中");
  try {
    await downloadZip({
      remixIds: [remixId],
      includeFailed: false,
      includeRemoteUrls: false
    });
  } catch (error) {
    renderError(els.globalError, error, "下载失败");
  } finally {
    setBusy(els.downloadBtn, false);
    renderDetail();
  }
}

function bindEvents() {
  els.useSampleBtn.addEventListener("click", () => {
    els.sourceFile.value = "";
    state.usingSample = true;
    els.sourceBox.className = "wz-list empty-line";
    els.sourceBox.textContent = "将使用小型 data URL 样例验证上传边界，不代表真实媒体可播放";
  });
  els.uploadBtn.addEventListener("click", uploadSource);
  els.addRegionBtn.addEventListener("click", () => {
    const next = state.regions.length + 1;
    state.regions.push({
      regionId: `reg_${next}`,
      type: "bbox",
      label: `region_${next}`,
      bbox: { x: 0.1, y: 0.1, width: 0.25, height: 0.12 }
    });
    renderRegions();
  });
  els.defaultRegionBtn.addEventListener("click", () => {
    state.regions = [{
      regionId: "reg_watermark",
      type: "bbox",
      label: "watermark",
      bbox: { x: 0.62, y: 0.84, width: 0.24, height: 0.08 }
    }];
    renderRegions();
  });
  els.operationType.addEventListener("change", () => {
    state.estimate = null;
    renderEstimate();
  });
  els.estimateBtn.addEventListener("click", estimateRemix);
  els.startBtn.addEventListener("click", startRemix);
  els.confirmBtn.addEventListener("click", confirmPreview);
  els.downloadBtn.addEventListener("click", downloadRemixPackage);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
}

async function init() {
  renderRegions();
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

async function loadInitialData() {
  clearError(els.globalError);
  await loadTemplates();
  await loadGallery();
}

init();
