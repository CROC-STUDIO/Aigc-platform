const ACTIVE_TASK_STATUSES = new Set([
  "pending",
  "queued",
  "submitting",
  "waiting_upstream",
  "running",
  "processing",
  "downloading",
  "downloaded"
]);

const REPAIR_REQUIRED_ERROR_CODES = new Set([
  "asset_review_pending",
  "asset_review_failed",
  "asset_review_required",
  "asset_review_rejected",
  "asset_id_missing",
  "missing_asset_id",
  "missing_seedance_asset_id",
  "seedance_asset_missing"
]);

const RETRYABLE_ERROR_CODES = new Set([
  "upstream_timeout",
  "provider_timeout",
  "rate_limited",
  "temporarily_unavailable"
]);

function taskUid(task = {}) {
  return String(task.generationTaskId || task.taskId || task.id || "");
}

function outputTaskUids(output = {}) {
  const values = Array.isArray(output.generationTaskIds) ? output.generationTaskIds : [];
  return new Set([
    ...values,
    output.generationTaskId,
    output.taskId
  ].filter(Boolean).map(String));
}

function outputBelongsToTask(output = {}, task = {}) {
  const uid = taskUid(task);
  if (uid && outputTaskUids(output).has(uid)) return true;
  return Boolean(task.scriptId && output.scriptId && String(task.scriptId) === String(output.scriptId));
}

function outputTimestamp(output = {}) {
  for (const value of [output.updatedAt, output.createdAt, output.completedAt]) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function isUsableSegmentOutput(output = {}) {
  return Boolean(
    output
    && output.outputId
    && output.kind === "segment_video"
    && output.status !== "deleted"
    && output.deletedAt == null
  );
}

function attemptHistoryFor(attemptsByTask, task) {
  const uid = taskUid(task);
  const mapped = attemptsByTask instanceof Map
    ? attemptsByTask.get(uid)
    : attemptsByTask && typeof attemptsByTask === "object" ? attemptsByTask[uid] : undefined;
  const history = Array.isArray(mapped)
    ? mapped
    : Array.isArray(task.attemptHistory) ? task.attemptHistory : [];
  return [...history].sort((left, right) => Number(left.attemptNo || 0) - Number(right.attemptNo || 0));
}

function latestContinuityParent(task = {}) {
  const history = Array.isArray(task.attemptHistory) ? task.attemptHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.continuityParent) return history[index].continuityParent;
  }
  return task.requestSummary?.continuityParent || null;
}

function currentParentVersion(task = {}) {
  const output = task.currentOutput || null;
  const history = Array.isArray(task.attemptHistory) ? task.attemptHistory : [];
  const latestSucceeded = [...history].reverse().find((attempt) => attempt.status === "succeeded");
  return {
    generationTaskId: taskUid(task),
    continuitySliceId: String(task.continuitySliceId || ""),
    attemptNo: Number(latestSucceeded?.attemptNo || task.attempts || 0),
    outputId: String(output?.outputId || task.currentOutputId || ""),
    outputPath: String(output?.filePath || task.outputPath || "")
  };
}

function continuityParentMatches(recorded = {}, current = {}) {
  if (!recorded || !current) return false;
  if (recorded.generationTaskId && recorded.generationTaskId !== current.generationTaskId) return false;
  if (recorded.continuitySliceId && recorded.continuitySliceId !== current.continuitySliceId) return false;
  if (Number(recorded.attemptNo || 0) && Number(current.attemptNo || 0)
    && Number(recorded.attemptNo) !== Number(current.attemptNo)) return false;
  if (recorded.outputId && current.outputId && recorded.outputId !== current.outputId) return false;
  if (recorded.outputPath && current.outputPath && recorded.outputPath !== current.outputPath) return false;
  return true;
}

function applyContinuityRecoveryState(tasks = []) {
  const bySliceId = new Map(tasks
    .filter((task) => task.continuitySliceId)
    .map((task) => [`${recoveryGroupKey(task)}:${task.continuitySliceId}`, task]));
  return tasks.map((task) => {
    const previousSliceId = String(task.previousSliceId || "");
    if (!previousSliceId) return task;
    const parent = bySliceId.get(`${recoveryGroupKey(task)}:${previousSliceId}`);
    const parentVersion = parent ? currentParentVersion(parent) : null;
    const recordedParent = latestContinuityParent(task);
    const parentReady = Boolean(parent?.currentOutput && ["ready", "replacement_ready"].includes(parent.availability));
    const continuityState = {
      status: parentReady ? "ready" : "waiting_predecessor",
      parentTaskId: parentVersion?.generationTaskId || "",
      parentContinuitySliceId: previousSliceId,
      parentAttemptNo: Number(parentVersion?.attemptNo || 0),
      parentOutputId: parentVersion?.outputId || "",
      recordedParentAttemptNo: Number(recordedParent?.attemptNo || 0),
      recordedParentOutputId: recordedParent?.outputId || ""
    };
    if (!parentReady) {
      return {
        ...task,
        continuityState,
        retryEligibility: { status: "waiting_predecessor", canRetry: false, reason: "previous_slice_unavailable" },
        availability: "waiting_predecessor"
      };
    }
    if (task.currentOutput && (!recordedParent || !continuityParentMatches(recordedParent, parentVersion))) {
      return {
        ...task,
        continuityState: { ...continuityState, status: "continuity_stale" },
        retryEligibility: { status: "continuity_stale", canRetry: true, reason: "continuity_version_stale" },
        availability: "continuity_stale"
      };
    }
    return { ...task, continuityState };
  });
}

function branchOrder(value = {}) {
  const explicit = Number(value.branchIndex);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(value.branchId || "").match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function recoveryGroupKey(value = {}) {
  return `${String(value.branchId || "default")}:${Number(value.branchVariantIndex || value.variantIndex || 1)}`;
}

export function classifyRetryEligibility(task = {}, output = null) {
  if (isUsableSegmentOutput(output)) {
    const isReplacement = output.fulfillmentSource === "user_replacement";
    return {
      status: isReplacement ? "replacement_ready" : "ready",
      canRetry: false,
      reason: output.outputId
    };
  }

  const status = String(task.status || "").toLowerCase();
  const errorCode = String(task.errorCode || "").toLowerCase();
  if (ACTIVE_TASK_STATUSES.has(status)) {
    return { status: "running", canRetry: false, reason: status || "running" };
  }
  if (REPAIR_REQUIRED_ERROR_CODES.has(errorCode)) {
    return { status: "repair_required", canRetry: false, reason: errorCode };
  }

  const attempts = Math.max(0, Number(task.attempts || 0));
  const maxAttempts = Math.max(1, Number(task.maxAttempts || 2));
  if (status === "failed" && attempts >= maxAttempts) {
    return { status: "retry_exhausted", canRetry: false, reason: "attempt_limit" };
  }

  const explicitlyRetryable = task.retryable === true
    || task.responseSummary?.retryable === true
    || RETRYABLE_ERROR_CODES.has(errorCode);
  if (status === "failed" && explicitlyRetryable) {
    return { status: "retryable", canRetry: true, reason: errorCode || "retryable_failure" };
  }
  return {
    status: "unavailable",
    canRetry: false,
    reason: errorCode || status || "no_output"
  };
}

export function currentSegmentOutput(batch = {}, task = {}) {
  const outputs = (Array.isArray(batch.outputs) ? batch.outputs : [])
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => isUsableSegmentOutput(output) && outputBelongsToTask(output, task));
  if (!outputs.length) return null;

  const explicitOutputId = task.currentOutputId || task.outputId || task.responseSummary?.outputId;
  if (explicitOutputId) {
    const explicit = outputs.find(({ output }) => output.outputId === explicitOutputId);
    if (explicit) return explicit.output;
  }

  outputs.sort((left, right) => {
    const timestampDifference = outputTimestamp(left.output) - outputTimestamp(right.output);
    return timestampDifference || left.index - right.index;
  });
  return outputs.at(-1).output;
}

export function enrichSegmentRecovery(batch = {}, attemptsByTask = new Map()) {
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    const currentOutput = currentSegmentOutput(batch, task);
    const retryEligibility = classifyRetryEligibility(task, currentOutput);
    return {
      ...task,
      attemptHistory: attemptHistoryFor(attemptsByTask, task),
      currentOutput,
      currentOutputId: currentOutput?.outputId || "",
      retryEligibility,
      availability: retryEligibility.status,
      recoveryGroupKey: recoveryGroupKey(task)
    };
  });
  return { ...batch, tasks: applyContinuityRecoveryState(tasks) };
}

export function groupRecoveryTasks(batch = {}) {
  const groups = new Map();
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const key = recoveryGroupKey(task);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        branchId: task.branchId || "default",
        branchLabel: task.branchLabel || task.branchId || "默认分支",
        branchIndex: task.branchIndex,
        branchVariantIndex: Number(task.branchVariantIndex || task.variantIndex || 1),
        tasks: []
      });
    }
    groups.get(key).tasks.push(task);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((left, right) => {
        const segmentDifference = Number(left.segmentIndex || 1) - Number(right.segmentIndex || 1);
        return segmentDifference || taskUid(left).localeCompare(taskUid(right));
      })
    }))
    .sort((left, right) => {
      const branchDifference = branchOrder(left) - branchOrder(right);
      if (branchDifference) return branchDifference;
      const branchIdDifference = String(left.branchId).localeCompare(String(right.branchId));
      if (branchIdDifference) return branchIdDifference;
      return left.branchVariantIndex - right.branchVariantIndex;
    });
}

export function classifyStitchSelection(batch = {}, outputIds = []) {
  const recoveryBatch = enrichSegmentRecovery(batch);
  const tasks = recoveryBatch.tasks;
  const outputsById = new Map(
    (Array.isArray(recoveryBatch.outputs) ? recoveryBatch.outputs : [])
      .filter(isUsableSegmentOutput)
      .map((output) => [output.outputId, output])
  );
  const currentOutputIds = new Set(tasks.map((task) => currentSegmentOutput(batch, task)?.outputId).filter(Boolean));
  const seen = new Set();
  const selected = [];
  for (const outputId of Array.isArray(outputIds) ? outputIds : []) {
    if (seen.has(outputId) || !currentOutputIds.has(outputId)) continue;
    const output = outputsById.get(outputId);
    if (!output) continue;
    seen.add(outputId);
    selected.push(output);
  }

  const selectedTasks = selected.map((output) => tasks.find((task) => outputBelongsToTask(output, task)) || null);
  const sourceGroups = [];
  for (const task of selectedTasks) {
    if (!task) continue;
    const key = recoveryGroupKey(task);
    if (!sourceGroups.includes(key)) sourceGroups.push(key);
  }

  let kind = "partial";
  if (sourceGroups.length > 1) {
    kind = "mixed";
  } else if (sourceGroups.length === 1) {
    const groupTasks = tasks.filter((task) => recoveryGroupKey(task) === sourceGroups[0]);
    const selectedTaskIds = new Set(selectedTasks.filter(Boolean).map(taskUid));
    if (groupTasks.length > 0 && selectedTaskIds.size === groupTasks.length) kind = "complete";
  }
  const selectedIndexes = new Map(selectedTasks
    .map((task, index) => [task?.continuitySliceId, index])
    .filter(([sliceId]) => sliceId));
  const continuityErrors = [];
  for (const [index, task] of selectedTasks.entries()) {
    if (!task?.previousSliceId) continue;
    if (task.continuityState?.status === "continuity_stale") {
      continuityErrors.push({
        code: "continuity_parent_stale",
        generationTaskId: taskUid(task),
        previousSliceId: task.previousSliceId
      });
      continue;
    }
    const parentIndex = selectedIndexes.get(task.previousSliceId);
    if (parentIndex !== undefined && parentIndex >= index) {
      continuityErrors.push({
        code: "continuity_order_invalid",
        generationTaskId: taskUid(task),
        previousSliceId: task.previousSliceId
      });
    }
  }
  return {
    kind,
    sourceGroups,
    outputs: selected,
    continuityCompatible: continuityErrors.length === 0,
    continuityErrors
  };
}
