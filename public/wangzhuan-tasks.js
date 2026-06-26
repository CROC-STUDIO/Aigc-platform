import {
  $,
  apiEnvelope,
  badge,
  batchStatusLabels,
  bindLogin,
  channelLabels,
  clearError,
  confirmBatchPlanRequest,
  downloadZip,
  escapeHtml,
  formatTimestamp,
  idempotencyKey,
  isBatchQcRunnable,
  operationLabels,
  remixStatusLabels,
  renderError,
  renderKeyValues,
  schedulePoll,
  setBusy,
  showToast,
  stopWorkflowTask,
  terminalBatchStatus,
  workbenchHref
} from "./wangzhuan-common.js";

const els = {
  badge: $("#wzTasksUserBadge"),
  logoutBtn: $("#wzTasksLogoutBtn"),
  loginModal: $("#wzTasksLoginModal"),
  globalError: $("#wzTasksGlobalError"),
  refreshBtn: $("#wzTasksRefreshBtn"),
  list: $("#wzTasksList"),
  pager: $("#wzTasksPager"),
  detail: $("#wzTasksDetail"),
  detailEmpty: $("#wzTasksDetailEmpty"),
  scopeActive: $("#wzTasksScopeActive"),
  scopeAll: $("#wzTasksScopeAll"),
  scopeDone: $("#wzTasksScopeDone"),
  typeAll: $("#wzTasksTypeAll"),
  typePipeline: $("#wzTasksTypePipeline"),
  typeRemix: $("#wzTasksTypeRemix")
};

const OUTPUT_KIND_PRIORITY = ["stitched_video", "remix_video", "segment_video", "segment"];

const state = {
  user: null,
  scope: "active",
  runType: "",
  page: 1,
  pageSize: 20,
  items: [],
  pagination: null,
  selectedId: "",
  selectedType: "",
  detail: null,
  stopPoll: null
};

function readInitialSelection() {
  const params = new URLSearchParams(location.search);
  const batchId = params.get("batchId");
  const remixId = params.get("remixId");
  if (batchId) {
    state.selectedType = "batch";
    state.selectedId = batchId;
    return;
  }
  if (remixId) {
    state.selectedType = "remix";
    state.selectedId = remixId;
  }
}

function syncSelectionUrl() {
  const params = new URLSearchParams();
  if (state.selectedType === "batch" && state.selectedId) params.set("batchId", state.selectedId);
  if (state.selectedType === "remix" && state.selectedId) params.set("remixId", state.selectedId);
  const query = params.toString();
  const next = `${location.pathname}${query ? `?${query}` : ""}`;
  history.replaceState(null, "", next);
}

function taskLabels(type) {
  return type === "remix" ? remixStatusLabels : batchStatusLabels;
}

function taskTypeLabel(type) {
  return type === "remix" ? "竞品素材改造" : "网赚素材管线";
}

function taskPrimaryId(item) {
  return item.type === "remix" ? item.remixId : item.batchId;
}

function assetPreviewUrl(asset) {
  if (!asset) return "";
  return String(asset.previewUrl || asset.storageUrl || "").trim()
    || (asset.storedPath ? `/file?path=${encodeURIComponent(asset.storedPath)}` : "");
}

function mediaDimensions(asset) {
  return {
    width: Number(asset?.width || 0),
    height: Number(asset?.height || 0)
  };
}

function mediaAspectRatioValue(dimensions) {
  const w = Number(dimensions?.width);
  const h = Number(dimensions?.height);
  if (w > 0 && h > 0) return `${w} / ${h}`;
  return "9 / 16";
}

function isVideoAsset(asset) {
  const mime = String(asset?.mimeType || "").toLowerCase();
  const url = assetPreviewUrl(asset);
  return mime.startsWith("video/") || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

function formatMediaMeta(asset = {}) {
  const parts = [];
  if (asset.fileName) parts.push(asset.fileName);
  if (asset.durationSec != null && asset.durationSec !== "") parts.push(`${Number(asset.durationSec)}s`);
  if (asset.ratio) parts.push(asset.ratio);
  else if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.kind && asset.kind !== "video") parts.push(asset.kind);
  return parts.join(" · ") || "暂无元数据";
}

function pickPrimaryOutput(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return null;
  const score = (output) => {
    const idx = OUTPUT_KIND_PRIORITY.indexOf(output.kind);
    return idx === -1 ? 100 : idx;
  };
  return [...outputs]
    .sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      return (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0);
    })
    .find((output) => assetPreviewUrl(output)) || outputs[0];
}

function renderMediaPlayer(asset, emptyText) {
  const url = assetPreviewUrl(asset);
  if (!url) {
    return `<div class="wz-tasks-media-empty">${escapeHtml(emptyText)}</div>`;
  }
  const aspect = mediaAspectRatioValue(mediaDimensions(asset));
  if (isVideoAsset(asset)) {
    return `
      <div class="wz-tasks-media-frame" style="--wz-media-aspect: ${escapeHtml(aspect)}">
        <video src="${escapeHtml(url)}" controls preload="metadata" playsinline></video>
      </div>
    `;
  }
  return `
    <div class="wz-tasks-media-frame" style="--wz-media-aspect: ${escapeHtml(aspect)}">
      <img src="${escapeHtml(url)}" alt="素材预览" />
    </div>
  `;
}

function renderTaskMediaCompare({ inputAsset, outputAsset, inputLabel = "输入素材", outputLabel = "输出成片" }) {
  return `
    <section class="wz-tasks-media-stage" aria-label="输入与输出预览">
      <header class="wz-tasks-media-stage-head">
        <h2>素材预览</h2>
        <p>对比任务初始输入与最终交付输出</p>
      </header>
      <div class="wz-tasks-media-grid">
        <article class="wz-tasks-media-card is-input">
          <div class="wz-tasks-media-card-head">
            <span class="wz-tasks-media-tag">输入</span>
            <strong>${escapeHtml(inputLabel)}</strong>
          </div>
          ${renderMediaPlayer(inputAsset, "输入视频尚未关联或暂不可预览")}
          <footer class="wz-tasks-media-meta">${escapeHtml(formatMediaMeta(inputAsset || {}))}</footer>
          ${assetPreviewUrl(inputAsset) ? `<a class="wz-tasks-media-link" href="${escapeHtml(assetPreviewUrl(inputAsset))}" target="_blank" rel="noreferrer">新窗口打开</a>` : ""}
        </article>
        <div class="wz-tasks-media-arrow" aria-hidden="true"><span>→</span></div>
        <article class="wz-tasks-media-card is-output">
          <div class="wz-tasks-media-card-head">
            <span class="wz-tasks-media-tag">输出</span>
            <strong>${escapeHtml(outputLabel)}</strong>
          </div>
          ${renderMediaPlayer(outputAsset, "输出仍在生成中，完成后可在此预览")}
          <footer class="wz-tasks-media-meta">${escapeHtml(formatMediaMeta(outputAsset || {}))}</footer>
          ${assetPreviewUrl(outputAsset) ? `<a class="wz-tasks-media-link" href="${escapeHtml(assetPreviewUrl(outputAsset))}" target="_blank" rel="noreferrer">新窗口打开</a>` : ""}
        </article>
      </div>
    </section>
  `;
}

function renderScopeFilters() {
  for (const button of [els.scopeActive, els.scopeAll, els.scopeDone]) {
    if (!button) continue;
    button.classList.toggle("active", button.dataset.scope === state.scope);
  }
}

function renderTypeFilters() {
  for (const button of [els.typeAll, els.typePipeline, els.typeRemix]) {
    if (!button) continue;
    const active = (button.dataset.runType || "") === state.runType;
    button.classList.toggle("active", active);
  }
}

function renderPager() {
  const pagination = state.pagination;
  if (!pagination?.total) {
    els.pager.hidden = true;
    els.pager.textContent = "";
    return;
  }
  els.pager.hidden = false;
  const pageLabel = pagination.totalPages ? `${pagination.page} / ${pagination.totalPages}` : "0 / 0";
  els.pager.innerHTML = `
    <span>共 ${escapeHtml(pagination.total)} 条 · 第 ${escapeHtml(pageLabel)} 页</span>
    <div>
      <button type="button" class="ghost" data-tasks-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
      <button type="button" class="ghost" data-tasks-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
    </div>
  `;
}

function renderTaskList() {
  renderScopeFilters();
  renderTypeFilters();
  if (!state.items.length) {
    els.list.className = "wz-list empty-line";
    els.list.textContent = state.scope === "active" ? "暂无进行中的任务" : "暂无任务记录";
    renderPager();
    return;
  }
  els.list.className = "wz-list wz-tasks-list";
  els.list.innerHTML = state.items.map((item) => {
    const id = taskPrimaryId(item);
    const selected = item.type === state.selectedType && id === state.selectedId;
    const labels = taskLabels(item.type);
    const typeClass = item.type === "remix" ? "remix" : "pipeline";
    const label = item.typeLabel || taskTypeLabel(item.type);
    return `
      <button type="button" class="wz-tasks-item${selected ? " selected" : ""}" data-task-type="${escapeHtml(item.type)}" data-task-id="${escapeHtml(id)}">
        <div class="wz-tasks-item-head">
          <span class="wz-tasks-type-badge ${typeClass}">${escapeHtml(label)}</span>
          ${badge(item.status, labels)}
        </div>
        <div class="wz-tasks-item-body">
          <span>${escapeHtml(id)}</span>
          <small>${escapeHtml(item.productName || item.operationType || "-")} · ${escapeHtml(formatTimestamp(item.updatedAt || item.createdAt))}</small>
        </div>
      </button>
    `;
  }).join("");
  renderPager();
}

function detailNotice(type, status) {
  if (type === "batch" && status === "preview_required") {
    return "批次已生成 Seedance 预案，请在此确认后开始生成视频。";
  }
  if (type === "batch" && status === "qc") {
    return "视频已生成完成，下一步请运行视频质检；质检通过后才能下载交付包。";
  }
  if (type === "batch" && status === "failed") {
    return "当前批次已有视频输出但质检未通过，可重新运行视频质检，无需重新提交 Seedance。";
  }
  if (type === "remix" && status === "preview_required") {
    return "改造已完成，请预览输出并确认交付。";
  }
  if (status === "partial_failed") return "任务部分失败，可在工作台重试拼接或下载可用分段。";
  return "";
}

function renderBatchDetail(detail) {
  const batch = detail?.batch;
  if (!batch) return "";
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const qcRunnable = isBatchQcRunnable(batch, tasks, outputs);
  const notice = detailNotice("batch", batch.status);
  const outputAsset = pickPrimaryOutput(batch.outputs);
  const outputLabel = outputAsset?.kind === "stitched_video" ? "拼接成片" : "输出视频";
  return `
    <article class="wz-row wz-tasks-detail-head">
      <div>
        <span class="wz-tasks-type-badge pipeline">网赚素材管线</span>
        <strong>${escapeHtml(batch.batchId)}</strong>
        <small>创建 ${escapeHtml(formatTimestamp(batch.createdAt))} · 更新 ${escapeHtml(formatTimestamp(batch.updatedAt))}</small>
      </div>
      ${badge(batch.status, batchStatusLabels)}
    </article>
    ${notice ? `<div class="wz-warning">${escapeHtml(notice)}</div>` : ""}
    ${renderTaskMediaCompare({
      inputAsset: batch.referenceVideo,
      outputAsset,
      inputLabel: "参考输入视频",
      outputLabel
    })}
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["任务数", tasks.length],
        ["Seedance 预案", plans.length],
        ["输出总数", detail.downloadSummary?.outputsTotal || 0],
        ["可下载", detail.downloadSummary?.downloadEligibleCount || 0],
        ["包状态", detail.downloadSummary?.packageReady ? "ready" : "not_ready"]
      ])}
    </div>
    ${plans.length ? `
      <div class="wz-task-list">
        ${plans.slice(0, 8).map((plan) => `
          <div>
            <span>${escapeHtml(plan.branchLabel || plan.branchId || "分支")} / 变体 ${escapeHtml(plan.branchVariantIndex || plan.variantIndex || "-")}</span>
            <strong>${escapeHtml(plan.status || "drafted")}</strong>
          </div>
        `).join("")}
      </div>
    ` : batch.status === "preview_required" ? `<div class="wz-warning">未读取到 Seedance 预案，请刷新或前往管线工作台第 4 步查看。</div>` : ""}
    <div class="modal-actions wz-actions wz-tasks-actions">
      ${batch.status === "preview_required" && plans.length ? `<button id="wzTasksConfirmPlanBtn" type="button">确认预案并生成视频</button>` : ""}
      ${qcRunnable ? `<button id="wzTasksRunQcBtn" type="button">${batch.status === "qc" ? "运行视频质检" : "重新质检"}</button>` : ""}
      <a class="mini ghost" href="${escapeHtml(workbenchHref("batch", batch.status))}">前往管线工作台</a>
      ${!terminalBatchStatus(batch.status) ? `<button id="wzTasksStopBtn" class="ghost" type="button">${batch.status === "qc" ? "放弃批次" : "停止任务"}</button>` : ""}
      ${detail.downloadSummary?.packageReady ? `<button id="wzTasksDownloadBtn" type="button">下载交付包</button>` : ""}
    </div>
  `;
}

function renderRemixDetail(detail) {
  const remix = detail?.remix;
  if (!remix) return "";
  const output = pickPrimaryOutput(remix.outputs);
  const notice = detailNotice("remix", remix.status);
  return `
    <article class="wz-row wz-tasks-detail-head">
      <div>
        <span class="wz-tasks-type-badge remix">竞品素材改造</span>
        <strong>${escapeHtml(remix.remixId)}</strong>
        <small>${escapeHtml(operationLabels[remix.operationType] || remix.operationType || "-")}</small>
      </div>
      ${badge(remix.status, remixStatusLabels)}
    </article>
    ${notice ? `<div class="wz-warning">${escapeHtml(notice)}</div>` : ""}
    ${renderTaskMediaCompare({
      inputAsset: remix.source,
      outputAsset: output,
      inputLabel: "竞品源视频",
      outputLabel: "改造输出"
    })}
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["渠道", channelLabels[remix.targetChannel] || remix.targetChannel || "-"],
        ["输出", remix.outputs?.length || 0],
        ["可下载", detail.downloadSummary?.downloadEligibleCount || 0],
        ["远端 Job", remix.providerJob?.jobId || "-"],
        ["远端状态", remix.providerJob?.status || "-"]
      ])}
    </div>
    <div class="modal-actions wz-actions wz-tasks-actions">
      <a class="mini ghost" href="${escapeHtml(workbenchHref("remix", remix.status))}">前往改造工作台</a>
      ${remix.status === "preview_required" && output ? `<button id="wzTasksConfirmPreviewBtn" type="button">确认预览</button>` : ""}
      ${!["succeeded", "failed", "stopped"].includes(remix.status) ? `<button id="wzTasksStopBtn" class="ghost" type="button">停止任务</button>` : ""}
      ${detail.downloadSummary?.packageReady ? `<button id="wzTasksDownloadBtn" type="button">下载交付包</button>` : ""}
    </div>
  `;
}

function shouldPollDetail(detail) {
  if (state.selectedType === "batch") {
    const status = detail?.batch?.status;
    return Boolean(status && !terminalBatchStatus(status));
  }
  const status = detail?.remix?.status;
  return Boolean(status && !["succeeded", "failed", "stopped"].includes(status));
}

function renderDetailPanel() {
  if (!state.detail) {
    els.detail.hidden = true;
    els.detailEmpty.hidden = false;
    return;
  }
  els.detailEmpty.hidden = true;
  els.detail.hidden = false;
  els.detail.className = "wz-list wz-tasks-detail";
  els.detail.innerHTML = state.selectedType === "remix"
    ? renderRemixDetail(state.detail)
    : renderBatchDetail(state.detail);
}

async function loadTasks(options = {}) {
  if (options.scope) state.scope = options.scope;
  if (options.runType !== undefined) state.runType = options.runType;
  if (options.page) state.page = options.page;
  clearError(els.globalError);
  const query = new URLSearchParams({
    scope: state.scope,
    page: String(state.page),
    pageSize: String(state.pageSize)
  });
  if (state.runType) query.set("runType", state.runType);
  const data = await apiEnvelope(`/api/wangzhuan/tasks?${query}`);
  state.items = data.items || [];
  state.pagination = data.pagination || null;
  state.page = state.pagination?.page || state.page;
  if (state.selectedId && !state.items.some((item) => taskPrimaryId(item) === state.selectedId && item.type === state.selectedType)) {
    // Keep deep-linked selection even if it is not on the current page.
  } else if (!state.selectedId && state.items.length) {
    const firstActive = state.items.find((item) => item.isActive) || state.items[0];
    state.selectedType = firstActive.type;
    state.selectedId = taskPrimaryId(firstActive);
    syncSelectionUrl();
  }
  renderTaskList();
}

async function loadSelectedDetail() {
  state.stopPoll?.();
  state.stopPoll = null;
  if (!state.selectedId || !state.selectedType) {
    state.detail = null;
    renderDetailPanel();
    return;
  }
  const url = state.selectedType === "remix"
    ? `/api/wangzhuan/remix/${encodeURIComponent(state.selectedId)}`
    : `/api/wangzhuan/batches/${encodeURIComponent(state.selectedId)}`;
  state.detail = await apiEnvelope(url);
  renderDetailPanel();
  if (shouldPollDetail(state.detail)) {
    state.stopPoll = schedulePoll({
      load: async () => {
        state.detail = await apiEnvelope(url);
        renderDetailPanel();
        return state.detail;
      },
      shouldStop: () => !shouldPollDetail(state.detail),
      interval: 3000
    });
  }
}

async function selectTask(type, id) {
  state.selectedType = type;
  state.selectedId = id;
  syncSelectionUrl();
  renderTaskList();
  try {
    await loadSelectedDetail();
  } catch (error) {
    renderError(els.globalError, error, "加载任务详情失败");
  }
}

async function confirmBatchPlan() {
  const batch = state.detail?.batch;
  const plans = batch?.plans || [];
  if (!batch?.batchId || !plans.length) return;
  const button = $("#wzTasksConfirmPlanBtn");
  setBusy(button, true, "确认中");
  try {
    await confirmBatchPlanRequest(batch.batchId, plans);
    showToast("批次已提交生成，正在后台处理", { type: "success" });
    await loadSelectedDetail();
    await loadTasks();
  } catch (error) {
    renderError(els.globalError, error, "确认预案失败");
  } finally {
    setBusy(button, false);
  }
}

async function runSelectedBatchQc() {
  const batch = state.detail?.batch;
  if (!batch?.batchId || batch.status !== "qc") return;
  const button = $("#wzTasksRunQcBtn");
  setBusy(button, true, "质检中");
  try {
    state.detail = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/qc`, {
      method: "POST",
      body: JSON.stringify({})
    });
    showToast("视频质检已完成", { type: "success" });
    renderDetailPanel();
    await loadTasks();
  } catch (error) {
    renderError(els.globalError, error, "视频质检失败");
  } finally {
    setBusy(button, false);
  }
}

async function confirmRemixPreview() {
  const remix = state.detail?.remix;
  const output = pickPrimaryOutput(remix?.outputs);
  if (!remix?.remixId || !output) return;
  const button = $("#wzTasksConfirmPreviewBtn");
  setBusy(button, true, "确认中");
  try {
    await apiEnvelope(`/api/wangzhuan/remix/${encodeURIComponent(remix.remixId)}/preview-confirm`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotencyKey("remix_preview_confirm"),
        outputId: output.outputId,
        confirmationNotes: ""
      })
    });
    showToast("预览已确认", { type: "success" });
    await loadSelectedDetail();
    await loadTasks();
  } catch (error) {
    renderError(els.globalError, error, "确认预览失败");
  } finally {
    setBusy(button, false);
  }
}

async function stopSelectedTask() {
  if (!state.selectedId || !state.selectedType) return;
  const button = $("#wzTasksStopBtn");
  setBusy(button, true, "停止中");
  try {
    state.detail = await stopWorkflowTask(state.selectedType, state.selectedId, "frontend_stop_from_tasks_page");
    showToast("任务已停止", { type: "success" });
    renderDetailPanel();
    await loadTasks();
  } catch (error) {
    renderError(els.globalError, error, "停止任务失败");
  } finally {
    setBusy(button, false);
  }
}

async function downloadSelectedTask() {
  const button = $("#wzTasksDownloadBtn");
  setBusy(button, true, "打包中");
  try {
    if (state.selectedType === "remix") {
      await downloadZip({
        remixIds: [state.selectedId],
        includeFailed: false,
        includeRemoteUrls: false
      });
    } else {
      await downloadZip({
        batchIds: [state.selectedId],
        includeSegments: false,
        includeFailed: false,
        includeRemoteUrls: false
      });
    }
  } catch (error) {
    renderError(els.globalError, error, "下载失败");
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  els.refreshBtn?.addEventListener("click", () => {
    loadTasks().then(() => loadSelectedDetail()).catch((error) => renderError(els.globalError, error, "刷新失败"));
  });
  for (const button of [els.scopeActive, els.scopeAll, els.scopeDone]) {
    button?.addEventListener("click", () => {
      loadTasks({ scope: button.dataset.scope, page: 1 })
        .then(() => loadSelectedDetail())
        .catch((error) => renderError(els.globalError, error, "加载任务失败"));
    });
  }
  for (const button of [els.typeAll, els.typePipeline, els.typeRemix]) {
    button?.addEventListener("click", () => {
      loadTasks({ runType: button.dataset.runType || "", page: 1 })
        .then(() => loadSelectedDetail())
        .catch((error) => renderError(els.globalError, error, "加载任务失败"));
    });
  }
  els.list?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-task-id]");
    if (!item) return;
    selectTask(item.dataset.taskType, item.dataset.taskId);
  });
  els.pager?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tasks-page]");
    if (!button || button.disabled) return;
    loadTasks({ page: Number(button.dataset.tasksPage) })
      .catch((error) => renderError(els.globalError, error, "加载任务失败"));
  });
  els.detail?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("#wzTasksConfirmPlanBtn")) {
      confirmBatchPlan();
      return;
    }
    if (event.target.closest("#wzTasksRunQcBtn")) {
      runSelectedBatchQc();
      return;
    }
    if (event.target.closest("#wzTasksConfirmPreviewBtn")) {
      confirmRemixPreview();
      return;
    }
    if (event.target.closest("#wzTasksStopBtn")) {
      stopSelectedTask();
      return;
    }
    if (event.target.closest("#wzTasksDownloadBtn")) {
      downloadSelectedTask();
    }
  });
}

async function loadInitialData() {
  readInitialSelection();
  await loadTasks();
  if (state.selectedId) {
    await loadSelectedDetail();
  } else {
    renderDetailPanel();
  }
}

async function init() {
  bindEvents();
  await bindLogin({
    modal: els.loginModal,
    badge: els.badge,
    logoutBtn: els.logoutBtn,
    onAuthed: (user) => {
      state.user = user;
      loadInitialData().catch((error) => renderError(els.globalError, error, "页面初始化失败"));
    }
  });
}

init();
