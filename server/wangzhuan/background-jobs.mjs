import { createHash, randomBytes } from "node:crypto";

const JOBS = new Map();
const MAX_EVENTS = 80;
const FINAL_STATUSES = new Set(["succeeded", "failed"]);
const PLAN_SIGNATURE_FIELDS = Object.freeze([
  "productName",
  "productLink",
  "assets",
  "targetChannel",
  "targetRegion",
  "targetRegions",
  "language",
  "languages",
  "materialDirection",
  "materialDirectionCustom",
  "voiceoverStyle",
  "promiseLevel",
  "currencySymbol",
  "cta",
  "ending",
  "variantPrompt",
  "customPrompt",
  "negativePrompt"
]);

function nowIso() {
  return new Date().toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    result: job.result,
    draftSignature: job.draftSignature,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    events: job.events.slice()
  };
}

function pushEvent(job, event) {
  job.events.push({
    at: nowIso(),
    type: event.type || "log",
    message: String(event.message || "").slice(0, 500),
    ...(event.data ? { data: event.data } : {})
  });
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

function safeError(error) {
  return {
    code: error?.code || "job_failed",
    message: String(error?.message || "任务失败").slice(0, 500),
    data: error?.data && typeof error.data === "object" ? error.data : {}
  };
}

function clampProgress(value, ceiling = 99) {
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  return Math.max(0, Math.min(ceiling, Math.round(next)));
}

export function createBackgroundJob(type, runner, options = {}) {
  const idPrefix = type === "seedance_plan" ? "planjob" : "decompjob";
  const job = {
    id: `${idPrefix}_${Date.now()}_${randomBytes(4).toString("hex")}`,
    type,
    status: "queued",
    progress: 0,
    message: "已加入后台任务队列",
    error: null,
    result: null,
    draftSignature: options.draftSignature || "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    events: []
  };
  JOBS.set(job.id, job);
  pushEvent(job, { type: "queued", message: job.message });

  queueMicrotask(async () => {
    if (FINAL_STATUSES.has(job.status)) return;
    job.status = "running";
    job.progress = Math.max(job.progress, 5);
    job.message = "任务运行中";
    job.updatedAt = nowIso();
    pushEvent(job, { type: "running", message: job.message });

    try {
      const result = await runner({
        log(message, data) {
          const safeMessage = String(message || job.message);
          pushEvent(job, { type: "log", message: safeMessage, data });
          job.message = safeMessage;
          job.updatedAt = nowIso();
        },
        progress(progress, message) {
          const next = clampProgress(progress);
          if (next !== null) job.progress = next;
          if (message) job.message = String(message);
          job.updatedAt = nowIso();
          pushEvent(job, {
            type: "progress",
            message: job.message,
            data: { progress: job.progress }
          });
        }
      });
      job.status = "succeeded";
      job.progress = 100;
      job.message = "任务完成";
      job.result = result || {};
      job.updatedAt = nowIso();
      pushEvent(job, { type: "succeeded", message: job.message });
    } catch (error) {
      job.status = "failed";
      job.progress = 100;
      job.message = "任务失败";
      job.error = safeError(error);
      job.updatedAt = nowIso();
      pushEvent(job, {
        type: "failed",
        message: job.error.message,
        data: { code: job.error.code }
      });
    }
  });

  return publicJob(job);
}

export function getBackgroundJob(jobId) {
  const job = JOBS.get(String(jobId || ""));
  return job ? publicJob(job) : null;
}

export function resetBackgroundJobsForTest() {
  JOBS.clear();
}

export function planDraftSignature(input = {}) {
  const signaturePayload = Object.fromEntries(
    PLAN_SIGNATURE_FIELDS.map((field) => [field, input[field]])
  );
  return `plansig_${hashPayload(signaturePayload)}`;
}

export function isPlanSignatureStale(signature, input = {}) {
  if (!signature) return false;
  return signature !== planDraftSignature(input);
}
