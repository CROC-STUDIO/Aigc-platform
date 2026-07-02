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
  notifyBatchQcResult,
  applyQcReportsToBatch,
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
  stats: $("#wzTasksStats"),
  layout: $("#wzTasksLayout"),
  list: $("#wzTasksList"),
  pager: $("#wzTasksPager"),
  detailPane: $("#wzTasksDetailPane"),
  detail: $("#wzTasksDetail"),
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
  scope: "all",
  runType: "",
  page: 1,
  pageSize: 20,
  items: [],
  pagination: null,
  selectedId: "",
  selectedType: "",
  detail: null,
  stopPagePoll: null,
  loading: false,
  bootstrapped: false,
  listRequestId: 0,
  detailRequestId: 0
};

function shortId(value, head = 10, tail = 6) {
  const text = String(value || "");
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function taskDisplayTitle(item) {
  return item.productName || operationLabels[item.operationType] || item.operationType || "未命名任务";
}

function renderLoadingSkeleton() {
  els.list.className = "wz-tasks-list-host is-loading";
  els.list.setAttribute("aria-busy", "true");
  els.list.innerHTML = Array.from({ length: 6 }, (_, index) => `
    <div class="wz-tasks-skeleton" style="--wz-skeleton-delay: ${index * 70}ms" aria-hidden="true">
      <span class="wz-tasks-skeleton-line wz-tasks-skeleton-line-sm"></span>
      <span class="wz-tasks-skeleton-line"></span>
      <span class="wz-tasks-skeleton-line wz-tasks-skeleton-line-xs"></span>
    </div>
  `).join("");
}

function renderListEmpty(message) {
  els.list.className = "wz-tasks-list-host is-empty";
  els.list.removeAttribute("aria-busy");
  const hint = state.scope === "active"
    ? "进行中的任务会出现在这里。已完成或失败的批次请切换到「全部」或「已完成」。"
    : "切换筛选条件或刷新列表试试。";
  const showCreateActions = state.scope !== "terminal" && !state.runType;
  els.list.innerHTML = `
    <div class="wz-tasks-empty-state wz-tasks-empty-state-inline wz-tasks-empty-state-rich">
      <div class="wz-tasks-empty-icon" aria-hidden="true"></div>
      <strong>${escapeHtml(message)}</strong>
      <p>${escapeHtml(hint)}</p>
      ${showCreateActions ? `
        <div class="wz-tasks-empty-actions">
          <a class="mini" href="/wangzhuan-v2.html">去网赚管线创建</a>
          <a class="mini ghost" href="/competitor-remix.html">去竞品改造创建</a>
        </div>
      ` : ""}
    </div>
  `;
}

function renderDetailSkeleton() {
  els.detail.hidden = false;
  els.detail.className = "wz-tasks-detail is-loading";
  els.detail.innerHTML = `
    <div class="wz-tasks-detail-skeleton" aria-busy="true" aria-label="加载任务详情">
      <span class="wz-tasks-skeleton-line wz-tasks-skeleton-line-sm"></span>
      <span class="wz-tasks-skeleton-line"></span>
      <div class="wz-tasks-detail-skeleton-media"></div>
      <span class="wz-tasks-skeleton-line wz-tasks-skeleton-line-xs"></span>
    </div>
  `;
}

function updateTasksLayout() {
  const hasSelection = Boolean(state.selectedId && state.selectedType);
  els.layout?.classList.toggle("is-list-only", !hasSelection);
  if (els.detailPane) {
    if (hasSelection) {
      els.detailPane.hidden = false;
    } else {
      els.detailPane.hidden = true;
    }
  }
}

function renderStats() {
  if (!els.stats) return;
  const pagination = state.pagination;
  if (!pagination?.total && !state.items.length) {
    els.stats.hidden = true;
    els.stats.innerHTML = "";
    return;
  }
  const activeOnPage = state.items.filter((item) => item.isActive).length;
  const total = pagination?.total ?? state.items.length;
  els.stats.hidden = false;
  els.stats.innerHTML = `
    <div class="wz-tasks-stat">
      <strong>${escapeHtml(total)}</strong>
      <span>当前列表</span>
    </div>
    ${state.scope === "active" || activeOnPage ? `
      <div class="wz-tasks-stat is-live">
        <strong>${escapeHtml(activeOnPage)}</strong>
        <span>本页进行中</span>
      </div>
    ` : ""}
  `;
}

function readInitialSelection() {
  const params = new URLSearchParams(location.search);
  const batchId = params.get("batchId");
  const remixId = params.get("remixId");
  if (batchId) {
    state.selectedType = "batch";
    state.selectedId = batchId;
    state.scope = "all";
    return;
  }
  if (remixId) {
    state.selectedType = "remix";
    state.selectedId = remixId;
    state.scope = "all";
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

function taskTypeLabelShort(type) {
  return type === "remix" ? "改造" : "管线";
}

function statusStripeTone(status) {
  if (["succeeded", "pass"].includes(status)) return "good";
  if (["failed", "partial_failed", "preview_required", "warn", "manual_required"].includes(status)) {
    return "warn";
  }
  if (["stopped", "unsupported"].includes(status)) return "bad";
  return "neutral";
}

function taskListStripe(label, stripeClass) {
  return `
    <span class="wz-tasks-stripe ${stripeClass}">
      <span class="wz-tasks-stripe-line" aria-hidden="true"></span>
      <span class="wz-tasks-stripe-text">${escapeHtml(label)}</span>
    </span>
  `;
}

function typeStripe(type, label) {
  const stripeClass = type === "remix" ? "type-remix" : "type-pipeline";
  return taskListStripe(label, stripeClass);
}

function statusStripe(status, labelMap) {
  const label = labelMap[status] || status || "未知";
  return taskListStripe(label, `tone-${statusStripeTone(status)}`);
}

function taskPrimaryId(item) {
  return item.type === "remix" ? item.remixId : item.batchId;
}

function taskItemSignature(item) {
  if (!item) return "";
  return [
    item.type,
    taskPrimaryId(item),
    item.status,
    item.updatedAt,
    item.isActive ? "1" : "0",
    taskDisplayTitle(item)
  ].join(":");
}

function listSignature(items = []) {
  return items.map(taskItemSignature).join("|");
}

function detailSignature(detail) {
  if (!detail) return "";
  const entity = detail.batch || detail.remix;
  if (!entity) return "";
  const outputs = Array.isArray(entity.outputs) ? entity.outputs : [];
  const outputSig = outputs.map((output) => [
    output.outputId,
    output.qcStatus,
    output.downloadEligible ? "1" : "0",
    output.previewConfirmed ? "1" : "0"
  ].join(":")).join("|");
  return [
    entity.status,
    entity.updatedAt,
    detail.downloadSummary?.downloadEligibleCount || 0,
    detail.downloadSummary?.packageReady ? "1" : "0",
    outputSig
  ].join("|");
}

function shouldPollPage() {
  return shouldPollDetail(state.detail);
}

function stopPagePolling() {
  state.stopPagePoll?.();
  state.stopPagePoll = null;
}

function updatePagePolling() {
  stopPagePolling();
  if (!shouldPollPage()) return;
  state.stopPagePoll = schedulePoll({
    load: async () => {
      await loadSelectedDetail({ silent: true });
      return state.detail;
    },
    shouldStop: () => !shouldPollPage(),
    interval: 4000
  });
}

function assetPreviewUrl(asset) {
  if (!asset) return "";
  return String(asset.previewUrl || asset.storageUrl || "").trim()
    || (asset.storedPath ? `/file?path=${encodeURIComponent(asset.storedPath)}` : "");
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

function sortedOutputs(outputs = []) {
  const priority = new Map(OUTPUT_KIND_PRIORITY.map((kind, index) => [kind, index]));
  return (Array.isArray(outputs) ? [...outputs] : [])
    .filter(Boolean)
    .sort((a, b) => {
      const diff = (priority.get(a.kind) ?? 100) - (priority.get(b.kind) ?? 100);
      if (diff !== 0) return diff;
      return String(a.outputId || "").localeCompare(String(b.outputId || ""));
    });
}

function isIntermediateOutput(output = {}) {
  return output.kind === "segment_video" || output.kind === "segment";
}

function splitOutputGroups(outputs = []) {
  const items = sortedOutputs(outputs);
  return {
    finalOutputs: items.filter((output) => !isIntermediateOutput(output)),
    intermediateOutputs: items.filter(isIntermediateOutput)
  };
}

function outputStatusText(output = {}) {
  const parts = [];
  if (output.kind) parts.push(output.kind);
  if (output.qcStatus) parts.push(`QC ${output.qcStatus}`);
  parts.push(output.downloadEligible ? "可下载" : "不可下载");
  if (output.visualPreviewRequired && !output.previewConfirmed) parts.push("待预览确认");
  return parts.join(" · ");
}

function renderOutputQcIssues(output = {}) {
  const checks = Array.isArray(output.qcChecks) ? output.qcChecks : [];
  const issues = checks.filter((item) => ["fail", "warn", "manual_required"].includes(item.status));
  if (!issues.length) return "";
  return `
    <ul class="wz-tasks-qc-issues">
      ${issues.map((item) => `
        <li class="wz-tasks-qc-issue wz-tasks-qc-issue--${escapeHtml(item.status || "fail")}">
          <strong>${escapeHtml(item.checkId || "检查项")}</strong>
          <span>${escapeHtml(item.message || "")}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderOutputCards(items = []) {
  return `
    <div class="wz-tasks-output-grid">
      ${items.map((output) => `
        <article class="wz-tasks-output-card">
          <div class="wz-tasks-output-card-head">
            <strong>${escapeHtml(output.outputId || output.fileName || "输出")}</strong>
            ${output.downloadEligible ? badge("succeeded", { succeeded: "可下载" }) : badge("pending", { pending: "归档中" })}
          </div>
          ${renderMediaPlayer(output, "该输出暂不可预览")}
          <footer class="wz-tasks-media-meta">${escapeHtml(outputStatusText(output))}</footer>
          ${renderOutputQcIssues(output)}
          ${assetPreviewUrl(output) ? `<a class="wz-tasks-media-link" href="${escapeHtml(assetPreviewUrl(output))}" target="_blank" rel="noreferrer">新窗口打开</a>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderOutputStage({ title, description, items = [], emptyText, className = "" }) {
  return `
    <section class="wz-tasks-output-stage ${escapeHtml(className)}" aria-label="${escapeHtml(title)}">
      <header class="wz-tasks-media-stage-head">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </header>
      ${items.length ? renderOutputCards(items) : `<div class="wz-list empty-line">${escapeHtml(emptyText)}</div>`}
    </section>
  `;
}

function renderOutputCollection(outputs = []) {
  const { finalOutputs, intermediateOutputs } = splitOutputGroups(outputs);
  const hasAnyOutput = finalOutputs.length || intermediateOutputs.length;
  const finalStage = renderOutputStage({
    title: "交付结果",
    description: "最终成片、改造视频等面向交付的结果",
    items: finalOutputs,
    emptyText: hasAnyOutput ? "最终结果尚未生成" : "暂无输出"
  });
  const intermediateStage = intermediateOutputs.length
    ? renderOutputStage({
        title: "中间结果",
        description: "分段视频、诊断过程文件等中间产物，不作为最终交付成片",
        items: intermediateOutputs,
        emptyText: "暂无中间结果",
        className: "is-intermediate"
      })
    : "";
  return `${finalStage}${intermediateStage}`;
}

function renderDiagnosticArchive(providerJob = {}) {
  if (!providerJob?.resultPath && !providerJob?.resultStorageUrl) return "";
  const href = providerJob.resultStorageUrl || (providerJob.resultPath ? `/file?path=${encodeURIComponent(providerJob.resultPath)}` : "");
  return `
    <section class="wz-tasks-output-stage" aria-label="诊断归档">
      <header class="wz-tasks-media-stage-head">
        <h2>诊断归档</h2>
        <p>video-ops result、stage_timings 和 engine_trace 已归口到任务管理</p>
      </header>
      <article class="wz-tasks-output-card">
        <div class="wz-tasks-output-card-head">
          <strong>${escapeHtml(providerJob.jobId || "video-ops result")}</strong>
          ${badge("succeeded", { succeeded: "已归档" })}
        </div>
        <footer class="wz-tasks-media-meta">${escapeHtml(providerJob.resultPath || providerJob.resultStorageUrl || "")}</footer>
        ${href ? `<a class="wz-tasks-media-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">打开诊断结果</a>` : ""}
      </article>
    </section>
  `;
}

function renderMediaPlayer(asset, emptyText) {
  const url = assetPreviewUrl(asset);
  if (!url) {
    return `<div class="wz-tasks-media-empty">${escapeHtml(emptyText)}</div>`;
  }
  if (isVideoAsset(asset)) {
    return `
      <div class="wz-tasks-media-frame">
        <video src="${escapeHtml(url)}" controls preload="metadata" playsinline></video>
      </div>
    `;
  }
  return `
    <div class="wz-tasks-media-frame">
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
    button.setAttribute("aria-pressed", button.dataset.scope === state.scope ? "true" : "false");
  }
}

function renderTypeFilters() {
  for (const button of [els.typeAll, els.typePipeline, els.typeRemix]) {
    if (!button) continue;
    const active = (button.dataset.runType || "") === state.runType;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
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
    <span class="wz-tasks-pager-meta">共 ${escapeHtml(pagination.total)} 条 · 第 ${escapeHtml(pageLabel)} 页</span>
    <div class="wz-tasks-pager-actions">
      <button type="button" class="ghost" data-tasks-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
      <button type="button" class="ghost" data-tasks-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
    </div>
  `;
}

function renderTaskList() {
  renderScopeFilters();
  renderTypeFilters();
  renderStats();
  if (!state.items.length) {
    renderListEmpty(state.scope === "active" ? "暂无进行中的任务" : "暂无任务记录");
    renderPager();
    return;
  }
  els.list.className = "wz-tasks-list-host wz-tasks-list";
  els.list.removeAttribute("aria-busy");
  els.list.innerHTML = state.items.map((item) => {
    const id = taskPrimaryId(item);
    const selected = item.type === state.selectedType && id === state.selectedId;
    const labels = taskLabels(item.type);
    const typeClass = item.type === "remix" ? "remix" : "pipeline";
    const label = taskTypeLabelShort(item.type);
    const liveClass = item.isActive ? " is-live" : "";
    const title = taskDisplayTitle(item);
    return `
      <button type="button" class="wz-tasks-item${selected ? " selected" : ""}${liveClass}" data-task-type="${escapeHtml(item.type)}" data-task-id="${escapeHtml(id)}">
        <span class="wz-tasks-item-rail" aria-hidden="true"></span>
        <span class="wz-tasks-item-row">
          ${typeStripe(typeClass, label)}
          ${statusStripe(item.status, labels)}
          <strong class="wz-tasks-item-title" title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
          <code class="wz-tasks-item-id" title="${escapeHtml(id)}">${escapeHtml(shortId(id))}</code>
          <small class="wz-tasks-item-time">${escapeHtml(formatTimestamp(item.updatedAt || item.createdAt))}</small>
        </span>
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

function backgroundJobRetryLabel(jobType = "") {
  return jobType === "decomposition" ? "重试查询拆解结果" : "重试查询预案结果";
}

function renderBackgroundJobNotice(job, title) {
  if (!job) return "";
  const recoverable = Boolean(job.error?.recoverable);
  const reason = job.error?.message || job.message || "";
  const statusLabel = recoverable ? "可重试查询" : (job.status || "-");
  const action = recoverable
    ? `<a class="mini ghost" href="${escapeHtml(workbenchHref("batch", "running", state.selectedId, { jobType: job.type === "seedance_plan" ? "plan" : job.type, jobId: job.id }))}">${escapeHtml(backgroundJobRetryLabel(job.type))}</a>`
    : "";
  return `
    <div class="wz-warning wz-tasks-notice">
      <strong>${escapeHtml(title)}</strong>
      <div>${escapeHtml(statusLabel)}${reason ? `：${reason}` : ""}</div>
      ${action ? `<div>${action}</div>` : ""}
    </div>
  `;
}

function renderBatchDetail(detail) {
  const batch = detail?.batch;
  if (!batch) return "";
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const qcRunnable = isBatchQcRunnable(batch, tasks, outputs);
  const notice = detailNotice("batch", batch.status);
  const planJobNotice = renderBackgroundJobNotice(detail?.backgroundJobs?.latestPlanJob, "Seedance 预案后台任务");
  const decompositionJobNotice = renderBackgroundJobNotice(detail?.backgroundJobs?.latestDecompositionJob, "AI 拆解后台任务");
  const outputAsset = pickPrimaryOutput(batch.outputs);
  const outputLabel = outputAsset?.kind === "stitched_video" ? "拼接成片" : "输出视频";
  return `
    <article class="wz-tasks-detail-head">
      <div class="wz-tasks-detail-head-copy">
        <div class="wz-tasks-detail-head-badges">
          <span class="wz-tasks-type-badge pipeline">网赚素材管线</span>
          ${badge(batch.status, batchStatusLabels)}
        </div>
        <strong class="wz-tasks-detail-id" title="${escapeHtml(batch.batchId)}">${escapeHtml(batch.batchId)}</strong>
        <small>创建 ${escapeHtml(formatTimestamp(batch.createdAt))} · 更新 ${escapeHtml(formatTimestamp(batch.updatedAt))}</small>
      </div>
    </article>
    ${notice ? `<div class="wz-warning wz-tasks-notice">${escapeHtml(notice)}</div>` : ""}
    ${decompositionJobNotice}
    ${planJobNotice}
    ${renderTaskMediaCompare({
      inputAsset: batch.referenceVideo,
      outputAsset,
      inputLabel: "参考输入视频",
      outputLabel
    })}
    ${renderOutputCollection(batch.outputs)}
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
    <div class="modal-actions wz-actions wz-tasks-actions wz-tasks-actions-bar">
      ${batch.status === "preview_required" && plans.length ? `<button id="wzTasksConfirmPlanBtn" type="button">确认预案并生成视频</button>` : ""}
      ${qcRunnable ? `<button id="wzTasksRunQcBtn" type="button">${batch.status === "qc" ? "运行视频质检" : "重新质检"}</button>` : ""}
      <a class="mini ghost" href="${escapeHtml(workbenchHref("batch", batch.status, batch.batchId))}">前往管线工作台</a>
      ${!terminalBatchStatus(batch.status) ? `<button id="wzTasksStopBtn" class="ghost" type="button">${batch.status === "qc" ? "放弃批次" : "停止任务"}</button>` : ""}
      ${batch.status === "partial_failed" ? `<label class="wz-check"><input id="wzTasksIncludeSegments" type="checkbox" checked /> 下载可用分段/可用项</label>` : ""}
      ${detail.downloadSummary?.packageReady || batch.status === "partial_failed" ? `<button id="wzTasksDownloadBtn" type="button">${batch.status === "partial_failed" ? "下载可用项" : "下载交付包"}</button>` : ""}
    </div>
  `;
}

function renderRemixDetail(detail) {
  const remix = detail?.remix;
  if (!remix) return "";
  const output = pickPrimaryOutput(remix.outputs);
  const notice = detailNotice("remix", remix.status);
  return `
    <article class="wz-tasks-detail-head">
      <div class="wz-tasks-detail-head-copy">
        <div class="wz-tasks-detail-head-badges">
          <span class="wz-tasks-type-badge remix">竞品素材改造</span>
          ${badge(remix.status, remixStatusLabels)}
        </div>
        <strong class="wz-tasks-detail-id" title="${escapeHtml(remix.remixId)}">${escapeHtml(remix.remixId)}</strong>
        <small>${escapeHtml(operationLabels[remix.operationType] || remix.operationType || "-")}</small>
      </div>
    </article>
    ${notice ? `<div class="wz-warning wz-tasks-notice">${escapeHtml(notice)}</div>` : ""}
    ${renderTaskMediaCompare({
      inputAsset: remix.source,
      outputAsset: output,
      inputLabel: "竞品源视频",
      outputLabel: "改造输出"
    })}
    ${renderOutputCollection(remix.outputs)}
    ${renderDiagnosticArchive(remix.providerJob)}
    <div class="wz-kv-grid">
      ${renderKeyValues([
        ["渠道", channelLabels[remix.targetChannel] || remix.targetChannel || "-"],
        ["输出", remix.outputs?.length || 0],
        ["可下载", detail.downloadSummary?.downloadEligibleCount || 0],
        ["远端 Job", remix.providerJob?.jobId || "-"],
        ["远端状态", remix.providerJob?.status || "-"]
      ])}
    </div>
    <div class="modal-actions wz-actions wz-tasks-actions wz-tasks-actions-bar">
      <a class="mini ghost" href="${escapeHtml(workbenchHref("remix", remix.status, remix.remixId))}">前往改造工作台</a>
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

function renderDetailPanel(options = {}) {
  const { force = false } = options;
  updateTasksLayout();
  if (!state.selectedId || !state.selectedType) {
    els.detail.hidden = true;
    els.detail.innerHTML = "";
    return;
  }
  if (!state.detail) {
    renderDetailSkeleton();
    return;
  }
  els.detail.hidden = false;
  els.detail.className = "wz-tasks-detail";
  const nextHtml = state.selectedType === "remix"
    ? renderRemixDetail(state.detail)
    : renderBatchDetail(state.detail);
  if (!force && els.detail.innerHTML === nextHtml) return;
  const scrollTop = els.detail.scrollTop;
  els.detail.innerHTML = nextHtml;
  if (scrollTop > 0) els.detail.scrollTop = scrollTop;
}

async function loadTasks(options = {}) {
  const {
    scope,
    runType,
    page,
    silent = false,
    autoSelect = false
  } = options;
  if (scope) state.scope = scope;
  if (runType !== undefined) state.runType = runType;
  if (page) state.page = page;
  clearError(els.globalError);
  const requestId = ++state.listRequestId;
  state.loading = !silent;
  const previousSignature = listSignature(state.items);
  const hadRenderedList = Boolean(els.list?.querySelector(".wz-tasks-item"));
  if (!silent) {
    renderLoadingSkeleton();
    els.refreshBtn?.classList.add("is-spinning");
  } else {
    els.list?.setAttribute("aria-busy", "true");
  }
  const query = new URLSearchParams({
    scope: state.scope,
    page: String(state.page),
    pageSize: String(state.pageSize)
  });
  if (state.runType) query.set("runType", state.runType);
  try {
    const data = await apiEnvelope(`/api/wangzhuan/tasks?${query}`);
    if (requestId !== state.listRequestId) return;
    state.items = data.items || [];
    state.pagination = data.pagination || null;
    state.page = state.pagination?.page || state.page;
    if (autoSelect && !state.selectedId && state.items.length) {
      const firstActive = state.items.find((item) => item.isActive) || state.items[0];
      state.selectedType = firstActive.type;
      state.selectedId = taskPrimaryId(firstActive);
      syncSelectionUrl();
    }
    const nextSignature = listSignature(state.items);
    if (!silent || !hadRenderedList || previousSignature !== nextSignature) {
      renderTaskList();
    } else {
      renderScopeFilters();
      renderTypeFilters();
      renderStats();
      renderPager();
    }
  } catch (error) {
    if (requestId !== state.listRequestId) return;
    if (!silent || !hadRenderedList) {
      renderListEmpty("任务列表加载失败");
      renderStats();
      renderPager();
    }
    throw error;
  } finally {
    if (requestId === state.listRequestId) {
      state.loading = false;
      els.list?.removeAttribute("aria-busy");
      if (!silent) els.refreshBtn?.classList.remove("is-spinning");
    }
  }
}

async function loadSelectedDetail(options = {}) {
  const { silent = false } = options;
  if (!state.selectedId || !state.selectedType) {
    state.detail = null;
    stopPagePolling();
    renderDetailPanel({ force: true });
    return;
  }
  const requestId = ++state.detailRequestId;
  const previousSignature = detailSignature(state.detail);
  if (!silent && !state.detail) {
    renderDetailPanel({ force: true });
  } else if (silent) {
    els.detail?.setAttribute("aria-busy", "true");
  }
  const url = state.selectedType === "remix"
    ? `/api/wangzhuan/remix/${encodeURIComponent(state.selectedId)}`
    : `/api/wangzhuan/batches/${encodeURIComponent(state.selectedId)}`;
  try {
    const nextDetail = await apiEnvelope(url);
    if (requestId !== state.detailRequestId) return;
    state.detail = nextDetail;
    const nextSignature = detailSignature(state.detail);
    if (!silent || previousSignature !== nextSignature) {
      renderDetailPanel({ force: !silent || previousSignature !== nextSignature });
    }
    updatePagePolling();
  } catch (error) {
    if (requestId !== state.detailRequestId) return;
    if (!silent) {
      state.detail = null;
      renderDetailPanel({ force: true });
    }
    throw error;
  } finally {
    if (requestId === state.detailRequestId) {
      els.detail?.removeAttribute("aria-busy");
    }
  }
}

async function selectTask(type, id) {
  if (type === state.selectedType && id === state.selectedId) return;
  stopPagePolling();
  state.selectedType = type;
  state.selectedId = id;
  state.detail = null;
  syncSelectionUrl();
  renderTaskList();
  renderDetailPanel({ force: true });
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
    await refreshTasksPage({ silent: true });
  } catch (error) {
    renderError(els.globalError, error, "确认预案失败");
  } finally {
    setBusy(button, false);
  }
}

async function runSelectedBatchQc() {
  const batch = state.detail?.batch;
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  const outputs = Array.isArray(batch?.outputs) ? batch.outputs : [];
  if (!batch?.batchId || !isBatchQcRunnable(batch, tasks, outputs)) return;
  const button = $("#wzTasksRunQcBtn");
  setBusy(button, true, "质检中");
  try {
    const qcResult = await apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batch.batchId)}/qc`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await refreshTasksPage({ silent: true });
    if (state.detail?.batch && qcResult?.batch) {
      applyQcReportsToBatch(state.detail.batch, qcResult.reports || []);
      renderDetailPanel({ force: true });
    }
    notifyBatchQcResult(qcResult);
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
    await refreshTasksPage({ silent: true });
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
    await refreshTasksPage({ silent: true });
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
    let result;
    if (state.selectedType === "remix") {
      result = await downloadZip({
        remixIds: [state.selectedId],
        includeFailed: false,
        includeRemoteUrls: false
      });
    } else {
      result = await downloadZip({
        batchIds: [state.selectedId],
        includeSegments: Boolean($("#wzTasksIncludeSegments")?.checked),
        includeFailed: false,
        includeRemoteUrls: false
      });
    }
    showToast(`已开始下载 ${result?.fileName || "交付包"}`, { type: "success" });
  } catch (error) {
    renderError(els.globalError, error, "下载失败");
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  els.refreshBtn?.addEventListener("click", () => {
    refreshTasksPage({ silent: false })
      .catch((error) => renderError(els.globalError, error, "刷新失败"));
  });
  for (const button of [els.scopeActive, els.scopeAll, els.scopeDone]) {
    button?.addEventListener("click", () => {
      if (button.dataset.scope === state.scope) return;
      refreshTasksPage({ silent: true, scope: button.dataset.scope, page: 1 })
        .catch((error) => renderError(els.globalError, error, "加载任务失败"));
    });
  }
  for (const button of [els.typeAll, els.typePipeline, els.typeRemix]) {
    button?.addEventListener("click", () => {
      const runType = button.dataset.runType || "";
      if (runType === state.runType) return;
      refreshTasksPage({ silent: true, runType, page: 1 })
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
    const nextPage = Number(button.dataset.tasksPage);
    if (nextPage === state.page) return;
    loadTasks({ page: nextPage, silent: true })
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

async function refreshTasksPage(options = {}) {
  const {
    silent = false,
    autoSelect = false,
    scope,
    runType,
    page
  } = options;
  await loadTasks({ silent, autoSelect, scope, runType, page });
  if (state.selectedId) {
    await loadSelectedDetail({ silent });
  } else {
    stopPagePolling();
    renderDetailPanel({ force: true });
  }
}

async function loadInitialData() {
  if (state.bootstrapped) return;
  state.bootstrapped = true;
  readInitialSelection();
  const hadUrlSelection = Boolean(state.selectedId);
  await loadTasks({ autoSelect: !hadUrlSelection });
  if (state.selectedId) {
    await loadSelectedDetail();
  } else {
    renderDetailPanel({ force: true });
  }
  updatePagePolling();
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
