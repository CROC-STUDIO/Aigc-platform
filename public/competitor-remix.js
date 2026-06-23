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
  inlineRetryHtml,
  operationLabels,
  remixStatusLabels,
  renderError,
  renderKeyValues,
  setBusy,
  showLogin,
  showToast,
  syncActionHint,
  taskProgressHtml,
  terminalRemixStatus
} from "./wangzhuan-common.js";
import {
  clearActiveLockBanner,
  showActiveLockFromError
} from "./wangzhuan-task-nav.js";

const lockHost = () => ({
  state,
  actions: els.activeLockActions,
  text: els.activeLockText
});

const els = {
  badge: $("#remixCurrentUserBadge"),
  logoutBtn: $("#remixLogoutBtn"),
  loginModal: $("#remixLoginModal"),
  globalError: $("#remixGlobalError"),
  activeLockActions: $("#remixActiveLockActions"),
  activeLockText: $("#remixActiveLockText"),
  operationType: $("#remixOperationType"),
  sourceCount: $("#remixTemplateCount"),
  regionCount: $("#remixRegionCount"),
  outputCount: $("#remixOutputCount"),
  downloadCount: $("#remixDownloadCount"),
  sourceUploadPanel: $("#remixSourceUploadPanel"),
  sourceUploadStatus: $("#remixSourceUploadStatus"),
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
  galleryBox: $("#remixGalleryBox"),
  prototypeReviewOnly: $("#remixPrototypeReviewOnly"),
  prototypeSeedBtn: $("#remixPrototypeSeedBtn"),
  prototypeSourceList: $("#remixPrototypeSourceList"),
  prototypeApplyRegionsBtn: $("#remixPrototypeApplyRegionsBtn"),
  prototypeConfirmReviewBtn: $("#remixPrototypeConfirmReviewBtn"),
  prototypeGenerateTasksBtn: $("#remixPrototypeGenerateTasksBtn"),
  prototypeCapabilityPlan: $("#remixPrototypeCapabilityPlan"),
  prototypeSubmitTasksBtn: $("#remixPrototypeSubmitTasksBtn"),
  prototypeAdvanceTasksBtn: $("#remixPrototypeAdvanceTasksBtn"),
  prototypeTaskQueue: $("#remixPrototypeTaskQueue"),
  prototypeGallery: $("#remixPrototypeGallery")
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
  initFailed: false,
  actualMediaCache: null,
  activeLock: null,
  prototype: {
    activeSourceId: "",
    selectedSourceIds: new Set(),
    reviewOnly: false,
    sources: [],
    tasks: [],
    outputs: []
  }
};

let hasHandledInitialPageShow = false;
let sourceObjectUrl = "";

function resetWorkshopState() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.source = null;
  state.regions = [];
  state.selectedRegionId = "";
  state.actualMediaCache = null;
  state.detail = null;
  state.submitBlocked = false;
  state.maskDrag = null;
  resetBrowserRestoredInputs();
  if (PROTOTYPE_MODE && !state.prototype.sources.length) seedPrototypeSources();
  renderPrototypeAll();
  renderDetail();
}

function resetBrowserRestoredInputs() {
  if (els.sourceFile) els.sourceFile.value = "";
  if (!els.operationType) return;
  const defaultOption = [...els.operationType.options].find((option) => option.defaultSelected)
    || [...els.operationType.options].find((option) => option.value === DEFAULT_DIRECT_OPERATION)
    || els.operationType.options[0];
  els.operationType.value = defaultOption?.value || DEFAULT_DIRECT_OPERATION;
}

const MIN_MASK_SIZE = 0.03;
const MASK_KEY_STEP = 0.01;
const CREATE_MASK_THRESHOLD = 0.012;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_DIRECT_OPERATION = "watermark_cover";
const ACTIVE_REMIX_STATUSES = new Set(["queued", "running", "qc", "preview_required"]);
const SOURCE_SUBMIT_LOCKED_STATUSES = new Set([...ACTIVE_REMIX_STATUSES, "succeeded"]);
const PROVIDER_RUNNING_STATUSES = new Set(["submitting", "pending", "running"]);
const PROTOTYPE_MODE = true;
const PROTOTYPE_CAPABILITIES = {
  logo_icon: { label: "Logo/Icon 去除", jobType: "auto_ai_remove", detail: "框选或点选后传播 mask" },
  watermark: { label: "水印遮挡", jobType: "mask_edit", detail: "区域遮挡或模糊" },
  product_name: { label: "产品名替换", jobType: "language_rewrite", detail: "OCR 后生成覆盖计划" },
  cta: { label: "CTA 文案替换", jobType: "video_copy_translate", detail: "字幕/画面文字回写" },
  subtitle: { label: "字幕处理", jobType: "video_copy_translate", detail: "OCR/ASR 时间轴处理" },
  phone_ui: { label: "手机界面区域", jobType: "mask_edit", detail: "标记需人工确认" },
  ending: { label: "Ending 检测", jobType: "end_trim_detection", detail: "尾部导流检测/裁切" }
};
const PROTOTYPE_STATUS_LABELS = {
  draft: "草稿",
  queued: "排队中",
  running: "处理中",
  review_required: "待确认",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止"
};

function isActiveRemixStatus(status) {
  return ACTIVE_REMIX_STATUSES.has(status);
}

function remixSourceId(remix) {
  return remix?.sourceId || remix?.source?.sourceId || "";
}

function isProviderJobRunning(remix) {
  const status = remix?.providerJob?.status;
  return Boolean(status && PROVIDER_RUNNING_STATUSES.has(status));
}

function isSourceSubmitLocked() {
  const remix = state.detail?.remix;
  const sourceId = state.source?.sourceId;
  if (!remix || !sourceId) return false;
  if (remixSourceId(remix) !== sourceId) return false;
  return SOURCE_SUBMIT_LOCKED_STATUSES.has(remix.status) || isProviderJobRunning(remix);
}

function isPrototypeMirroredSource() {
  return Boolean(PROTOTYPE_MODE && state.source?.prototypeOnly);
}

function selectedOperationType() {
  return els.operationType?.value || DEFAULT_DIRECT_OPERATION;
}

function prototypeSourceStatus(source) {
  const counts = prototypeTaskCountsForSource(source?.sourceId);
  if (counts.failed) return "failed";
  if (counts.running) return "running";
  if (counts.queued) return "queued";
  if (counts.succeeded && counts.succeeded === counts.total) return "succeeded";
  if (source?.reviewRequired || source?.status === "review_required") return "review_required";
  return source?.status || "draft";
}

function prototypeSourceStatusLabel(source) {
  return PROTOTYPE_STATUS_LABELS[prototypeSourceStatus(source)] || "草稿";
}

function createMockSourceFromFile(file, index = state.prototype.sources.length) {
  const safeIndex = Number.isFinite(Number(index)) ? Number(index) : state.prototype.sources.length;
  const fileName = file?.name || `competitor-demo-${safeIndex + 1}.mp4`;
  const mimeType = file?.type || "video/mp4";
  const kind = String(mimeType).startsWith("image/") ? "image" : "video";
  const sourceId = `prototype_source_${safeIndex + 1}`;
  const regions = (file?.regions || []).map((region, regionIndex) => ({
    regionId: region.regionId || `mask_${regionIndex + 1}`,
    type: "bbox",
    label: region.label || `mask_${regionIndex + 1}`,
    capabilityKey: region.capabilityKey || "",
    bbox: normalizeBbox(region.bbox)
  }));
  return {
    sourceId,
    fileName,
    status: file?.status || "draft",
    reviewRequired: Boolean(file?.reviewRequired),
    selected: Boolean(file?.selected),
    capabilityKeys: Array.isArray(file?.capabilityKeys) ? [...file.capabilityKeys] : [],
    regions,
    previewUrl: file?.previewUrl || "",
    probe: {
      sourceId,
      fileName,
      kind,
      mimeType,
      status: file?.probe?.status || "pass",
      durationSec: Number(file?.durationSec || file?.probe?.durationSec || 15),
      width: Number(file?.width || file?.probe?.width || 720),
      height: Number(file?.height || file?.probe?.height || 1280),
      ratio: file?.ratio || file?.probe?.ratio || "9:16"
    }
  };
}

function seedPrototypeSources() {
  const mockSources = [
    {
      name: "competitor-logo-watermark-demo.mp4",
      type: "video/mp4",
      durationSec: 18,
      capabilityKeys: ["logo_icon", "watermark", "cta"],
      selected: true,
      regions: [
        { regionId: "mask_1", label: "Logo/Icon", capabilityKey: "logo_icon", bbox: { x: 0.06, y: 0.05, width: 0.2, height: 0.1 } },
        { regionId: "mask_2", label: "CTA", capabilityKey: "cta", bbox: { x: 0.18, y: 0.82, width: 0.64, height: 0.1 } }
      ]
    },
    {
      name: "competitor-product-name-demo.mp4",
      type: "video/mp4",
      durationSec: 22,
      capabilityKeys: ["product_name", "subtitle", "phone_ui"],
      reviewRequired: true,
      regions: [
        { regionId: "mask_1", label: "产品名", capabilityKey: "product_name", bbox: { x: 0.16, y: 0.16, width: 0.68, height: 0.08 } },
        { regionId: "mask_2", label: "手机界面", capabilityKey: "phone_ui", bbox: { x: 0.12, y: 0.28, width: 0.76, height: 0.42 } }
      ]
    },
    {
      name: "competitor-ending-demo.mp4",
      type: "video/mp4",
      durationSec: 12,
      capabilityKeys: ["ending", "watermark"],
      regions: [
        { regionId: "mask_1", label: "Ending", capabilityKey: "ending", bbox: { x: 0.1, y: 0.72, width: 0.8, height: 0.18 } }
      ]
    }
  ];
  state.prototype.sources = mockSources.map((item, index) => createMockSourceFromFile(item, index));
  state.prototype.selectedSourceIds = new Set(state.prototype.sources.filter((source) => source.selected).map((source) => source.sourceId));
  state.prototype.activeSourceId = state.prototype.sources[0]?.sourceId || "";
}

function activePrototypeSource() {
  if (!state.prototype.activeSourceId && state.prototype.sources[0]) {
    state.prototype.activeSourceId = state.prototype.sources[0].sourceId;
  }
  return state.prototype.sources.find((source) => source.sourceId === state.prototype.activeSourceId)
    || state.prototype.sources[0]
    || null;
}

function syncPrototypeActiveSourceToLegacyState() {
  if (!PROTOTYPE_MODE) return;
  const source = activePrototypeSource();
  if (!source) {
    state.source = null;
    state.regions = [];
    state.selectedRegionId = "";
    state.actualMediaCache = null;
    return;
  }
  state.source = {
    sourceId: source.sourceId,
    previewUrl: source.previewUrl,
    prototypeOnly: true,
    probe: { ...source.probe }
  };
  state.regions = source.regions.map((region, index) => ({
    regionId: region.regionId || `mask_${index + 1}`,
    type: "bbox",
    label: region.label || `mask_${index + 1}`,
    capabilityKey: region.capabilityKey || "",
    bbox: normalizeBbox(region.bbox)
  }));
  state.selectedRegionId = state.regions[0]?.regionId || "";
  state.actualMediaCache = null;
}

function activeRemixNotice(status) {
  if (status === "succeeded") return "该素材已完成改造，不可重复提交";
  if (status === "preview_required") return "处理已完成，请先完成预览确认或下载交付";
  return "处理中，请等待状态刷新后再继续操作";
}

function syncMetrics() {
  const activeRemix = isActiveRemixStatus(state.detail?.remix?.status);
  const submitLocked = isSourceSubmitLocked();
  const prototypeOnly = isPrototypeMirroredSource();
  const activePrototype = activePrototypeSource();
  const hasPrototypeRegions = Boolean(activePrototype?.regions?.length);
  const uploading = Boolean(els.uploadBtn?.dataset.originalText);
  const fileReady = Boolean(els.sourceFile?.files?.[0]);
  const unavailable = state.initFailed;
  const prototypeSourceCount = state.prototype.sources.length;
  const prototypeRegionCount = state.prototype.sources.reduce((sum, source) => sum + (source.regions?.length || 0), 0);
  const prototypeOutputCount = state.prototype.outputs.length;
  els.sourceCount.textContent = prototypeSourceCount || (state.source ? "1" : "0");
  els.regionCount.textContent = prototypeRegionCount || state.regions.length;
  els.outputCount.textContent = prototypeOutputCount || state.detail?.remix?.outputs?.length || state.gallery?.counts?.total || 0;
  els.downloadCount.textContent = prototypeOutputCount || state.detail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
  els.maskConfirmBtn.disabled = unavailable || state.submitBlocked || submitLocked || !state.source || !state.regions.length;
  if (prototypeOnly) els.maskConfirmBtn.disabled = true;
  els.uploadBtn.disabled = unavailable || activeRemix;
  if (uploading) els.uploadBtn.disabled = true;
  els.sourceFile.disabled = unavailable || activeRemix || uploading;
  els.sourceUploadPanel?.classList.toggle("has-file", fileReady || Boolean(state.source));
  els.sourceUploadPanel?.classList.toggle("is-uploading", uploading);
  els.sourceUploadPanel?.classList.toggle("has-upload", Boolean(state.source));
  if (els.sourceUploadStatus && !uploading) {
    els.sourceUploadStatus.textContent = state.source
      ? `已上传 ${state.source.probe?.fileName || "源素材"}，可在下一步框选区域。`
      : fileReady
        ? `已选择 ${els.sourceFile.files[0]?.name || "源素材"}，正在准备上传。`
        : "选中文件后会自动上传、校验并生成可框选预览。";
  }
  els.clearMaskBtn.disabled = unavailable || activeRemix;
  els.operationType.disabled = unavailable || activeRemix;
  els.stopBtn.hidden = !activeRemix;
  els.stopBtn.disabled = unavailable || !activeRemix;
  els.maskEditor?.setAttribute("aria-busy", activeRemix ? "true" : "false");
  if (els.prototypeApplyRegionsBtn) {
    els.prototypeApplyRegionsBtn.disabled = unavailable || !hasPrototypeRegions || state.prototype.selectedSourceIds.size <= 1;
  }
  if (els.prototypeConfirmReviewBtn) {
    els.prototypeConfirmReviewBtn.disabled = unavailable || !activePrototype?.reviewRequired;
  }
  if (els.prototypeGenerateTasksBtn) {
    els.prototypeGenerateTasksBtn.disabled = unavailable || !hasPrototypeRegions || activePrototype?.reviewRequired || activePrototype?.rejected;
  }
  syncFlowHints();
}

function syncFlowHints() {
  const activeRemix = isActiveRemixStatus(state.detail?.remix?.status);
  const submitLocked = isSourceSubmitLocked();
  const fileReady = Boolean(els.sourceFile?.files?.[0]);
  const unavailable = state.initFailed;
  syncActionHint(
    els.uploadBtn,
    unavailable
      ? "页面初始化失败，请修复 MySQL 连接后刷新"
      : activeRemix
      ? "当前有改造任务处理中，请等待完成"
      : !fileReady && !state.source
        ? "点击选择需要改造的视频或图片，选择后自动上传"
        : fileReady && !state.source
          ? "已选择文件，正在等待自动上传"
          : "",
    { tone: activeRemix ? "warn" : "muted" }
  );
  syncActionHint(
    els.maskConfirmBtn,
    unavailable
      ? "页面初始化失败，暂不可提交改造任务"
      : submitLocked
      ? "当前素材已有任务或已完成改造，暂不可重复提交"
      : !state.source
        ? "需先上传源素材"
        : !state.regions.length
          ? "请在 Mask 编辑窗口框选至少一个区域"
          : state.submitBlocked
            ? "当前能力不可用，请检查改造类型"
            : "确认后将提交视频处理平台任务",
    { tone: unavailable || submitLocked || state.submitBlocked ? "warn" : "muted" }
  );
  const remix = state.detail?.remix;
  const output = remix?.outputs?.[0];
  syncActionHint(
    els.confirmBtn,
    !remix
      ? "需先提交 Mask 改造任务"
      : remix.status !== "preview_required"
        ? "等待处理完成并进入预览确认"
        : !output
          ? "暂无可预览输出"
          : "确认预览通过后可下载交付包",
    { tone: "muted" }
  );
}

function remixProgressSection(remix) {
  if (!remix || terminalRemixStatus(remix.status)) return "";
  const tasks = Array.isArray(remix.tasks) ? remix.tasks : [];
  const terminalTaskStatuses = new Set(["succeeded", "failed", "skipped", "stopped"]);
  const done = tasks.filter((task) => terminalTaskStatuses.has(task.status)).length;
  const total = tasks.length;
  return taskProgressHtml({
    label: remixStatusLabels[remix.status] || remix.status,
    detail: total ? `${done}/${total} 个子任务` : `远端状态：${remix.providerJob?.status || "等待中"}`,
    percent: total ? Math.round((done / total) * 100) : null,
    indeterminate: !total && isActiveRemixStatus(remix.status)
  });
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
    capabilityKey: region.capabilityKey || "",
    bbox: normalizeBbox(region.bbox)
  }));
}

function clonePrototypeRegions(regions = []) {
  return regions.map((region, index) => ({
    regionId: region.regionId || `mask_${index + 1}`,
    type: region.type || "bbox",
    label: region.label || `mask_${index + 1}`,
    capabilityKey: region.capabilityKey || "",
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

function clearSourceObjectUrl() {
  if (!sourceObjectUrl) return;
  URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = "";
}

function selectedSourcePreviewUrl() {
  const file = els.sourceFile?.files?.[0];
  if (!file) return "";
  clearSourceObjectUrl();
  sourceObjectUrl = URL.createObjectURL(file);
  return sourceObjectUrl;
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

function renderSelectedSource(file) {
  if (!file) {
    renderSource();
    return;
  }
  const isVideo = String(file.type || "").startsWith("video/");
  const previewUrl = selectedSourcePreviewUrl();
  els.sourceBox.className = "wz-list";
  els.sourceBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <small>待上传 · ${escapeHtml(isVideo ? "video" : "image")} · ${escapeHtml(Math.max(1, Math.round(file.size / 1024 / 1024)))} MB</small>
      </div>
      ${badge("checking", { checking: "准备上传" })}
    </article>
    ${previewUrl ? `
      <div class="remix-source-preview" data-source-preview="${isVideo ? "video" : "image"}">
        ${isVideo
          ? `<video src="${escapeHtml(previewUrl)}" controls preload="metadata" playsinline></video>`
          : `<img src="${escapeHtml(previewUrl)}" alt="源素材本地预览" />`}
      </div>
    ` : ""}
  `;
  syncMetrics();
}

function renderSource() {
  if (!state.source) {
    if (!els.sourceFile?.files?.[0]) clearSourceObjectUrl();
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

function prototypeTaskCountsForSource(sourceId) {
  const tasks = state.prototype.tasks.filter((task) => task.sourceId === sourceId);
  return {
    total: tasks.length,
    draft: tasks.filter((task) => task.status === "draft").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    review_required: tasks.filter((task) => task.status === "review_required").length,
    succeeded: tasks.filter((task) => task.status === "succeeded").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    stopped: tasks.filter((task) => task.status === "stopped").length
  };
}

function renderPrototypeSources() {
  if (!els.prototypeSourceList) return;
  const reviewOnly = Boolean(els.prototypeReviewOnly?.checked || state.prototype.reviewOnly);
  state.prototype.reviewOnly = reviewOnly;
  const sources = reviewOnly
    ? state.prototype.sources.filter((source) => prototypeSourceStatus(source) === "review_required")
    : state.prototype.sources;
  if (!sources.length) {
    els.prototypeSourceList.className = "wz-list empty-line";
    els.prototypeSourceList.textContent = "暂无批量素材";
    return;
  }
  els.prototypeSourceList.className = "wz-list";
  els.prototypeSourceList.innerHTML = sources.map((source) => {
    const active = source.sourceId === state.prototype.activeSourceId ? " active" : "";
    const selected = state.prototype.selectedSourceIds.has(source.sourceId);
    const counts = prototypeTaskCountsForSource(source.sourceId);
    const capabilityLabels = source.capabilityKeys
      .map((key) => PROTOTYPE_CAPABILITIES[key]?.label || key)
      .filter(Boolean)
      .join("、") || "待识别";
    return `
      <article class="wz-row remix-prototype-source-card${active}" data-prototype-source-id="${escapeHtml(source.sourceId)}">
        <label>
          <input type="checkbox" data-prototype-source-select="${escapeHtml(source.sourceId)}" ${selected ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(source.fileName)}</strong>
            <small>${escapeHtml(source.probe.kind)} · ${escapeHtml(source.probe.durationSec)}s · ${escapeHtml(capabilityLabels)} · ${escapeHtml(counts.total)} 个任务</small>
          </span>
        </label>
        ${badge(prototypeSourceStatus(source), PROTOTYPE_STATUS_LABELS)}
        <button type="button" class="ghost" data-prototype-source-open="${escapeHtml(source.sourceId)}">编辑</button>
      </article>
    `;
  }).join("");
}

function capabilityKeysForRegions(regions = []) {
  return [...new Set(regions
    .map((region) => region.capabilityKey)
    .filter((key) => key && PROTOTYPE_CAPABILITIES[key]))];
}

function persistPrototypeSourceRegions(source, regions, { reviewRequired = source?.reviewRequired } = {}) {
  if (!source) return null;
  const nextRegions = clonePrototypeRegions(regions);
  source.regions = nextRegions;
  source.capabilityKeys = capabilityKeysForRegions(nextRegions);
  source.reviewRequired = Boolean(reviewRequired);
  return source;
}

function renderPrototypeCapabilityPlan() {
  if (!els.prototypeCapabilityPlan) return;
  const source = activePrototypeSource();
  const regions = source?.regions || [];
  const capabilityKeys = capabilityKeysForRegions(regions);
  if (!source || !capabilityKeys.length) {
    els.prototypeCapabilityPlan.className = "remix-prototype-capability-grid empty-line";
    els.prototypeCapabilityPlan.textContent = "请选择素材后配置能力";
    return;
  }
  els.prototypeCapabilityPlan.className = "remix-prototype-capability-grid";
  els.prototypeCapabilityPlan.innerHTML = capabilityKeys.map((key) => {
    const capability = PROTOTYPE_CAPABILITIES[key];
    const count = regions.filter((region) => region.capabilityKey === key).length;
    return `
      <article class="wz-row">
        <div>
          <strong>${escapeHtml(capability.label)}</strong>
          <small>${escapeHtml(capability.detail)} · ${escapeHtml(capability.jobType)} · ${escapeHtml(count)} 个区域</small>
        </div>
        ${badge(key, { [key]: "已配置" })}
      </article>
    `;
  }).join("");
}

function copyRegionsToSelectedPrototypeSources() {
  const activeSource = activePrototypeSource();
  if (!activeSource?.regions?.length) return;
  const sourceRegions = clonePrototypeRegions(activeSource.regions);
  state.prototype.sources = state.prototype.sources.map((source) => {
    if (source.sourceId === activeSource.sourceId) return source;
    if (!state.prototype.selectedSourceIds.has(source.sourceId) || source.rejected) return source;
    return persistPrototypeSourceRegions({ ...source }, sourceRegions, { reviewRequired: true });
  });
  renderPrototypeAll();
  showToast("当前区域已复制到选中素材，请逐条复核", { type: "success" });
}

function confirmPrototypeSourceReview() {
  const activeSource = activePrototypeSource();
  if (!activeSource) return;
  activeSource.reviewRequired = false;
  renderPrototypeAll();
  showToast("当前素材复核已确认", { type: "success" });
}

function prototypeTaskIsTerminal(task) {
  return ["succeeded", "failed", "stopped"].includes(task?.status);
}

function prototypeTaskLog(task, message) {
  task.log = Array.isArray(task.log) ? [...task.log, message] : [message];
}

function generatePrototypeDraftTasks() {
  const source = activePrototypeSource();
  if (!source || source.rejected || source.reviewRequired || !source.regions?.length) return;
  const existing = new Set(state.prototype.tasks.map((task) => `${task.sourceId}:${task.capabilityKey}`));
  const capabilityKeys = capabilityKeysForRegions(source.regions);
  for (const capabilityKey of capabilityKeys) {
    if (existing.has(`${source.sourceId}:${capabilityKey}`)) continue;
    const capability = PROTOTYPE_CAPABILITIES[capabilityKey];
    state.prototype.tasks.push({
      taskId: `prototype_task_${state.prototype.tasks.length + 1}`,
      sourceId: source.sourceId,
      sourceName: source.fileName,
      capabilityKey,
      jobType: capability.jobType,
      status: "draft",
      failureReason: "",
      log: [`已生成 ${capability.label} 草稿任务`]
    });
    existing.add(`${source.sourceId}:${capabilityKey}`);
  }
  renderPrototypeAll();
}

function nextPrototypeTaskStatus(task) {
  if (!task) return "";
  if (task.status === "draft") return "queued";
  if (task.status === "queued") return "running";
  if (task.status === "running") return task.capabilityKey === "phone_ui" ? "failed" : "review_required";
  if (task.status === "review_required") return "succeeded";
  return task.status;
}

function prototypeOutputForTask(task) {
  const capability = PROTOTYPE_CAPABILITIES[task.capabilityKey] || {};
  return {
    outputId: `prototype_output_${task.taskId}`,
    taskId: task.taskId,
    sourceId: task.sourceId,
    sourceName: task.sourceName,
    kind: capability.label || task.jobType,
    qcStatus: "pass"
  };
}

function appendPrototypeOutputForTask(task) {
  const outputId = `prototype_output_${task.taskId}`;
  if (state.prototype.outputs.some((output) => output.outputId === outputId)) return;
  state.prototype.outputs.push(prototypeOutputForTask(task));
}

function advancePrototypeTask(taskId = "") {
  const tasks = taskId
    ? state.prototype.tasks.filter((task) => task.taskId === taskId)
    : state.prototype.tasks.filter((task) => !prototypeTaskIsTerminal(task));
  for (const task of tasks) {
    if (prototypeTaskIsTerminal(task)) continue;
    const nextStatus = nextPrototypeTaskStatus(task);
    if (nextStatus === task.status) continue;
    task.status = nextStatus;
    if (nextStatus === "failed" && task.capabilityKey === "phone_ui") {
      task.failureReason = "手机界面区域需要人工复核";
      prototypeTaskLog(task, task.failureReason);
    } else if (nextStatus === "succeeded") {
      task.failureReason = "";
      appendPrototypeOutputForTask(task);
      prototypeTaskLog(task, "mock 输出已生成");
    } else {
      prototypeTaskLog(task, `状态更新为 ${PROTOTYPE_STATUS_LABELS[nextStatus] || nextStatus}`);
    }
  }
  renderPrototypeAll();
}

function stopPrototypeTask(taskId) {
  const task = state.prototype.tasks.find((item) => item.taskId === taskId);
  if (!task || prototypeTaskIsTerminal(task)) return;
  task.status = "stopped";
  prototypeTaskLog(task, "任务已停止");
  renderPrototypeAll();
}

function retryPrototypeTask(taskId) {
  const task = state.prototype.tasks.find((item) => item.taskId === taskId);
  if (!task || task.status !== "failed") return;
  task.status = "queued";
  task.failureReason = "";
  prototypeTaskLog(task, "失败任务已重新排队");
  renderPrototypeAll();
}

function renderPrototypeTaskQueue() {
  if (!els.prototypeTaskQueue) return;
  const tasks = state.prototype.tasks;
  const draftTasks = tasks.filter((task) => task.status === "draft");
  const nonterminalTasks = tasks.filter((task) => !prototypeTaskIsTerminal(task));
  if (els.prototypeSubmitTasksBtn) {
    els.prototypeSubmitTasksBtn.disabled = state.initFailed || !draftTasks.length;
  }
  if (els.prototypeAdvanceTasksBtn) {
    els.prototypeAdvanceTasksBtn.disabled = state.initFailed || !nonterminalTasks.length;
  }
  if (!tasks.length) {
    els.prototypeTaskQueue.className = "wz-list empty-line";
    els.prototypeTaskQueue.textContent = "暂无异步任务，先配置区域并生成草稿任务";
    return;
  }
  els.prototypeTaskQueue.className = "wz-list";
  els.prototypeTaskQueue.innerHTML = tasks.map((task) => {
    const terminal = prototypeTaskIsTerminal(task);
    return `
      <article class="remix-prototype-task ${escapeHtml(task.status)}">
        <div>
          <strong>${escapeHtml(task.taskId)}</strong>
          <small>${escapeHtml(task.sourceName)} · ${escapeHtml(task.jobType)}</small>
          ${task.failureReason ? `<p>${escapeHtml(task.failureReason)}</p>` : ""}
        </div>
        ${badge(task.status, PROTOTYPE_STATUS_LABELS)}
        <div class="wz-row-actions">
          <button type="button" class="ghost" data-prototype-task-advance="${escapeHtml(task.taskId)}" ${terminal ? "disabled" : ""}>推进</button>
          <button type="button" class="ghost" data-prototype-task-retry="${escapeHtml(task.taskId)}" ${task.status === "failed" ? "" : "disabled"}>重试</button>
          <button type="button" class="ghost" data-prototype-task-stop="${escapeHtml(task.taskId)}" ${terminal ? "disabled" : ""}>停止</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderPrototypeGallery() {
  if (!els.prototypeGallery) return;
  const outputs = state.prototype.outputs;
  if (!outputs.length) {
    els.prototypeGallery.className = "wz-list empty-line";
    els.prototypeGallery.textContent = "暂无 mock 输出";
    return;
  }
  els.prototypeGallery.className = "wz-list";
  els.prototypeGallery.innerHTML = outputs.map((output) => `
    <article class="remix-prototype-output">
      <div>
        <strong>${escapeHtml(output.outputId)}</strong>
        <small>${escapeHtml(output.sourceName)} · ${escapeHtml(output.kind)}</small>
      </div>
      ${badge(output.qcStatus, { pass: "QC 通过", manual_required: "需人工确认", fail: "QC 失败" })}
      <div class="wz-row-actions">
        <button type="button" class="ghost">预览占位</button>
        <button type="button" class="ghost">下载占位</button>
      </div>
    </article>
  `).join("");
}

function renderPrototypeAll() {
  syncPrototypeActiveSourceToLegacyState();
  renderSource();
  renderPrototypeSources();
  renderPrototypeCapabilityPlan();
  if (typeof renderPrototypeTaskQueue === "function") renderPrototypeTaskQueue();
  if (typeof renderPrototypeGallery === "function") renderPrototypeGallery();
  syncMetrics();
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
  const source = isPrototypeMirroredSource() ? activePrototypeSource() : null;
  if (source) {
    persistPrototypeSourceRegions(source, state.regions, { reviewRequired: false });
  }
  renderMaskEditor();
  renderPrototypeSources();
  renderPrototypeCapabilityPlan();
  syncMetrics();
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
      const source = isPrototypeMirroredSource() ? activePrototypeSource() : null;
      if (source) {
        persistPrototypeSourceRegions(source, state.regions, { reviewRequired: false });
      }
      state.selectedRegionId = selectedBboxRegion()?.regionId || "";
      renderMaskEditor();
      renderPrototypeSources();
      renderPrototypeCapabilityPlan();
      syncMetrics();
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
    syncFlowHints();
    return;
  }
  els.statusBadge.innerHTML = badge(remix.status, remixStatusLabels);
  const active = isActiveRemixStatus(remix.status);
  const submitLocked = isSourceSubmitLocked();
  const output = remix.outputs?.[0];
  els.confirmBtn.disabled = remix.status !== "preview_required" || !output;
  els.downloadBtn.disabled = !state.detail.downloadSummary?.packageReady;
  const retryActions = remix.status === "failed"
    ? [{ id: "retry-mask", label: "重新提交改造" }]
    : remix.status === "partial_failed"
      ? [{ id: "retry-mask", label: "重新提交改造" }]
      : [];
  els.detailBox.className = "wz-list";
  els.detailBox.innerHTML = `
    ${remixProgressSection(remix)}
    ${inlineRetryHtml({
      message: remix.status === "failed"
        ? "改造失败，可调整区域后重新提交"
        : remix.status === "partial_failed"
          ? "部分输出失败，可重新提交改造"
          : "",
      actions: retryActions
    })}
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
    ${active || submitLocked ? `<div class="wz-warning">${escapeHtml(activeRemixNotice(remix.status))}</div>` : ""}
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
  if (els.sourceUploadStatus) {
    els.sourceUploadStatus.textContent = "正在上传并检查素材，请稍等。";
  }
  syncMetrics();
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
    clearSourceObjectUrl();
    renderSource();
    showToast("源素材上传成功，请框选改造区域", { type: "success" });
  } catch (error) {
    if (error.code === "unauthenticated") showLogin(els.loginModal);
    if (els.sourceUploadStatus) {
      els.sourceUploadStatus.textContent = "上传或检查失败，请重新选择源素材。";
    }
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
  if (isPrototypeMirroredSource()) {
    renderError(els.globalError, {
      code: "prototype_source_submit_blocked",
      message: "当前是原型演示素材，暂不可提交真实后端任务"
    }, "改造启动失败");
    showToast("原型演示素材不会提交真实任务", { type: "warn" });
    syncMetrics();
    return;
  }
  if (isSourceSubmitLocked()) {
    renderError(els.globalError, {
      code: "remix_source_locked",
      message: state.detail?.remix?.status === "succeeded"
        ? "该素材已完成改造，不可重复提交"
        : "当前素材已有改造任务处理中，请等待状态刷新后再继续操作"
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
    renderDetail();
    startPolling();
    showToast("改造任务已提交，正在后台处理", { type: "success" });
  } catch (error) {
    if (error.code === "unsupported_capability") {
      state.submitBlocked = true;
    }
    showActiveLockFromError(lockHost(), error);
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
      const previousStatus = state.detail?.remix?.status;
      const detail = await loadRemixDetail();
      await loadGallery();
      const remix = detail?.remix;
      if (!remix || terminalRemixStatus(remix.status)) {
        if (remix && remix.status !== previousStatus) {
          if (remix.status === "preview_required") {
            showToast("改造完成，请预览并确认", { type: "success" });
          } else if (remix.status === "failed" || remix.status === "partial_failed") {
            showToast("改造未完全成功，可查看详情并重试", { type: "error" });
          }
        }
        return;
      }
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
    showToast("预览已确认，可下载交付包", { type: "success" });
  } catch (error) {
    renderError(els.globalError, error, "预览确认失败");
  } finally {
    setBusy(els.confirmBtn, false);
  }
}

async function loadGallery(options = {}) {
  const requestedPage = Number(options.page || state.galleryPage || 1);
  state.galleryPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const query = new URLSearchParams({
    page: String(state.galleryPage),
    pageSize: String(state.galleryPageSize),
    sourceType: "remix"
  });
  const params = `?${query}`;
  state.gallery = await apiEnvelope(`/api/wangzhuan/gallery${params}`);
  state.galleryPage = state.gallery?.pagination?.page || state.galleryPage;
  renderGallery();
}

async function loadActiveRemix() {
  const detail = await apiEnvelope("/api/wangzhuan/remix/active");
  if (!detail?.remix) return null;
  state.detail = detail;
  state.source = detail.remix.source
    ? { sourceId: detail.remix.source.sourceId, probe: detail.remix.source, previewUrl: detail.remix.source.storageUrl || "" }
    : null;
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
  els.uploadBtn.addEventListener("click", () => {
    if (isActiveRemixStatus(state.detail?.remix?.status)) return;
    els.sourceFile.value = "";
    els.sourceFile.click();
  });
  els.sourceFile.addEventListener("change", () => {
    if (isActiveRemixStatus(state.detail?.remix?.status)) return;
    clearError(els.globalError);
    state.source = null;
    state.regions = [];
    state.selectedRegionId = "";
    state.actualMediaCache = null;
    const file = els.sourceFile.files?.[0];
    if (!file) {
      clearSourceObjectUrl();
      renderSource();
      return;
    }
    renderSelectedSource(file);
    uploadSource();
  });
  els.clearMaskBtn.addEventListener("click", () => {
    if (isActiveRemixStatus(state.detail?.remix?.status)) return;
    state.regions = [];
    state.selectedRegionId = "";
    const source = isPrototypeMirroredSource() ? activePrototypeSource() : null;
    if (source) {
      persistPrototypeSourceRegions(source, [], { reviewRequired: false });
    }
    renderMaskEditor();
    renderPrototypeSources();
    renderPrototypeCapabilityPlan();
    syncMetrics();
  });
  els.maskConfirmBtn.addEventListener("click", startMaskEdit);
  els.detailBox?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-inline-retry]");
    if (!btn) return;
    if (btn.dataset.inlineRetry === "retry-mask") window.wzFocusNode?.("remixNodeMask");
  });
  els.confirmBtn.addEventListener("click", confirmPreview);
  els.stopBtn.addEventListener("click", stopRemix);
  els.downloadBtn.addEventListener("click", downloadRemixPackage);
  els.refreshGalleryBtn.addEventListener("click", () => loadGallery().catch((error) => renderError(els.globalError, error, "图库刷新失败")));
  els.prototypeSeedBtn?.addEventListener("click", () => {
    seedPrototypeSources();
    renderPrototypeAll();
    showToast("示例素材已载入", { type: "success" });
  });
  els.prototypeReviewOnly?.addEventListener("change", () => {
    renderPrototypeSources();
    syncMetrics();
  });
  els.prototypeSourceList?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const selector = event.target.closest("[data-prototype-source-select]");
    if (selector) {
      const sourceId = selector.dataset.prototypeSourceSelect;
      if (selector.checked) state.prototype.selectedSourceIds.add(sourceId);
      else state.prototype.selectedSourceIds.delete(sourceId);
      syncMetrics();
      return;
    }
    const opener = event.target.closest("[data-prototype-source-open], [data-prototype-source-id]");
    const sourceId = opener?.dataset.prototypeSourceOpen || opener?.dataset.prototypeSourceId;
    if (!sourceId) return;
    state.prototype.activeSourceId = sourceId;
    renderPrototypeAll();
  });
  els.prototypeApplyRegionsBtn?.addEventListener("click", copyRegionsToSelectedPrototypeSources);
  els.prototypeConfirmReviewBtn?.addEventListener("click", confirmPrototypeSourceReview);
  els.galleryBox.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-gallery-page]");
    if (!button || button.disabled) return;
    loadGallery({ page: Number(button.dataset.galleryPage) })
      .catch((error) => renderError(els.globalError, error, "图库刷新失败"));
  });
}

async function loadInitialData() {
  clearError(els.globalError);
  clearActiveLockBanner(lockHost());
  state.initFailed = false;
  resetWorkshopState();
  await loadActiveRemix();
  await loadGallery();
}

function handleInitialDataError(error, title) {
  state.initFailed = true;
  renderError(els.globalError, error, title);
  syncMetrics();
}

function bindPageLifecycle() {
  window.addEventListener("pageshow", () => {
    if (!state.user) return;
    if (!hasHandledInitialPageShow) {
      hasHandledInitialPageShow = true;
      return;
    }
    loadInitialData().catch((error) => {
      handleInitialDataError(error, "页面刷新失败");
    });
  });
}

async function init() {
  resetBrowserRestoredInputs();
  renderMaskEditor();
  bindMaskEditor();
  bindEvents();
  bindPageLifecycle();
  await bindLogin({
    modal: els.loginModal,
    badge: els.badge,
    logoutBtn: els.logoutBtn,
    onAuthed: (user) => {
      state.user = user;
      loadInitialData().catch((error) => {
        handleInitialDataError(error, "页面初始化失败");
      });
    }
  });
}

init();
