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
  terminalRemixStatus
} from "./wangzhuan-common.js";

const els = {
  badge: $("#remixCurrentUserBadge"),
  logoutBtn: $("#remixLogoutBtn"),
  loginModal: $("#remixLoginModal"),
  envelopeBadge: $("#remixEnvelopeBadge"),
  capabilityBadge: $("#remixCapabilityBadge"),
  globalError: $("#remixGlobalError"),
  activeLockActions: $("#remixActiveLockActions"),
  activeLockText: $("#remixActiveLockText"),
  stopActiveLockBtn: $("#remixStopActiveLockBtn"),
  operationType: $("#remixOperationType"),
  sourceCount: $("#remixTemplateCount"),
  regionCount: $("#remixRegionCount"),
  outputCount: $("#remixOutputCount"),
  downloadCount: $("#remixDownloadCount"),
  sourceFile: $("#remixSourceFile"),
  uploadBtn: $("#remixUploadBtn"),
  sourceBox: $("#remixSourceBox"),
  clearMaskBtn: $("#remixClearMaskBtn"),
  maskEditor: $("#remixMaskEditor"),
  maskMediaLayer: $("#remixMaskMediaLayer"),
  maskLayer: $("#remixMaskLayer"),
  maskSummary: $("#remixMaskSummary"),
  maskPreviewCanvas: $("#remixMaskPreviewCanvas"),
  maskConfirmBtn: $("#remixMaskConfirmBtn"),
  statusBadge: $("#remixStatusBadge"),
  detailBox: $("#remixDetailBox"),
  confirmBtn: $("#remixConfirmBtn"),
  stopBtn: $("#remixStopBtn"),
  downloadBtn: $("#remixDownloadBtn"),
  refreshGalleryBtn: $("#remixRefreshGalleryBtn"),
  galleryBox: $("#remixGalleryBox")
};

const state = {
  user: null,
  source: null,
  regions: [],
  detail: null,
  gallery: null,
  galleryPage: 1,
  galleryPageSize: 20,
  pollTimer: 0,
  selectedRegionId: "",
  maskDrag: null,
  submitBlocked: false,
  actualMediaCache: null,
  activeLock: null
};

const MIN_MASK_SIZE = 0.03;
const MASK_KEY_STEP = 0.01;
const CREATE_MASK_THRESHOLD = 0.012;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_DIRECT_OPERATION = "watermark_cover";
const ACTIVE_REMIX_STATUSES = new Set(["queued", "running", "qc", "preview_required"]);

function isActiveRemixStatus(status) {
  return ACTIVE_REMIX_STATUSES.has(status);
}

function selectedOperationType() {
  return els.operationType?.value || DEFAULT_DIRECT_OPERATION;
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
  const href = state.activeLock.type === "batch" ? "/wangzhuan.html" : "/competitor-remix.html";
  els.activeLockText.innerHTML = `当前占用：${escapeHtml(state.activeLock.label)} · <a href="${href}">打开任务页</a>`;
  els.stopActiveLockBtn.disabled = false;
}

async function stopActiveLock() {
  const lock = state.activeLock;
  if (!lock) return;
  const url = lock.type === "batch"
    ? `/api/wangzhuan/batches/${encodeURIComponent(lock.id)}/stop`
    : `/api/wangzhuan/remix/${encodeURIComponent(lock.id)}/stop`;
  setBusy(els.stopActiveLockBtn, true, "停止中");
  try {
    await apiEnvelope(url, {
      method: "POST",
      body: JSON.stringify({ reason: "frontend_stop_active_lock" })
    });
    renderActiveLock(null);
    clearError(els.globalError);
    els.capabilityBadge.textContent = "占用任务已停止";
  } catch (error) {
    renderError(els.globalError, error, "停止占用任务失败");
  } finally {
    setBusy(els.stopActiveLockBtn, false);
  }
}

function activeRemixNotice(status) {
  if (status === "preview_required") return "处理已完成，请先完成预览确认或下载交付";
  return "处理中，请等待状态刷新后再继续操作";
}

function syncMetrics() {
  const activeRemix = isActiveRemixStatus(state.detail?.remix?.status);
  els.sourceCount.textContent = state.source ? "1" : "0";
  els.regionCount.textContent = state.regions.length;
  els.outputCount.textContent = state.detail?.remix?.outputs?.length || state.gallery?.counts?.total || 0;
  els.downloadCount.textContent = state.detail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
  els.maskConfirmBtn.disabled = state.submitBlocked || activeRemix || !state.source || !state.regions.length;
  els.uploadBtn.disabled = activeRemix;
  els.sourceFile.disabled = activeRemix;
  els.clearMaskBtn.disabled = activeRemix;
  els.operationType.disabled = activeRemix;
  els.stopBtn.hidden = !activeRemix;
  els.stopBtn.disabled = !activeRemix;
  els.maskEditor?.setAttribute("aria-busy", activeRemix ? "true" : "false");
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

function clampNumber(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundMaskValue(value) {
  return Math.round(clampNumber(value) * 1000) / 1000;
}

function normalizeBbox(bbox = {}) {
  const width = clampNumber(Number(bbox.width), MIN_MASK_SIZE, 1);
  const height = clampNumber(Number(bbox.height), MIN_MASK_SIZE, 1);
  const x = clampNumber(Number(bbox.x), 0, 1 - width);
  const y = clampNumber(Number(bbox.y), 0, 1 - height);
  return {
    x: roundMaskValue(x),
    y: roundMaskValue(y),
    width: roundMaskValue(width),
    height: roundMaskValue(height)
  };
}

function normalizedRegions() {
  return state.regions.map((region, index) => ({
    regionId: region.regionId || `mask_${index + 1}`,
    type: "bbox",
    label: region.label || `mask_${index + 1}`,
    bbox: normalizeBbox(region.bbox)
  }));
}

function nextRegionId() {
  let next = state.regions.length + 1;
  const existing = new Set(state.regions.map((item) => item.regionId));
  while (existing.has(`mask_${next}`)) next += 1;
  return `mask_${next}`;
}

function selectedBboxRegion() {
  return state.regions.find((item) => item.regionId === state.selectedRegionId && item.bbox)
    || state.regions.find((item) => item.bbox)
    || null;
}

function mediaDimensionsFromProbe(probe = {}) {
  const width = Number(probe.width || 720);
  const height = Number(probe.height || 1280);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 720,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 1280
  };
}

function mediaDimensions() {
  return mediaDimensionsFromProbe(state.source?.probe || {});
}

function rememberActualMediaDimensions(media = els.maskMediaLayer?.querySelector("video,img")) {
  const sourceId = state.source?.sourceId || "";
  const width = Number(media?.videoWidth || media?.naturalWidth || 0);
  const height = Number(media?.videoHeight || media?.naturalHeight || 0);
  if (!sourceId || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  state.actualMediaCache = {
    sourceId,
    width: Math.round(width),
    height: Math.round(height)
  };
  return state.actualMediaCache;
}

function actualMediaDimensions() {
  const fallback = mediaDimensions();
  const sourceId = state.source?.sourceId || "";
  const media = els.maskMediaLayer?.querySelector("video,img");
  const remembered = rememberActualMediaDimensions(media);
  const cached = remembered?.sourceId === sourceId ? remembered : state.actualMediaCache;
  if (cached?.sourceId === sourceId) {
    return { width: cached.width, height: cached.height };
  }
  return {
    width: fallback.width,
    height: fallback.height
  };
}

function mediaAspectRatioValue(dimensions = actualMediaDimensions()) {
  return `${Math.max(1, dimensions.width)} / ${Math.max(1, dimensions.height)}`;
}

function applyMediaAspectRatio(dimensions = actualMediaDimensions()) {
  const value = mediaAspectRatioValue(dimensions);
  els.maskEditor?.style.setProperty("--remix-media-aspect-ratio", value);
  els.maskPreviewCanvas?.parentElement?.style.setProperty("--remix-media-aspect-ratio", value);
  els.maskMediaLayer?.style.setProperty("--remix-media-aspect-ratio", value);
}

function mediaViewport() {
  const rect = els.maskEditor?.getBoundingClientRect?.();
  const dimensions = actualMediaDimensions();
  if (!rect || !rect.width || !rect.height) {
    return { left: 0, top: 0, width: 1, height: 1, rect: { left: 0, top: 0, width: 1, height: 1 } };
  }
  const mediaRatio = dimensions.width / dimensions.height || 9 / 16;
  const editorRatio = rect.width / rect.height;
  if (editorRatio > mediaRatio) {
    const height = rect.height;
    const width = height * mediaRatio;
    return { left: (rect.width - width) / 2, top: 0, width, height, rect };
  }
  const width = rect.width;
  const height = width / mediaRatio;
  return { left: 0, top: (rect.height - height) / 2, width, height, rect };
}

function syncMaskLayerViewport() {
  applyMediaAspectRatio();
  const viewport = mediaViewport();
  if (els.maskLayer) {
    els.maskLayer.style.inset = "auto";
    els.maskLayer.style.left = `${viewport.left}px`;
    els.maskLayer.style.top = `${viewport.top}px`;
    els.maskLayer.style.width = `${viewport.width}px`;
    els.maskLayer.style.height = `${viewport.height}px`;
  }
  return viewport;
}

function renderMaskMedia(force = false) {
  if (!els.maskMediaLayer) return;
  if (!state.source?.previewUrl) {
    els.maskMediaLayer.innerHTML = "";
    state.actualMediaCache = null;
    applyMediaAspectRatio(mediaDimensions());
    return;
  }
  const existingMedia = els.maskMediaLayer.querySelector("video,img");
  if (!force && existingMedia?.dataset.sourceId === state.source.sourceId) {
    rememberActualMediaDimensions(existingMedia);
    applyMediaAspectRatio(actualMediaDimensions());
    return;
  }
  const probe = state.source.probe || {};
  const safeUrl = escapeHtml(state.source.previewUrl);
  const safeSourceId = escapeHtml(state.source.sourceId || "");
  const mimeType = String(probe.mimeType || "").toLowerCase();
  const isVideo = probe.kind === "video" || mimeType.startsWith("video/");
  els.maskMediaLayer.innerHTML = isVideo
    ? `<video src="${safeUrl}" data-source-id="${safeSourceId}" muted loop playsinline preload="metadata"></video>`
    : `<img src="${safeUrl}" data-source-id="${safeSourceId}" alt="" />`;
  applyMediaAspectRatio(mediaDimensions());
  const media = els.maskMediaLayer.querySelector("video,img");
  const syncFromMedia = () => {
    rememberActualMediaDimensions(media);
    syncMaskLayerViewport();
    renderMaskPreview();
  };
  media?.addEventListener(isVideo ? "loadedmetadata" : "load", syncFromMedia, { once: true });
  media?.addEventListener("loadeddata", syncFromMedia, { once: true });
}

function renderMaskPreview() {
  const canvas = els.maskPreviewCanvas;
  if (!canvas) return;
  const { width, height } = actualMediaDimensions();
  applyMediaAspectRatio({ width, height });
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const regions = normalizedRegions();
  ctx.fillStyle = "#ffffff";
  for (const region of regions) {
    const box = region.bbox;
    ctx.fillRect(
      Math.round(box.x * width),
      Math.round(box.y * height),
      Math.max(1, Math.round(box.width * width)),
      Math.max(1, Math.round(box.height * height))
    );
  }
  els.maskSummary.textContent = regions.length ? `${regions.length} 个区域已合成` : "未生成";
  syncMetrics();
}

function maskPreviewDataUrl() {
  renderMaskPreview();
  return els.maskPreviewCanvas.toDataURL("image/png");
}

function renderMaskEditor(forceMedia = false) {
  if (!els.maskEditor || !els.maskLayer) return;
  if (forceMedia) renderMaskMedia(true);
  else renderMaskMedia();
  syncMaskLayerViewport();
  const empty = els.maskEditor.querySelector("[data-mask-empty]");
  if (empty) empty.hidden = Boolean(state.source?.previewUrl);
  const bboxRegions = normalizedRegions();
  state.regions = bboxRegions;
  if (!bboxRegions.some((region) => region.regionId === state.selectedRegionId)) {
    state.selectedRegionId = bboxRegions[0]?.regionId || "";
  }
  els.maskLayer.innerHTML = bboxRegions.map((region) => {
    const bbox = normalizeBbox(region.bbox);
    const selected = region.regionId === state.selectedRegionId ? " selected" : "";
    return `
      <button class="wz-region-rect${selected}" type="button" data-region-id="${escapeHtml(region.regionId)}"
        style="left:${bbox.x * 100}%;top:${bbox.y * 100}%;width:${bbox.width * 100}%;height:${bbox.height * 100}%"
        aria-label="Mask 区域 ${escapeHtml(region.label || region.regionId)}">
        <span>${escapeHtml(region.label || "mask")}</span>
        <i data-resize-handle="nw"></i>
        <i data-resize-handle="ne"></i>
        <i data-resize-handle="sw"></i>
        <i data-resize-handle="se"></i>
      </button>
    `;
  }).join("");
  renderMaskPreview();
}

function renderSourcePreview(source) {
  const url = source?.previewUrl;
  if (!url) return "";
  const probe = source.probe || {};
  const mimeType = String(probe.mimeType || "").toLowerCase();
  const safeUrl = escapeHtml(url);
  const isVideo = probe.kind === "video" || mimeType.startsWith("video/");
  if (isVideo) {
    return `
      <div class="remix-source-preview" style="--remix-media-aspect-ratio: ${escapeHtml(mediaAspectRatioValue(mediaDimensionsFromProbe(probe)))}" data-source-preview="video">
        <video src="${safeUrl}" controls preload="metadata" playsinline></video>
      </div>
    `;
  }
  return `
    <div class="remix-source-preview" style="--remix-media-aspect-ratio: ${escapeHtml(mediaAspectRatioValue(mediaDimensionsFromProbe(probe)))}" data-source-preview="image">
      <img src="${safeUrl}" alt="源素材预览" />
    </div>
  `;
}

function renderSource() {
  if (!state.source) {
    els.sourceBox.className = "wz-list empty-line";
    els.sourceBox.textContent = "未上传源素材";
    renderMaskEditor(true);
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
    ${renderSourcePreview(state.source)}
  `;
  renderMaskEditor(true);
}

function pointerToCanvasPoint(event) {
  const viewport = syncMaskLayerViewport();
  const rawX = (event.clientX - viewport.rect.left - viewport.left) / viewport.width;
  const rawY = (event.clientY - viewport.rect.top - viewport.top) / viewport.height;
  return {
    x: clampNumber(rawX),
    y: clampNumber(rawY),
    inside: rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1
  };
}

function commitMaskEdit(regionId, bbox) {
  state.regions = state.regions.map((region) => {
    if (region.regionId !== regionId) return region;
    return { ...region, type: "bbox", bbox: normalizeBbox(bbox) };
  });
  state.selectedRegionId = regionId;
  renderMaskEditor();
}

function resizeBboxFromDrag(startBox, dx, dy, handle) {
  let { x, y, width, height } = startBox;
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) width += dx;
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) height += dy;
  if (width < MIN_MASK_SIZE) {
    if (handle.includes("w")) x -= MIN_MASK_SIZE - width;
    width = MIN_MASK_SIZE;
  }
  if (height < MIN_MASK_SIZE) {
    if (handle.includes("n")) y -= MIN_MASK_SIZE - height;
    height = MIN_MASK_SIZE;
  }
  return normalizeBbox({ x, y, width, height });
}

function previewDragBbox(bbox) {
  const regionId = state.maskDrag?.regionId || "";
  const target = regionId ? els.maskLayer.querySelector(`[data-region-id="${CSS.escape(regionId)}"]`) : null;
  if (!target) return;
  target.style.left = `${bbox.x * 100}%`;
  target.style.top = `${bbox.y * 100}%`;
  target.style.width = `${bbox.width * 100}%`;
  target.style.height = `${bbox.height * 100}%`;
}

function bindMaskEditor() {
  if (!els.maskEditor) return;
  els.maskEditor.addEventListener("pointerdown", (event) => {
    const rectButton = event.target.closest?.(".wz-region-rect");
    const point = pointerToCanvasPoint(event);
    if (!point.inside) return;
    if (rectButton) {
      const region = state.regions.find((item) => item.regionId === rectButton.dataset.regionId);
      if (!region?.bbox) return;
      const handle = event.target.dataset.resizeHandle || "";
      state.selectedRegionId = region.regionId;
      state.maskDrag = {
        mode: handle ? "resize" : "move",
        handle,
        regionId: region.regionId,
        startPoint: point,
        startBox: normalizeBbox(region.bbox)
      };
      rectButton.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (!state.source?.previewUrl) return;
    state.maskDrag = {
      mode: "create",
      regionId: nextRegionId(),
      startPoint: point,
      created: false
    };
    els.maskEditor.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  els.maskEditor.addEventListener("pointermove", (event) => {
    const drag = state.maskDrag;
    if (!drag) return;
    const point = pointerToCanvasPoint(event);
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    let nextBox = drag.startBox;
    if (drag.mode === "move") {
      nextBox = normalizeBbox({
        ...drag.startBox,
        x: drag.startBox.x + dx,
        y: drag.startBox.y + dy
      });
    } else if (drag.mode === "resize") {
      nextBox = resizeBboxFromDrag(drag.startBox, dx, dy, drag.handle);
    } else if (drag.mode === "create") {
      if (!drag.created && Math.max(Math.abs(dx), Math.abs(dy)) < CREATE_MASK_THRESHOLD) return;
      if (!drag.created) {
        drag.created = true;
        const newRegion = {
          regionId: drag.regionId,
          type: "bbox",
          label: `mask_${state.regions.length + 1}`,
          bbox: normalizeBbox({ x: drag.startPoint.x, y: drag.startPoint.y, width: MIN_MASK_SIZE, height: MIN_MASK_SIZE })
        };
        state.regions.push(newRegion);
        state.selectedRegionId = drag.regionId;
        renderMaskEditor();
      }
      nextBox = normalizeBbox({
        x: Math.min(drag.startPoint.x, point.x),
        y: Math.min(drag.startPoint.y, point.y),
        width: Math.abs(point.x - drag.startPoint.x),
        height: Math.abs(point.y - drag.startPoint.y)
      });
    }
    state.maskDrag.nextBox = nextBox;
    previewDragBbox(nextBox);
  });

  const endDrag = () => {
    if (!state.maskDrag) return;
    const { regionId, nextBox, startBox } = state.maskDrag;
    state.maskDrag = null;
    if (nextBox || startBox) commitMaskEdit(regionId, nextBox || startBox);
  };
  els.maskEditor.addEventListener("pointerup", endDrag);
  els.maskEditor.addEventListener("pointercancel", endDrag);

  els.maskEditor.addEventListener("keydown", (event) => {
    const region = selectedBboxRegion();
    if (!region?.bbox) return;
    const box = normalizeBbox(region.bbox);
    const step = event.altKey ? MASK_KEY_STEP / 2 : MASK_KEY_STEP;
    let nextBox = { ...box };
    if (event.key === "ArrowLeft") {
      if (event.shiftKey) nextBox.width -= step;
      else nextBox.x -= step;
    } else if (event.key === "ArrowRight") {
      if (event.shiftKey) nextBox.width += step;
      else nextBox.x += step;
    } else if (event.key === "ArrowUp") {
      if (event.shiftKey) nextBox.height -= step;
      else nextBox.y -= step;
    } else if (event.key === "ArrowDown") {
      if (event.shiftKey) nextBox.height += step;
      else nextBox.y += step;
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      state.regions = state.regions.filter((item) => item.regionId !== region.regionId);
      state.selectedRegionId = selectedBboxRegion()?.regionId || "";
      renderMaskEditor();
      return;
    } else {
      return;
    }
    event.preventDefault();
    commitMaskEdit(region.regionId, nextBox);
  });
  window.addEventListener("resize", () => {
    syncMaskLayerViewport();
    renderMaskPreview();
  });
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
  const active = isActiveRemixStatus(remix.status);
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
        ["远端 Job", remix.providerJob?.jobId || "-"],
        ["远端状态", remix.providerJob?.status || "-"],
        ["预览确认", output?.previewConfirmed ? "已确认" : "未确认"]
      ])}
    </div>
    ${active ? `<div class="wz-warning">${escapeHtml(activeRemixNotice(remix.status))}</div>` : ""}
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
        <small>${escapeHtml(item.kind)} · ${escapeHtml(item.qcStatus)} · ${escapeHtml(item.productName || "")}</small>
      </div>
      ${badge(item.qcStatus, { pass: "QC 通过", manual_required: "需人工确认", fail: "QC 失败" })}
      ${item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">预览文件</a>` : ""}
    </article>
  `).join("")}
    ${galleryPaginationHtml(gallery)}
  `;
  syncMetrics();
}

async function uploadSource() {
  clearError(els.globalError);
  if (isActiveRemixStatus(state.detail?.remix?.status)) {
    renderError(els.globalError, {
      code: "active_remix_running",
      message: "当前已有改造任务处理中，请等待状态刷新后再继续操作"
    }, "源素材上传失败");
    return;
  }
  const file = els.sourceFile.files?.[0];
  if (!file) {
    renderError(els.globalError, {
      code: "validation_error",
      message: "请先选择需要改造的视频或图片素材"
    }, "源素材上传失败");
    return;
  }
  setBusy(els.uploadBtn, true, "上传中");
  try {
    const content = await dataUrlFromFile(file);
    const data = await apiEnvelope("/api/wangzhuan/remix/upload", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        content
      })
    });
    state.source = data;
    state.regions = [];
    state.selectedRegionId = "";
    state.actualMediaCache = null;
    state.submitBlocked = false;
    renderSource();
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    renderError(els.globalError, error, "源素材上传失败");
  } finally {
    setBusy(els.uploadBtn, false);
    syncMetrics();
  }
}

async function startMaskEdit() {
  clearError(els.globalError);
  const regions = normalizedRegions();
  if (!state.source || !regions.length) {
    renderError(els.globalError, {
      code: "region_required",
      message: "请先上传素材并框选至少一个区域"
    }, "Mask 校验");
    return;
  }
  if (isActiveRemixStatus(state.detail?.remix?.status)) {
    renderError(els.globalError, {
      code: "active_remix_running",
      message: "当前已有改造任务处理中，请等待状态刷新后再继续操作"
    }, "改造启动失败");
    syncMetrics();
    return;
  }
  const previousDetail = state.detail;
  state.submitBlocked = false;
  state.detail = { remix: { status: "queued", remixId: "提交中", operationType: selectedOperationType(), targetChannel: "generic", regions, tasks: [], outputs: [], providerJob: { status: "submitting" }, qcSummary: { total: 0, passed: 0, failed: 0 } }, downloadSummary: { downloadEligibleCount: 0, packageReady: false, missingFiles: [] } };
  renderDetail();
  setBusy(els.maskConfirmBtn, true, "提交中");
  try {
    state.detail = await apiEnvelope("/api/wangzhuan/remix/mask-edit", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("remix_mask_edit"),
        sourceId: state.source.sourceId,
        operationType: selectedOperationType(),
        targetChannel: "generic",
        regions,
        maskDataUrl: maskPreviewDataUrl()
      })
    });
    els.capabilityBadge.textContent = `Provider: ${state.detail.remix?.capability?.status || "submitted"} / ${state.detail.remix?.capability?.provider || "video_aigc"}`;
    renderDetail();
    startPolling();
  } catch (error) {
    els.capabilityBadge.textContent = error.data?.capability
      ? `Provider: ${error.data.capability.status} / ${error.data.capability.provider}`
      : "Provider: unsupported";
    if (error.code === "unsupported_capability") {
      state.submitBlocked = true;
    }
    renderActiveLock(activeLockFromError(error));
    state.detail = previousDetail;
    renderDetail();
    renderError(els.globalError, error, "改造启动失败");
  } finally {
    setBusy(els.maskConfirmBtn, false);
    syncMetrics();
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
  const tick = async () => {
    try {
      const detail = await loadRemixDetail();
      await loadGallery();
      if (!detail?.remix || terminalRemixStatus(detail.remix.status)) return;
      state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
    } catch (error) {
      renderError(els.globalError, error, "改造轮询失败");
      state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  state.pollTimer = window.setTimeout(tick, 1200);
}

async function stopRemix() {
  const remixId = state.detail?.remix?.remixId;
  if (!remixId || !isActiveRemixStatus(state.detail?.remix?.status)) return;
  clearError(els.globalError);
  setBusy(els.stopBtn, true, "停止中");
  try {
    state.detail = await apiEnvelope(`/api/wangzhuan/remix/${encodeURIComponent(remixId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ reason: "frontend_stop" })
    });
    renderDetail();
    await loadGallery();
  } catch (error) {
    renderError(els.globalError, error, "停止改造失败");
  } finally {
    setBusy(els.stopBtn, false);
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

async function loadGallery(options = {}) {
  const requestedPage = Number(options.page || state.galleryPage || 1);
  state.galleryPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const remixId = state.detail?.remix?.remixId;
  const query = new URLSearchParams({
    page: String(state.galleryPage),
    pageSize: String(state.galleryPageSize)
  });
  if (remixId) query.set("remixId", remixId);
  const params = `?${query}`;
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
  state.galleryPage = state.gallery?.pagination?.page || state.galleryPage;
  els.envelopeBadge.textContent = "Envelope: ok";
  renderGallery();
}

async function loadActiveRemix() {
  const detail = await apiEnvelope("/api/wangzhuan/remix/active");
  if (!detail?.remix) {
    state.detail = null;
    renderDetail();
    return null;
  }
  state.detail = detail;
  state.source = detail.remix.source
    ? { sourceId: detail.remix.source.sourceId, probe: detail.remix.source, previewUrl: detail.remix.source.storageUrl || "" }
    : state.source;
  state.regions = Array.isArray(detail.remix.regions) ? detail.remix.regions : [];
  state.selectedRegionId = state.regions[0]?.regionId || "";
  if (els.operationType && detail.remix.operationType) {
    els.operationType.value = detail.remix.operationType;
  }
  renderSource();
  renderDetail();
  if (isActiveRemixStatus(detail.remix.status)) startPolling();
  return detail;
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
  els.uploadBtn.addEventListener("click", uploadSource);
  els.clearMaskBtn.addEventListener("click", () => {
    if (isActiveRemixStatus(state.detail?.remix?.status)) return;
    state.regions = [];
    state.selectedRegionId = "";
    renderMaskEditor();
  });
  els.maskConfirmBtn.addEventListener("click", startMaskEdit);
  els.confirmBtn.addEventListener("click", confirmPreview);
  els.stopBtn.addEventListener("click", stopRemix);
  els.stopActiveLockBtn?.addEventListener("click", stopActiveLock);
  els.downloadBtn.addEventListener("click", downloadRemixPackage);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  els.galleryBox.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-gallery-page]");
    if (!button || button.disabled) return;
    loadGallery({ page: Number(button.dataset.galleryPage) })
      .catch((error) => renderError(els.globalError, error, "图库刷新失败"));
  });
}

async function init() {
  renderMaskEditor();
  bindMaskEditor();
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
  renderActiveLock(null);
  await loadActiveRemix();
  await loadGallery();
  els.envelopeBadge.textContent = "Envelope: ok";
}

init();
