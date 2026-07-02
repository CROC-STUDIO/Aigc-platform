import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { WangzhuanError } from "./http.mjs";
import {
  makeGenerationTaskId,
  makeOutputId,
  makeRemixId
} from "./ids.mjs";
import {
  loadRemixDetailByProviderJobIdFromMysql,
  loadRemixDetailFromMysql,
  syncRemixFacts
} from "./mysql-facts.mjs";
import {
  syncWangzhuanAsset,
  toProjectRelative,
  wangzhuanPaths,
  writeAtomicJson
} from "./storage.mjs";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function providerJobId(job) {
  return String(job?.job_id || job?.jobId || job?.id || "");
}

function providerStatus(job) {
  return String(job?.status || "queued");
}

function terminalStatus(status = "") {
  return ["succeeded", "review_required", "failed", "canceled", "stopped"].includes(status);
}

function remixStatusFromProvider(status = "") {
  if (status === "succeeded" || status === "review_required") return "preview_required";
  if (status === "failed") return "failed";
  if (status === "canceled" || status === "stopped") return "stopped";
  if (status === "running" || status === "processing") return "running";
  return "queued";
}

function remixShortId(remixId) {
  return String(remixId || "").split("_").pop();
}

function makeRemixTaskId(remixId) {
  return makeGenerationTaskId(`wzb_19700101000000_${remixShortId(remixId)}`, 1);
}

function makeRemixOutputId(remixId) {
  return makeOutputId(`wzb_19700101000000_${remixShortId(remixId)}`, 1);
}

function providerJobSnapshot(job, payload = {}) {
  return {
    jobId: providerJobId(job),
    jobType: job?.job_type || job?.jobType || payload.job_type || payload.jobType || "video_ops",
    status: providerStatus(job),
    provider: job?.provider || "video_ops",
    createdAt: job?.created_at || job?.createdAt || null,
    updatedAt: job?.updated_at || job?.updatedAt || null,
    startedAt: job?.started_at || job?.startedAt || null,
    finishedAt: job?.finished_at || job?.finishedAt || null,
    downloadUrl: job?.download_url || job?.downloadUrl || job?.output_url || job?.outputUrl || job?.result_url || job?.resultUrl || ""
  };
}

function sourceFromPayload(payload = {}, remixId = "") {
  const input = payload.input || {};
  const sourceType = input.source_type || input.sourceType || "";
  if (sourceType === "url") {
    const source = String(input.source || "").trim();
    return {
      sourceId: `video_ops_source_${remixShortId(remixId)}`,
      fileName: source.split("/").pop()?.split("?")[0] || "video-ops-source.mp4",
      mimeType: "video/mp4",
      kind: "video",
      status: "pass",
      storedPath: "",
      storageUrl: source,
      previewUrl: source
    };
  }
  if (sourceType === "report_text") {
    return {
      sourceId: `video_ops_report_${remixShortId(remixId)}`,
      fileName: "video-ops-report.txt",
      mimeType: "text/plain",
      kind: "report_text",
      status: "pass",
      storedPath: ""
    };
  }
  return {
    sourceId: `video_ops_source_${remixShortId(remixId)}`,
    fileName: "video-ops-source.mp4",
    mimeType: "video/mp4",
    kind: "video",
    status: "pass",
    storedPath: ""
  };
}

function operationTypeFromPayload(payload = {}) {
  const jobType = String(payload.job_type || payload.jobType || "");
  if (jobType.includes("rewrite") || jobType.includes("translate")) return "text_cta_ending_replace";
  if (jobType.includes("logo") || jobType.includes("sticker")) return "logo_icon_cover_or_replace";
  return "watermark_cover";
}

function videoOpsTemplateSnapshot(payload = {}) {
  return {
    templateId: "video_ops_direct",
    versionId: "video_ops_direct_v1",
    versionNumber: 1,
    status: "active",
    draft: {
      displayName: "Video Ops Direct",
      productName: "",
      cta: "",
      ending: "",
      language: "",
      regions: [],
      targetChannels: ["generic"],
      jobType: payload.job_type || payload.jobType || ""
    }
  };
}

function downloadSummary(remix = {}) {
  const outputs = Array.isArray(remix.outputs) ? remix.outputs : [];
  return {
    outputsTotal: outputs.length,
    downloadEligibleCount: outputs.filter((item) => item.downloadEligible).length,
    packageReady: outputs.some((item) => item.downloadEligible),
    missingFiles: []
  };
}

function withPublicIds(job, remix) {
  if (!remix?.remixId) return job;
  return {
    ...job,
    remixId: remix.remixId,
    remix_id: remix.remixId,
    taskManagementUrl: `/wangzhuan-tasks.html?remixId=${encodeURIComponent(remix.remixId)}`
  };
}

function normalizeJobDetail(job, previousProviderJob = {}, payload = {}) {
  return {
    ...previousProviderJob,
    ...providerJobSnapshot(job, payload),
    rawStatus: providerStatus(job)
  };
}

function taskStatusFromRemixStatus(status = "") {
  if (status === "preview_required") return "qc";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (status === "running") return "running";
  return "queued";
}

function buildTask(remix, providerJob, payload = {}) {
  const taskId = remix.tasks?.[0]?.generationTaskId || makeRemixTaskId(remix.remixId);
  return {
    ...(remix.tasks?.[0] || {}),
    generationTaskId: taskId,
    remixId: remix.remixId,
    kind: "remix_provider",
    status: taskStatusFromRemixStatus(remix.status),
    modelImage: "not_required",
    modelVideo: providerJob.provider || "video_ops",
    provider: providerJob.provider || "video_ops",
    providerJobId: providerJob.jobId,
    seedanceTaskId: providerJob.jobId,
    remoteUrlStored: Boolean(providerJob.downloadUrl),
    attempts: Number(remix.tasks?.[0]?.attempts || 1),
    maxAttempts: Number(remix.tasks?.[0]?.maxAttempts || 2),
    startedAt: remix.tasks?.[0]?.startedAt || providerJob.startedAt || remix.createdAt,
    finishedAt: terminalStatus(providerJob.status) ? (providerJob.finishedAt || new Date().toISOString()) : null,
    requestSummary: {
      ...(remix.tasks?.[0]?.requestSummary || {}),
      jobType: providerJob.jobType,
      input: { source_type: payload.input?.source_type || payload.input?.sourceType || "" },
      params: payload.params || {}
    },
    responseSummary: {
      ...(remix.tasks?.[0]?.responseSummary || {}),
      providerStatus: providerJob.status,
      providerJobId: providerJob.jobId,
      ...(providerJob.downloadUrl ? { downloadUrl: providerJob.downloadUrl } : {})
    }
  };
}

function baseRemixRecord({ context, payload, providerJob, remixId = makeRemixId() }) {
  const now = new Date().toISOString();
  const request = {
    sourceId: sourceFromPayload(payload, remixId).sourceId,
    source: sourceFromPayload(payload, remixId),
    operationType: operationTypeFromPayload(payload),
    targetChannel: "generic",
    regions: [],
    autoDetect: true,
    capabilityKey: "video_ops",
    jobType: payload.job_type || payload.jobType || providerJob.jobType,
    videoOpsPayload: {
      job_type: payload.job_type || payload.jobType || providerJob.jobType,
      input: { source_type: payload.input?.source_type || payload.input?.sourceType || "" },
      params: payload.params || {},
      options: payload.options || {}
    },
    executionPlan: {
      planId: `video_ops_${remixShortId(remixId)}`,
      steps: [
        {
          stepId: "video_ops_provider",
          title: "video-content-ops provider job",
          providerJobId: providerJob.jobId,
          jobType: providerJob.jobType
        }
      ]
    }
  };
  const remix = {
    remixId,
    type: "remix",
    status: remixStatusFromProvider(providerJob.status),
    userId: currentUserId(context),
    sourceId: request.sourceId,
    source: sourceFromPayload(payload, remixId),
    request,
    operationType: request.operationType,
    targetChannel: request.targetChannel,
    regions: [],
    autoDetect: true,
    capabilityKey: request.capabilityKey,
    jobType: request.jobType,
    keyframe: null,
    executionPlan: request.executionPlan,
    templateSnapshot: videoOpsTemplateSnapshot(payload),
    capability: {
      provider: providerJob.provider || "video_ops",
      status: "supported",
      mode: "video_ops_direct"
    },
    providerJob,
    tasks: [],
    outputs: [],
    qcSummary: { total: 0, passed: 0, failed: 0, warnings: [] },
    createdAt: now,
    updatedAt: now,
    startedAt: providerJob.startedAt || now,
    finishedAt: terminalStatus(providerJob.status) ? (providerJob.finishedAt || now) : null
  };
  remix.tasks = [buildTask(remix, providerJob, payload)];
  return remix;
}

function mergeRemixProviderJob(remix, job, payload = {}) {
  const providerJob = normalizeJobDetail(job, remix.providerJob || {}, payload);
  const next = {
    ...remix,
    status: remixStatusFromProvider(providerJob.status),
    providerJob,
    updatedAt: new Date().toISOString(),
    finishedAt: terminalStatus(providerJob.status) ? (providerJob.finishedAt || new Date().toISOString()) : remix.finishedAt
  };
  next.tasks = [buildTask(next, providerJob, payload)];
  if (next.status === "failed") {
    next.qcSummary = {
      total: 0,
      passed: 0,
      failed: 1,
      warnings: [{
        providerJobId: providerJob.jobId,
        qcStatus: "fail",
        summary: "video-ops provider job failed"
      }]
    };
  }
  return next;
}

async function writeJsonAsset(context, remixId, relativeDir, fileName, body, assetKind) {
  const target = join(wangzhuanPaths(context).remixDir, remixId, relativeDir, fileName);
  await writeAtomicJson(target, body);
  const storage = await syncWangzhuanAsset(context, target, assetKind).catch(() => null);
  return {
    storedPath: toProjectRelative(context.userProjectRoot, target),
    storageKey: storage?.storageKey || "",
    storageUrl: storage?.storageUrl || ""
  };
}

async function writeOutputAsset(context, remix, providerJob, outputBuffer) {
  const outputId = remix.outputs?.[0]?.outputId || makeRemixOutputId(remix.remixId);
  const ext = extname(String(providerJob.downloadUrl || "").split("?")[0]) || ".mp4";
  const target = join(wangzhuanPaths(context).remixDir, remix.remixId, "outputs", `${outputId}${ext}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, outputBuffer);
  const storage = await syncWangzhuanAsset(context, target, "remix_output_video").catch(() => null);
  return {
    outputId,
    sourceType: "remix",
    remixId: remix.remixId,
    generationTaskIds: remix.tasks?.[0]?.generationTaskId ? [remix.tasks[0].generationTaskId] : [],
    durationSec: Number(remix.source?.durationSec || 0) || null,
    kind: "remix_video",
    filePath: toProjectRelative(context.userProjectRoot, target),
    previewUrl: storage?.storageUrl || `/file?path=${encodeURIComponent(toProjectRelative(context.userProjectRoot, target))}`,
    storageKey: storage?.storageKey || "",
    storageUrl: storage?.storageUrl || "",
    qcStatus: providerJob.status === "review_required" ? "manual_required" : "pass",
    downloadEligible: providerJob.status !== "review_required",
    visualPreviewRequired: providerJob.status === "review_required",
    previewConfirmed: providerJob.status !== "review_required"
  };
}

async function materializeResult(context, remix, providerJob, outputBuffer, result = null) {
  const resultAsset = result
    ? await writeJsonAsset(context, remix.remixId, "results", `${providerJob.jobId || remix.remixId}.json`, {
      schemaVersion: "video_ops_result.v1",
      remixId: remix.remixId,
      providerJob,
      result,
      archivedAt: new Date().toISOString()
    }, "remix_result")
    : null;
  const withResultArchive = resultAsset
    ? {
        ...remix,
        providerJob: {
          ...providerJob,
          resultPath: resultAsset.storedPath,
          resultStorageKey: resultAsset.storageKey,
          resultStorageUrl: resultAsset.storageUrl
        },
        tasks: (remix.tasks || []).map((task) => ({
          ...task,
          responseSummary: {
            ...(task.responseSummary || {}),
            resultPath: resultAsset.storedPath,
            resultStorageKey: resultAsset.storageKey,
            resultStorageUrl: resultAsset.storageUrl,
            stageTimingsAvailable: Boolean(result?.stage_timings),
            engineTraceAvailable: Boolean(result?.engine_trace)
          }
        }))
      }
    : remix;
  if (!outputBuffer || remix.outputs?.some((output) => output.downloadEligible || output.visualPreviewRequired)) {
    if (resultAsset && providerJob.status === "succeeded" && !remix.outputs?.length) {
      return {
        ...withResultArchive,
        status: "succeeded",
        qcSummary: {
          total: 0,
          passed: 0,
          failed: 0,
          warnings: []
        },
        previewConfirmedBy: "system_video_ops",
        previewConfirmedAt: new Date().toISOString(),
        finishedAt: providerJob.finishedAt || new Date().toISOString()
      };
    }
    return withResultArchive;
  }
  const output = await writeOutputAsset(context, withResultArchive, providerJob, outputBuffer);
  const reportAsset = await writeJsonAsset(context, withResultArchive.remixId, "qc", `${output.outputId}.json`, {
    schemaVersion: "video_ops_qc_report.v1",
    remixId: withResultArchive.remixId,
    outputId: output.outputId,
    providerJob,
    result,
    qcStatus: output.qcStatus,
    summary: providerJob.status === "review_required" ? "video-ops result requires preview confirmation" : "video-ops result archived",
    createdAt: new Date().toISOString()
  }, "remix_qc_report");
  return {
    ...withResultArchive,
    status: providerJob.status === "review_required" ? "preview_required" : "succeeded",
    outputs: [{
      ...output,
      qcReportPath: reportAsset.storedPath,
      qcReportStorageKey: reportAsset.storageKey,
      qcReportStorageUrl: reportAsset.storageUrl,
      qcSummary: providerJob.status === "review_required" ? "Preview confirmation required" : "Archived from video-ops provider"
    }],
    qcSummary: {
      total: 1,
      passed: providerJob.status === "review_required" ? 0 : 1,
      failed: 0,
      warnings: providerJob.status === "review_required" ? [{ outputId: output.outputId, qcStatus: "manual_required" }] : []
    },
    previewConfirmedBy: providerJob.status === "review_required" ? undefined : "system_video_ops",
    previewConfirmedAt: providerJob.status === "review_required" ? undefined : new Date().toISOString(),
    finishedAt: providerJob.finishedAt || new Date().toISOString()
  };
}

async function findArchivedRemix(context, jobId, remixId = "") {
  if (remixId) {
    const detail = await loadRemixDetailFromMysql(context, remixId);
    if (detail?.remix) return detail.remix;
  }
  const detail = await loadRemixDetailByProviderJobIdFromMysql(context, jobId);
  return detail?.remix || null;
}

export async function archiveVideoOpsSubmission(context, payload, job) {
  const providerJob = providerJobSnapshot(job, payload);
  if (!providerJob.jobId) {
    throw new WangzhuanError("upstream_failed", "video-ops 未返回 job_id", {});
  }
  const existing = await findArchivedRemix(context, providerJob.jobId);
  const remix = existing
    ? mergeRemixProviderJob(existing, providerJob, payload)
    : baseRemixRecord({ context, payload, providerJob });
  const synced = await syncRemixFacts(context, remix, "remix_write");
  if (synced.skipped) {
    throw new WangzhuanError("database_unavailable", "MySQL 写入失败，video-ops 任务未归档", { jobId: providerJob.jobId });
  }
  return withPublicIds(job, remix);
}

export async function syncVideoOpsJobArchive(context, job, options = {}) {
  const providerJob = providerJobSnapshot(job, options.payload || {});
  if (!providerJob.jobId) return job;
  const existing = await findArchivedRemix(context, providerJob.jobId, options.remixId || job?.remixId || job?.remix_id);
  if (!existing) return job;
  let remix = mergeRemixProviderJob(existing, providerJob, options.payload || existing.request?.videoOpsPayload || {});
  const shouldMaterialize = Boolean(options.outputBuffer || options.result)
    && (providerJob.status === "succeeded" || providerJob.status === "review_required");
  if (shouldMaterialize && providerJob.status === "succeeded" && existing.status !== "preview_required") {
    let staged = null;
    try {
      staged = await syncRemixFacts(context, remix, "remix_write");
    } catch (error) {
      if (error?.code === "invalid_state_transition") return withPublicIds(job, existing);
      throw error;
    }
    if (staged.skipped) return withPublicIds(job, existing);
    const stagedDetail = await findArchivedRemix(context, providerJob.jobId, remix.remixId);
    if (stagedDetail) remix = stagedDetail;
  }
  if (shouldMaterialize) {
    remix = await materializeResult(context, remix, providerJob, options.outputBuffer, options.result || null);
  }
  let synced = null;
  try {
    synced = await syncRemixFacts(context, remix, options.triggerName || "remix_write");
  } catch (error) {
    if (error?.code === "invalid_state_transition") return withPublicIds(job, existing);
    throw error;
  }
  if (synced.skipped) return withPublicIds(job, existing);
  return withPublicIds(job, remix);
}

export async function resolveVideoOpsArchive(context, jobId) {
  const detail = await loadRemixDetailByProviderJobIdFromMysql(context, jobId);
  return detail?.remix || null;
}

export function videoOpsArchiveSummary(remix) {
  return remix ? { remix, downloadSummary: downloadSummary(remix) } : null;
}
