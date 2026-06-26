import {
  $,
  apiEnvelope,
  bindLogin,
  dataUrlFromFile,
  escapeHtml,
  renderKeyValues,
  setBusy,
  showLogin,
  showToast,
  taskSpaceHref
} from "./wangzhuan-common.js";

const POLL_INTERVAL_MS = 3000;
const MAX_UPLOAD_VIDEO_BYTES = 314572800;
const TERMINAL_STATUSES = new Set(["succeeded", "review_required", "failed", "canceled"]);
const RUNNING_STATUSES = new Set(["pending", "queued", "running"]);

const TASKS = [
  ["seedance_ai_remove", "seedance_ai_remove", "一键去标识", "无需 mask，提交后由 Seedance 专区模型去除可见 logo、icon、水印和品牌露出。", "video", "seedance_ai_remove", "none"],
  ["ai_remove_auto", "ai_remove", "自动去除", "无需用户画 mask，调用 ai_remove 的自动检测移除链路。", "video", "ai_remove_auto", "none"],
  ["auto_ai_remove", "auto_ai_remove", "K 帧点选/框选去除", "在指定帧上点选或框选对象，作为 interaction_prompt 传给 SAM2 传播整段视频 mask。", "video", "auto_ai_remove", "interactive"],
  ["ai_remove_manual", "ai_remove", "手动 mask 去除", "上传 mask 图片并填写时间段，提交 ai_remove mode=manual。", "video", "ai_remove_manual", "manual"],
  ["mask_edit", "mask_edit", "区域遮挡/模糊", "框选画面区域，做遮挡、模糊或填色处理，不做语义替换。", "video", "mask_edit", "region"],
  ["sticker_blur", "sticker_blur", "贴纸/水印模糊", "复用 MaskParams，对局部贴纸或水印区域执行模糊处理。", "video", "mask_edit", "region"],
  ["end_trim_detection", "end_trim_detection", "尾段检测", "自动检测 ending 或导流尾段，可配置检测秒数、关键词和阈值。", "video", "end_trim_detection", "none"],
  ["video_copy_translate", "video_copy_translate", "字幕翻译回写", "按文档能力做字幕翻译和回写，不承诺局部营销文案替换。", "video", "video_copy_translate", "none"],
  ["language_rewrite", "language_rewrite", "语言改写", "只暴露目标语言改写能力，不包装成品牌名局部替换。", "video", "language_rewrite", "none"],
  ["material_analysis", "material_analysis", "素材分析", "输入 report_text 做素材表现分析，不处理视频文件。", "report_text", "material_analysis", "none"]
].map(([id, jobType, title, detail, input, paramGroup, maskMode]) => ({ id, jobType, title, detail, input, paramGroup, maskMode }));

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));

const els = {
  badge: $("#remixCurrentUserBadge"),
  logoutBtn: $("#remixLogoutBtn"),
  loginModal: $("#remixLoginModal"),
  taskGrid: $("#videoOpsTaskGrid"),
  selectedTitle: $("#videoOpsSelectedTitle"),
  selectedJobType: $("#videoOpsSelectedJobType"),
  taskTypeMetric: $("#remixTaskTypeMetric"),
  jobStatusMetric: $("#remixJobStatusMetric"),
  queueMetric: $("#remixQueueMetric"),
  outputMetric: $("#remixOutputMetric"),
  mediaInput: $("#videoOpsMediaInput"),
  reportInput: $("#videoOpsReportInput"),
  inputModeLabel: $("#videoOpsInputModeLabel"),
  sourceModeRadios: [...document.querySelectorAll('input[name="videoOpsSourceMode"]')],
  urlWrap: $("#videoOpsUrlWrap"),
  fileWrap: $("#videoOpsFileWrap"),
  sourceUrl: $("#videoOpsSourceUrl"),
  sourceFile: $("#videoOpsSourceFile"),
  fileStatus: $("#videoOpsFileStatus"),
  reportText: $("#videoOpsReportText"),
  video: $("#videoOpsVideo"),
  regionVideo: $("#videoOpsRegionVideo"),
  paramHint: $("#videoOpsParamHint"),
  paramGroups: [...document.querySelectorAll(".video-ops-param-group")],
  seedancePrompt: $("#seedancePrompt"),
  seedanceRatio: $("#seedanceRatio"),
  seedanceResolution: $("#seedanceResolution"),
  seedanceSegmentSeconds: $("#seedanceSegmentSeconds"),
  autoRemoveMaskThreshold: $("#autoRemoveMaskThreshold"),
  frameCanvas: $("#videoOpsFrameCanvas"),
  promptLayer: $("#videoOpsPromptLayer"),
  interactiveFrameIndex: $("#interactiveFrameIndex"),
  interactiveFrameTime: $("#interactiveFrameTime"),
  interactivePromptType: $("#interactivePromptType"),
  interactivePointLabel: $("#interactivePointLabel"),
  interactiveFrameSlider: $("#interactiveFrameSlider"),
  captureCurrentFrameBtn: $("#captureCurrentFrameBtn"),
  clearPromptBtn: $("#clearPromptBtn"),
  interactiveFramePreview: $("#interactiveFramePreview"),
  interactiveFramePreviewMeta: $("#interactiveFramePreviewMeta"),
  interactiveFramePreviewImage: $("#interactiveFramePreviewImage"),
  interactiveFramePreviewEmpty: $("#interactiveFramePreviewEmpty"),
  interactiveSampleFps: $("#interactiveSampleFps"),
  interactiveMaxFrames: $("#interactiveMaxFrames"),
  interactiveRemovalEngine: $("#interactiveRemovalEngine"),
  interactiveMaskThreshold: $("#interactiveMaskThreshold"),
  interactivePromptSummary: $("#interactivePromptSummary"),
  manualMaskFile: $("#manualMaskFile"),
  manualMaskStatus: $("#manualMaskStatus"),
  manualStartMs: $("#manualStartMs"),
  manualEndMs: $("#manualEndMs"),
  manualMaskThreshold: $("#manualMaskThreshold"),
  regionOverlay: $("#videoOpsRegionOverlay"),
  useCurrentRegionFrameBtn: $("#useCurrentRegionFrameBtn"),
  clearRegionBtn: $("#clearRegionBtn"),
  regionSummary: $("#regionSummary"),
  maskBlurSigma: $("#maskBlurSigma"),
  maskThreshold: $("#maskThreshold"),
  maskFillColor: $("#maskFillColor"),
  maskFillOpacity: $("#maskFillOpacity"),
  tailDetectSeconds: $("#tailDetectSeconds"),
  reviewThreshold: $("#reviewThreshold"),
  trimMode: $("#trimMode"),
  safeTrimMarginMs: $("#safeTrimMarginMs"),
  competitorKeywords: $("#competitorKeywords"),
  allowReencode: $("#allowReencode"),
  copyTargetLanguage: $("#copyTargetLanguage"),
  copySourceMode: $("#copySourceMode"),
  copyRenderMode: $("#copyRenderMode"),
  copySubtitleRoiMode: $("#copySubtitleRoiMode"),
  copySubtitleRemovalMode: $("#copySubtitleRemovalMode"),
  rewriteTargetLanguage: $("#rewriteTargetLanguage"),
  materialUseLlm: $("#materialUseLlm"),
  priority: $("#videoOpsPriority"),
  payloadPreview: $("#videoOpsPayloadPreview"),
  formError: $("#videoOpsFormError"),
  submitBtn: $("#videoOpsSubmitBtn"),
  resetBtn: $("#videoOpsResetBtn"),
  statusBadge: $("#videoOpsStatusBadge"),
  jobSummary: $("#videoOpsJobSummary"),
  refreshBtn: $("#videoOpsRefreshBtn"),
  resultBtn: $("#videoOpsResultBtn"),
  downloadBtn: $("#videoOpsDownloadBtn"),
  cancelBtn: $("#videoOpsCancelBtn"),
  retryBtn: $("#videoOpsRetryBtn"),
  taskDetailLink: $("#videoOpsTaskDetailLink"),
  resultBox: $("#videoOpsResultBox")
};

const state = {
  user: null,
  selectedTaskId: "seedance_ai_remove",
  sourceMode: "url",
  fileDataUrl: "",
  fileObjectUrl: "",
  manualMaskDataUrl: "",
  selectedFramePreviewDataUrl: "",
  job: null,
  result: null,
  pollTimer: 0,
  submitting: false,
  loadingJob: false,
  prompt: { points: [], box: null, drag: null },
  region: { box: null, drag: null }
};

function selectedTask() {
  return TASK_BY_ID.get(state.selectedTaskId) || TASKS[0];
}

function numberValue(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function intValue(input, fallback = 0) {
  return Math.round(numberValue(input, fallback));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function formatUploadLimit(bytes = MAX_UPLOAD_VIDEO_BYTES) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function validateSubmitReady() {
  try {
    buildPayload();
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: error.message || "参数不完整" };
  }
}

function setFormError(message = "") {
  if (!els.formError) return;
  els.formError.hidden = !message;
  els.formError.textContent = message;
}

function queueLabel(job = {}) {
  const stats = job.queue_stats || job.providerJob?.queue_stats || {};
  return `${stats.waiting ?? "-"}/${stats.running ?? "-"}`;
}

function statusLabel(status = "") {
  return {
    pending: "等待中",
    queued: "排队中",
    running: "处理中",
    review_required: "待复核",
    succeeded: "已完成",
    failed: "失败",
    canceled: "已取消"
  }[status] || status || "未提交";
}

function renderTasks() {
  if (!els.taskGrid) return;
  els.taskGrid.innerHTML = TASKS.map((task) => {
    const maskLabel = task.maskMode === "none"
      ? "无需 mask"
      : task.maskMode === "interactive"
        ? "需要 K 帧点选/框选"
        : task.maskMode === "manual"
          ? "需要上传 mask"
          : "需要框选区域";
    const active = task.id === state.selectedTaskId ? " active" : "";
    return `
      <button type="button" class="video-ops-task-card ${task.maskMode}${active}" data-task-id="${escapeHtml(task.id)}">
        <span>${escapeHtml(task.jobType)}</span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(task.detail)}</small>
        <b>${escapeHtml(maskLabel)}</b>
      </button>
    `;
  }).join("");
}

function renderInputMode() {
  const task = selectedTask();
  const isReport = task.input === "report_text";
  if (els.mediaInput) els.mediaInput.hidden = isReport;
  if (els.reportInput) els.reportInput.hidden = !isReport;
  if (els.inputModeLabel) els.inputModeLabel.textContent = isReport ? "report_text" : "视频 URL 或上传文件";
  const fileMode = state.sourceMode === "file";
  if (els.urlWrap) els.urlWrap.hidden = fileMode;
  if (els.fileWrap) els.fileWrap.hidden = !fileMode;
  for (const radio of els.sourceModeRadios) radio.checked = radio.value === state.sourceMode;
}

function renderParamGroups() {
  const task = selectedTask();
  for (const group of els.paramGroups) group.hidden = group.dataset.paramFor !== task.paramGroup;
  const hint = task.maskMode === "none"
    ? "不需要用户处理 mask"
    : task.maskMode === "interactive"
      ? "需要在 K 帧上点选或框选对象"
      : task.maskMode === "manual"
        ? "需要上传 mask 并填写时间段"
        : "需要框选局部遮挡或模糊区域";
  if (els.paramHint) els.paramHint.textContent = hint;
}

function ensureInputNodeVisible({ center = false } = {}) {
  const node = document.getElementById("remixNodeInput");
  if (!node) return;
  if (typeof window.wzFocusNode === "function") {
    window.wzFocusNode(node, { center, collapseOthers: true });
    return;
  }
  node.classList.remove("collapsed");
}

function renderSelection() {
  const task = selectedTask();
  if (els.selectedTitle) els.selectedTitle.textContent = task.title;
  if (els.selectedJobType) els.selectedJobType.textContent = task.jobType;
  if (els.taskTypeMetric) els.taskTypeMetric.textContent = task.jobType;
  renderTasks();
  renderInputMode();
  renderParamGroups();
  syncVideoPreviews();
  renderPrompt();
  renderRegion();
  renderPayloadPreview();
  if (task.maskMode !== "none") ensureInputNodeVisible();
}

function sourceInputPayload() {
  const task = selectedTask();
  if (task.input === "report_text") {
    const source = String(els.reportText?.value || "").trim();
    if (!source) throw new Error("请先填写 report_text");
    return { source_type: "report_text", source };
  }
  if (state.sourceMode === "url") {
    const source = String(els.sourceUrl?.value || "").trim();
    if (!/^https?:\/\//i.test(source)) throw new Error("请填写 http(s) 视频 URL");
    return { source_type: "url", source };
  }
  if (!state.fileDataUrl) throw new Error("请先上传视频文件");
  return { source_type: "base64_data_url", source: state.fileDataUrl };
}

function buildRegionSpec() {
  if (!state.region.box) throw new Error("请在视频画面中框选需要遮挡或模糊的区域");
  return { type: "box", ...state.region.box, coordinate_space: "normalized" };
}

function buildInteractionPrompt() {
  const frameIndex = intValue(els.interactiveFrameIndex, 0);
  if ((els.interactivePromptType?.value || "box") === "point") {
    if (!state.prompt.points.length) throw new Error("Point Prompt 至少需要一个点");
    return {
      prompt_type: "point",
      frame_index: frameIndex,
      points: state.prompt.points.map((point) => ({
        x: point.x,
        y: point.y,
        label: point.label || "positive",
        coordinate_space: "normalized"
      }))
    };
  }
  if (!state.prompt.box) throw new Error("Box Prompt 需要先框选对象");
  return { prompt_type: "box", frame_index: frameIndex, box: { ...state.prompt.box, coordinate_space: "normalized" } };
}

function buildParams() {
  switch (state.selectedTaskId) {
    case "seedance_ai_remove":
      return {
        prompt: String(els.seedancePrompt?.value || "").trim(),
        ratio: els.seedanceRatio?.value || "auto",
        resolution: els.seedanceResolution?.value || "720p",
        segment_seconds: intValue(els.seedanceSegmentSeconds, 15)
      };
    case "ai_remove_auto":
      return { mode: "auto", mask_threshold: intValue(els.autoRemoveMaskThreshold, 1) };
    case "auto_ai_remove":
      return {
        sample_fps: numberValue(els.interactiveSampleFps, 1),
        max_frames: intValue(els.interactiveMaxFrames, 20),
        removal_engine: els.interactiveRemovalEngine?.value || "configured",
        mask_threshold: intValue(els.interactiveMaskThreshold, 1),
        interaction_prompt: buildInteractionPrompt()
      };
    case "ai_remove_manual":
      if (!state.manualMaskDataUrl) throw new Error("请上传 mask 图片");
      return {
        mode: "manual",
        mask_source: state.manualMaskDataUrl,
        time_ranges: [{ start_ms: intValue(els.manualStartMs, 0), end_ms: intValue(els.manualEndMs, 15000) }],
        mask_threshold: intValue(els.manualMaskThreshold, 1)
      };
    case "mask_edit":
    case "sticker_blur":
      return {
        region_spec: buildRegionSpec(),
        blur_sigma: intValue(els.maskBlurSigma, 40),
        mask_threshold: intValue(els.maskThreshold, 1),
        fill_color: els.maskFillColor?.value || "#000000",
        fill_opacity: numberValue(els.maskFillOpacity, 1)
      };
    case "end_trim_detection":
      return {
        tail_detect_seconds: intValue(els.tailDetectSeconds, 15),
        competitor_keywords: String(els.competitorKeywords?.value || "").split(/\n+/).map((item) => item.trim()).filter(Boolean),
        review_threshold: numberValue(els.reviewThreshold, 0.55),
        trim_mode: els.trimMode?.value || "fast",
        allow_reencode: Boolean(els.allowReencode?.checked),
        safe_trim_margin_ms: intValue(els.safeTrimMarginMs, 300)
      };
    case "video_copy_translate":
      return {
        target_language: String(els.copyTargetLanguage?.value || "en").trim() || "en",
        source_mode: String(els.copySourceMode?.value || "auto").trim() || "auto",
        render_mode: String(els.copyRenderMode?.value || "subtitle_band").trim() || "subtitle_band",
        subtitle_roi_mode: String(els.copySubtitleRoiMode?.value || "auto").trim() || "auto",
        subtitle_removal_mode: String(els.copySubtitleRemovalMode?.value || "band").trim() || "band"
      };
    case "language_rewrite":
      return { target_language: String(els.rewriteTargetLanguage?.value || "en").trim() || "en" };
    case "material_analysis":
      return { use_llm: els.materialUseLlm?.checked !== false };
    default:
      return {};
  }
}

function buildPayload({ includeSource = true } = {}) {
  const task = selectedTask();
  const sourceType = task.input === "report_text" ? "report_text" : state.sourceMode === "file" ? "base64_data_url" : "url";
  return {
    job_type: task.jobType,
    input: includeSource ? sourceInputPayload() : { source_type: sourceType, source: "<redacted>" },
    options: { priority: intValue(els.priority, 0) },
    params: buildParams()
  };
}

function renderPayloadPreview() {
  setFormError("");
  try {
    const payload = buildPayload({ includeSource: false });
    if (state.sourceMode === "url" && selectedTask().input !== "report_text") {
      payload.input.source = String(els.sourceUrl?.value || "").trim() || "https://example.com/video.mp4";
    }
    if (selectedTask().input === "report_text") payload.input.source = "<report_text>";
    if (payload.params?.mask_source) payload.params.mask_source = "<mask_data_url>";
    if (els.payloadPreview) els.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    if (els.payloadPreview) els.payloadPreview.textContent = JSON.stringify({ error: error.message }, null, 2);
  }
  renderSubmitState();
}

function renderSubmitState() {
  const ready = validateSubmitReady();
  if (els.submitBtn) {
    els.submitBtn.disabled = !state.user || state.submitting || !ready.ok;
    els.submitBtn.title = ready.ok ? "" : ready.message;
  }
}

function jobId() {
  return state.job?.jobId || state.job?.job_id || state.job?.providerJob?.job_id || "";
}

function remixArchiveId() {
  return state.job?.remixId || state.job?.remix_id || state.result?.remixId || state.result?.remix_id || "";
}

function archiveHref() {
  return state.job?.taskManagementUrl || state.result?.taskManagementUrl || taskSpaceHref("remix", remixArchiveId());
}

function jobFailureMessage(job = {}) {
  const provider = job.providerJob || job;
  const candidates = [
    provider.failure_reason,
    provider.failureReason,
    provider.error_message,
    provider.errorMessage,
    provider.error,
    provider.message
  ];
  for (const item of candidates) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text) return text;
  }
  return "";
}

function renderJob() {
  const job = state.job;
  const status = statusLabel(job?.status);
  if (els.statusBadge) els.statusBadge.textContent = status;
  if (els.jobStatusMetric) els.jobStatusMetric.textContent = status;
  if (els.queueMetric) els.queueMetric.textContent = job ? queueLabel(job) : "-";
  if (els.outputMetric) els.outputMetric.textContent = state.result ? "1" : "0";
  if (els.jobSummary) {
    if (!job) {
      els.jobSummary.className = "wz-list empty-line";
      els.jobSummary.textContent = "暂无任务";
    } else {
      const providerJob = job.providerJob || job;
      const failureMessage = jobFailureMessage(job);
      const rows = [
        ["job_id", job.jobId || providerJob.job_id || "-"],
        ["job_type", job.jobType || providerJob.job_type || "-"],
        ["status", status],
        ["queue waiting/running", queueLabel(providerJob)],
        ["attempts", `${providerJob.attempts ?? "-"}/${providerJob.max_attempts ?? "-"}`],
        ["created_at", providerJob.created_at || "-"],
        ["updated_at", providerJob.updated_at || "-"]
      ];
      if (failureMessage) rows.push(["failure_reason", failureMessage]);
      els.jobSummary.className = "wz-list";
      els.jobSummary.innerHTML = renderKeyValues(rows);
    }
  }
  const id = jobId();
  const terminal = TERMINAL_STATUSES.has(job?.status);
  if (els.refreshBtn) els.refreshBtn.disabled = !id || state.loadingJob;
  if (els.resultBtn) {
    els.resultBtn.disabled = !id;
    els.resultBtn.textContent = "同步诊断";
  }
  if (els.downloadBtn) {
    els.downloadBtn.disabled = !id;
    els.downloadBtn.textContent = "打开任务管理";
  }
  if (els.cancelBtn) els.cancelBtn.disabled = !id || terminal;
  if (els.retryBtn) els.retryBtn.disabled = !id || job?.status !== "failed";
  if (els.taskDetailLink) {
    els.taskDetailLink.href = archiveHref();
    els.taskDetailLink.classList.toggle("disabled", !id);
    els.taskDetailLink.setAttribute("aria-disabled", id ? "false" : "true");
  }
  renderSubmitState();
}

function renderResult() {
  if (!els.resultBox) return;
  const id = jobId();
  const href = archiveHref();
  if (!id) {
    els.resultBox.className = "wz-list empty-line";
    els.resultBox.textContent = "任务提交后，最终结果、预览确认、诊断摘要和交付下载统一在任务管理中查看。";
    return;
  }
  els.resultBox.className = "wz-list";
  const result = state.result || {};
  const diagnosticRows = state.result
    ? [
      ["诊断", "已同步"],
      ["stage_timings", result.stage_timings ? "available" : "-"],
      ["engine_trace", result.engine_trace ? "available" : "-"]
    ]
    : [["诊断", "未同步"]];
  els.resultBox.innerHTML = `
    <article class="wz-row">
      <div>
        <strong>任务管理归档</strong>
        <small>${escapeHtml(id)}</small>
        <p>最终输出集合、预览确认、质检和下载入口统一在任务管理中处理。</p>
      </div>
      <a class="mini" href="${escapeHtml(href)}">查看任务详情</a>
    </article>
    <div class="wz-kv-grid">${renderKeyValues(diagnosticRows)}</div>
  `;
}

function syncVideoPreviews() {
  const task = selectedTask();
  const url = state.sourceMode === "file" ? state.fileObjectUrl : String(els.sourceUrl?.value || "").trim();
  const show = Boolean(url) && task.input === "video";
  for (const video of [els.video, els.regionVideo]) {
    if (!video) continue;
    if (show) {
      if (video.src !== url) video.src = url;
      video.hidden = false;
    } else {
      video.removeAttribute("src");
      video.hidden = true;
    }
  }
  if (!show) {
    state.selectedFramePreviewDataUrl = "";
    renderSelectedFramePreview({ status: "上传视频或填写可预览的视频 URL 后再选择 K 帧" });
  }
  updateFrameSlider();
}

function usableRect(target) {
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width > 1 && rect.height > 1) return rect;
  const fallbackWidth = target.clientWidth || target.offsetWidth || target.scrollWidth || 0;
  const fallbackHeight = target.clientHeight || target.offsetHeight || target.scrollHeight || 0;
  if (fallbackWidth > 1 && fallbackHeight > 1) {
    return {
      left: rect.left,
      top: rect.top,
      width: fallbackWidth,
      height: fallbackHeight
    };
  }
  const host = target.closest(".video-ops-frame-box, .video-ops-region-box");
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  if (hostRect.width > 1 && hostRect.height > 1) return hostRect;
  return null;
}

function updateFrameSlider() {
  if (!els.video || !els.interactiveFrameSlider) return;
  const totalFrames = Math.max(0, Math.floor(Number(els.video.duration || 0) * 30));
  els.interactiveFrameSlider.max = String(totalFrames);
  els.interactiveFrameSlider.value = String(Math.min(totalFrames, intValue(els.interactiveFrameIndex, 0)));
}

function renderSelectedFramePreview({ status = "" } = {}) {
  if (!els.interactiveFramePreview) return;
  const frameIndex = intValue(els.interactiveFrameIndex, 0);
  const time = numberValue(els.interactiveFrameTime, 0);
  const hasPreview = Boolean(state.selectedFramePreviewDataUrl);
  els.interactiveFramePreview.classList.toggle("empty", !hasPreview);
  if (els.interactiveFramePreviewMeta) {
    els.interactiveFramePreviewMeta.textContent = hasPreview
      ? `frame=${frameIndex} · ${time.toFixed(2)}s`
      : status || "尚未选择帧";
  }
  if (els.interactiveFramePreviewImage) {
    els.interactiveFramePreviewImage.hidden = !hasPreview;
    if (hasPreview) els.interactiveFramePreviewImage.src = state.selectedFramePreviewDataUrl;
    else els.interactiveFramePreviewImage.removeAttribute("src");
  }
  if (els.interactiveFramePreviewEmpty) {
    els.interactiveFramePreviewEmpty.hidden = hasPreview;
    if (!hasPreview && status) els.interactiveFramePreviewEmpty.textContent = status;
  }
}

function captureCurrentFrame({ updateSelection = true } = {}) {
  if (!els.video || !els.frameCanvas) return;
  const canvas = els.frameCanvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = els.video.videoWidth || 360;
  const height = els.video.videoHeight || 640;
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = "#0e1524";
  ctx.fillRect(0, 0, width, height);
  try {
    if (els.video.readyState >= 2) ctx.drawImage(els.video, 0, 0, width, height);
  } catch {
    ctx.fillStyle = "#8aa0c0";
    ctx.fillText("当前视频无法绘制到画布", 16, 28);
  }
  const time = Number(els.video.currentTime || 0);
  const frameIndex = Math.max(0, Math.round(time * 30));
  if (updateSelection) {
    if (els.interactiveFrameTime) els.interactiveFrameTime.value = time.toFixed(2);
    if (els.interactiveFrameIndex) els.interactiveFrameIndex.value = String(frameIndex);
    if (els.interactiveFrameSlider) els.interactiveFrameSlider.value = String(frameIndex);
  }
  try {
    state.selectedFramePreviewDataUrl = canvas.toDataURL("image/jpeg", 0.86);
  } catch {
    state.selectedFramePreviewDataUrl = "";
  }
  renderSelectedFramePreview();
  renderPayloadPreview();
}

function seekVideoToFrame(frameIndex, { capture = true } = {}) {
  if (!els.video || !els.video.src) {
    renderSelectedFramePreview({ status: "请先上传视频或填写可预览的视频 URL" });
    return;
  }
  const frame = Math.max(0, Math.round(Number(frameIndex || 0)));
  const time = frame / 30;
  if (els.interactiveFrameIndex) els.interactiveFrameIndex.value = String(frame);
  if (els.interactiveFrameTime) els.interactiveFrameTime.value = time.toFixed(2);
  if (els.interactiveFrameSlider) els.interactiveFrameSlider.value = String(frame);
  if (capture && els.video.readyState < 1) {
    renderSelectedFramePreview({ status: "视频元信息加载后会显示对应帧" });
    return;
  }
  const doCapture = () => captureCurrentFrame({ updateSelection: true });
  if (capture) {
    els.video.addEventListener("seeked", doCapture, { once: true });
  }
  try {
    els.video.currentTime = Math.min(Math.max(time, 0), Number(els.video.duration || time));
  } catch {
    if (capture) doCapture();
  }
  if (capture && Math.abs(Number(els.video.currentTime || 0) - time) < 0.03) {
    requestAnimationFrame(doCapture);
  }
}

function seekVideoToTime(timeValue, { capture = true } = {}) {
  const time = Math.max(0, Number(timeValue || 0));
  seekVideoToFrame(Math.round(time * 30), { capture });
}

function pointFromEvent(event, target) {
  const rect = usableRect(target);
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (rect.width <= 1 || rect.height <= 1) return null;
  return {
    x: clamp((x - rect.left) / rect.width),
    y: clamp((y - rect.top) / rect.height)
  };
}

function renderPrompt() {
  if (!els.promptLayer) return;
  const box = state.prompt.box;
  const boxHtml = box ? `<div class="video-ops-prompt-box" style="left:${box.x1 * 100}%;top:${box.y1 * 100}%;width:${(box.x2 - box.x1) * 100}%;height:${(box.y2 - box.y1) * 100}%;"></div>` : "";
  const pointHtml = state.prompt.points.map((point) => `<span class="video-ops-prompt-point ${point.label === "negative" ? "negative" : "positive"}" style="left:${point.x * 100}%;top:${point.y * 100}%;"></span>`).join("");
  els.promptLayer.innerHTML = boxHtml + pointHtml;
  if (els.interactivePromptSummary) {
    if ((els.interactivePromptType?.value || "box") === "point") {
      els.interactivePromptSummary.className = state.prompt.points.length ? "wz-list" : "wz-list empty-line";
      els.interactivePromptSummary.textContent = state.prompt.points.length ? `Point Prompt：${state.prompt.points.length} 个点` : "尚未点选对象";
    } else {
      els.interactivePromptSummary.className = box ? "wz-list" : "wz-list empty-line";
      els.interactivePromptSummary.textContent = box ? `Box Prompt：x1=${box.x1.toFixed(3)}, y1=${box.y1.toFixed(3)}, x2=${box.x2.toFixed(3)}, y2=${box.y2.toFixed(3)}` : "尚未框选对象";
    }
  }
  renderPayloadPreview();
}

function renderRegion() {
  if (!els.regionOverlay) return;
  const box = state.region.box;
  els.regionOverlay.innerHTML = box ? `<div class="video-ops-region-rect" style="left:${box.x1 * 100}%;top:${box.y1 * 100}%;width:${(box.x2 - box.x1) * 100}%;height:${(box.y2 - box.y1) * 100}%;"></div>` : "";
  if (els.regionSummary) {
    els.regionSummary.className = box ? "wz-list" : "wz-list empty-line";
    els.regionSummary.textContent = box ? `区域：x1=${box.x1.toFixed(3)}, y1=${box.y1.toFixed(3)}, x2=${box.x2.toFixed(3)}, y2=${box.y2.toFixed(3)}` : "拖拽画面框选遮挡或模糊区域";
  }
  renderPayloadPreview();
}

function setBoxFromDrag(kind, start, end) {
  if (!start || !end) return;
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return;
  const box = { x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y), x2: Math.max(start.x, end.x), y2: Math.max(start.y, end.y) };
  if (box.x2 - box.x1 < 0.01 || box.y2 - box.y1 < 0.01) return;
  if (kind === "prompt") state.prompt.box = box;
  if (kind === "region") state.region.box = box;
}

function ensureInteractiveSurfaceReady(kind = "prompt") {
  ensureInputNodeVisible();
  const target = kind === "region" ? els.regionOverlay : els.promptLayer;
  const rect = usableRect(target);
  if (rect) return true;
  setFormError(kind === "region" ? "区域框选画布尚未完成布局，请稍后再试" : "K 帧画布尚未完成布局，请稍后再试");
  return false;
}

async function handleFileChange(file) {
  if (state.fileObjectUrl) URL.revokeObjectURL(state.fileObjectUrl);
  state.fileDataUrl = "";
  state.fileObjectUrl = "";
  if (!file) {
    if (els.fileStatus) els.fileStatus.textContent = "未选择文件";
    syncVideoPreviews();
    renderPayloadPreview();
    return;
  }
  if (!/^video\//i.test(file.type || "")) {
    setFormError("只支持上传视频文件");
    if (els.sourceFile) els.sourceFile.value = "";
    return;
  }
  if (file.size > MAX_UPLOAD_VIDEO_BYTES) {
    setFormError(`文件超过 ${formatUploadLimit()} 上限，请压缩后重试`);
    if (els.sourceFile) els.sourceFile.value = "";
    if (els.fileStatus) els.fileStatus.textContent = "未选择文件";
    renderPayloadPreview();
    return;
  }
  if (els.fileStatus) els.fileStatus.textContent = "正在读取文件...";
  state.fileDataUrl = await dataUrlFromFile(file);
  state.fileObjectUrl = URL.createObjectURL(file);
  if (els.fileStatus) els.fileStatus.textContent = `${file.name} · ${Math.round((file.size / 1024 / 1024) * 10) / 10} MB`;
  syncVideoPreviews();
  renderPayloadPreview();
}

async function handleManualMaskChange(file) {
  state.manualMaskDataUrl = "";
  if (!file) {
    if (els.manualMaskStatus) els.manualMaskStatus.textContent = "未上传 mask";
    renderPayloadPreview();
    return;
  }
  if (!/^image\//i.test(file.type || "")) {
    setFormError("mask 只支持图片文件");
    if (els.manualMaskFile) els.manualMaskFile.value = "";
    return;
  }
  state.manualMaskDataUrl = await dataUrlFromFile(file);
  if (els.manualMaskStatus) els.manualMaskStatus.textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
  renderPayloadPreview();
}

function stopPolling() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
}

async function submitJob() {
  let payload;
  try {
    payload = buildPayload();
  } catch (error) {
    setFormError(error.message || "参数不完整");
    return;
  }
  state.submitting = true;
  setBusy(els.submitBtn, true, "提交中");
  renderSubmitState();
  try {
    state.job = await apiEnvelope("/api/wangzhuan/video-ops/jobs", { method: "POST", body: JSON.stringify(payload) });
    state.result = null;
    showToast(`任务已提交：${jobId()}`);
    renderJob();
    renderResult();
    schedulePoll();
  } catch (error) {
    setFormError(error.message || "提交失败");
  } finally {
    state.submitting = false;
    setBusy(els.submitBtn, false);
    renderSubmitState();
  }
}

async function loadJob({ quiet = false } = {}) {
  const id = jobId();
  if (!id) return null;
  state.loadingJob = true;
  renderJob();
  try {
    state.job = await apiEnvelope(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(id)}?include_model_calls=true`);
    renderJob();
    if (!quiet) showToast("任务状态已刷新");
    return state.job;
  } catch (error) {
    if (!quiet) setFormError(error.message || "刷新失败");
    return null;
  } finally {
    state.loadingJob = false;
    renderJob();
  }
}

function schedulePoll() {
  stopPolling();
  const tick = async () => {
    const job = await loadJob({ quiet: true });
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      stopPolling();
      if (job?.status === "succeeded" || job?.status === "review_required") await loadResult({ quiet: true });
      return;
    }
    state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
  };
  state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
}

async function loadResult({ quiet = false } = {}) {
  const id = jobId();
  if (!id) return;
  try {
    state.result = await apiEnvelope(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(id)}/result?include_model_calls=true`);
    renderResult();
    if (!quiet) showToast("结果已读取");
  } catch (error) {
    if (!quiet) setFormError(error.message || "读取结果失败");
  }
}

async function cancelJob() {
  const id = jobId();
  if (!id) return;
  try {
    state.job = await apiEnvelope(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
    stopPolling();
    renderJob();
    showToast("任务已取消");
  } catch (error) {
    setFormError(error.message || "取消失败");
  }
}

async function retryJob() {
  const id = jobId();
  if (!id) return;
  try {
    state.job = await apiEnvelope(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" });
    state.result = null;
    renderJob();
    renderResult();
    schedulePoll();
    showToast("任务已重试");
  } catch (error) {
    setFormError(error.message || "重试失败");
  }
}

function resetTaskState() {
  stopPolling();
  state.job = null;
  state.result = null;
  state.prompt.points = [];
  state.prompt.box = null;
  state.region.box = null;
  state.manualMaskDataUrl = "";
  state.selectedFramePreviewDataUrl = "";
  if (els.manualMaskFile) els.manualMaskFile.value = "";
  if (els.manualMaskStatus) els.manualMaskStatus.textContent = "未上传 mask";
  renderSelectedFramePreview({ status: "尚未选择帧" });
  renderPrompt();
  renderRegion();
  renderJob();
  renderResult();
  renderPayloadPreview();
}

function bindEvents() {
  els.taskGrid?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-task-id]");
    if (!card) return;
    state.selectedTaskId = card.dataset.taskId;
    renderSelection();
  });
  for (const radio of els.sourceModeRadios) {
    radio.addEventListener("change", () => {
      state.sourceMode = radio.value;
      ensureInputNodeVisible();
      renderInputMode();
      syncVideoPreviews();
      renderPayloadPreview();
    });
  }
  els.sourceUrl?.addEventListener("input", () => {
    ensureInputNodeVisible();
    syncVideoPreviews();
    renderPayloadPreview();
  });
  els.sourceFile?.addEventListener("change", () => {
    ensureInputNodeVisible();
    handleFileChange(els.sourceFile.files?.[0]);
  });
  els.manualMaskFile?.addEventListener("change", () => {
    ensureInputNodeVisible();
    handleManualMaskChange(els.manualMaskFile.files?.[0]);
  });
  els.video?.addEventListener("loadedmetadata", () => {
    updateFrameSlider();
    seekVideoToFrame(intValue(els.interactiveFrameIndex, 0), { capture: true });
  });
  els.video?.addEventListener("timeupdate", () => {
    if (state.selectedTaskId !== "auto_ai_remove") return;
    const time = Number(els.video.currentTime || 0);
    if (els.interactiveFrameTime) els.interactiveFrameTime.value = time.toFixed(2);
    if (els.interactiveFrameIndex) els.interactiveFrameIndex.value = String(Math.round(time * 30));
    updateFrameSlider();
  });
  els.interactiveFrameSlider?.addEventListener("input", () => {
    ensureInputNodeVisible();
    seekVideoToFrame(intValue(els.interactiveFrameSlider, 0), { capture: true });
  });
  els.interactiveFrameIndex?.addEventListener("change", () => {
    ensureInputNodeVisible();
    seekVideoToFrame(intValue(els.interactiveFrameIndex, 0), { capture: true });
  });
  els.interactiveFrameTime?.addEventListener("change", () => {
    ensureInputNodeVisible();
    seekVideoToTime(numberValue(els.interactiveFrameTime, 0), { capture: true });
  });
  els.captureCurrentFrameBtn?.addEventListener("click", () => {
    ensureInputNodeVisible();
    captureCurrentFrame({ updateSelection: true });
  });
  els.clearPromptBtn?.addEventListener("click", () => {
    ensureInputNodeVisible();
    state.prompt.points = [];
    state.prompt.box = null;
    renderPrompt();
  });
  els.promptLayer?.addEventListener("pointerdown", (event) => {
    if (!ensureInteractiveSurfaceReady("prompt")) return;
    const start = pointFromEvent(event, els.promptLayer);
    if (!start) return;
    if ((els.interactivePromptType?.value || "box") === "point") {
      state.prompt.points.push({ ...start, label: els.interactivePointLabel?.value || "positive" });
      renderPrompt();
      return;
    }
    state.prompt.drag = start;
    els.promptLayer.setPointerCapture?.(event.pointerId);
  });
  els.promptLayer?.addEventListener("pointermove", (event) => {
    if (!state.prompt.drag) return;
    setBoxFromDrag("prompt", state.prompt.drag, pointFromEvent(event, els.promptLayer));
    renderPrompt();
  });
  els.promptLayer?.addEventListener("pointerup", (event) => {
    if (!state.prompt.drag) return;
    setBoxFromDrag("prompt", state.prompt.drag, pointFromEvent(event, els.promptLayer));
    state.prompt.drag = null;
    renderPrompt();
  });
  els.regionOverlay?.addEventListener("pointerdown", (event) => {
    if (!ensureInteractiveSurfaceReady("region")) return;
    state.region.drag = pointFromEvent(event, els.regionOverlay);
    if (!state.region.drag) return;
    els.regionOverlay.setPointerCapture?.(event.pointerId);
  });
  els.regionOverlay?.addEventListener("pointermove", (event) => {
    if (!state.region.drag) return;
    setBoxFromDrag("region", state.region.drag, pointFromEvent(event, els.regionOverlay));
    renderRegion();
  });
  els.regionOverlay?.addEventListener("pointerup", (event) => {
    if (!state.region.drag) return;
    setBoxFromDrag("region", state.region.drag, pointFromEvent(event, els.regionOverlay));
    state.region.drag = null;
    renderRegion();
  });
  els.useCurrentRegionFrameBtn?.addEventListener("click", () => {
    ensureInputNodeVisible();
    if (els.regionVideo && els.video) els.regionVideo.currentTime = els.video.currentTime;
  });
  els.clearRegionBtn?.addEventListener("click", () => {
    ensureInputNodeVisible();
    state.region.box = null;
    renderRegion();
  });
  els.interactivePromptType?.addEventListener("change", renderPrompt);
  document.addEventListener("input", (event) => {
    if (event.target.closest("#remixNodeInput")) renderPayloadPreview();
  });
  els.submitBtn?.addEventListener("click", submitJob);
  els.resetBtn?.addEventListener("click", resetTaskState);
  els.refreshBtn?.addEventListener("click", () => loadJob());
  els.resultBtn?.addEventListener("click", () => loadResult());
  els.downloadBtn?.addEventListener("click", () => {
    const id = jobId();
    if (id) location.assign(archiveHref());
  });
  els.taskDetailLink?.addEventListener("click", (event) => {
    if (jobId()) return;
    event.preventDefault();
  });
  els.cancelBtn?.addEventListener("click", cancelJob);
  els.retryBtn?.addEventListener("click", retryJob);
}

async function init() {
  bindEvents();
  renderSelection();
  renderJob();
  renderResult();
  try {
    await bindLogin({
      modal: els.loginModal,
      badge: els.badge,
      logoutBtn: els.logoutBtn,
      onAuthed(user) {
        state.user = user;
        renderSubmitState();
      }
    });
  } catch {
    showLogin(els.loginModal);
  }
  renderSubmitState();
}

window.addEventListener("beforeunload", () => {
  stopPolling();
  if (state.fileObjectUrl) URL.revokeObjectURL(state.fileObjectUrl);
});

init();
