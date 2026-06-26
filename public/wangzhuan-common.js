const JSON_HEADERS = { "Content-Type": "application/json" };

export class WangzhuanApiError extends Error {
  constructor(payload = {}, status = 0) {
    super(payload.message || payload.error || "请求失败");
    this.name = "WangzhuanApiError";
    this.code = payload.code || payload.error || "request_failed";
    this.data = payload.data || {};
    this.requestId = payload.requestId || "";
    this.status = status;
  }
}

export const channelLabels = {
  generic: "通用",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
  google_ads: "Google Ads",
  unity_ads: "Unity Ads",
  iron_source: "ironSource"
};

export const promiseLabels = {
  stable: "稳健版",
  strong_conversion: "强转化版",
  strong_commitment: "强承诺版"
};

export const operationLabels = {
  text_cta_ending_replace: "文字/CTA/ending 替换",
  logo_icon_cover_or_replace: "Logo/Icon 区域遮挡或替换",
  watermark_cover: "水印区域遮挡"
};

export const batchStatusLabels = {
  draft: "草稿",
  checking: "检查中",
  queued: "排队中",
  running: "生成中",
  stitching: "拼接中",
  qc: "待质检",
  preview_required: "待预览确认",
  succeeded: "已完成",
  partial_failed: "部分失败",
  failed: "失败",
  skipped: "已跳过",
  stopped: "已停止"
};

export const batchGenerationTaskStatusLabels = {
  pending: "排队中",
  pending_preview: "待确认预案",
  waiting_upstream: "等待 Seedance",
  downloaded: "已下载",
  qc: "待复检",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
  stopped: "已停止"
};

export function batchStatusDisplayLabel(batch = {}) {
  const status = String(batch.status || "");
  if (status !== "qc") return batchStatusLabels[status] || status;
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const qcStarted = outputs.some((output) => output.qcStatus && output.qcStatus !== "not_started");
  return qcStarted ? "质检中" : batchStatusLabels.qc;
}

export function batchGenerationProgress(batch = {}, tasks = []) {
  const total = tasks.length;
  const generationDoneStatuses = new Set(["downloaded", "qc", "succeeded", "failed", "skipped", "stopped"]);
  const done = tasks.filter((task) => generationDoneStatuses.has(task.status)).length;
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const qcStarted = outputs.some((output) => output.qcStatus && output.qcStatus !== "not_started");
  if (batch.status === "qc" && done === total && total > 0 && !qcStarted) {
    return {
      label: batchStatusLabels.qc,
      detail: `${done}/${total} 段视频已就绪，待执行质检`,
      percent: 100,
      indeterminate: false
    };
  }
  if (batch.status === "qc" && qcStarted) {
    const qcDone = outputs.filter((output) => output.qcStatus && output.qcStatus !== "not_started").length;
    return {
      label: "质检中",
      detail: outputs.length ? `${qcDone}/${outputs.length} 个输出已质检` : "正在执行质检",
      percent: outputs.length ? Math.round((qcDone / outputs.length) * 100) : null,
      indeterminate: !outputs.length
    };
  }
  return {
    label: batchStatusDisplayLabel(batch),
    detail: total ? `${done}/${total} 个子任务` : "正在等待任务分配",
    percent: total ? Math.round((done / total) * 100) : null,
    indeterminate: !total && ["queued", "checking", "running", "stitching", "qc"].includes(batch.status)
  };
}

const DONE_TASK_STATUSES = new Set(["downloaded", "qc", "succeeded", "failed", "skipped", "stopped"]);

function timestampMs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function formatTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    return text.slice(0, 16).replace("T", " ");
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function doneTaskCount(tasks = []) {
  return tasks.filter((task) => DONE_TASK_STATUSES.has(task.status)).length;
}

function taskDurationMs(task = {}) {
  const started = timestampMs(task.startedAt || task.createdAt);
  const finished = timestampMs(task.finishedAt || task.updatedAt);
  return started && finished && finished >= started ? finished - started : 0;
}

export function batchRuntimeSummary(batch = {}, tasks = [], { now = Date.now() } = {}) {
  const nowMs = typeof now === "number" ? now : timestampMs(now);
  const total = tasks.length;
  const done = doneTaskCount(tasks);
  const startedMs = timestampMs(batch.startedAt || batch.createdAt);
  const endMs = timestampMs(batch.finishedAt || batch.stoppedAt) || nowMs || timestampMs(batch.updatedAt);
  const completedDurations = tasks.map(taskDurationMs).filter((value) => value > 0);
  const averageDoneMs = completedDurations.length
    ? completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length
    : startedMs && done > 0 && endMs > startedMs
      ? (endMs - startedMs) / done
      : 0;
  const remaining = Math.max(0, total - done);
  const active = !terminalBatchStatus(batch.status);
  return {
    createdAt: formatTimestamp(batch.createdAt),
    updatedAt: formatTimestamp(batch.updatedAt),
    elapsed: startedMs && endMs >= startedMs ? formatDuration(endMs - startedMs) : "-",
    eta: total && remaining === 0
      ? "已完成"
      : active && averageDoneMs && remaining
        ? `约 ${formatDuration(averageDoneMs * remaining)}`
        : total
          ? "计算中"
          : "等待任务",
    progressText: total ? `${done}/${total}` : "0/0",
    percent: total ? Math.round((done / total) * 100) : null
  };
}

export function modelQcStatusLabel(outputs = [], qcRunnable = false) {
  if (!outputs.length) return qcRunnable ? "待执行（需手动点击）" : "未就绪";
  const modelChecked = outputs.filter((output) =>
    output.modelQcSummary
    || (Array.isArray(output.qcChecks) && output.qcChecks.some((check) => check.checkId === "model_video_qc"))
  );
  if (modelChecked.length === outputs.length) return "已执行";
  if (modelChecked.length > 0) return `部分执行（${modelChecked.length}/${outputs.length}）`;
  const ruleQcDone = outputs.every((output) => output.qcStatus && output.qcStatus !== "not_started");
  if (ruleQcDone) return "已执行（规则质检，模型未跑）";
  return qcRunnable ? "待执行（需手动点击）" : "未就绪";
}

export function isBatchQcRunnable(batch = {}, tasks = [], outputs = []) {
  if (!outputs.length || !tasks.length) return false;
  const generationDoneStatuses = new Set(["downloaded", "qc", "succeeded"]);
  if (!tasks.every((task) => generationDoneStatuses.has(task.status))) return false;
  if (batch.status === "qc") {
    return outputs.some((output) => output.qcStatus === "not_started");
  }
  if (batch.status === "failed" || batch.status === "partial_failed") {
    return outputs.some((output) => ["fail", "warn", "manual_required"].includes(output.qcStatus));
  }
  return false;
}

export const workflowTriggerLabels = {
  batch_prepared: "批次已准备",
  seedance_plan_generated: "Seedance 预案已生成",
  plan_confirmed: "预案已确认",
  generation_task_submitted: "Seedance 任务已提交",
  generation_completed: "视频生成完成",
  segments_completed: "分段输出已落盘",
  stitch_progress: "拼接进行中",
  stitch_completed: "拼接完成",
  qc_started: "质检已开始",
  qc_completed: "质检完成",
  user_stop: "用户停止",
  batch_write: "批次更新"
};

export function formatWorkflowEvent(event = {}) {
  const trigger = event.triggerName || event.event || "";
  const label = workflowTriggerLabels[trigger] || trigger || "状态变更";
  if (event.entityType === "workflow_task" && event.toStatus) {
    const taskStatus = batchGenerationTaskStatusLabels[event.toStatus] || event.toStatus;
    return `${label} · 子任务 ${event.entityUid || ""} → ${taskStatus}`.trim();
  }
  if (event.fromStatus && event.toStatus) {
    const fromLabel = batchStatusLabels[event.fromStatus] || event.fromStatus;
    const toLabel = batchStatusLabels[event.toStatus] || event.toStatus;
    return `${label} · ${fromLabel} → ${toLabel}`;
  }
  return label;
}

export function isBatchGenerationActive(batch = {}, tasks = []) {
  if (!batch || terminalBatchStatus(batch.status)) return false;
  if (["queued", "running", "stitching"].includes(batch.status)) return true;
  return tasks.some((task) => ["pending", "waiting_upstream"].includes(task.status));
}

export function generationTaskUpstreamLabel(task = {}) {
  const response = task.responseSummary || {};
  const upstream = String(response.upstreamStatus || response.status || "").toLowerCase();
  if (task.status === "pending") return "排队提交 Seedance";
  if (task.status === "waiting_upstream") {
    if (upstream === "running" || upstream === "processing") return "Seedance 生成中";
    if (upstream === "queued") return "Seedance 排队中";
    if (upstream === "succeeded") return "Seedance 已完成，等待落盘";
    return "等待 Seedance 响应";
  }
  if (task.status === "downloaded") return "视频已下载";
  if (task.status === "failed") return task.errorMessage || "生成失败";
  return batchGenerationTaskStatusLabels[task.status] || task.status || "未知";
}

export function summarizeGenerationRequest(task = {}) {
  const request = task.requestSummary || {};
  const content = Array.isArray(request.content) ? request.content : [];
  const references = Array.isArray(request.references) ? request.references : [];
  const mediaItems = references.length
    ? references
    : content.filter((item) => item?.type && item.type !== "text");
  const mediaCount = mediaItems.length;
  const typeCounts = mediaItems.reduce((counts, item) => {
    const type = String(item?.type || "").replace(/_url$/, "") || "media";
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  const typeSummary = Object.entries(typeCounts).map(([type, count]) => `${type} ${count}`).join(" / ");
  const parts = [
    request.mode ? `模式 ${request.mode}` : "",
    request.model ? `模型 ${request.model}` : "",
    mediaCount ? `${mediaCount} 个参考素材${typeSummary ? `（${typeSummary}）` : ""}` : "纯文生视频",
    request.generate_audio === true ? "含音频" : request.generate_audio === false ? "静音" : ""
  ].filter(Boolean);
  return parts.join(" · ") || "等待提交";
}

export function renderGenerationTaskCards(tasks = []) {
  if (!tasks.length) return "";
  return tasks.map((task) => {
    const upstream = generationTaskUpstreamLabel(task);
    const requestLine = summarizeGenerationRequest(task);
    const live = ["pending", "waiting_upstream"].includes(task.status);
    return `
      <article class="wz-generation-task${live ? " is-live" : ""}">
        <div class="wz-generation-task-head">
          <strong>${escapeHtml(task.generationTaskId)}</strong>
          <span class="wz-badge ${live ? "neutral" : task.status === "failed" ? "warn" : "good"}">${escapeHtml(batchGenerationTaskStatusLabels[task.status] || task.status)}</span>
        </div>
        <small>${escapeHtml(upstream)}</small>
        <small>${escapeHtml(requestLine)}</small>
        <small>${escapeHtml(task.seedanceTaskId ? `任务 ID：${task.seedanceTaskId}` : (task.errorCode || "尚未提交"))}</small>
      </article>
    `;
  }).join("");
}

export const remixStatusLabels = {
  draft: "草稿",
  queued: "排队中",
  running: "处理中",
  qc: "质检中",
  preview_required: "待预览确认",
  succeeded: "已确认",
  partial_failed: "部分失败",
  failed: "失败",
  stopped: "已停止"
};

export const strongTruthFields = [
  ["rewardAmountRange", "收益金额范围"],
  ["rewardCondition", "收益触发条件"],
  ["withdrawalThreshold", "提现门槛"],
  ["withdrawalMethod", "提现方式"],
  ["arrivalTime", "到账时间"],
  ["applicableRegion", "适用地区"],
  ["applicableChannel", "适用渠道"],
  ["sourceOrUpdatedAt", "规则来源/更新时间"]
];

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function idempotencyKey(prefix) {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function dataUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("文件读取失败")));
    reader.readAsDataURL(file);
  });
}

export function tinyVideoDataUrl(label = "sample") {
  return `data:video/mp4;base64,${btoa(`mock ${label} video`)}`;
}

export async function apiEnvelope(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
    credentials: "same-origin"
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new WangzhuanApiError({
      code: "invalid_json",
      message: "服务返回了无法解析的数据",
      requestId: response.headers.get("X-Request-Id") || ""
    }, response.status);
  }
  if (!response.ok || payload.code !== "ok") {
    throw new WangzhuanApiError(payload, response.status);
  }
  return payload.data;
}

export async function apiLegacy(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
    credentials: "same-origin"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new WangzhuanApiError({
      code: response.status === 401 ? "unauthenticated" : "legacy_error",
      message: payload.error || "请求失败"
    }, response.status);
  }
  return payload;
}

export async function downloadZip(request) {
  const response = await fetch("/api/wangzhuan/download", {
    method: "POST",
    headers: JSON_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(request)
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    let payload = {};
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => ({}));
    }
    throw new WangzhuanApiError(payload, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || "wangzhuan-package.zip";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { fileName, size: blob.size, requestId: response.headers.get("X-Request-Id") || "" };
}

export function showLogin(modal, message = "请先登录") {
  if (!modal) return;
  modal.hidden = false;
  const status = $(".login-status", modal);
  if (status) status.textContent = message;
}

export function hideLogin(modal) {
  if (modal) modal.hidden = true;
}

export async function bindLogin({ modal, badge, logoutBtn, onAuthed }) {
  const renderAuth = (auth) => {
    if (auth.authenticated) {
      hideLogin(modal);
      if (badge) badge.textContent = auth.user?.displayName || auth.user?.username || "已登录";
      if (logoutBtn) logoutBtn.hidden = false;
      onAuthed?.(auth.user);
      return true;
    }
    if (badge) badge.textContent = "未登录";
    if (logoutBtn) logoutBtn.hidden = true;
    showLogin(modal);
    return false;
  };

  $("#wangzhuanLoginBtn", modal)?.addEventListener("click", async () => {
    const status = $(".login-status", modal);
    if (status) status.textContent = "登录中...";
    try {
      const auth = await apiLegacy("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#wangzhuanLoginUsername", modal)?.value || "",
          password: $("#wangzhuanLoginPassword", modal)?.value || ""
        })
      });
      renderAuth(auth);
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    await apiLegacy("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.reload();
  });

  const auth = await apiLegacy("/api/auth").catch(() => ({ authenticated: false }));
  return renderAuth(auth);
}

export function renderError(_target, error, context = "") {
  showErrorModal(error, context);
}

export function clearError(target) {
  hideErrorModal();
  if (target) {
    target.hidden = true;
    target.textContent = "";
  }
}

function buildErrorDetails(error) {
  const missing = Array.isArray(error?.data?.missingFields) ? error.data.missingFields : [];
  const capability = error?.data?.capability;
  const validationErrors = Array.isArray(error?.data?.validationErrors) ? error.data.validationErrors : [];
  const validationSummary = validationErrors
    .map((item) => {
      const loc = Array.isArray(item?.loc) ? item.loc.join(".") : "";
      const msg = item?.msg || item?.message || "";
      return [loc, msg].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .slice(0, 3);
  const rows = [];
  if (missing.length) rows.push(`缺失字段：${missing.join("、")}`);
  if (capability) rows.push(`能力状态：${capability.status || "unknown"}；provider：${capability.provider || "unknown"}`);
  if (error?.data?.status) rows.push(`上游状态码：${error.data.status}`);
  if (error?.data?.inputMode) rows.push(`模型输入：${error.data.inputMode}`);
  if (error?.data?.upstreamMessage) rows.push(`上游信息：${error.data.upstreamMessage}`);
  if (validationSummary.length) rows.push(`上游校验：${validationSummary.join("；")}`);
  if (error?.requestId) rows.push(`requestId：${error.requestId}`);
  return rows;
}

function ensureErrorModal() {
  let backdrop = document.getElementById("wzErrorModal");
  if (backdrop) return backdrop;

  backdrop = document.createElement("div");
  backdrop.id = "wzErrorModal";
  backdrop.className = "modal-backdrop wz-error-modal";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <div class="modal-panel wz-error-modal-panel" role="alertdialog" aria-modal="true" aria-labelledby="wzErrorModalTitle">
      <div class="modal-title-row">
        <div>
          <h2 id="wzErrorModalTitle">操作失败</h2>
          <p id="wzErrorModalMessage"></p>
        </div>
      </div>
      <div id="wzErrorModalDetails" class="wz-error-modal-details" hidden></div>
      <div class="modal-actions">
        <button type="button" data-wz-error-close>我知道了</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest("[data-wz-error-close]")) {
      hideErrorModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && backdrop && !backdrop.hidden) hideErrorModal();
  });
  return backdrop;
}

export function showErrorModal(error, context = "") {
  const backdrop = ensureErrorModal();
  const title = backdrop.querySelector("#wzErrorModalTitle");
  const message = backdrop.querySelector("#wzErrorModalMessage");
  const details = backdrop.querySelector("#wzErrorModalDetails");
  const closeBtn = backdrop.querySelector("[data-wz-error-close]");
  if (title) title.textContent = context || error?.code || "操作失败";
  if (message) message.textContent = error?.message || "请求失败，请稍后重试。";
  const rows = buildErrorDetails(error);
  if (details) {
    if (rows.length) {
      details.hidden = false;
      details.innerHTML = rows.map((row) => `<small>${escapeHtml(row)}</small>`).join("");
    } else {
      details.hidden = true;
      details.innerHTML = "";
    }
  }
  backdrop.hidden = false;
  closeBtn?.focus({ preventScroll: true });
}

export function hideErrorModal() {
  const backdrop = document.getElementById("wzErrorModal");
  if (backdrop) backdrop.hidden = true;
}

export function badge(status, labelMap = batchStatusLabels) {
  const label = labelMap[status] || status || "未知";
  const tone = ["succeeded", "pass"].includes(status)
    ? "good"
    : ["failed", "partial_failed", "preview_required", "warn", "manual_required"].includes(status)
      ? "warn"
      : ["stopped", "unsupported"].includes(status)
        ? "bad"
        : "neutral";
  return `<span class="wz-badge ${tone}">${escapeHtml(label)}</span>`;
}

export function renderKeyValues(items) {
  return items.map(([key, value]) => `
    <div class="wz-kv">
      <span>${escapeHtml(key)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `).join("");
}

function outputPreviewUrl(output = {}) {
  return output.previewUrl || output.storageUrl || output.publicUrl || "";
}

function isImagePreview(output = {}) {
  const url = outputPreviewUrl(output);
  const kind = String(output.kind || output.sourceType || "").toLowerCase();
  return /^data:image\//i.test(url)
    || /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(url)
    || kind.includes("image");
}

export function renderOutputPreviewCards(outputs = [], { emptyText = "暂无输出", confirmable = false } = {}) {
  const items = (Array.isArray(outputs) ? outputs : []).filter(Boolean);
  if (!items.length) return `<div class="wz-output-previews empty-line">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="wz-output-previews">
      ${items.map((output, index) => {
        const url = outputPreviewUrl(output);
        const key = output.outputId || output.storageKey || url || `output_${index + 1}`;
        const statusMap = { pass: "QC 通过", warn: "QC 警告", fail: "QC 失败", manual_required: "需人工确认", not_started: "未质检" };
        const meta = [
          output.kind,
          output.durationSec ? `${output.durationSec}s` : "",
          output.downloadEligible ? "可下载" : "",
          output.previewConfirmed ? "已确认" : ""
        ].filter(Boolean).join(" · ");
        return `
          <article class="wz-output-card" data-output-id="${escapeHtml(key)}">
            <div class="wz-output-card-media">
              ${url
                ? isImagePreview(output)
                  ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(output.outputId || "输出预览")}" loading="lazy" />`
                  : `<video class="wz-output-video" data-preview-key="${escapeHtml(key)}" src="${escapeHtml(url)}" controls preload="metadata" playsinline aria-label="${escapeHtml(output.outputId || "输出视频预览")}"></video>`
                : `<div class="wz-output-card-empty">暂无预览地址</div>`}
            </div>
            <div class="wz-output-card-body">
              <div>
                <strong>${escapeHtml(output.displayBatchName || output.userBatchName || output.outputId || `输出 ${index + 1}`)}</strong>
                ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
              </div>
              ${badge(output.qcStatus || "not_started", statusMap)}
              ${output.modelQcSummary ? `<small>模型质检 ${escapeHtml(output.modelQcSummary.score ?? "-")} · ${escapeHtml(output.modelQcSummary.summary || "")}</small>` : ""}
              ${output.errorMessage ? `<small class="wz-output-error">${escapeHtml(output.errorMessage)}</small>` : ""}
              <div class="wz-output-card-actions">
                ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开文件</a>` : ""}
                ${confirmable && output.qcStatus === "manual_required" ? `<span>待人工确认</span>` : ""}
              </div>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function compactFailureRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const message = String(row?.message || "").trim();
    if (!message) return false;
    const key = `${row.scope}|${row.id}|${message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function renderFailureReasons({ batch = null, remix = null, tasks = [], outputs = [], providerJob = null } = {}) {
  const rows = [];
  const run = batch || remix || {};
  if (run.errorMessage) {
    rows.push({ scope: batch ? "批次" : "任务", id: run.batchId || run.remixId || "", message: run.errorMessage });
  }
  if (providerJob?.errorMessage || providerJob?.responseSummary?.message || providerJob?.responseSummary?.upstreamMessage) {
    rows.push({
      scope: "远端 Job",
      id: providerJob.jobId || providerJob.providerJobId || "",
      message: providerJob.errorMessage || providerJob.responseSummary?.message || providerJob.responseSummary?.upstreamMessage
    });
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const message = task.errorMessage || task.responseSummary?.upstreamMessage || task.responseSummary?.message || "";
    if (!message && task.status !== "failed") continue;
    rows.push({
      scope: "子任务",
      id: task.generationTaskId || task.taskId || task.seedanceTaskId || task.providerJobId || "",
      message: message || task.errorCode || "任务失败"
    });
  }
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const failed = ["fail", "failed", "warn"].includes(output.qcStatus) || output.errorMessage;
    if (!failed) continue;
    rows.push({
      scope: "输出",
      id: output.outputId || "",
      message: output.errorMessage || output.modelQcSummary?.summary || output.qcSummary?.summary || "输出质检未通过"
    });
  }
  const visibleRows = compactFailureRows(rows);
  if (!visibleRows.length) return "";
  return `
    <div class="wz-failure-panel" role="alert">
      <strong>失败原因</strong>
      ${visibleRows.slice(0, 8).map((row) => `
        <small><b>${escapeHtml(row.scope)}${row.id ? ` ${escapeHtml(row.id)}` : ""}</b> · ${escapeHtml(row.message)}</small>
      `).join("")}
    </div>
  `;
}

export function snapshotPreviewPlayback(root = document) {
  const state = new Map();
  for (const video of root.querySelectorAll?.(".wz-output-video[data-preview-key]") || []) {
    state.set(video.dataset.previewKey, {
      src: video.currentSrc || video.src,
      currentTime: video.currentTime || 0,
      paused: video.paused
    });
  }
  return state;
}

export function restorePreviewPlayback(snapshot, root = document) {
  if (!snapshot?.size) return;
  requestAnimationFrame(() => {
    for (const video of root.querySelectorAll?.(".wz-output-video[data-preview-key]") || []) {
      const previous = snapshot.get(video.dataset.previewKey);
      if (!previous) continue;
      const currentSrc = video.currentSrc || video.src;
      if (previous.src && currentSrc && previous.src !== currentSrc) continue;
      if (previous.currentTime > 0 && Number.isFinite(previous.currentTime)) {
        try {
          video.currentTime = previous.currentTime;
        } catch {
          // Some browsers reject seeking before metadata is loaded.
        }
      }
      if (!previous.paused) video.play?.().catch(() => {});
    }
  });
}

export function outputPreviewItemsFingerprint(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const key = item.outputId || item.storageKey || `idx_${index}`;
      const url = outputPreviewUrl(item);
      return [key, item.qcStatus || "", url, item.downloadEligible ? "1" : "0"].join(":");
    })
    .join("|");
}

export function galleryStateFingerprint(gallery = {}) {
  const pagination = gallery.pagination || {};
  return `${outputPreviewItemsFingerprint(gallery.items)}::${pagination.page || 1}:${pagination.pageSize || 0}:${pagination.total || 0}`;
}

export function isAnyPreviewVideoPlaying(root) {
  if (!root?.querySelectorAll) return false;
  for (const video of root.querySelectorAll(".wz-output-video")) {
    if (!video.paused && !video.ended) return true;
  }
  return false;
}

export function bindPreviewPlaybackGuard(root, flush) {
  if (!root || typeof flush !== "function" || root.dataset.previewGuardBound) return;
  root.dataset.previewGuardBound = "1";
  root.addEventListener("pause", flush, true);
  root.addEventListener("ended", flush, true);
}

const DECOMPOSITION_NESTED_LABELS = Object.freeze({
  main: "主体",
  appearance: "外观",
  role: "角色",
  props: "道具",
  core: "核心",
  mainAction: "主要动作",
  shotType: "景别",
  framing: "构图",
  movement: "运镜",
  setup: "布光",
  mood: "氛围",
  environment: "环境",
  durationSec: "时长",
  format: "形式",
  resolution: "清晰度",
  firstSeconds: "开头"
});

function humanizeDecompositionKey(key) {
  return DECOMPOSITION_NESTED_LABELS[key]
    || String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .trim();
}

export function flattenDecompositionFieldValue(value, depth = 0) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (depth === 0 && /^[\[{]/.test(trimmed)) {
      try {
        return flattenDecompositionFieldValue(JSON.parse(trimmed), depth + 1);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenDecompositionFieldValue(item, depth + 1))
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object") {
    const parts = [];
    for (const [key, nested] of Object.entries(value)) {
      const text = flattenDecompositionFieldValue(nested, depth + 1);
      if (!text) continue;
      const label = humanizeDecompositionKey(key);
      const known = Boolean(DECOMPOSITION_NESTED_LABELS[key]);
      const nestedIsObject = nested && typeof nested === "object" && !Array.isArray(nested);
      if (known || nestedIsObject) {
        parts.push(`${label}：${text}`);
      } else {
        parts.push(text);
      }
    }
    return parts.join("；");
  }
  return String(value).trim();
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.textContent = label || "处理中";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

export function terminalBatchStatus(status) {
  return ["succeeded", "partial_failed", "failed", "stopped", "skipped"].includes(status);
}

export function terminalRemixStatus(status) {
  return ["preview_required", "succeeded", "partial_failed", "failed", "stopped"].includes(status);
}

export function activeLockLabel(type, id, status = "") {
  const statusLabel = type === "remix"
    ? (remixStatusLabels[status] || status)
    : (batchStatusLabels[status] || status);
  const prefix = type === "remix" ? "竞品改造任务" : "素材管线批次";
  return statusLabel ? `${prefix} ${id} · ${statusLabel}` : `${prefix} ${id}`;
}

export function activeLockFromBatchError(error) {
  if (error?.code !== "batch_already_running") return null;
  const data = error.data || {};
  if (data.remixId) {
    return {
      type: "remix",
      id: data.remixId,
      status: data.status || "",
      label: activeLockLabel("remix", data.remixId, data.status)
    };
  }
  if (data.batchId) {
    return {
      type: "batch",
      id: data.batchId,
      status: data.status || "",
      label: activeLockLabel("batch", data.batchId, data.status)
    };
  }
  return null;
}

export function taskSpaceHref(type, id = "") {
  const params = new URLSearchParams();
  if (type === "remix" && id) params.set("remixId", id);
  if (type === "batch" && id) params.set("batchId", id);
  const query = params.toString();
  return `/wangzhuan-tasks.html${query ? `?${query}` : ""}`;
}

export function workbenchHref(type, status = "") {
  if (type === "remix") return "/competitor-remix.html";
  return status === "preview_required" ? "/wangzhuan.html#wzNodeBatch" : "/wangzhuan.html#wzNodeLog";
}

export function activeLockActionsHtml(lock) {
  if (!lock) return "";
  const href = taskSpaceHref(lock.type, lock.id);
  return `${escapeHtml(lock.label)} · <a href="${href}">打开任务管理</a>`;
}

export async function stopWorkflowTask(type, id, reason = "frontend_stop") {
  const url = type === "remix"
    ? `/api/wangzhuan/remix/${encodeURIComponent(id)}/stop`
    : `/api/wangzhuan/batches/${encodeURIComponent(id)}/stop`;
  return apiEnvelope(url, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

export async function confirmBatchPlanRequest(batchId, plans, confirmationNotes = "", branchDrafts = [], options = {}) {
  return apiEnvelope(`/api/wangzhuan/batches/${encodeURIComponent(batchId)}/confirm-plan`, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: idempotencyKey("batch_confirm_plan"),
      confirmedPlanIds: plans.map((plan) => plan.planId),
      plans: plans.map((plan) => ({
        planId: plan.planId,
        hook: plan.hook,
        body: plan.body,
        voiceover: plan.voiceover,
        subtitles: plan.subtitles,
        cta: plan.cta,
        ending: plan.ending,
        imagePrompt: plan.imagePrompt,
        seedancePrompt: plan.seedancePrompt,
        negativePrompt: plan.negativePrompt,
        mediaRefs: plan.mediaRefs,
        complianceNotes: plan.complianceNotes
      })),
      branchDrafts: Array.isArray(branchDrafts) ? branchDrafts : [],
      assetReviewConfirmed: Boolean(options.assetReviewConfirmed),
      confirmationNotes
    })
  });
}

export function schedulePoll({ load, shouldStop, interval = 2000 }) {
  let timer = 0;
  const tick = async () => {
    const value = await load();
    if (shouldStop(value)) return;
    timer = window.setTimeout(tick, interval);
  };
  timer = window.setTimeout(tick, interval);
  return () => window.clearTimeout(timer);
}

let toastTimer = 0;
let toastEl = null;

export function showToast(message, { type = "info", duration = 4200, actionLabel = "", onAction = null } = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  if (type === "error") {
    showErrorModal({ message: text }, "操作失败");
    return;
  }
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast wz-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
  }
  window.clearTimeout(toastTimer);
  toastEl.className = `toast wz-toast wz-toast-${type}`;
  toastEl.innerHTML = actionLabel && typeof onAction === "function"
    ? `<span>${escapeHtml(text)}</span><button type="button" class="mini ghost wz-toast-action">${escapeHtml(actionLabel)}</button>`
    : `<span>${escapeHtml(text)}</span>`;
  toastEl.hidden = false;
  const actionBtn = toastEl.querySelector(".wz-toast-action");
  if (actionBtn) {
    actionBtn.onclick = () => {
      hideToast();
      onAction();
    };
  }
  toastTimer = window.setTimeout(hideToast, duration);
}

export function hideToast() {
  window.clearTimeout(toastTimer);
  if (toastEl) toastEl.hidden = true;
}

export function syncActionHint(button, hint, { tone = "muted" } = {}) {
  if (!button) return;
  let el = button.nextElementSibling;
  if (!el?.classList?.contains("wz-action-hint")) {
    el = document.createElement("p");
    el.className = "wz-action-hint";
    button.insertAdjacentElement("afterend", el);
  }
  const text = String(hint || "").trim();
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `wz-action-hint wz-action-hint-${tone}`;
}

export function taskProgressHtml({ label = "处理中", detail = "", percent = null, indeterminate = false } = {}) {
  const width = indeterminate ? 35 : Math.max(0, Math.min(100, Number(percent) || 0));
  const barClass = indeterminate ? " wz-task-progress-indeterminate" : "";
  const style = indeterminate ? "" : ` style="width:${width}%"`;
  return `
    <div class="wz-task-progress" role="status" aria-live="polite">
      <div class="wz-task-progress-track">
        <div class="wz-task-progress-bar${barClass}"${style}></div>
      </div>
      <div class="wz-task-progress-copy">
        <strong>${escapeHtml(label)}</strong>
        ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
      </div>
    </div>
  `;
}

export function inlineRetryHtml({ message, actions = [] } = {}) {
  const buttons = actions
    .filter((item) => item?.label)
    .map((item) => `<button type="button" class="ghost mini" data-inline-retry="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`)
    .join("");
  if (!message && !buttons) return "";
  return `
    <div class="wz-inline-retry" role="alert">
      ${message ? `<span>${escapeHtml(message)}</span>` : ""}
      ${buttons ? `<div class="wz-inline-retry-actions">${buttons}</div>` : ""}
    </div>
  `;
}
