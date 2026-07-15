import { redactPayload } from "./payloads.js";

const TERMINAL_STATUSES = new Set(["succeeded", "review_required", "failed", "canceled", "stopped"]);

function providerJobId(job = {}) {
  return String(job.jobId || job.job_id || job.id || job.providerJob?.job_id || job.providerJob?.jobId || "");
}

function providerStatus(job = {}, fallback = "queued") {
  return String(job.status || job.providerJob?.status || fallback);
}

function defaultRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function runById(store, runId) {
  return store.getState().runs.find((item) => item.runId === runId) || null;
}

export function createJobRunner({
  store,
  request,
  pollMs = 3000,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
  isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden",
  createRunId = defaultRunId,
  now = () => new Date().toISOString()
} = {}) {
  if (!store || typeof request !== "function") throw new Error("job runner 需要 store 和 request");
  const timers = new Map();

  function stop(runId) {
    const timer = timers.get(runId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(runId);
  }

  function schedule(runId, delay = pollMs) {
    stop(runId);
    if (!runById(store, runId) || TERMINAL_STATUSES.has(runById(store, runId).status)) return;
    const timer = setTimer(() => {
      timers.delete(runId);
      if (!isVisible()) {
        schedule(runId, pollMs);
        return;
      }
      refresh(runId).catch(() => {});
    }, delay);
    timers.set(runId, timer);
  }

  async function submit({ capabilityId, modeId, capabilityLabel = "", modeLabel = "", payload } = {}) {
    if (!payload?.job_type) throw new Error("任务请求尚未准备完成");
    const response = await request("/api/wangzhuan/video-ops/jobs", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const jobId = providerJobId(response);
    if (!jobId) throw new Error("任务提交成功但未返回 job_id");
    const runId = createRunId();
    const run = {
      runId,
      providerJobId: jobId,
      remixId: response.remixId || response.remix_id || "",
      taskManagementUrl: response.taskManagementUrl || "",
      capabilityId,
      modeId,
      capabilityLabel,
      modeLabel,
      jobType: response.jobType || response.job_type || payload.job_type,
      status: providerStatus(response),
      providerJob: response.providerJob || response,
      requestSnapshot: redactPayload(payload),
      createdAt: now(),
      updatedAt: now(),
      errorCount: 0,
      connectionError: "",
      result: null
    };
    store.upsertRun(run);
    store.setActiveRun(runId);
    if (!TERMINAL_STATUSES.has(run.status)) schedule(runId);
    return runById(store, runId);
  }

  async function loadResult(runId) {
    const run = runById(store, runId);
    if (!run?.providerJobId) return null;
    try {
      const result = await request(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(run.providerJobId)}/result?include_model_calls=true`);
      store.patchRun(runId, { result, resultError: "", updatedAt: now() });
      return result;
    } catch (error) {
      store.patchRun(runId, { resultError: error?.message || "结果读取失败", updatedAt: now() });
      throw error;
    }
  }

  async function refresh(runId) {
    const run = runById(store, runId);
    if (!run?.providerJobId) return null;
    try {
      const job = await request(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(run.providerJobId)}?include_model_calls=true`);
      const status = providerStatus(job, run.status);
      store.patchRun(runId, {
        status,
        providerJob: job,
        remixId: job.remixId || job.remix_id || run.remixId || "",
        taskManagementUrl: job.taskManagementUrl || run.taskManagementUrl || "",
        connectionError: "",
        errorCount: 0,
        updatedAt: now()
      });
      if (TERMINAL_STATUSES.has(status)) {
        stop(runId);
        if (status === "succeeded" || status === "review_required") {
          try {
            await loadResult(runId);
          } catch {
            // Result errors are stored separately from the provider job status.
          }
        }
      } else {
        schedule(runId);
      }
      return runById(store, runId);
    } catch (error) {
      const current = runById(store, runId) || run;
      const errorCount = Number(current.errorCount || 0) + 1;
      store.patchRun(runId, {
        connectionError: error?.message || "任务状态连接失败",
        errorCount,
        updatedAt: now()
      });
      schedule(runId, Math.min(30000, pollMs * (2 ** Math.min(errorCount, 3))));
      return runById(store, runId);
    }
  }

  async function cancel(runId) {
    const run = runById(store, runId);
    if (!run?.providerJobId) return null;
    const job = await request(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(run.providerJobId)}/cancel`, {
      method: "POST",
      body: "{}"
    });
    stop(runId);
    store.patchRun(runId, {
      status: providerStatus(job, "canceled"),
      providerJob: job,
      connectionError: "",
      updatedAt: now()
    });
    return runById(store, runId);
  }

  async function retry(runId) {
    const run = runById(store, runId);
    if (!run?.providerJobId) return null;
    const job = await request(`/api/wangzhuan/video-ops/jobs/${encodeURIComponent(run.providerJobId)}/retry`, {
      method: "POST",
      body: "{}"
    });
    store.patchRun(runId, {
      status: providerStatus(job, "queued"),
      providerJob: job,
      result: null,
      resultError: "",
      connectionError: "",
      errorCount: 0,
      updatedAt: now()
    });
    schedule(runId);
    return runById(store, runId);
  }

  function resume() {
    for (const run of store.getState().runs) {
      if (run.providerJobId && !TERMINAL_STATUSES.has(run.status)) schedule(run.runId, 0);
    }
  }

  function destroy() {
    for (const runId of [...timers.keys()]) stop(runId);
  }

  return { submit, refresh, loadResult, cancel, retry, resume, destroy };
}
