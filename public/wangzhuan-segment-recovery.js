const READY_STATES = new Set(["ready", "replacement_ready"]);

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

function renderModel(model, queue) {
  const selected = new Set(queue);
  const groups = model.groups.map((group) => {
    const readyCount = group.tasks.filter((task) => READY_STATES.has(task.availability)).length;
    const failedCount = group.tasks.filter((task) => !READY_STATES.has(task.availability) && task.availability !== "running").length;
    const rows = group.tasks.map((task) => {
      const output = task.currentOutput;
      const checked = output?.outputId && selected.has(output.outputId);
      const selectable = output?.outputId && model.outputsById.has(output.outputId);
      return `<div class="wz-recovery-segment" data-task-id="${escapeHtml(taskId(task))}">
        <input type="checkbox" data-select-output="${escapeHtml(output?.outputId || "")}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="选择片段 ${escapeHtml(task.segmentIndex || 1)}">
        <span class="wz-recovery-thumb">${output?.previewUrl ? `<img src="${escapeHtml(output.previewUrl)}" alt="" loading="lazy">` : "<span>--</span>"}</span>
        <span class="wz-recovery-segment-name">片段 ${escapeHtml(task.segmentIndex || 1)}</span>
        <span class="wz-recovery-status" data-status="${escapeHtml(task.availability)}">${escapeHtml(statusText(task.availability))}</span>
        <span class="wz-recovery-attempt">最新 · 尝试 ${escapeHtml(task.attemptHistory?.length || task.attempts || 0)}</span>
      </div>`;
    }).join("");
    return `<section class="wz-recovery-group" data-group-key="${escapeHtml(group.key)}">
      <header><strong>${escapeHtml(group.branchLabel)} · 变体 ${escapeHtml(group.branchVariantIndex)}</strong><span>可用 ${readyCount} / 失败 ${failedCount}</span></header>
      <div>${rows}</div>
    </section>`;
  }).join("");
  const queueItems = queue.map((outputId, index) => {
    const output = model.outputsById.get(outputId);
    const group = model.groupByOutputId.get(outputId) || "";
    return `<li draggable="true" data-queue-output="${escapeHtml(outputId)}" data-queue-index="${index}">
      <span class="wz-recovery-order">${index + 1}</span>
      <span>${escapeHtml(group)} · ${escapeHtml(output?.displayFileName || outputId)}</span>
      <span class="wz-recovery-queue-actions">
        <button type="button" data-move-queue="up" data-index="${index}" aria-label="上移">↑</button>
        <button type="button" data-move-queue="down" data-index="${index}" aria-label="下移">↓</button>
        <button type="button" data-remove-queue="${escapeHtml(outputId)}" aria-label="移除">×</button>
      </span>
    </li>`;
  }).join("");
  const versions = model.stitchVersions.map((output) => `<li data-stitch-version="${escapeHtml(output.outputId)}">
    <strong>V${escapeHtml(output.stitchVersion || 1)}</strong>
    <span>${escapeHtml(output.displayFileName || output.outputId)}</span>
    <span>${escapeHtml(output.stitchKind || "partial")}</span>
  </li>`).join("");
  return `<div class="wz-recovery-summary">
    <span>片段 ${model.summary.total}</span><span>可用 ${model.summary.ready}</span><span>失败 ${model.summary.failed}</span><span>处理中 ${model.summary.running}</span>
  </div>
  <section class="wz-recovery-zone" data-recovery-zone="segments"><h3>片段状态</h3>${groups || "<p>等待片段任务</p>"}</section>
  <section class="wz-recovery-zone" data-recovery-zone="queue"><header><h3>拼接队列</h3><button type="button" data-clear-queue ${queue.length ? "" : "disabled"}>清空</button></header><ol>${queueItems || "<li class=\"wz-recovery-empty\">尚未选择片段</li>"}</ol></section>
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

  const persistAndRender = () => {
    if (storageKey) writeStoredQueue(storage, storageKey, queue);
    if (body) body.innerHTML = renderModel(model, queue);
  };

  const onChange = (event) => {
    const input = event.target?.closest?.("[data-select-output]") || event.target;
    const outputId = input?.dataset?.selectOutput;
    if (!outputId) return;
    if (input.checked) queue = reconcileQueue([...queue, outputId], model.outputsById);
    else queue = queue.filter((id) => id !== outputId);
    persistAndRender();
  };
  const onClick = (event) => {
    const target = event.target?.closest?.("button") || event.target;
    if (target?.dataset?.clearQueue !== undefined) queue = [];
    else if (target?.dataset?.removeQueue) queue = queue.filter((id) => id !== target.dataset.removeQueue);
    else if (target?.dataset?.moveQueue) {
      const from = Number(target.dataset.index);
      queue = moveQueueItem(queue, from, target.dataset.moveQueue === "up" ? from - 1 : from + 1);
    } else return;
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
    update(detail) {
      const batch = detail?.batch;
      if (!batch?.batchId) {
        model = buildRecoveryViewModel();
        queue = [];
        storageKey = "";
        if (root) root.hidden = true;
        if (body) body.innerHTML = "";
        return;
      }
      model = buildRecoveryViewModel(batch);
      const scope = { ...(options.getScope?.() || {}), batchId: batch.batchId };
      storageKey = queueStorageKey(scope);
      queue = reconcileQueue(queue.length ? queue : readStoredQueue(storage, storageKey), model.outputsById);
      if (root) root.hidden = false;
      persistAndRender();
    },
    destroy() {
      for (const [type, listener] of listeners) root?.removeEventListener?.(type, listener);
      model = buildRecoveryViewModel();
      queue = [];
    }
  };
}
