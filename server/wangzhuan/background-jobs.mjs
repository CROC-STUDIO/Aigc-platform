import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { readJsonOrDefault, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";

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
  "outputTemplateMode",
  "sliceStrategy",
  "moneyVisuals",
  "subtitleWorkflow",
  "branches",
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
    subjectType: job.subjectType || "",
    subjectId: job.subjectId || "",
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

function jobFileTarget(context, jobId) {
  if (!context?.userProjectRoot || !context?.sharedProjectRoot) return "";
  return join(wangzhuanPaths(context).jobsDir, `${jobId}.json`);
}

async function persistJob(context, job) {
  const target = jobFileTarget(context, job.id);
  if (!target) return;
  await writeAtomicJson(target, publicJob(job));
}

function queuePersist(context, job) {
  const previous = job.persistPromise || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => persistJob(context, job));
  job.persistPromise = next;
  return next;
}

async function loadPersistedJob(context, jobId) {
  const target = jobFileTarget(context, jobId);
  if (!target) return null;
  const loaded = await readJsonOrDefault(target, null);
  return loaded && typeof loaded === "object" ? loaded : null;
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
    recoverable: Boolean(error?.recoverable),
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
  const context = options.context || null;
  const job = {
    id: `${idPrefix}_${Date.now()}_${randomBytes(4).toString("hex")}`,
    type,
    subjectType: String(options.subjectType || ""),
    subjectId: String(options.subjectId || ""),
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
  void queuePersist(context, job);

  queueMicrotask(async () => {
    if (FINAL_STATUSES.has(job.status)) return;
    job.status = "running";
    job.progress = Math.max(job.progress, 5);
    job.message = "任务运行中";
    job.updatedAt = nowIso();
    pushEvent(job, { type: "running", message: job.message });
    await queuePersist(context, job);

    try {
      const result = await runner({
        log(message, data) {
          const safeMessage = String(message || job.message);
          pushEvent(job, { type: "log", message: safeMessage, data });
          job.message = safeMessage;
          job.updatedAt = nowIso();
          void queuePersist(context, job);
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
          void queuePersist(context, job);
        }
      });
      job.status = "succeeded";
      job.progress = 100;
      job.message = "任务完成";
      job.result = result || {};
      job.updatedAt = nowIso();
      pushEvent(job, { type: "succeeded", message: job.message });
      await queuePersist(context, job);
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
      await queuePersist(context, job);
    }
  });

  return publicJob(job);
}

export async function getBackgroundJob(context, jobId) {
  const job = JOBS.get(String(jobId || ""));
  if (job) {
    if (context && FINAL_STATUSES.has(job.status) && job.persistPromise) {
      await job.persistPromise.catch(() => {});
    }
    return publicJob(job);
  }
  return loadPersistedJob(context, String(jobId || ""));
}

export async function listBackgroundJobs(context, filter = {}) {
  const paths = wangzhuanPaths(context);
  const { readdir } = await import("node:fs/promises");
  let names = [];
  try {
    names = await readdir(paths.jobsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const loaded = await loadPersistedJob(context, name.slice(0, -5));
    if (!loaded) continue;
    if (filter.type && loaded.type !== filter.type) continue;
    if (filter.subjectType && loaded.subjectType !== filter.subjectType) continue;
    if (filter.subjectId && loaded.subjectId !== filter.subjectId) continue;
    entries.push(loaded);
  }
  return entries.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
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
