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
const SEEDANCE_ETA_MINUTES_PER_TASK = 3;
const SEEDANCE_ETA_MS_PER_TASK = SEEDANCE_ETA_MINUTES_PER_TASK * 60 * 1000;
const UNSUBMITTED_TASK_STATUSES = new Set(["pending", "pending_preview"]);

function normalizeTimestampInput(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text) return "";
  if (/^\d{13,}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2} /.test(text)) {
    const base = text.replace(" ", "T");
    if (/[zZ]$/.test(base) || /[+-]\d{2}:\d{2}$/.test(base)) return base;
    return `${base}Z`;
  }
  return text;
}

function timestampMs(value) {
  const normalized = normalizeTimestampInput(value);
  if (typeof normalized === "number") return normalized;
  if (!normalized) return 0;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatTimestamp(value) {
  const ms = timestampMs(value);
  if (!ms) {
    const text = String(value || "").trim();
    return text || "-";
  }
  const date = new Date(ms);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

function seedanceSubmittedTasks(tasks = []) {
  return tasks.filter((task) => {
    const startedMs = timestampMs(task.startedAt);
    if (!startedMs) return false;
    return !UNSUBMITTED_TASK_STATUSES.has(task.status);
  });
}

function seedanceSubmissionStartMs(batch = {}, tasks = []) {
  const batchStartedMs = timestampMs(batch.startedAt);
  if (batchStartedMs) return batchStartedMs;
  const submittedStarts = seedanceSubmittedTasks(tasks)
    .map((task) => timestampMs(task.startedAt))
    .filter(Boolean);
  return submittedStarts.length ? Math.min(...submittedStarts) : 0;
}

export function batchRuntimeSummary(batch = {}, tasks = [], { now = Date.now() } = {}) {
  const nowMs = typeof now === "number" ? now : timestampMs(now);
  const total = tasks.length;
  const done = doneTaskCount(tasks);
  const submittedTasks = seedanceSubmittedTasks(tasks);
  const seedanceStartMs = seedanceSubmissionStartMs(batch, tasks);
  const seedanceCount = submittedTasks.length;
  const active = !terminalBatchStatus(batch.status);
  const endMs = timestampMs(batch.finishedAt || batch.stoppedAt)
    || (active ? nowMs : timestampMs(batch.updatedAt));
  const elapsedMs = seedanceStartMs && endMs >= seedanceStartMs ? endMs - seedanceStartMs : 0;
  const elapsedRoundedMs = Math.floor(elapsedMs / 60000) * 60000;
  const remaining = Math.max(0, total - done);
  const etaBudgetMs = seedanceCount > 0 ? seedanceCount * SEEDANCE_ETA_MS_PER_TASK : total * SEEDANCE_ETA_MS_PER_TASK;
  const etaRemainingMs = seedanceStartMs
    ? Math.max(0, etaBudgetMs - elapsedRoundedMs)
    : etaBudgetMs;
  const updatedSourceMs = active && seedanceStartMs
    ? nowMs
    : (timestampMs(batch.updatedAt) || timestampMs(batch.createdAt) || nowMs);

  return {
    createdAt: formatTimestamp(batch.createdAt),
    updatedAt: formatTimestamp(updatedSourceMs),
    elapsed: seedanceStartMs ? formatDuration(elapsedMs) : "-",
    eta: total && remaining === 0
      ? "已完成"
      : !seedanceStartMs
        ? (total ? `约 ${formatDuration(etaBudgetMs)}（待提交 Seedance）` : "待提交 Seedance")
        : active
          ? `约 ${formatDuration(etaRemainingMs)}`
          : remaining === 0
            ? "已完成"
            : `约 ${formatDuration(etaRemainingMs)}`,
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
  const generationDoneStatuses = new Set(["downloaded", "qc", "succeeded", "failed", "stopped", "skipped"]);
  const hasRenderableOutputs = outputs.some((output) => {
    const filePath = String(output.filePath || "").trim();
    return filePath || output.storageUrl || output.storageKey;
  });
  if (!hasRenderableOutputs) return false;
  if (!tasks.every((task) => generationDoneStatuses.has(task.status))) return false;
  if (batch.status === "qc") {
    return outputs.some((output) => output.qcStatus === "not_started");
  }
  if (batch.status === "failed" || batch.status === "partial_failed") {
    if (outputs.some((output) => output.qcStatus === "not_started")) return true;
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

function stableBranchId(item = {}, index = 0) {
  const raw = String(item?.branchId || item?.id || "").trim();
  return raw || `branch_${index + 1}`;
}

function planBranchId(item = {}, index = 0) {
  const raw = String(item?.branchId || item?.branch?.branchId || "").trim();
  return raw || `branch_${index + 1}`;
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function compactList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined && value[key] !== "")
        .map((key) => [key, stableObject(value[key])])
    );
  }
  return value;
}

function branchSignatureItem(branch = {}, index = 0) {
  return stableObject({
    branchId: stableBranchId(branch, index),
    productName: String(branch.productName || "").trim(),
    productLink: String(branch.productLink || "").trim(),
    cta: String(branch.cta || "").trim(),
    ending: String(branch.ending || "").trim(),
    currencySymbol: String(branch.currencySymbol || "").trim(),
    language: String(branch.language || "").trim(),
    languages: compactList(branch.languages || branch.language).sort(),
    regions: compactList(branch.regions || branch.targetRegions || branch.targetRegion).sort(),
    targetChannels: compactList(branch.targetChannels || branch.targetChannel).sort(),
    promiseLevel: String(branch.promiseLevel || "").trim(),
    materialDirection: String(branch.materialDirection || "").trim(),
    voiceoverStyle: String(branch.voiceoverStyle || "").trim(),
    variantPrompt: String(branch.variantPrompt || "").trim(),
    customPrompt: String(branch.customPrompt || "").trim(),
    negativePrompt: String(branch.negativePrompt || "").trim(),
    assetFileNames: stableObject(branch.assetFileNames || {}),
    assetUrls: stableObject(branch.assetUrls || {}),
    assetStorageKeys: stableObject(branch.assetStorageKeys || {}),
    assetStoredPaths: stableObject(branch.assetStoredPaths || {}),
    truthRules: stableObject(branch.truthRules || {})
  });
}

export function branchPlanSignature(branches = [], plans = []) {
  const branchKeys = (Array.isArray(branches) ? branches : [])
    .map(branchSignatureItem)
    .sort((left, right) => String(left.branchId).localeCompare(String(right.branchId)));
  const planKeys = (Array.isArray(plans) ? plans : [])
    .map((plan, index) => [
      planBranchId(plan, index),
      plan.branchVariantIndex || plan.variantIndex || "",
      plan.segmentIndex || ""
    ].join(":"))
    .sort();
  return JSON.stringify({ branchKeys, planKeys });
}

export function branchPlanCoverage(branches = [], plans = []) {
  const currentBranchIds = uniqueValues((Array.isArray(branches) ? branches : []).map(stableBranchId)).sort();
  const planBranchIds = uniqueValues((Array.isArray(plans) ? plans : []).map(planBranchId)).sort();
  const planBranchSet = new Set(planBranchIds);
  const currentBranchSet = new Set(currentBranchIds);
  const missingBranchIds = currentBranchIds.filter((branchId) => !planBranchSet.has(branchId));
  const staleBranchIds = planBranchIds.filter((branchId) => !currentBranchSet.has(branchId));
  return {
    ok: currentBranchIds.length > 0
      && planBranchIds.length > 0
      && missingBranchIds.length === 0
      && staleBranchIds.length === 0,
    currentBranchCount: currentBranchIds.length,
    planBranchCount: planBranchIds.length,
    currentBranchIds,
    planBranchIds,
    missingBranchIds,
    staleBranchIds,
    signature: branchPlanSignature(branches, plans)
  };
}

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

export function parseClientSseBlocks(buffer) {
  const events = [];
  let rest = buffer;
  let splitAt;
  while ((splitAt = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 2);
    if (!block.trim()) continue;
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    events.push({ event: eventName, data: dataLines.join("\n") });
  }
  return { events, rest };
}

function ensureLlmStreamDock() {
  let dock = document.getElementById("wzLlmStreamDock");
  if (!dock) {
    dock = document.createElement("div");
    dock.id = "wzLlmStreamDock";
    dock.className = "wz-llm-stream-dock";
    dock.hidden = true;
    dock.innerHTML = `
      <button type="button" class="wz-llm-stream-dock-btn" aria-live="polite">
        <span class="wz-llm-stream-dock-title"></span>
        <span class="wz-llm-stream-dock-stage"></span>
      </button>
    `;
    document.body.appendChild(dock);
  }
  return dock;
}

function ensureLlmStreamModal() {
  let backdrop = document.getElementById("wzLlmStreamModal");
  if (backdrop && !backdrop.querySelector("#wzLlmStreamStage")) {
    backdrop.remove();
    backdrop = null;
  }
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "wzLlmStreamModal";
    backdrop.className = "modal-backdrop wz-llm-stream-modal";
    backdrop.hidden = true;
    backdrop.innerHTML = `
    <div class="modal-panel wz-llm-stream-panel" role="dialog" aria-modal="true" aria-labelledby="wzLlmStreamTitle">
      <div class="wz-llm-stream-header">
        <div>
          <h2 id="wzLlmStreamTitle">LLM 运行中</h2>
          <p id="wzLlmStreamSubtitle">正在调用模型，请稍候</p>
        </div>
        <span id="wzLlmStreamStatus" class="wz-llm-stream-status" data-state="running">running</span>
      </div>
      <div class="wz-llm-stream-stage">
        <div id="wzLlmStreamStage" class="wz-llm-stream-stage-label">正在连接服务…</div>
        <div id="wzLlmStreamStageDetail" class="wz-llm-stream-stage-detail"></div>
        <div class="wz-llm-stream-progress" aria-hidden="true">
          <div id="wzLlmStreamProgressBar" class="wz-llm-stream-progress-bar" style="width: 8%"></div>
        </div>
        <p class="wz-llm-stream-hint">可点击「后台继续」先处理其他步骤；任务不会中断，完成后会提示您。</p>
      </div>
      <details id="wzLlmStreamLogDetails" class="wz-llm-stream-log-details">
        <summary>技术日志（可选）</summary>
        <pre id="wzLlmStreamOutput" class="wz-llm-stream-output" aria-live="polite"></pre>
      </details>
      <div class="modal-actions wz-llm-stream-actions">
        <button id="wzLlmStreamMinimizeBtn" type="button" class="ghost">后台继续</button>
        <button id="wzLlmStreamCloseBtn" type="button" class="ghost">关闭</button>
      </div>
    </div>
  `;
    document.body.appendChild(backdrop);
  }
  if (!backdrop.dataset.bound) {
    backdrop.dataset.bound = "1";
    const dock = ensureLlmStreamDock();
    backdrop.querySelector("#wzLlmStreamMinimizeBtn")?.addEventListener("click", () => {
      backdrop.__llmConsole?.minimize?.();
    });
    backdrop.querySelector("#wzLlmStreamCloseBtn")?.addEventListener("click", () => {
      backdrop.__llmConsole?.closePanel?.();
    });
    dock.querySelector(".wz-llm-stream-dock-btn")?.addEventListener("click", () => {
      backdrop.__llmConsole?.expand?.();
    });
  }
  return backdrop;
}

function updateLlmStreamSubtitle(backdrop, text) {
  const subtitle = backdrop?.querySelector("#wzLlmStreamSubtitle");
  if (subtitle) subtitle.textContent = text;
}

function inferLlmStreamStage(line = "", title = "") {
  const text = String(line || "").trim();
  if (!text) return null;

  const planMatch = text.match(/\[plan\s+(\d+)\/(\d+)\]\s*(.*)$/i);
  if (planMatch) {
    const index = Number(planMatch[1]);
    const total = Number(planMatch[2]) || 1;
    const detail = planMatch[3]?.trim() || "";
    const progress = Math.min(96, Math.round((index / total) * 100));
    return {
      label: `正在生成 Seedance 预案（${index}/${total}）`,
      detail: detail || `第 ${index} 条预案调用模型中…`,
      progress
    };
  }

  if (/init draft-decomposition stream/i.test(text)) {
    return { label: "准备脚本拆解", detail: "读取参考视频与模型配置", progress: 12 };
  }
  if (/init batch-plan stream/i.test(text)) {
    return { label: "准备生成预案", detail: "校验批次参数并创建预览批次", progress: 10 };
  }
  if (/^model=/i.test(text)) {
    return { label: "模型已就绪", detail: text, progress: 22 };
  }
  if (/idempotency replay/i.test(text)) {
    return { label: "复用已有结果", detail: "跳过重复调用，正在加载历史预案", progress: 88 };
  }
  if (/POST upstream stream/i.test(text)) {
    const isPlan = /plan|预案|batch-plan/i.test(title);
    return {
      label: isPlan ? "正在调用模型生成预案" : "正在调用模型拆解脚本",
      detail: "模型流式输出中，通常需要 30 秒到数分钟",
      progress: 42
    };
  }
  if (/\[DONE\] received — parsing JSON/i.test(text)) {
    return { label: "正在解析脚本结果", detail: "模型输出已完成，正在整理表单字段", progress: 86 };
  }
  if (/parse ok — decomposition ready/i.test(text)) {
    return { label: "脚本拆解完成", detail: "即将写入第 2 步表单", progress: 96 };
  }
  if (/\[DONE\] all plans ready/i.test(text)) {
    return { label: "预案生成完成", detail: "正在保存批次并刷新表格", progress: 96 };
  }
  if (/\[完成\] 正在应用到页面/i.test(text)) {
    return { label: "正在应用到页面", detail: "请稍候…", progress: 98 };
  }
  if (/upstream:/i.test(text)) {
    return { label: "已连接上游模型", detail: text.replace(/^upstream:\s*/i, ""), progress: 28 };
  }
  return null;
}

async function appendAnimatedDelta(consoleUi, text, animated = true) {
  const chunk = String(text || "");
  if (!chunk) return;
  if (!animated || consoleUi.isMinimized?.()) {
    consoleUi.delta(chunk);
    return;
  }
  const maxFrames = 160;
  const sliceSize = Math.max(1, Math.ceil(chunk.length / maxFrames));
  for (let offset = 0; offset < chunk.length; offset += sliceSize) {
    consoleUi.delta(chunk.slice(offset, offset + sliceSize));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

export function openLlmStreamConsole(title = "LLM 运行中") {
  const backdrop = ensureLlmStreamModal();
  const dock = ensureLlmStreamDock();
  const titleEl = backdrop.querySelector("#wzLlmStreamTitle");
  const statusEl = backdrop.querySelector("#wzLlmStreamStatus");
  const outputEl = backdrop.querySelector("#wzLlmStreamOutput");
  const logDetails = backdrop.querySelector("#wzLlmStreamLogDetails");
  const stageEl = backdrop.querySelector("#wzLlmStreamStage");
  const stageDetailEl = backdrop.querySelector("#wzLlmStreamStageDetail");
  const progressBar = backdrop.querySelector("#wzLlmStreamProgressBar");
  const minimizeBtn = backdrop.querySelector("#wzLlmStreamMinimizeBtn");
  const closeBtn = backdrop.querySelector("#wzLlmStreamCloseBtn");
  const dockTitle = dock.querySelector(".wz-llm-stream-dock-title");
  const dockStage = dock.querySelector(".wz-llm-stream-dock-stage");
  const dockBtn = dock.querySelector(".wz-llm-stream-dock-btn");

  if (titleEl) titleEl.textContent = title;
  updateLlmStreamSubtitle(backdrop, "通常需要 30 秒到数分钟，可先后台继续处理其他步骤");
  if (statusEl) {
    statusEl.textContent = "running";
    statusEl.dataset.state = "running";
  }
  if (outputEl) outputEl.textContent = "";
  if (logDetails) logDetails.open = false;
  if (minimizeBtn) {
    minimizeBtn.hidden = false;
    minimizeBtn.disabled = false;
    minimizeBtn.textContent = "后台继续";
  }
  if (closeBtn) {
    closeBtn.hidden = true;
    closeBtn.disabled = false;
    closeBtn.textContent = "关闭";
  }
  dock.hidden = true;
  dock.dataset.state = "running";
  backdrop.hidden = false;
  backdrop.classList.remove("is-minimized");

  let logBuffer = "";
  let deltaBuffer = "";
  let minimized = false;
  let panelTitle = title;
  let stageLabel = "正在连接服务…";
  let stageDetail = "";

  function renderOutput() {
    if (!outputEl) return;
    outputEl.textContent = logBuffer + deltaBuffer;
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function syncProgress(progress) {
    if (!progressBar || progress === undefined || progress === null) return;
    const value = Math.max(4, Math.min(100, Number(progress) || 0));
    progressBar.style.width = `${value}%`;
  }

  function syncStageUi() {
    if (stageEl) stageEl.textContent = stageLabel;
    if (stageDetailEl) stageDetailEl.textContent = stageDetail;
    if (dockTitle) dockTitle.textContent = panelTitle;
    if (dockStage) dockStage.textContent = stageDetail ? `${stageLabel} · ${stageDetail}` : stageLabel;
  }

  function syncDockState(state) {
    dock.dataset.state = state;
    if (dockBtn) {
      dockBtn.dataset.state = state;
    }
  }

  const consoleUi = {
    isMinimized() {
      return minimized;
    },
    setStage(label, { detail = "", progress } = {}) {
      if (label) stageLabel = String(label);
      if (detail !== undefined) stageDetail = String(detail || "");
      if (progress !== undefined) syncProgress(progress);
      syncStageUi();
    },
    inferStageFromLog(line) {
      const inferred = inferLlmStreamStage(line, panelTitle);
      if (!inferred) return;
      this.setStage(inferred.label, { detail: inferred.detail, progress: inferred.progress });
    },
    log(line) {
      const text = String(line ?? "");
      logBuffer += text.endsWith("\n") ? text : `${text}\n`;
      this.inferStageFromLog(text);
      renderOutput();
    },
    delta(text) {
      deltaBuffer += String(text || "");
      renderOutput();
    },
    resetDelta() {
      if (deltaBuffer) {
        logBuffer += deltaBuffer;
        if (!logBuffer.endsWith("\n")) logBuffer += "\n";
        deltaBuffer = "";
      }
      renderOutput();
    },
    minimize() {
      if (statusEl?.dataset.state !== "running") return;
      minimized = true;
      backdrop.hidden = true;
      backdrop.classList.add("is-minimized");
      dock.hidden = false;
      syncDockState("running");
      syncStageUi();
      showToast(`${panelTitle}：已转入后台，完成后会通知您`, { type: "info", duration: 3600 });
    },
    expand() {
      minimized = false;
      backdrop.hidden = false;
      backdrop.classList.remove("is-minimized");
      dock.hidden = true;
    },
    closePanel() {
      if (statusEl?.dataset.state === "running") {
        this.minimize();
        return;
      }
      backdrop.hidden = true;
      dock.hidden = true;
      minimized = false;
      backdrop.classList.remove("is-minimized");
    },
    finish() {
      if (deltaBuffer) {
        logBuffer += deltaBuffer;
        if (!logBuffer.endsWith("\n")) logBuffer += "\n";
        deltaBuffer = "";
      }
      if (statusEl) {
        statusEl.textContent = "done";
        statusEl.dataset.state = "done";
      }
      this.setStage("已完成", { detail: "结果已写入页面，请检查后继续", progress: 100 });
      updateLlmStreamSubtitle(backdrop, "生成完成，请检查结果后关闭");
      if (minimizeBtn) minimizeBtn.hidden = true;
      if (closeBtn) {
        closeBtn.hidden = false;
        closeBtn.disabled = false;
        closeBtn.textContent = "关闭";
      }
      syncDockState("done");
      if (minimized) {
        dock.hidden = false;
      }
      renderOutput();
    },
    fail(message) {
      logBuffer += `\n[error] ${String(message || "请求失败")}\n`;
      if (statusEl) {
        statusEl.textContent = "error";
        statusEl.dataset.state = "error";
      }
      this.setStage("请求失败", { detail: String(message || "请求失败"), progress: 100 });
      updateLlmStreamSubtitle(backdrop, "请求失败，可展开技术日志查看详情");
      if (minimizeBtn) minimizeBtn.hidden = true;
      if (closeBtn) {
        closeBtn.hidden = false;
        closeBtn.disabled = false;
        closeBtn.textContent = "关闭";
      }
      syncDockState("error");
      if (minimized) {
        dock.hidden = false;
        this.expand();
        if (logDetails) logDetails.open = true;
        showToast(`${panelTitle}失败，请查看控制台输出`, { type: "error", duration: 5600 });
      }
      renderOutput();
    },
    close(delayMs = 0) {
      window.setTimeout(() => {
        backdrop.hidden = true;
        dock.hidden = true;
        minimized = false;
        backdrop.classList.remove("is-minimized");
      }, delayMs);
    }
  };

  consoleUi.setStage(stageLabel, { detail: "正在建立连接…", progress: 8 });
  backdrop.__llmConsole = consoleUi;
  return consoleUi;
}

export async function apiEnvelopeStream(path, options = {}, streamUi = {}) {
  const {
    title = "LLM 运行中",
    console: externalConsole = null,
    animated = true,
    autoCloseOnSuccess = false
  } = streamUi;
  const consoleUi = externalConsole || openLlmStreamConsole(title);
  let settled = false;

  try {
    const response = await fetch(path, {
      ...options,
      headers: { ...JSON_HEADERS, ...(options.headers || {}) },
      credentials: "same-origin"
    });
    const contentType = response.headers.get("Content-Type") || "";

    if (!contentType.includes("text/event-stream")) {
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
      consoleUi.finish();
      settled = true;
      return payload.data;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new WangzhuanApiError({
        code: "stream_unavailable",
        message: "浏览器无法读取流式响应"
      }, response.status);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let resultData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseClientSseBlocks(buffer);
      buffer = parsed.rest;

      for (const item of parsed.events) {
        if (item.data === "[DONE]") continue;
        let payload = {};
        try {
          payload = JSON.parse(item.data);
        } catch {
          continue;
        }

        if (item.event === "log") {
          consoleUi.log(payload.line ?? "");
        } else if (item.event === "reset") {
          consoleUi.resetDelta();
        } else if (item.event === "delta") {
          await appendAnimatedDelta(consoleUi, payload.text ?? "", animated);
        } else if (item.event === "done") {
          if (payload.code !== "ok") {
            throw new WangzhuanApiError(payload, response.status);
          }
          consoleUi.log("");
          consoleUi.log("[完成] 正在应用到页面…");
          consoleUi.finish();
          resultData = payload.data;
          settled = true;
        } else if (item.event === "error") {
          throw new WangzhuanApiError(payload, response.status);
        }
      }
    }

    if (resultData) return resultData;
    throw new WangzhuanApiError({
      code: "stream_incomplete",
      message: "流式连接意外结束",
      requestId: response.headers.get("X-Request-Id") || ""
    }, response.status);
  } catch (error) {
    if (!settled) {
      consoleUi.fail(error?.message || "请求失败");
    }
    throw error;
  } finally {
    if (!externalConsole && settled && autoCloseOnSuccess) {
      consoleUi.close(1800);
    }
  }
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
  const rows = Array.isArray(error?.details) && error.details.length
    ? error.details
    : buildErrorDetails(error);
  if (details) {
    if (rows.length) {
      details.hidden = false;
      details.innerHTML = rows.map((row) => `<div class="wz-error-modal-detail-row">${escapeHtml(String(row))}</div>`).join("");
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

function outputPreviewCardKey(output = {}, index = 0) {
  if (output.outputId) return String(output.outputId);
  const base = output.storageKey || outputPreviewUrl(output) || "output";
  return `${base}::${index}`;
}

function outputPreviewMediaFingerprint(output = {}, index = 0) {
  const url = outputPreviewUrl(output);
  return [outputPreviewCardKey(output, index), url, output.kind || ""].join("|");
}

function outputPreviewCardFingerprint(output = {}, index = 0) {
  const url = outputPreviewUrl(output);
  return [
    outputPreviewMediaFingerprint(output, index),
    output.qcStatus || "",
    output.downloadEligible ? "1" : "0",
    output.previewConfirmed ? "1" : "0",
    output.errorMessage || "",
    output.modelQcSummary?.score ?? "",
    output.modelQcSummary?.summary || ""
  ].join("|");
}

function renderOutputPreviewCardBody(output = {}, index = 0, { confirmable = false } = {}) {
  const url = outputPreviewUrl(output);
  const statusMap = { pass: "QC 通过", warn: "QC 警告", fail: "QC 失败", manual_required: "需人工确认", not_started: "未质检" };
  const meta = [
    output.kind,
    output.durationSec ? `${output.durationSec}s` : "",
    output.downloadEligible ? "可下载" : "",
    output.previewConfirmed ? "已确认" : ""
  ].filter(Boolean).join(" · ");
  return `
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
  `;
}

function renderOutputPreviewCard(output = {}, index = 0, { confirmable = false } = {}) {
  const url = outputPreviewUrl(output);
  const key = outputPreviewCardKey(output, index);
  const fingerprint = outputPreviewCardFingerprint(output, index);
  const mediaFingerprint = outputPreviewMediaFingerprint(output, index);
  return `
    <article class="wz-output-card" data-output-id="${escapeHtml(key)}" data-preview-fingerprint="${escapeHtml(fingerprint)}" data-media-fingerprint="${escapeHtml(mediaFingerprint)}">
      <div class="wz-output-card-media">
        ${url
          ? isImagePreview(output)
            ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(output.outputId || "输出预览")}" loading="lazy" />`
            : `<video class="wz-output-video" data-preview-key="${escapeHtml(key)}" src="${escapeHtml(url)}" controls preload="metadata" playsinline aria-label="${escapeHtml(output.outputId || "输出视频预览")}"></video>`
          : `<div class="wz-output-card-empty">暂无预览地址</div>`}
      </div>
      <div class="wz-output-card-body">
        ${renderOutputPreviewCardBody(output, index, { confirmable })}
      </div>
    </article>
  `;
}

function updateOutputPreviewCardInPlace(card, output = {}, index = 0, { confirmable = false } = {}) {
  card.dataset.previewFingerprint = outputPreviewCardFingerprint(output, index);
  card.dataset.mediaFingerprint = outputPreviewMediaFingerprint(output, index);
  const body = card.querySelector(".wz-output-card-body");
  if (body) body.innerHTML = renderOutputPreviewCardBody(output, index, { confirmable });
}

function listDirectOutputPreviewCards(root) {
  if (!root) return [];
  return [...root.children].filter((node) => node.classList?.contains("wz-output-card") && node.dataset.outputId);
}

function findDirectOutputPreviewRoot(container) {
  for (const child of container.children) {
    if (child.classList.contains("wz-output-previews") && !child.classList.contains("empty-line")) return child;
  }
  return null;
}

function findDirectGalleryPager(container) {
  for (const child of container.children) {
    if (child.classList.contains("wz-gallery-pager")) return child;
  }
  return null;
}

export function renderOutputPreviewCards(outputs = [], { emptyText = "暂无输出", confirmable = false } = {}) {
  const items = (Array.isArray(outputs) ? outputs : []).filter(Boolean);
  if (!items.length) return `<div class="wz-output-previews empty-line">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="wz-output-previews">
      ${items.map((output, index) => renderOutputPreviewCard(output, index, { confirmable })).join("")}
    </div>
  `;
}

function ensureOutputPreviewRoot(container) {
  let root = findDirectOutputPreviewRoot(container);
  if (root) return root;
  for (const child of [...container.children]) {
    if (child.classList.contains("wz-output-previews") && child.classList.contains("empty-line")) child.remove();
  }
  root = document.createElement("div");
  root.className = "wz-output-previews";
  const pager = findDirectGalleryPager(container);
  if (pager) container.insertBefore(root, pager);
  else container.appendChild(root);
  return root;
}

export function patchOutputPreviewCards(container, outputs = [], { emptyText = "暂无输出", confirmable = false } = {}) {
  if (!container) return;
  const items = (Array.isArray(outputs) ? outputs : []).filter(Boolean);
  if (!items.length) {
    findDirectOutputPreviewRoot(container)?.remove();
    let empty = null;
    for (const child of container.children) {
      if (child.classList.contains("wz-output-previews") && child.classList.contains("empty-line")) {
        empty = child;
        break;
      }
    }
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "wz-output-previews empty-line";
      const pager = findDirectGalleryPager(container);
      if (pager) container.insertBefore(empty, pager);
      else container.appendChild(empty);
    }
    empty.textContent = emptyText;
    return;
  }

  const root = ensureOutputPreviewRoot(container);
  const existing = new Map();
  for (const card of listDirectOutputPreviewCards(root)) {
    existing.set(card.dataset.outputId, card);
  }

  const nextKeys = [];
  for (let index = 0; index < items.length; index += 1) {
    const output = items[index];
    const key = outputPreviewCardKey(output, index);
    const fingerprint = outputPreviewCardFingerprint(output, index);
    const mediaFingerprint = outputPreviewMediaFingerprint(output, index);
    nextKeys.push(key);
    const current = existing.get(key);
    if (current?.dataset.previewFingerprint === fingerprint) {
      root.appendChild(current);
      continue;
    }
    if (current?.dataset.mediaFingerprint === mediaFingerprint) {
      updateOutputPreviewCardInPlace(current, output, index, { confirmable });
      root.appendChild(current);
      continue;
    }
    const html = renderOutputPreviewCard(output, index, { confirmable }).trim();
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const next = holder.firstElementChild;
    if (!next) continue;
    if (current) current.replaceWith(next);
    else root.appendChild(next);
  }

  for (const [key, card] of existing) {
    if (!nextKeys.includes(key)) card.remove();
  }
}

export function bindPreviewInteractionGuard(root) {
  if (!root || root.dataset.previewInteractionBound) return;
  root.dataset.previewInteractionBound = "1";
  for (const type of ["click", "pointerdown"]) {
    root.addEventListener(type, (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".wz-output-card-media, .wz-output-video, .wz-output-card-actions")) {
        event.stopPropagation();
      }
    }, true);
  }
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
    .map((item, index) => outputPreviewCardFingerprint(item, index))
    .join("|");
}

export function galleryStateFingerprint(gallery = {}) {
  const pagination = gallery.pagination || {};
  return `${outputPreviewItemsFingerprint(gallery.items)}::${pagination.page || 1}:${pagination.pageSize || 0}:${pagination.total || 0}`;
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

export function workbenchFocusHash(type, status = "") {
  if (type === "remix") return "#remixNodeDelivery";
  return status === "preview_required" ? "#wzNodeBatch" : "#wzNodeLog";
}

export function readWorkbenchRestoreRequest() {
  const params = new URLSearchParams(location.search);
  if (params.get("restore") !== "1") return null;
  const remixId = String(params.get("remixId") || "").trim();
  if (remixId) return { type: "remix", id: remixId };
  const batchId = String(params.get("batchId") || "").trim();
  if (batchId) return { type: "batch", id: batchId };
  return null;
}

export function workbenchHref(type, status = "", id = "") {
  const base = type === "remix" ? "/competitor-remix.html" : "/wangzhuan-v2.html";
  const hash = workbenchFocusHash(type, status);
  const taskId = String(id || "").trim();
  if (!taskId) return `${base}${hash}`;
  const params = new URLSearchParams({ restore: "1" });
  if (type === "remix") params.set("remixId", taskId);
  else params.set("batchId", taskId);
  return `${base}?${params}${hash}`;
}

export function activeLockActionsHtml(lock) {
  if (!lock) return "";
  const href = taskSpaceHref(lock.type, lock.id);
  return `${escapeHtml(lock.label)} · 可继续并行发起新任务 · <a href="${href}">打开任务管理</a>`;
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

export function applyQcReportsToBatch(batch = {}, reports = []) {
  if (!batch || !Array.isArray(reports) || !reports.length) return batch;
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const byId = new Map(outputs.map((output) => [output.outputId, output]));
  for (const report of reports) {
    if (!report?.outputId) continue;
    const output = byId.get(report.outputId) || { outputId: report.outputId };
    if (!byId.has(report.outputId)) outputs.push(output);
    output.qcStatus = report.qcStatus || output.qcStatus;
    if (Array.isArray(report.checks) && report.checks.length) output.qcChecks = report.checks;
    if (report.summary) output.qcSummary = report.summary;
    if (report.modelReview) {
      output.modelQcSummary = {
        provider: report.modelReview.provider,
        model: report.modelReview.model,
        passed: report.modelReview.passed,
        score: report.modelReview.score,
        summary: report.modelReview.summary,
        issueCodes: (report.modelReview.issues || []).map((issue) => issue.code),
        recommendedAction: report.modelReview.recommendedAction
      };
    }
    byId.set(report.outputId, output);
  }
  batch.outputs = outputs;
  return batch;
}

function outputExpectsModelQc(batch = {}, output = {}) {
  if (output.sourceType !== "pipeline") return false;
  const hasAsset = Boolean(output.filePath || output.storageUrl || output.storageKey);
  if (!hasAsset) return false;
  if (output.kind === "stitched_video") return true;
  return Number(batch.estimate?.durationSec) === 15 && Number(output.durationSec) === 15;
}

function batchModelQcSummary(batch = {}, reports = []) {
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const reportById = new Map((Array.isArray(reports) ? reports : []).map((report) => [report.outputId, report]));
  let expected = 0;
  let ran = 0;
  for (const output of outputs) {
    if (!outputExpectsModelQc(batch, output)) continue;
    expected += 1;
    const report = reportById.get(output.outputId);
    if (report?.modelReview || output.modelQcSummary) {
      ran += 1;
      continue;
    }
    const checks = report?.checks || output.qcChecks || [];
    if (checks.some((item) => item.checkId === "model_video_qc")) ran += 1;
  }
  return { expected, ran, skipped: Math.max(0, expected - ran) };
}

export function summarizeBatchQcFailures(batch = {}, reports = []) {
  const reportById = new Map((Array.isArray(reports) ? reports : []).map((report) => [report.outputId, report]));
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const rows = [];
  for (const output of outputs) {
    const label = output.outputId || output.kind || "输出";
    const report = reportById.get(output.outputId);
    const checks = Array.isArray(report?.checks) && report.checks.length
      ? report.checks
      : (Array.isArray(output.qcChecks) ? output.qcChecks : []);
    const issues = checks.filter((item) => ["fail", "warn", "manual_required"].includes(item.status));
    if (issues.length) {
      for (const item of issues) {
        const prefix = item.status === "warn" ? "警告" : "未通过";
        rows.push(`${label} · ${prefix} · ${item.checkId}: ${item.message}`);
      }
      continue;
    }
    const qcStatus = report?.qcStatus || output.qcStatus;
    if (qcStatus && !["pass", "not_started"].includes(qcStatus)) {
      const summary = report?.summary
        || (typeof output.qcSummary === "string" ? output.qcSummary : output.qcSummary?.summary)
        || output.modelQcSummary?.summary
        || output.errorMessage
        || "";
      rows.push(`${label} · ${qcStatus}${summary ? `: ${summary}` : ""}`);
    }
  }
  const modelSummary = batchModelQcSummary(batch, reports);
  if (modelSummary.skipped > 0) {
    rows.unshift(`模型质检未执行（${modelSummary.skipped}/${modelSummary.expected} 个成片输出）：规则质检秒级完成，视觉模型需本地文件或可访问的视频 URL。`);
  }
  if (!rows.length && batch.qcSummary) {
    const failed = Number(batch.qcSummary.failed || 0);
    const passed = Number(batch.qcSummary.passed || 0);
    const total = Number(batch.qcSummary.total || 0);
    if (total) rows.push(`汇总：${passed}/${total} 通过，${failed} 项未通过`);
  }
  return rows.slice(0, 14);
}

export function notifyBatchQcResult(qcResult = {}) {
  const reports = Array.isArray(qcResult.reports) ? qcResult.reports : [];
  const batch = applyQcReportsToBatch({ ...(qcResult.batch || qcResult) }, reports);
  const hasFreshQc = reports.length > 0 || batch.outputs?.some((output) => Array.isArray(output.qcChecks) && output.qcChecks.length);
  const modelSummary = batchModelQcSummary(batch, reports);
  const ruleOnly = hasFreshQc && modelSummary.expected > 0 && modelSummary.ran === 0;
  const qcFailed = batch.outputs?.some((output) => ["fail", "manual_required"].includes(output.qcStatus))
    || (hasFreshQc && (batch.status === "failed" || batch.status === "partial_failed"));
  const qcPassed = hasFreshQc && batch.outputs?.length
    && batch.outputs.every((output) => output.qcStatus === "pass");

  if (qcPassed || (hasFreshQc && batch.status === "succeeded")) {
    showToast(ruleOnly ? "规则质检通过（未调用视觉模型）" : "视频质检通过", { type: "success", duration: 4200 });
    return;
  }
  if (qcFailed) {
    const details = summarizeBatchQcFailures(batch, reports);
    showErrorModal({
      message: ruleOnly
        ? "规则质检未通过（秒级完成，未调用视觉模型）。请根据明细修复后重新质检。"
        : details.length
          ? "以下检查项未通过，请根据明细修复后重新质检。"
          : "视频质检未通过，请在下方交付结果中查看各输出的质检状态。",
      details
    }, ruleOnly ? "规则质检未通过" : "质检未通过");
    return;
  }
  if (hasFreshQc) {
    showToast(ruleOnly ? "规则质检已完成（未调用视觉模型）" : "视频质检已完成", { type: "info", duration: 4200 });
    return;
  }
  showToast("质检状态已刷新", { type: "info", duration: 3200 });
}

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
