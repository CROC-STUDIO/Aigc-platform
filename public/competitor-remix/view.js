import { escapeHtml, showToast, taskSpaceHref } from "../wangzhuan-common.js";
import { CAPABILITIES, getCapability, getMode } from "./capability-catalog.js";
import { buildPayload, validateDraft } from "./payloads.js";
import { createRegionEditor, visibleMediaRect } from "./editors.js";

const ACTIVE_STATUSES = new Set(["pending", "queued", "running", "processing"]);

function statusLabel(status = "") {
  return {
    pending: "等待中",
    queued: "排队中",
    running: "处理中",
    processing: "处理中",
    review_required: "待复核",
    succeeded: "已完成",
    failed: "失败",
    canceled: "已取消",
    stopped: "已停止"
  }[status] || status || "未知";
}

function valueAttr(value) {
  return escapeHtml(String(value ?? ""));
}

function selectedAttr(value, expected) {
  return value === expected ? " selected" : "";
}

function field(label, name, value, { type = "text", min = "", max = "", step = "", hint = "" } = {}) {
  return `<label class="remix-field"><span>${escapeHtml(label)}</span><input data-field="${escapeHtml(name)}" type="${type}" value="${valueAttr(value)}"${min !== "" ? ` min="${min}"` : ""}${max !== "" ? ` max="${max}"` : ""}${step !== "" ? ` step="${step}"` : ""} />${hint ? `<small class="remix-field-hint">${escapeHtml(hint)}</small>` : ""}</label>`;
}

function selectField(label, name, value, options) {
  return `<label class="remix-field"><span>${escapeHtml(label)}</span><select data-field="${escapeHtml(name)}">${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}"${selectedAttr(value, optionValue)}>${escapeHtml(optionLabel)}</option>`).join("")}</select></label>`;
}

function priorityField(draft) {
  return field("队列优先级", "priority", draft.priority, { type: "number", min: 0, max: 10, step: 1 });
}

function advanced(content) {
  return `<details class="remix-advanced"><summary>高级设置</summary><div class="remix-form-grid">${content}</div></details>`;
}

function editorStageTemplate() {
  return `<div id="remixInteractiveSurface" class="remix-editor-stage" tabindex="0" aria-label="视频区域编辑器"><video id="remixEditorVideo" muted playsinline preload="metadata"></video><div id="remixOverlayContent" class="remix-overlay-content"></div><div id="remixEditorEmpty" class="remix-editor-empty">请先载入可预览的视频</div></div>`;
}

function coordinateSummary(draft) {
  if (draft.promptType === "point") {
    return draft.points?.length ? `${draft.points.length} 个点` : "尚未点选";
  }
  const box = draft.box;
  return box ? `x1=${box.x1.toFixed(3)} y1=${box.y1.toFixed(3)} x2=${box.x2.toFixed(3)} y2=${box.y2.toFixed(3)}` : "尚未框选";
}

function visualEditorTemplate(capabilityId, modeId, draft) {
  const isKframe = capabilityId === "remove" && modeId === "kframe";
  const controls = isKframe
    ? `<div class="remix-form-grid">${selectField("选择工具", "promptType", draft.promptType, [["box", "框选"], ["point", "点选"]])}${selectField("点类型", "pointLabel", draft.pointLabel, [["positive", "目标点"], ["negative", "排除点"]])}${field("当前时间（秒）", "frameTime", draft.frameTime, { type: "number", min: 0, step: 0.01 })}${field("换算帧号（30 fps）", "frameIndex", draft.frameIndex, { type: "number", min: 0, step: 1 })}</div><input id="remixFrameSlider" type="range" min="0" max="0" step="1" value="${valueAttr(draft.frameIndex)}" aria-label="K 帧位置" /><div class="remix-actions"><button type="button" class="ghost" data-editor-action="use-current-frame">使用播放器当前帧</button><button type="button" class="ghost" data-editor-action="undo-point">撤销点</button><button type="button" class="ghost" data-editor-action="clear">清除选择</button></div><div id="remixCoordinateSummary" class="remix-coordinate-summary">${escapeHtml(coordinateSummary(draft))}</div>${advanced(`${field("sample_fps", "sampleFps", draft.sampleFps, { type: "number", min: 0, max: 10, step: 0.1 })}${field("max_frames", "maxFrames", draft.maxFrames, { type: "number", min: 1, max: 1000, step: 1 })}${selectField("removal_engine", "removalEngine", draft.removalEngine, [["configured", "configured"], ["lama", "lama"], ["fallback_blur", "fallback_blur"]])}${field("mask_threshold", "maskThreshold", draft.maskThreshold, { type: "number", min: 0, max: 255, step: 1 })}${priorityField(draft)}`)}`
    : `<div class="remix-actions"><button type="button" class="ghost" data-editor-action="sync-source-time">同步播放器时间</button><button type="button" class="ghost" data-editor-action="clear">清除区域</button></div><div id="remixCoordinateSummary" class="remix-coordinate-summary">${escapeHtml(coordinateSummary(draft))}</div>${capabilityId === "remove" ? `<div class="remix-form-grid">${field("开始时间（毫秒）", "startMs", draft.startMs, { type: "number", min: 0, step: 1 })}${field("结束时间（毫秒）", "endMs", draft.endMs, { type: "number", min: 1, step: 1 })}</div>${advanced(`${field("mask_threshold", "maskThreshold", draft.maskThreshold, { type: "number", min: 0, max: 255, step: 1 })}${priorityField(draft)}`)}` : `<div class="remix-form-grid">${field("模糊强度", "blurSigma", draft.blurSigma, { type: "number", min: 0, max: 200, step: 1 })}${field("填充颜色", "fillColor", draft.fillColor, { type: "color" })}${field("填充透明度", "fillOpacity", draft.fillOpacity, { type: "number", min: 0, max: 1, step: 0.05 })}</div>${advanced(`${field("mask_threshold", "maskThreshold", draft.maskThreshold, { type: "number", min: 0, max: 255, step: 1 })}${priorityField(draft)}`)}`}`;
  return `<div class="remix-editor-layout">${editorStageTemplate()}<div class="remix-editor-controls">${controls}</div></div>`;
}

function formTemplate(capabilityId, modeId, draft) {
  if (capabilityId === "remove" && modeId === "seedance") {
    return `<div class="remix-form"><label class="remix-field"><span>处理提示</span><textarea data-field="prompt" rows="4">${escapeHtml(draft.prompt)}</textarea></label><div class="remix-form-grid">${selectField("画面比例", "ratio", draft.ratio, [["auto", "自动"], ["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"]])}${selectField("分辨率", "resolution", draft.resolution, [["720p", "720p"], ["1080p", "1080p"]])}${field("切片秒数", "segmentSeconds", draft.segmentSeconds, { type: "number", min: 1, max: 30, step: 1 })}</div>${advanced(priorityField(draft))}</div>`;
  }
  if (capabilityId === "remove" && modeId === "automatic") {
    return `<div class="remix-form">${advanced(`${field("mask_threshold", "maskThreshold", draft.maskThreshold, { type: "number", min: 0, max: 255, step: 1 })}${priorityField(draft)}`)}</div>`;
  }
  if ((capabilityId === "remove" && ["kframe", "fixed_region"].includes(modeId)) || capabilityId === "mask") {
    return visualEditorTemplate(capabilityId, modeId, draft);
  }
  if (capabilityId === "ending") {
    return `<div class="remix-form"><div class="remix-form-grid">${field("检测尾段秒数", "tailDetectSeconds", draft.tailDetectSeconds, { type: "number", min: 1, max: 30, step: 1 })}${field("复核阈值", "reviewThreshold", draft.reviewThreshold, { type: "number", min: 0, max: 1, step: 0.05 })}${selectField("裁剪方式", "trimMode", draft.trimMode, [["fast", "快速"], ["precise", "精确"]])}${field("安全边距（毫秒）", "safeTrimMarginMs", draft.safeTrimMarginMs, { type: "number", min: 0, max: 5000, step: 1 })}</div><label class="remix-field"><span>竞品或导流关键词（每行一个）</span><textarea data-field="competitorKeywords" rows="4">${escapeHtml(draft.competitorKeywords)}</textarea></label><label class="remix-check"><input data-field="allowReencode" type="checkbox"${draft.allowReencode ? " checked" : ""} />允许必要时重新编码</label>${advanced(priorityField(draft))}</div>`;
  }
  if (capabilityId === "language" && modeId === "subtitle_translate") {
    return `<div class="remix-form"><div class="remix-form-grid">${field("目标语言", "targetLanguage", draft.targetLanguage)}${selectField("字幕来源", "sourceMode", draft.sourceMode, [["auto", "自动识别"], ["embedded", "内嵌字幕"], ["burned", "画面字幕"]])}${selectField("回写方式", "renderMode", draft.renderMode, [["subtitle_band", "字幕带"], ["overlay", "画面覆盖"]])}${selectField("字幕区域", "subtitleRoiMode", draft.subtitleRoiMode, [["auto", "自动"], ["full", "全画面"]])}</div>${advanced(`${selectField("原字幕处理", "subtitleRemovalMode", draft.subtitleRemovalMode, [["band", "字幕带移除"], ["none", "不移除"]])}${priorityField(draft)}`)}</div>`;
  }
  if (capabilityId === "language" && modeId === "rewrite") {
    return `<div class="remix-form"><div class="remix-form-grid">${field("目标语言", "targetLanguage", draft.targetLanguage)}${priorityField(draft)}</div></div>`;
  }
  if (capabilityId === "analysis") {
    return `<div class="remix-form"><label class="remix-check"><input data-field="useLlm" type="checkbox"${draft.useLlm ? " checked" : ""} />启用模型分析</label>${advanced(priorityField(draft))}</div>`;
  }
  return "";
}

function failureMessage(run = {}) {
  const job = run.providerJob || {};
  return job.failure_reason || job.failureReason || job.error_message || job.errorMessage || job.error?.message || job.error || run.connectionError || "";
}

function queueLabel(run = {}) {
  const stats = run.providerJob?.queue_stats || run.providerJob?.queueStats || {};
  return stats.waiting === undefined && stats.running === undefined ? "-" : `${stats.waiting ?? "-"}/${stats.running ?? "-"}`;
}

function outputUrl(run = {}) {
  const candidates = [
    run.result?.download_url,
    run.result?.downloadUrl,
    run.result?.output_url,
    run.result?.outputUrl,
    run.providerJob?.download_url,
    run.providerJob?.downloadUrl,
    run.providerJob?.output_url,
    run.providerJob?.outputUrl
  ];
  const nested = Array.isArray(run.result?.outputs) ? run.result.outputs : [];
  for (const output of nested) candidates.push(output?.download_url, output?.downloadUrl, output?.url);
  return String(candidates.find(Boolean) || "");
}

export function createRemixView({ store, media, runner, requireLogin, root = document } = {}) {
  const elements = {
    capabilityList: root.querySelector("#remixCapabilityList"),
    capabilityEyebrow: root.querySelector("#remixCapabilityEyebrow"),
    workspaceTitle: root.querySelector("#remixWorkspaceTitle"),
    resetDraft: root.querySelector("#remixResetDraft"),
    dropzone: root.querySelector("#remixDropzone"),
    videoControls: root.querySelector("#remixVideoSourceControls"),
    sourceStatus: root.querySelector("#remixSourceStatus"),
    sourceUrl: root.querySelector("#remixSourceUrl"),
    applyUrl: root.querySelector("#remixApplyUrl"),
    urlRow: root.querySelector("#remixUrlRow"),
    fileRow: root.querySelector("#remixFileRow"),
    sourceFile: root.querySelector("#remixSourceFile"),
    chooseFile: root.querySelector("#remixChooseFile"),
    fileMeta: root.querySelector("#remixFileMeta"),
    sourceVideo: root.querySelector("#remixSourceVideo"),
    reportSource: root.querySelector("#remixReportSource"),
    reportText: root.querySelector("#remixReportText"),
    modeTabs: root.querySelector("#remixModeTabs"),
    editorContent: root.querySelector("#remixEditorContent"),
    readiness: root.querySelector("#remixReadiness"),
    formError: root.querySelector("#remixFormError"),
    submit: root.querySelector("#remixSubmit"),
    runCount: root.querySelector("#remixRunCount"),
    runList: root.querySelector("#remixRunList"),
    runDetail: root.querySelector("#remixRunDetail")
  };
  let editorKey = "";
  let regionEditor = null;
  let submitting = false;

  function selection(state = store.getState()) {
    const capability = getCapability(state.selectedCapabilityId) || CAPABILITIES[0];
    const modeId = state.selectedModes[capability.id] || capability.modes[0].id;
    const mode = getMode(capability.id, modeId) || capability.modes[0];
    const draft = store.getDraft(capability.id, mode.id);
    return { capability, mode, draft };
  }

  function showFormError(message = "") {
    elements.formError.hidden = !message;
    elements.formError.textContent = message;
  }

  function renderCapabilities(state) {
    elements.capabilityList.innerHTML = CAPABILITIES.map((capability, index) => {
      const active = capability.id === state.selectedCapabilityId;
      const activeRuns = state.runs.filter((run) => run.capabilityId === capability.id && ACTIVE_STATUSES.has(run.status)).length;
      const doneRuns = state.runs.filter((run) => run.capabilityId === capability.id && ["succeeded", "review_required"].includes(run.status)).length;
      const count = activeRuns || doneRuns;
      return `<button type="button" class="remix-capability" data-capability-id="${escapeHtml(capability.id)}" aria-current="${active}"><span class="remix-capability-index">${String(index + 1).padStart(2, "0")}</span><span class="remix-capability-copy"><strong>${escapeHtml(capability.label)}</strong><small>${escapeHtml(capability.description)}</small></span><span class="remix-capability-count">${count || ""}</span></button>`;
    }).join("");
  }

  function renderModes(state, capability, mode) {
    elements.modeTabs.innerHTML = capability.modes.map((item) => `<button type="button" role="tab" data-mode-id="${escapeHtml(item.id)}" aria-selected="${item.id === mode.id}">${escapeHtml(item.label)}</button>`).join("");
    elements.capabilityEyebrow.textContent = capability.label;
    elements.workspaceTitle.textContent = mode.label;
  }

  function sourcePreviewUrl(source) {
    return source.mode === "file" ? source.objectUrl : source.url;
  }

  function syncVideoElement(video, source) {
    if (!video) return;
    const previewUrl = sourcePreviewUrl(source);
    if (!previewUrl) {
      video.hidden = true;
      video.removeAttribute("src");
      return;
    }
    video.hidden = false;
    if (video.getAttribute("src") !== previewUrl) {
      video.src = previewUrl;
      video.load?.();
    }
  }

  function renderSource(state, capability) {
    const isReport = capability.id === "analysis";
    elements.videoControls.hidden = isReport;
    elements.reportSource.hidden = !isReport;
    if (isReport) {
      if (root.activeElement !== elements.reportText) elements.reportText.value = state.source.reportText || "";
      elements.sourceStatus.textContent = state.source.reportText ? "报告文本已填写" : "等待报告文本";
      return;
    }
    const fileMode = state.source.mode === "file";
    elements.urlRow.hidden = fileMode;
    elements.fileRow.hidden = !fileMode;
    for (const button of elements.videoControls.querySelectorAll("[data-source-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.sourceMode === state.source.mode));
    }
    if (root.activeElement !== elements.sourceUrl) elements.sourceUrl.value = state.source.url || "";
    const status = {
      idle: "等待输入",
      ready: "素材已就绪",
      preparing: "正在准备上传内容",
      error: state.source.error || "素材读取失败",
      needs_file: "请重新选择本地视频"
    }[state.source.status] || "等待输入";
    elements.sourceStatus.textContent = status;
    elements.fileMeta.textContent = state.source.fileName
      ? `${state.source.fileName}${state.source.metadata?.duration ? ` · ${state.source.metadata.duration.toFixed(1)} 秒` : ""}`
      : "也可以把视频拖到这里，单个文件不超过 300 MB";
    syncVideoElement(elements.sourceVideo, state.source);
  }

  function renderOverlay(draft) {
    const surface = root.querySelector("#remixInteractiveSurface");
    const overlay = root.querySelector("#remixOverlayContent");
    const video = root.querySelector("#remixEditorVideo");
    if (!surface || !overlay || !video) return;
    const rect = visibleMediaRect(surface.getBoundingClientRect(), {
      width: video.videoWidth || store.getState().source.metadata?.width || 0,
      height: video.videoHeight || store.getState().source.metadata?.height || 0
    });
    if (!rect) {
      overlay.innerHTML = "";
      return;
    }
    const surfaceRect = surface.getBoundingClientRect();
    overlay.style.left = `${rect.left - surfaceRect.left}px`;
    overlay.style.top = `${rect.top - surfaceRect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    const box = draft.box;
    const boxHtml = box ? `<div class="remix-selection-box" style="left:${box.x1 * 100}%;top:${box.y1 * 100}%;width:${(box.x2 - box.x1) * 100}%;height:${(box.y2 - box.y1) * 100}%"></div>` : "";
    const pointsHtml = (draft.points || []).map((point) => `<span class="remix-selection-point ${point.label === "negative" ? "negative" : "positive"}" style="left:${point.x * 100}%;top:${point.y * 100}%"></span>`).join("");
    overlay.innerHTML = boxHtml + pointsHtml;
    const summary = root.querySelector("#remixCoordinateSummary");
    if (summary) summary.textContent = coordinateSummary(draft);
  }

  function configureEditor(state, capability, mode, draft) {
    const surface = root.querySelector("#remixInteractiveSurface");
    const video = root.querySelector("#remixEditorVideo");
    if (!surface || !video) return;
    syncVideoElement(video, state.source);
    const empty = root.querySelector("#remixEditorEmpty");
    if (empty) empty.hidden = Boolean(sourcePreviewUrl(state.source));
    regionEditor?.setMode(mode.editor === "kframe" ? draft.promptType : "box", draft.pointLabel);
    regionEditor?.setValue({ box: draft.box, points: draft.points });
    const slider = root.querySelector("#remixFrameSlider");
    if (slider) {
      slider.max = String(Math.max(0, Math.round(Number(state.source.metadata?.duration || video.duration || 0) * 30)));
      slider.value = String(draft.frameIndex || 0);
    }
    if (mode.editor === "kframe" && Number.isFinite(Number(draft.frameTime))) {
      const nextTime = Math.max(0, Math.min(Number(draft.frameTime), Number(video.duration || draft.frameTime)));
      if (Math.abs(Number(video.currentTime || 0) - nextTime) > 0.04) {
        try { video.currentTime = nextTime; } catch {}
      }
    }
    renderOverlay(draft);
  }

  function bindVisualEditor(capability, mode) {
    regionEditor?.destroy();
    regionEditor = null;
    const surface = root.querySelector("#remixInteractiveSurface");
    const video = root.querySelector("#remixEditorVideo");
    if (!surface || !video) return;
    regionEditor = createRegionEditor({
      surface,
      getMediaSize: () => ({
        width: video.videoWidth || store.getState().source.metadata?.width || 0,
        height: video.videoHeight || store.getState().source.metadata?.height || 0
      }),
      onChange: (value) => {
        const current = selection();
        if (mode.editor === "kframe" && current.draft.promptType === "point") {
          store.updateDraft(capability.id, mode.id, { points: value.points });
        } else {
          store.updateDraft(capability.id, mode.id, { box: value.box });
        }
      }
    });
    video.addEventListener("loadedmetadata", () => {
      const current = selection();
      configureEditor(store.getState(), current.capability, current.mode, current.draft);
    });
  }

  function renderEditor(state, capability, mode, draft) {
    const key = `${capability.id}:${mode.id}`;
    if (editorKey !== key) {
      editorKey = key;
      regionEditor?.destroy();
      regionEditor = null;
      elements.editorContent.innerHTML = formTemplate(capability.id, mode.id, draft);
      if (["kframe", "region"].includes(mode.editor)) bindVisualEditor(capability, mode);
    }
    if (["kframe", "region"].includes(mode.editor)) configureEditor(state, capability, mode, draft);
  }

  function renderReadiness(state, capability, mode, draft) {
    const validation = validateDraft({ capabilityId: capability.id, modeId: mode.id, source: state.source, draft });
    elements.readiness.innerHTML = validation.requirements.map((item) => `<div class="remix-ready-item ${item.ready ? "ready" : ""}"><span class="remix-ready-mark">${item.ready ? "✓" : "×"}</span><span>${escapeHtml(item.label)}</span></div>`).join("");
    elements.submit.disabled = submitting || !validation.ok || !state.user;
    elements.submit.textContent = submitting ? (state.source.status === "preparing" ? "准备视频中" : "提交中") : "提交任务";
    elements.submit.title = !state.user ? "请先登录" : validation.ok ? "" : Object.values(validation.errors)[0];
  }

  function renderRuns(state) {
    elements.runCount.textContent = String(state.runs.length);
    elements.runList.innerHTML = state.runs.map((run) => `<button type="button" class="remix-run-card ${run.runId === state.activeRunId ? "active" : ""}" data-run-id="${escapeHtml(run.runId)}"><strong>${escapeHtml(run.capabilityLabel || run.capabilityId || run.jobType || "处理任务")}</strong><span class="remix-run-status ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span><small>${escapeHtml(run.modeLabel || run.modeId || run.providerJobId)}</small><small>${escapeHtml(run.providerJobId)}</small></button>`).join("");
    const run = state.runs.find((item) => item.runId === state.activeRunId) || state.runs[0];
    if (!run) {
      elements.runDetail.innerHTML = "";
      return;
    }
    const failure = failureMessage(run);
    const download = outputUrl(run);
    const archive = run.taskManagementUrl || (run.remixId ? taskSpaceHref("remix", run.remixId) : "/wangzhuan-tasks.html");
    elements.runDetail.innerHTML = `<dl><dt>状态</dt><dd>${escapeHtml(statusLabel(run.status))}</dd><dt>排队</dt><dd>${escapeHtml(queueLabel(run))}</dd><dt>任务 ID</dt><dd>${escapeHtml(run.providerJobId)}</dd>${run.connectionError ? `<dt>连接</dt><dd>${escapeHtml(run.connectionError)}</dd>` : ""}${failure && !run.connectionError ? `<dt>失败原因</dt><dd>${escapeHtml(String(failure))}</dd>` : ""}</dl><div class="remix-run-actions"><button type="button" class="ghost" data-run-action="refresh" data-run-id="${escapeHtml(run.runId)}">刷新</button>${ACTIVE_STATUSES.has(run.status) ? `<button type="button" class="ghost" data-run-action="cancel" data-run-id="${escapeHtml(run.runId)}">取消</button>` : ""}${["failed", "canceled", "stopped"].includes(run.status) ? `<button type="button" class="ghost" data-run-action="retry" data-run-id="${escapeHtml(run.runId)}">重试</button>` : ""}${["succeeded", "review_required"].includes(run.status) ? `<button type="button" class="ghost" data-run-action="result" data-run-id="${escapeHtml(run.runId)}">读取结果</button>` : ""}${download ? `<a class="mini ghost" href="${escapeHtml(download)}" target="_blank" rel="noopener">下载输出</a>` : ""}<a class="mini ghost" href="${escapeHtml(archive)}">任务管理</a></div>${run.result ? `<pre class="remix-result-data">${escapeHtml(JSON.stringify(run.result, null, 2))}</pre>` : run.resultError ? `<div class="remix-inline-error">${escapeHtml(run.resultError)}</div>` : ""}`;
  }

  function render(state = store.getState()) {
    const { capability, mode, draft } = selection(state);
    renderCapabilities(state);
    renderModes(state, capability, mode);
    renderSource(state, capability);
    renderEditor(state, capability, mode, draft);
    renderReadiness(state, capability, mode, draft);
    renderRuns(state);
  }

  function buildManualMaskDataUrl(box, source) {
    if (!box) throw new Error("请先框选需要去除的区域");
    const width = Math.max(1, Math.round(source.metadata?.width || elements.sourceVideo.videoWidth || 720));
    const height = Math.max(1, Math.round(source.metadata?.height || elements.sourceVideo.videoHeight || 1280));
    const canvas = root.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成 mask 图片");
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#fff";
    context.fillRect(
      Math.round(box.x1 * width),
      Math.round(box.y1 * height),
      Math.max(1, Math.round((box.x2 - box.x1) * width)),
      Math.max(1, Math.round((box.y2 - box.y1) * height))
    );
    return canvas.toDataURL("image/png");
  }

  async function submitCurrent() {
    const state = store.getState();
    if (!state.user) {
      requireLogin?.();
      return;
    }
    const { capability, mode, draft } = selection(state);
    const validation = validateDraft({ capabilityId: capability.id, modeId: mode.id, source: state.source, draft });
    if (!validation.ok) {
      showFormError(Object.values(validation.errors)[0]);
      return;
    }
    submitting = true;
    showFormError("");
    render(store.getState());
    try {
      const source = capability.id === "analysis" ? store.getState().source : await media.prepareInput();
      const maskSource = capability.id === "remove" && mode.id === "fixed_region"
        ? buildManualMaskDataUrl(draft.box, source)
        : "";
      const payload = buildPayload({ capabilityId: capability.id, modeId: mode.id, source, draft, maskSource });
      const run = await runner.submit({
        capabilityId: capability.id,
        modeId: mode.id,
        capabilityLabel: capability.label,
        modeLabel: mode.label,
        payload
      });
      showToast(`任务已提交：${run.providerJobId}`);
    } catch (error) {
      showFormError(error?.message || "任务提交失败");
    } finally {
      submitting = false;
      render(store.getState());
    }
  }

  elements.capabilityList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-capability-id]");
    if (button) store.selectCapability(button.dataset.capabilityId);
  });
  elements.modeTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode-id]");
    if (!button) return;
    const state = store.getState();
    store.selectMode(state.selectedCapabilityId, button.dataset.modeId);
  });
  elements.videoControls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-source-mode]");
    if (!button) return;
    if (button.dataset.sourceMode === "file") elements.sourceFile.click();
    else media.setUrl(elements.sourceUrl.value);
  });
  elements.applyUrl.addEventListener("click", () => media.setUrl(elements.sourceUrl.value));
  elements.sourceUrl.addEventListener("change", () => media.setUrl(elements.sourceUrl.value));
  elements.chooseFile.addEventListener("click", () => elements.sourceFile.click());
  elements.sourceFile.addEventListener("change", () => {
    try {
      if (elements.sourceFile.files?.[0]) media.selectFile(elements.sourceFile.files[0]);
    } catch (error) {
      showFormError(error?.message || "视频文件不可用");
      elements.sourceFile.value = "";
    }
  });
  elements.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("remix-drop-active");
  });
  elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("remix-drop-active"));
  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("remix-drop-active");
    try {
      if (event.dataTransfer?.files?.[0]) media.selectFile(event.dataTransfer.files[0]);
    } catch (error) {
      showFormError(error?.message || "视频文件不可用");
    }
  });
  elements.reportText.addEventListener("input", () => store.patchSource({ reportText: elements.reportText.value }));
  elements.sourceVideo.addEventListener("loadedmetadata", () => media.updateMetadata({
    width: elements.sourceVideo.videoWidth,
    height: elements.sourceVideo.videoHeight,
    duration: elements.sourceVideo.duration
  }));
  elements.editorContent.addEventListener("input", (event) => {
    const input = event.target.closest("[data-field]");
    if (!input) return;
    const { capability, mode } = selection();
    const value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    store.updateDraft(capability.id, mode.id, { [input.dataset.field]: value });
    if (["promptType", "pointLabel"].includes(input.dataset.field)) configureEditor(store.getState(), capability, mode, store.getDraft(capability.id, mode.id));
  });
  elements.editorContent.addEventListener("change", (event) => {
    const input = event.target.closest("[data-field]");
    if (!input || !["frameTime", "frameIndex"].includes(input.dataset.field)) return;
    const { capability, mode, draft } = selection();
    const frameTime = input.dataset.field === "frameIndex" ? Number(input.value || 0) / 30 : Number(input.value || 0);
    store.updateDraft(capability.id, mode.id, { frameTime, frameIndex: Math.max(0, Math.round(frameTime * 30)) });
    configureEditor(store.getState(), capability, mode, store.getDraft(capability.id, mode.id));
  });
  elements.editorContent.addEventListener("click", (event) => {
    const button = event.target.closest("[data-editor-action]");
    if (!button) return;
    const { capability, mode } = selection();
    if (button.dataset.editorAction === "clear") regionEditor?.clear();
    if (button.dataset.editorAction === "undo-point") regionEditor?.undoPoint();
    if (button.dataset.editorAction === "use-current-frame") {
      const time = Number(elements.sourceVideo.currentTime || 0);
      store.updateDraft(capability.id, mode.id, { frameTime: time, frameIndex: Math.max(0, Math.round(time * 30)) });
    }
    if (button.dataset.editorAction === "sync-source-time") {
      const video = root.querySelector("#remixEditorVideo");
      if (video) video.currentTime = Number(elements.sourceVideo.currentTime || 0);
    }
  });
  elements.editorContent.addEventListener("input", (event) => {
    const slider = event.target.closest("#remixFrameSlider");
    if (!slider) return;
    const { capability, mode } = selection();
    const frameIndex = Math.max(0, Math.round(Number(slider.value || 0)));
    store.updateDraft(capability.id, mode.id, { frameIndex, frameTime: frameIndex / 30 });
  });
  elements.resetDraft.addEventListener("click", () => {
    editorKey = "";
    store.resetCurrentDraft();
    showFormError("");
  });
  elements.submit.addEventListener("click", submitCurrent);
  elements.runList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-run-id]");
    if (button) store.setActiveRun(button.dataset.runId);
  });
  elements.runDetail.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-run-action]");
    if (!button) return;
    button.disabled = true;
    showFormError("");
    try {
      if (button.dataset.runAction === "refresh") await runner.refresh(button.dataset.runId);
      if (button.dataset.runAction === "cancel") await runner.cancel(button.dataset.runId);
      if (button.dataset.runAction === "retry") await runner.retry(button.dataset.runId);
      if (button.dataset.runAction === "result") await runner.loadResult(button.dataset.runId);
    } catch (error) {
      showFormError(error?.message || "作业操作失败");
    } finally {
      button.disabled = false;
    }
  });

  const unsubscribe = store.subscribe(render);
  render(store.getState());

  function destroy() {
    unsubscribe();
    regionEditor?.destroy();
  }

  return { render, destroy, buildManualMaskDataUrl };
}
