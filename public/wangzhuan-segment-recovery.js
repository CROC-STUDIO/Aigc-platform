const READY_STATES = new Set(["ready", "replacement_ready"]);
const MAX_REPLACEMENT_BYTES = 100 * 1024 * 1024;
const REPLACEMENT_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const REPLACEMENT_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function taskId(task = {}) {
  return String(task.generationTaskId || task.taskId || task.id || "");
}

function groupKey(value = {}) {
  return value.recoveryGroupKey
    || `${String(value.branchId || "default")}:${Number(value.branchVariantIndex || value.variantIndex || 1)}`;
}

function outputForTask(batch, task) {
  if (task.currentOutput?.outputId) return task.currentOutput;
  const currentOutputId = task.currentOutputId || task.responseSummary?.currentOutputId;
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  if (currentOutputId) return outputs.find((output) => output.outputId === currentOutputId) || null;
  return outputs.find((output) => {
    return output.kind === "segment_video"
      && (output.generationTaskIds || []).includes(taskId(task));
  }) || null;
}

function branchOrder(value = {}) {
  const explicit = Number(value.branchIndex);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(value.branchId || "").match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildRecoveryViewModel(batch = {}) {
  const outputsById = new Map();
  const groupByOutputId = new Map();
  const taskByOutputId = new Map();
  const groupsByKey = new Map();
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  for (const sourceTask of tasks) {
    const availability = sourceTask.availability || sourceTask.retryEligibility?.status || "unavailable";
    const currentOutput = outputForTask(batch, sourceTask);
    const task = {
      ...sourceTask,
      availability,
      currentOutput,
      currentOutputId: currentOutput?.outputId || ""
    };
    const key = groupKey(task);
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        key,
        branchId: task.branchId || "default",
        branchLabel: task.branchLabel || task.branchId || "默认分支",
        branchIndex: task.branchIndex,
        branchVariantIndex: Number(task.branchVariantIndex || task.variantIndex || 1),
        tasks: []
      });
    }
    groupsByKey.get(key).tasks.push(task);
    if (READY_STATES.has(availability) && currentOutput?.outputId && currentOutput.kind === "segment_video") {
      outputsById.set(currentOutput.outputId, currentOutput);
      groupByOutputId.set(currentOutput.outputId, key);
      taskByOutputId.set(currentOutput.outputId, task);
    }
  }
  const groups = [...groupsByKey.values()]
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((left, right) => {
        const segmentDifference = Number(left.segmentIndex || 1) - Number(right.segmentIndex || 1);
        return segmentDifference || taskId(left).localeCompare(taskId(right));
      })
    }))
    .sort((left, right) => {
      const branchDifference = branchOrder(left) - branchOrder(right);
      if (branchDifference) return branchDifference;
      const branchIdDifference = String(left.branchId).localeCompare(String(right.branchId));
      return branchIdDifference || left.branchVariantIndex - right.branchVariantIndex;
    });
  const ready = tasks.filter((task) => READY_STATES.has(task.availability || task.retryEligibility?.status)).length;
  const running = tasks.filter((task) => (task.availability || task.retryEligibility?.status) === "running").length;
  const failed = tasks.length - ready - running;
  const stitchVersions = (Array.isArray(batch.outputs) ? batch.outputs : [])
    .filter((output) => output.kind === "stitched_video" && output.manualStitch === true)
    .sort((left, right) => Number(right.stitchVersion || 0) - Number(left.stitchVersion || 0));
  return {
    batch,
    groups,
    outputsById,
    groupByOutputId,
    taskByOutputId,
    stitchVersions,
    summary: { total: tasks.length, ready, failed, running }
  };
}

export function queueStorageKey({ userId = "anonymous", projectKey = "default", batchId = "none" } = {}) {
  return `wangzhuan:segment-recovery:queue:${encodeURIComponent(String(userId))}:${encodeURIComponent(String(projectKey))}:${encodeURIComponent(String(batchId))}`;
}

export function reconcileQueue(outputIds = [], outputsById = new Map()) {
  const seen = new Set();
  const queue = [];
  for (const outputId of Array.isArray(outputIds) ? outputIds : []) {
    const id = String(outputId || "");
    if (!id || seen.has(id) || !outputsById.has(id)) continue;
    seen.add(id);
    queue.push(id);
  }
  return queue;
}

export function moveQueueItem(outputIds = [], fromIndex, toIndex) {
  const queue = [...outputIds];
  const from = Number(fromIndex);
  if (!Number.isInteger(from) || from < 0 || from >= queue.length) return queue;
  const target = Math.max(0, Math.min(Number(toIndex) || 0, queue.length - 1));
  const [item] = queue.splice(from, 1);
  queue.splice(target, 0, item);
  return queue;
}

export function buildStitchRequest(outputIds = [], model, idempotencyKey) {
  const queue = reconcileQueue(outputIds, model?.outputsById || new Map());
  const groups = new Set(queue.map((outputId) => model?.groupByOutputId?.get(outputId)).filter(Boolean));
  return {
    idempotencyKey,
    segmentOutputIds: queue,
    confirmMixed: groups.size > 1
  };
}

export function hasPendingSegmentRecovery(detail = {}) {
  const batch = detail?.batch || detail;
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  const activeStatuses = new Set(["pending", "queued", "submitting", "waiting_upstream", "processing", "running"]);
  return tasks.some((task) => {
    return task.availability === "running"
      || task.retryEligibility?.status === "running"
      || activeStatuses.has(String(task.status || ""));
  });
}

function readStoredQueue(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem?.(key) || "null");
    return Array.isArray(value?.outputIds) ? value.outputIds : [];
  } catch {
    return [];
  }
}

function writeStoredQueue(storage, key, outputIds) {
  try {
    storage?.setItem?.(key, JSON.stringify({
      outputIds,
      updatedAt: new Date().toISOString()
    }));
  } catch {
    // Local storage can be unavailable in private or quota-limited contexts.
  }
}

function statusText(status) {
  return {
    ready: "可用",
    replacement_ready: "用户替换",
    running: "处理中",
    retryable: "可重试",
    repair_required: "需修复素材",
    retry_exhausted: "重试已耗尽",
    unavailable: "不可用"
  }[status] || status || "未知";
}

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function newIdempotencyKey(prefix) {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${token}`;
}

export async function validateReplacementFile(file, options = {}) {
  if (!file) throw new Error("请选择替换视频");
  const extension = String(file.name || "").split(".").pop()?.toLowerCase() || "";
  if (!REPLACEMENT_EXTENSIONS.has(extension) || (file.type && !REPLACEMENT_MIME_TYPES.has(file.type))) {
    throw new Error("替换片段仅支持 MP4、MOV 或 WEBM 视频");
  }
  if (Number(file.size || 0) > MAX_REPLACEMENT_BYTES) {
    throw new Error("替换片段不能超过 100 MB");
  }
  const documentRef = options.document || globalThis.document;
  const urlApi = options.urlApi || globalThis.URL;
  if (!documentRef?.createElement || !urlApi?.createObjectURL) return;
  await new Promise((resolve, reject) => {
    const video = documentRef.createElement("video");
    const objectUrl = urlApi.createObjectURL(file);
    let timer;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      video.removeAttribute?.("src");
      video.load?.();
      urlApi.revokeObjectURL?.(objectUrl);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
        finish(new Error("无法读取替换视频的时长或画面尺寸"));
        return;
      }
      finish();
    };
    video.onerror = () => finish(new Error("无法读取替换视频元数据"));
    timer = globalThis.setTimeout(() => finish(new Error("读取替换视频元数据超时")), 10000);
    video.src = objectUrl;
  });
}

function taskActionMarkup(task, view = {}) {
  const taskUid = escapeHtml(taskId(task));
  const disabled = view.busy ? " disabled" : "";
  const replacement = ["repair_required", "retry_exhausted", "replacement_ready"].includes(task.availability)
    ? `<button type="button" class="mini ghost" data-upload-replacement="${taskUid}"${disabled}>上传替换片段</button>
       <input type="file" data-replacement-input="${taskUid}" accept="video/mp4,video/webm,video/quicktime" hidden>`
    : "";
  const retry = task.availability === "retryable"
    ? `<button type="button" class="mini" data-retry-task="${taskUid}"${disabled}>重试</button>`
    : "";
  const download = READY_STATES.has(task.availability) && task.currentOutput?.outputId
    ? `<button type="button" class="mini ghost" data-download-output="${escapeHtml(task.currentOutput.outputId)}"${disabled}>下载</button>`
    : "";
  return `${retry}${replacement}${download}<button type="button" class="wz-recovery-icon-btn" data-toggle-task="${taskUid}" aria-label="展开详情" title="展开详情" aria-expanded="${view.expandedTaskIds?.has(taskId(task)) ? "true" : "false"}">⌄</button>`;
}

function attemptMarkup(task) {
  const history = Array.isArray(task.attemptHistory) ? task.attemptHistory : [];
  if (!history.length) return "<p class=\"wz-recovery-empty\">暂无历次尝试记录</p>";
  return `<ol class="wz-recovery-attempts">${history.map((attempt, index) => `<li>
    <span><strong>尝试 ${escapeHtml(attempt.attemptNo || index + 1)}</strong>${index === history.length - 1 ? "<em>最新</em>" : ""}</span>
    <span>${escapeHtml(attempt.status || "-")} · ${escapeHtml(attempt.provider || "-")}</span>
    <span>${escapeHtml(formatTime(attempt.startedAt))} → ${escapeHtml(formatTime(attempt.finishedAt))}</span>
    ${attempt.upstreamTaskId ? `<code>${escapeHtml(attempt.upstreamTaskId)}</code>` : ""}
    ${attempt.errorMessage ? `<p>${escapeHtml(attempt.errorCode || "failed")} · ${escapeHtml(attempt.errorMessage)}</p>` : ""}
  </li>`).join("")}</ol>`;
}

function recoveryKind(model, queue) {
  const groups = new Set(queue.map((outputId) => model.groupByOutputId.get(outputId)).filter(Boolean));
  if (groups.size > 1) return { kind: "mixed", text: "混合编排", tone: "warn" };
  if (groups.size === 0) return { kind: "empty", text: "等待选择", tone: "muted" };
  const key = [...groups][0];
  const group = model.groups.find((item) => item.key === key);
  return queue.length === group?.tasks.length
    ? { kind: "complete", text: "完整变体", tone: "good" }
    : { kind: "partial", text: "部分片段", tone: "info" };
}

function compatibilityMarkup(model, queue, queueKind) {
  const outputs = queue.map((outputId) => model.outputsById.get(outputId)).filter(Boolean);
  const durationSec = outputs.reduce((total, output) => total + Number(output.durationSec || 0), 0);
  const sizes = new Set(outputs.map((output) => {
    const width = Number(output.width || output.probe?.width || 0);
    const height = Number(output.height || output.probe?.height || 0);
    return width && height ? `${width}×${height}` : "";
  }).filter(Boolean));
  const warnings = [];
  if (queueKind.kind === "mixed") warnings.push("跨变体");
  if (sizes.size > 1) warnings.push("分辨率不同");
  const tone = warnings.length ? "warn" : (queue.length ? "good" : "muted");
  const message = queue.length
    ? `${queue.length} 个片段 · 预计 ${durationSec ? `${durationSec.toFixed(1)}s` : "时长待服务端检查"}${warnings.length ? ` · ${warnings.join("、")}` : " · 可提交权威兼容检查"}`
    : "选择片段后显示预计时长与兼容性";
  return `<div class="wz-recovery-compatibility" data-tone="${tone}"><strong>拼接前检查</strong><span>${escapeHtml(message)}</span></div>`;
}

function renderModel(model, queue, view = {}) {
  const selected = new Set(queue);
  const actionDisabled = view.busy ? " disabled" : "";
  const groups = model.groups.map((group) => {
    const readyCount = group.tasks.filter((task) => READY_STATES.has(task.availability)).length;
    const failedCount = group.tasks.filter((task) => !READY_STATES.has(task.availability) && task.availability !== "running").length;
    const runningCount = group.tasks.filter((task) => task.availability === "running").length;
    const rows = group.tasks.map((task) => {
      const output = task.currentOutput;
      const checked = output?.outputId && selected.has(output.outputId);
      const selectable = output?.outputId && model.outputsById.has(output.outputId);
      const expanded = view.expandedTaskIds?.has(taskId(task));
      const errorText = task.errorMessage || task.retryEligibility?.reason || "";
      return `<div class="wz-recovery-segment-wrap" data-task-id="${escapeHtml(taskId(task))}">
      <div class="wz-recovery-segment">
        <input type="checkbox" data-select-output="${escapeHtml(output?.outputId || "")}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="选择片段 ${escapeHtml(task.segmentIndex || 1)}">
        <button type="button" class="wz-recovery-thumb" data-toggle-task="${escapeHtml(taskId(task))}" aria-label="查看片段 ${escapeHtml(task.segmentIndex || 1)}" aria-expanded="${expanded ? "true" : "false"}">${output?.previewUrl ? `<video src="${escapeHtml(output.previewUrl)}" preload="metadata" muted playsinline></video>` : "<span>--</span>"}</button>
        <span class="wz-recovery-segment-name"><strong>片段 ${escapeHtml(task.segmentIndex || 1)}</strong><small>${escapeHtml(task.segmentRole || task.title || task.scriptId || taskId(task))} · ${escapeHtml(task.durationSec || output?.durationSec || "-")}s</small></span>
        <span class="wz-recovery-status" data-status="${escapeHtml(task.availability)}">${escapeHtml(statusText(task.availability))}</span>
        <span class="wz-recovery-attempt"><strong>最新</strong><small>尝试 ${escapeHtml(task.attemptHistory?.length || task.attempts || 0)} · ${escapeHtml(formatTime(task.finishedAt || task.updatedAt))}</small></span>
        <span class="wz-recovery-error" title="${escapeHtml(errorText)}">${escapeHtml(errorText || (output?.fulfillmentSource === "user_replacement" ? "用户替换" : "--"))}</span>
        <span class="wz-recovery-actions">${taskActionMarkup(task, view)}</span>
      </div>
      ${expanded ? `<div class="wz-recovery-detail">
        <div class="wz-recovery-player">${output?.previewUrl ? `<video src="${escapeHtml(output.previewUrl)}" controls preload="metadata" playsinline></video>` : `<p>${escapeHtml(errorText || "当前没有可播放片段")}</p>`}</div>
        <div><h4>历次尝试</h4>${attemptMarkup(task)}</div>
      </div>` : ""}
      </div>`;
    }).join("");
    return `<section class="wz-recovery-group" data-group-key="${escapeHtml(group.key)}">
      <header><strong>${escapeHtml(group.branchLabel)} · 变体 ${escapeHtml(group.branchVariantIndex)}</strong><span>可用 ${readyCount} / 失败 ${failedCount} / 处理中 ${runningCount}</span></header>
      <div>${rows}</div>
    </section>`;
  }).join("");
  const queueItems = queue.map((outputId, index) => {
    const output = model.outputsById.get(outputId);
    const sourceTask = model.taskByOutputId.get(outputId);
    const group = model.groupByOutputId.get(outputId) || "";
    return `<li draggable="true" data-queue-output="${escapeHtml(outputId)}" data-queue-index="${index}">
      <span class="wz-recovery-order">${index + 1}</span>
      <span><strong>${escapeHtml(output?.displayFileName || outputId)}</strong><small>${escapeHtml(group)} · 原片段 ${escapeHtml(sourceTask?.segmentIndex || "-")}</small></span>
      <span class="wz-recovery-queue-actions">
        <button type="button" data-move-queue="up" data-index="${index}" aria-label="上移">↑</button>
        <button type="button" data-move-queue="down" data-index="${index}" aria-label="下移">↓</button>
        <button type="button" data-remove-queue="${escapeHtml(outputId)}" aria-label="移除">×</button>
      </span>
    </li>`;
  }).join("");
  const versions = model.stitchVersions.map((output) => `<li data-stitch-version="${escapeHtml(output.outputId)}">
    <span class="wz-recovery-version-index">V${escapeHtml(output.stitchVersion || 1)}</span>
    <span><strong>${escapeHtml(output.displayFileName || output.outputId)}</strong><small>${escapeHtml(output.stitchKind || "partial")} · ${escapeHtml(output.segmentOutputIds?.length || 0)} 个片段 · ${escapeHtml(formatTime(output.createdAt))}</small></span>
    <span class="wz-recovery-version-actions">
      <button type="button" class="mini ghost" data-restore-version="${escapeHtml(output.outputId)}"${actionDisabled}>恢复队列</button>
      <button type="button" class="mini ghost" data-download-output="${escapeHtml(output.outputId)}"${actionDisabled}>下载</button>
      <button type="button" class="wz-recovery-icon-btn" data-rename-version="${escapeHtml(output.outputId)}" aria-label="重命名" title="重命名"${actionDisabled}>✎</button>
      <button type="button" class="wz-recovery-icon-btn danger" data-delete-version="${escapeHtml(output.outputId)}" aria-label="删除" title="删除"${actionDisabled}>×</button>
    </span>
  </li>`).join("");
  const queueKind = recoveryKind(model, queue);
  const retryableCount = model.groups.flatMap((group) => group.tasks).filter((task) => task.availability === "retryable").length;
  return `<div class="wz-recovery-summary" aria-busy="${view.busy ? "true" : "false"}">
    <span><strong>${model.summary.total}</strong>片段</span><span><strong>${model.summary.ready}</strong>可用</span><span><strong>${model.summary.failed}</strong>失败</span><span><strong>${model.summary.running}</strong>处理中</span>
  </div>
  ${view.notice?.text ? `<div class="wz-recovery-notice" data-tone="${escapeHtml(view.notice.tone || "info")}" role="status">${escapeHtml(view.notice.text)}</div>` : ""}
  <section class="wz-recovery-zone" data-recovery-zone="segments"><header><h3>片段状态</h3><span class="wz-recovery-zone-actions"><button type="button" class="mini ghost" data-download-selected ${queue.length && !view.busy ? "" : "disabled"}>下载选中片段（${queue.length}）</button><button type="button" class="mini" data-retry-failed ${retryableCount && !view.busy ? "" : "disabled"}>一键重试全部失败片段</button></span></header>${groups || "<p class=\"wz-recovery-empty\">等待片段任务</p>"}</section>
  <section class="wz-recovery-zone" data-recovery-zone="queue"><header><h3>拼接队列</h3><span class="wz-recovery-zone-actions"><em data-tone="${queueKind.tone}">${queueKind.text}</em><button type="button" class="mini ghost" data-clear-queue ${queue.length && !view.busy ? "" : "disabled"}>清空</button><button type="button" class="mini" data-start-stitch ${queue.length && !view.busy ? "" : "disabled"}>开始拼接</button></span></header>${compatibilityMarkup(model, queue, queueKind)}<ol class="wz-recovery-queue">${queueItems || "<li class=\"wz-recovery-empty\">尚未选择片段</li>"}</ol></section>
  <section class="wz-recovery-zone" data-recovery-zone="versions"><h3>拼接版本</h3><ol>${versions || "<li class=\"wz-recovery-empty\">暂无手动拼接版本</li>"}</ol></section>`;
}

export function createSegmentRecoveryController(options = {}) {
  const root = options.root;
  const body = root?.querySelector?.("[data-segment-recovery-body]")
    || root?.querySelector?.("#wzSegmentRecoveryBody")
    || root;
  const storage = options.storage || globalThis.localStorage;
  let model = buildRecoveryViewModel();
  let queue = [];
  let storageKey = "";
  let draggedIndex = -1;
  let busy = false;
  let notice = null;
  let destroyed = false;
  let activeAbort = null;
  const expandedTaskIds = new Set();
  const request = options.request || (async () => {
    throw new Error("片段恢复请求方法未配置");
  });
  const downloadZip = options.downloadZip || (async () => {
    throw new Error("片段下载方法未配置");
  });
  const confirmAction = options.confirm || globalThis.confirm?.bind(globalThis) || (() => false);
  const promptAction = options.prompt || globalThis.prompt?.bind(globalThis) || (() => null);
  const validateFile = options.validateReplacementFile || validateReplacementFile;

  const persistAndRender = () => {
    if (storageKey) writeStoredQueue(storage, storageKey, queue);
    if (body) body.innerHTML = renderModel(model, queue, { expandedTaskIds, busy, notice });
  };

  const updateDetail = (detail) => {
    const batch = detail?.batch || (detail?.batchId ? detail : null);
    if (!batch?.batchId) {
      model = buildRecoveryViewModel();
      queue = [];
      storageKey = "";
      expandedTaskIds.clear();
      notice = null;
      if (root) root.hidden = true;
      if (body) body.innerHTML = "";
      return;
    }
    model = buildRecoveryViewModel(batch);
    const scope = { ...(options.getScope?.() || {}), batchId: batch.batchId };
    const nextStorageKey = queueStorageKey(scope);
    const storedQueue = nextStorageKey === storageKey && queue.length
      ? queue
      : readStoredQueue(storage, nextStorageKey);
    storageKey = nextStorageKey;
    queue = reconcileQueue(storedQueue, model.outputsById);
    for (const id of expandedTaskIds) {
      if (!model.groups.some((group) => group.tasks.some((task) => taskId(task) === id))) {
        expandedTaskIds.delete(id);
      }
    }
    if (root) root.hidden = false;
    persistAndRender();
  };

  const jsonRequest = (path, payload, method = "POST", signal) => request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {})
  });

  const applyResult = (result) => {
    if (!result?.batch) return;
    if (typeof options.onDetail === "function") options.onDetail(result);
    else updateDetail(result);
  };

  const runAction = async (title, action, successMessage) => {
    if (busy || destroyed) return null;
    busy = true;
    notice = { tone: "info", text: `${title}处理中` };
    persistAndRender();
    activeAbort = typeof AbortController === "function" ? new AbortController() : null;
    try {
      const result = await action(activeAbort?.signal);
      if (destroyed) return result;
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      notice = { tone: "good", text: message || `${title}已完成` };
      applyResult(result);
      options.showToast?.(notice.text);
      return result;
    } catch (error) {
      if (destroyed || error?.name === "AbortError") return null;
      notice = { tone: "bad", text: error?.message || `${title}失败` };
      options.onError?.(error, title);
      options.showToast?.(notice.text);
      return null;
    } finally {
      activeAbort = null;
      if (!destroyed) {
        busy = false;
        persistAndRender();
      }
    }
  };

  const hasData = (target, name) => Boolean(
    target?.dataset && Object.prototype.hasOwnProperty.call(target.dataset, name)
  );

  const findReplacementInput = (target, taskUid) => {
    const nearby = target?.parentElement?.querySelector?.("[data-replacement-input]");
    if (nearby?.dataset?.replacementInput === taskUid) return nearby;
    return [...(body?.querySelectorAll?.("[data-replacement-input]") || [])]
      .find((input) => input.dataset?.replacementInput === taskUid);
  };

  const onChange = async (event) => {
    const input = event.target;
    const outputId = input?.dataset?.selectOutput;
    if (outputId) {
      if (input.checked) queue = reconcileQueue([...queue, outputId], model.outputsById);
      else queue = queue.filter((id) => id !== outputId);
      notice = null;
      persistAndRender();
      return;
    }
    const taskId = input?.dataset?.replacementInput;
    const file = input?.files?.[0];
    if (!taskId || !file) return;
    await runAction("上传替换片段", async (signal) => {
      await validateFile(file);
      const form = new FormData();
      form.append("file", file, file.name);
      return request(`/api/wangzhuan/batches/${encodeURIComponent(model.batch.batchId)}/tasks/${encodeURIComponent(taskId)}/replacement`, {
        method: "POST",
        body: form,
        ...(signal ? { signal } : {})
      });
    }, "替换片段已上传");
    input.value = "";
  };

  const onClick = async (event) => {
    const target = event.target?.closest?.("button") || event.target;
    if (!target?.dataset || target.disabled) return;
    if (hasData(target, "clearQueue")) {
      queue = [];
      notice = null;
    } else if (target.dataset.removeQueue) {
      queue = queue.filter((id) => id !== target.dataset.removeQueue);
      notice = null;
    } else if (target.dataset.moveQueue) {
      const from = Number(target.dataset.index);
      queue = moveQueueItem(queue, from, target.dataset.moveQueue === "up" ? from - 1 : from + 1);
      notice = null;
    } else if (target.dataset.toggleTask) {
      const id = target.dataset.toggleTask;
      if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
      else expandedTaskIds.add(id);
    } else if (target.dataset.uploadReplacement) {
      findReplacementInput(target, target.dataset.uploadReplacement)?.click?.();
      return;
    } else if (target.dataset.retryTask) {
      const taskId = target.dataset.retryTask;
      const result = await runAction("重试片段", (signal) => jsonRequest(
        `/api/wangzhuan/batches/${encodeURIComponent(model.batch.batchId)}/tasks/${encodeURIComponent(taskId)}/retry`,
        { idempotencyKey: newIdempotencyKey("retry-segment") },
        "POST",
        signal
      ), "片段已提交重试");
      if (Number(result?.retriedCount || 0) > 0) options.onRetrySubmitted?.(result.batch?.batchId || model.batch.batchId);
      return;
    } else if (hasData(target, "retryFailed")) {
      const result = await runAction("重试失败片段", (signal) => jsonRequest(
        `/api/wangzhuan/batches/${encodeURIComponent(model.batch.batchId)}/tasks/retry-failed`,
        { idempotencyKey: newIdempotencyKey("retry-failed-segments") },
        "POST",
        signal
      ), (result) => {
        const summary = result?.summary || {};
        return `已提交 ${Number(summary.submitted || 0)} 个、需修复 ${Number(summary.repairRequired || 0)} 个、已耗尽 ${Number(summary.exhausted || 0)} 个、处理中 ${Number(summary.inProgress || 0)} 个`;
      });
      if (Number(result?.summary?.submitted || 0) > 0) options.onRetrySubmitted?.(result.batch?.batchId || model.batch.batchId);
      return;
    } else if (hasData(target, "downloadSelected")) {
      await runAction("下载选中片段", (signal) => downloadZip("/api/wangzhuan/download", {
        batchIds: [model.batch.batchId],
        outputIds: [...queue]
      }, `wangzhuan-${model.batch.batchId}-segments.zip`, signal), "选中片段下载已开始");
      return;
    } else if (target.dataset.downloadOutput) {
      const outputId = target.dataset.downloadOutput;
      await runAction("下载产物", (signal) => downloadZip("/api/wangzhuan/download", {
        batchIds: [model.batch.batchId],
        outputIds: [outputId]
      }, `wangzhuan-${outputId}.zip`, signal), "产物下载已开始");
      return;
    } else if (hasData(target, "startStitch")) {
      const requestPayload = buildStitchRequest(queue, model, newIdempotencyKey("stitch-version"));
      if (!requestPayload.segmentOutputIds.length) return;
      if (requestPayload.confirmMixed && !confirmAction("当前队列包含多个分支或变体，确定要生成混合编排版本吗？")) return;
      await runAction("创建拼接版本", (signal) => jsonRequest(
        `/api/wangzhuan/batches/${encodeURIComponent(model.batch.batchId)}/stitch-versions`,
        requestPayload,
        "POST",
        signal
      ), "新拼接版本已生成");
      return;
    } else if (target.dataset.restoreVersion) {
      const version = model.stitchVersions.find((output) => output.outputId === target.dataset.restoreVersion);
      queue = reconcileQueue(version?.segmentOutputIds || [], model.outputsById);
      notice = { tone: "info", text: `已恢复 V${version?.stitchVersion || "-"} 的拼接队列` };
    } else if (target.dataset.renameVersion) {
      const version = model.stitchVersions.find((output) => output.outputId === target.dataset.renameVersion);
      const nextName = promptAction("输入版本名称", version?.displayFileName || "");
      if (!String(nextName || "").trim()) return;
      await runAction("重命名版本", (signal) => request(
        `/api/wangzhuan/outputs/${encodeURIComponent(target.dataset.renameVersion)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayFileName: String(nextName).trim() }),
          ...(signal ? { signal } : {})
        }
      ), "拼接版本已重命名");
      return;
    } else if (target.dataset.deleteVersion) {
      if (!confirmAction("确定删除这个手动拼接版本吗？源片段和其他版本不会受影响。")) return;
      await runAction("删除版本", (signal) => request(
        `/api/wangzhuan/outputs/${encodeURIComponent(target.dataset.deleteVersion)}`,
        { method: "DELETE", ...(signal ? { signal } : {}) }
      ), "拼接版本已删除");
      return;
    } else {
      return;
    }
    persistAndRender();
  };
  const onDragStart = (event) => {
    draggedIndex = Number(event.target?.closest?.("[data-queue-index]")?.dataset?.queueIndex ?? -1);
    event.dataTransfer?.setData?.("text/plain", String(draggedIndex));
  };
  const onDragOver = (event) => {
    if (event.target?.closest?.("[data-queue-index]")) event.preventDefault?.();
  };
  const onDrop = (event) => {
    const targetIndex = Number(event.target?.closest?.("[data-queue-index]")?.dataset?.queueIndex ?? -1);
    if (draggedIndex < 0 || targetIndex < 0) return;
    event.preventDefault?.();
    queue = moveQueueItem(queue, draggedIndex, targetIndex);
    draggedIndex = -1;
    persistAndRender();
  };
  const listeners = [
    ["change", onChange],
    ["click", onClick],
    ["dragstart", onDragStart],
    ["dragover", onDragOver],
    ["drop", onDrop]
  ];
  for (const [type, listener] of listeners) root?.addEventListener?.(type, listener);

  return {
    update: updateDetail,
    destroy() {
      destroyed = true;
      activeAbort?.abort?.();
      for (const [type, listener] of listeners) root?.removeEventListener?.(type, listener);
      model = buildRecoveryViewModel();
      queue = [];
      expandedTaskIds.clear();
    }
  };
}
