import { getChannelRules } from "./channel-rules.mjs";
import { estimateBatch, prepareBatchPlanFromEstimate, prepareBatchPlanFromEstimateStream, startBatchFromEstimate } from "./estimates.mjs";
import { getGallery } from "./gallery.mjs";
import { listTasks } from "./tasks.mjs";
import { WangzhuanError, requirePermission, sendErrorEnvelope, sendOk } from "./http.mjs";
import { makeRequestId } from "./ids.mjs";
import { saveBatchDraft } from "./batch-drafts.mjs";
import { publicLlmConfig, publicQcLlmConfig } from "./llm-config.mjs";
import { buildDownloadPackage } from "./package.mjs";
import { confirmBatchAssets, confirmBatchPlan, getBatchDetail, getActiveBatch, stopBatch, submitPendingGenerationTasks } from "./pipeline.mjs";
import { uploadDisclaimerOverlayAsset, uploadProductAsset } from "./product-assets.mjs";
import { runBatchQc } from "./qc.mjs";
import { detectRemixRegions } from "./remix-detection.mjs";
import { buildRemixPlan } from "./remix-plan.mjs";
import { initWangzhuanSse } from "./sse.mjs";
import {
  checkReferenceVideo,
  decomposeReferenceVideo,
  draftReferenceVideoDecomposition,
  draftReferenceVideoDecompositionStream,
  getReferenceVideoWorkflowState
} from "./reference-videos.mjs";
import {
  confirmRemixPreview,
  estimateRemix,
  getActiveRemix,
  getRemixDetail,
  getRemixQcReport,
  startDirectMaskEdit,
  startRemix,
  stopRemix,
  uploadRemixSource
} from "./remix.mjs";
import { retryStitch } from "./stitch.mjs";
import { inspectStorePage } from "./store-page.mjs";
import { pollUpstreamBatch } from "./upstream-poll.mjs";
import { adminTemplateAction, listTemplates, saveTemplate } from "./templates.mjs";
import {
  cancelVideoOpsJob,
  createVideoOpsJob,
  downloadVideoOpsJob,
  getVideoOpsJob,
  getVideoOpsJobResult,
  retryVideoOpsJob
} from "./video-ops.mjs";
import {
  archiveVideoOpsSubmission,
  syncVideoOpsJobArchive
} from "./video-ops-archive.mjs";
import { createBackgroundJob, getBackgroundJob, isPlanSignatureStale, listBackgroundJobs, planDraftSignature } from "./background-jobs.mjs";
import {
  ensureExpandableOutput,
  expansionJobMeta,
  normalizeExpansionRequest,
  runOutputExpansion
} from "./output-expansion.mjs";
import { loadOutputDetailFromMysql } from "./mysql-facts.mjs";

function buildContext(context) {
  return {
    ...context,
    user: context.user ?? context.currentUser?.(),
    userId: context.userId ?? context.currentUserId?.(),
    userProjectRoot: context.userProjectRoot ?? context.currentProjectRoot?.(),
    sharedProjectRoot: context.sharedProjectRoot ?? context.currentBaseProjectRoot?.()
  };
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

async function readReferenceVideoCheckRequest(context, req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) return context.readJson(req);
  const form = await context.readMultipart(req);
  const file = form.files?.file || form.files?.referenceVideo || Object.values(form.files || {})[0];
  if (!file?.buffer?.length) {
    throw new WangzhuanError("validation_error", "上传素材读取失败，请重新选择素材", { field: "file" });
  }
  const mimeType = String(file.mimeType || form.fields?.mimeType || "").trim();
  return {
    ...form.fields,
    fileName: form.fields?.fileName || file.fileName,
    name: form.fields?.name || file.fileName,
    mimeType,
    content: `data:${mimeType || "application/octet-stream"};base64,${file.buffer.toString("base64")}`
  };
}

function batchRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})(?:\/(stop|retry-stitch|qc|confirm-plan|confirm-assets))?$/);
  if (!match) return null;
  return { batchId: match[1], action: match[2] || "detail" };
}

function remixRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/remix\/(rmx_\d{14}_[a-f0-9]{4})(?:\/(preview-confirm|stop|qc-report))?$/);
  if (!match) return null;
  return { remixId: match[1], action: match[2] || "detail" };
}

function videoOpsRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/video-ops\/jobs(?:\/([^/]+)(?:\/(result|download|cancel|retry))?)?$/);
  if (!match) return null;
  return { jobId: match[1] ? decodeURIComponent(match[1]) : "", action: match[2] || (match[1] ? "detail" : "collection") };
}

function referenceVideoRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/reference-videos\/(ref_\d{8}_\d{3})\/workflow-state$/);
  if (!match) return null;
  return { referenceVideoId: match[1] };
}

function decompositionJobRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/reference-videos\/decomposition-jobs\/([^/]+)$/);
  if (!match) return null;
  return { jobId: decodeURIComponent(match[1]) };
}

function planJobRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/plan-jobs\/([^/]+)$/);
  if (!match) return null;
  return { jobId: decodeURIComponent(match[1]) };
}

function outputExpansionSubmitRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/outputs\/([^/]+)\/expand$/);
  if (!match) return null;
  return { outputId: decodeURIComponent(match[1]) };
}

function outputExpansionJobsRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/outputs\/([^/]+)\/expand-jobs$/);
  if (!match) return null;
  return { outputId: decodeURIComponent(match[1]) };
}

function sendZip(res, zip, requestId) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/\D/g, "");
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="wangzhuan-package-${stamp}.zip"`,
    "X-Request-Id": requestId
  });
  res.end(zip);
}

function sendBinary(res, buffer, requestId, fileName = "video-ops-output.bin") {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "X-Request-Id": requestId
  });
  res.end(buffer);
}

export async function handleWangzhuanRequest(req, res, url, context) {
  const requestId = makeRequestId();
  const scoped = { ...buildContext(context), requestId };
  try {
    requirePermission(scoped.user, "wangzhuan:view");
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/templates") {
      return sendOk(res, await listTemplates(scoped, queryObject(url)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/templates") {
      return sendOk(res, await saveTemplate(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/templates/admin") {
      return sendOk(res, await adminTemplateAction(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/channel-rules") {
      return sendOk(res, await getChannelRules(scoped, queryObject(url)), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/llm-config") {
      return sendOk(res, {
        ...publicLlmConfig(scoped.config),
        ...publicQcLlmConfig(scoped.config)
      }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/check") {
      const runCheck = scoped.checkReferenceVideo || context.checkReferenceVideo || checkReferenceVideo;
      return sendOk(res, await runCheck(scoped, await readReferenceVideoCheckRequest(context, req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/draft-decomposition/stream") {
      const body = await context.readJson(req);
      initWangzhuanSse(res, requestId);
      await draftReferenceVideoDecompositionStream(scoped, body, res, { requestId });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/draft-decomposition") {
      return sendOk(res, await draftReferenceVideoDecomposition(scoped, await context.readJson(req), { requestId }), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/decomposition-jobs") {
      const body = await context.readJson(req);
      const job = createBackgroundJob("decomposition", async ({ log, progress }) => {
        log("AI 拆解视频已开始");
        progress(30, "正在调用拆解模型");
        const runDraft = scoped.draftReferenceVideoDecomposition || context.draftReferenceVideoDecomposition || draftReferenceVideoDecomposition;
        const result = await runDraft(scoped, body, {
          requestId,
          streamHandlers: {
            onRetry: ({ attempt, maxRetries, reason, upstreamMessage, code, status }) => log(
              `拆解模型重试 ${attempt}/${maxRetries}`,
              {
                ...(reason ? { reason } : {}),
                ...(upstreamMessage ? { upstreamMessage } : {}),
                ...(code ? { code } : {}),
                ...(status ? { status } : {})
              }
            ),
            onFallback: ({ from, to, reason }) => log(
              "拆解模型输入回退",
              { from, to, reason }
            )
          }
        });
        progress(95, "正在整理拆解字段");
        return result;
      }, {
        context: scoped,
        subjectType: "reference_video",
        subjectId: String(body.referenceVideoId || "")
      });
      return sendOk(res, { ...job, decompositionJobId: job.id }, requestId);
    }
    const decompositionJob = decompositionJobRoute(url.pathname);
    if (decompositionJob && req.method === "GET") {
      const job = await getBackgroundJob(scoped, decompositionJob.jobId);
      if (!job) throw new WangzhuanError("job_not_found", "拆解任务不存在或已过期", { jobId: decompositionJob.jobId }, 404);
      return sendOk(res, {
        ...job,
        decompositionJobId: job.id,
        decomposition: job.result?.decomposition || job.result?.draft?.decomposition || job.result?.draft || null
      }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/decompose") {
      return sendOk(res, await decomposeReferenceVideo(scoped, await context.readJson(req)), requestId);
    }
    const referenceVideo = referenceVideoRoute(url.pathname);
    if (referenceVideo && req.method === "GET" && referenceVideo.referenceVideoId) {
      return sendOk(res, await getReferenceVideoWorkflowState(scoped, referenceVideo.referenceVideoId), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/product-assets/upload") {
      return sendOk(res, await uploadProductAsset(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/disclaimer-overlays/upload") {
      return sendOk(res, await uploadDisclaimerOverlayAsset(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/draft") {
      return sendOk(res, await saveBatchDraft(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/store-page/inspect") {
      return sendOk(res, await inspectStorePage(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/estimate") {
      return sendOk(res, await estimateBatch(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/plan/stream") {
      const body = await context.readJson(req);
      initWangzhuanSse(res, requestId);
      await prepareBatchPlanFromEstimateStream(scoped, body, res, { requestId });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/plan") {
      return sendOk(res, await prepareBatchPlanFromEstimate(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/plan-jobs") {
      const body = await context.readJson(req);
      const draftSignature = planDraftSignature(body.draftSignatureInput || body);
      const job = createBackgroundJob("seedance_plan", async ({ log, progress }) => {
        log("Seedance 预案生成已开始");
        progress(25, "正在生成脚本与 Seedance prompt");
        const runPlan = scoped.prepareBatchPlanFromEstimate || context.prepareBatchPlanFromEstimate || prepareBatchPlanFromEstimate;
        const result = await runPlan(scoped, body);
        progress(95, "正在写入预案草稿");
        return result;
      }, {
        draftSignature,
        context: scoped,
        subjectType: "batch",
        subjectId: String(body.batchId || "")
      });
      return sendOk(res, { ...job, planJobId: job.id, draftSignature }, requestId);
    }
    const planJob = planJobRoute(url.pathname);
    if (planJob && req.method === "GET") {
      const job = await getBackgroundJob(scoped, planJob.jobId);
      if (!job) throw new WangzhuanError("job_not_found", "Seedance 预案任务不存在或已过期", { jobId: planJob.jobId }, 404);
      const batch = job.result?.batch || null;
      return sendOk(res, {
        ...job,
        planJobId: job.id,
        batch,
        plans: batch?.plans || job.result?.plans || []
      }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/start") {
      const started = await startBatchFromEstimate(scoped, await context.readJson(req));
      return sendOk(res, started, requestId);
    }
    const expandRoute = outputExpansionSubmitRoute(url.pathname);
    if (expandRoute && req.method === "POST") {
      const body = await context.readJson(req);
      const request = normalizeExpansionRequest(body);
      const loadOutputDetail = scoped.loadOutputDetailFromMysql || context.loadOutputDetailFromMysql || loadOutputDetailFromMysql;
      const output = ensureExpandableOutput(await loadOutputDetail(scoped, expandRoute.outputId));
      const meta = expansionJobMeta(output, request);
      const job = createBackgroundJob("output_expansion", async ({ log, progress }) => {
        log("视频尺寸扩展已开始");
        progress(20, "正在准备输出尺寸");
        const expandOutput = scoped.runOutputExpansion || context.runOutputExpansion || runOutputExpansion;
        const result = await expandOutput(scoped, output, request, {
          jobId: "",
          requestId
        });
        progress(95, "正在归档扩展结果");
        return { ...result, ...meta };
      }, {
        context: scoped,
        subjectType: "workflow_output",
        subjectId: String(output.outputId || "")
      });
      return sendOk(res, {
        ...job,
        jobId: job.id,
        outputId: output.outputId,
        targetWidth: request.targetWidth,
        targetHeight: request.targetHeight,
        sizeKey: meta.sizeKey,
        mode: request.mode
      }, requestId);
    }
    const expandJobsRoute = outputExpansionJobsRoute(url.pathname);
    if (expandJobsRoute && req.method === "GET") {
      const jobs = await listBackgroundJobs(scoped, {
        type: "output_expansion",
        subjectType: "workflow_output",
        subjectId: expandJobsRoute.outputId
      });
      const latestBySize = new Map();
      for (const job of jobs) {
        const targetWidth = Number(job.result?.targetWidth || job.error?.data?.targetWidth || 0);
        const targetHeight = Number(job.result?.targetHeight || job.error?.data?.targetHeight || 0);
        const sizeKey = String(job.result?.sizeKey || job.error?.data?.sizeKey || (targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : "")).trim();
        const dedupeKey = sizeKey || job.id;
        if (!latestBySize.has(dedupeKey)) latestBySize.set(dedupeKey, job);
      }
      return sendOk(res, {
        items: Array.from(latestBySize.values()).map((job) => ({
          jobId: job.id,
          outputId: expandJobsRoute.outputId,
          status: job.status,
          targetWidth: Number(job.result?.targetWidth || job.error?.data?.targetWidth || 0),
          targetHeight: Number(job.result?.targetHeight || job.error?.data?.targetHeight || 0),
          sizeKey: String(job.result?.sizeKey || job.error?.data?.sizeKey || "").trim(),
          fileName: job.result?.fileName || "",
          storedPath: job.result?.storedPath || "",
          videoUrl: job.result?.previewUrl || "",
          downloadUrl: job.result?.downloadUrl || "",
          errorMessage: job.error?.message || "",
          requestId: job.result?.requestId || "",
          updatedAt: job.result?.updatedAt || job.updatedAt || ""
        }))
      }, requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/batches/active") {
      return sendOk(res, await getActiveBatch(scoped), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/upload") {
      return sendOk(res, await uploadRemixSource(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/detect") {
      return sendOk(res, await detectRemixRegions(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/estimate") {
      return sendOk(res, await estimateRemix(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/plan") {
      return sendOk(res, buildRemixPlan(await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/start") {
      return sendOk(res, await startRemix(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/mask-edit") {
      return sendOk(res, await startDirectMaskEdit(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/remix/active") {
      return sendOk(res, await getActiveRemix(scoped), requestId);
    }
    const videoOps = videoOpsRoute(url.pathname);
    if (videoOps && req.method === "POST" && videoOps.action === "collection") {
      const payload = await context.readJson(req);
      const job = await createVideoOpsJob(scoped, payload);
      return sendOk(res, await archiveVideoOpsSubmission(scoped, payload, job), requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "detail") {
      const job = await getVideoOpsJob(scoped, videoOps.jobId, queryObject(url));
      return sendOk(res, await syncVideoOpsJobArchive(scoped, job), requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "result") {
      const result = await getVideoOpsJobResult(scoped, videoOps.jobId, queryObject(url));
      const job = await getVideoOpsJob(scoped, videoOps.jobId, queryObject(url));
      let outputBuffer = null;
      if (job?.status === "succeeded" || job?.status === "review_required") {
        try {
          outputBuffer = await downloadVideoOpsJob(scoped, videoOps.jobId);
        } catch {
          outputBuffer = null;
        }
      }
      const archived = await syncVideoOpsJobArchive(scoped, job, { result, outputBuffer });
      return sendOk(res, { ...result, remixId: archived.remixId, remix_id: archived.remixId, taskManagementUrl: archived.taskManagementUrl }, requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "download") {
      const output = await downloadVideoOpsJob(scoped, videoOps.jobId);
      return sendBinary(res, output, requestId, `video-ops-${videoOps.jobId}.bin`);
    }
    if (videoOps && req.method === "POST" && videoOps.action === "cancel") {
      const job = await cancelVideoOpsJob(scoped, videoOps.jobId);
      return sendOk(res, await syncVideoOpsJobArchive(scoped, job, { triggerName: "user_stop" }), requestId);
    }
    if (videoOps && req.method === "POST" && videoOps.action === "retry") {
      const job = await retryVideoOpsJob(scoped, videoOps.jobId);
      return sendOk(res, await syncVideoOpsJobArchive(scoped, job, { triggerName: "scheduler_retry" }), requestId);
    }
    const batch = batchRoute(url.pathname);
    if (batch && req.method === "GET" && batch.action === "detail") {
      return sendOk(res, await getBatchDetail(scoped, batch.batchId), requestId);
    }
    if (batch && req.method === "POST" && batch.action === "stop") {
      return sendOk(res, await stopBatch(scoped, batch.batchId, await context.readJson(req)), requestId);
    }
    if (batch && req.method === "POST" && batch.action === "retry-stitch") {
      return sendOk(res, await retryStitch(scoped, batch.batchId, await context.readJson(req)), requestId);
    }
    if (batch && req.method === "POST" && batch.action === "qc") {
      return sendOk(res, await runBatchQc(scoped, batch.batchId), requestId);
    }
    if (batch && req.method === "POST" && batch.action === "confirm-plan") {
      const body = await context.readJson(req);
      if (body.draftSignature && body.draftSignatureInput && isPlanSignatureStale(body.draftSignature, body.draftSignatureInput)) {
        throw new WangzhuanError("validation_error", "Seedance 预案已失效，请重新生成", {
          field: "draftSignature",
          reason: "stale_seedance_plan"
        });
      }
      const confirmed = await confirmBatchPlan(scoped, batch.batchId, body);
      const submitted = await submitPendingGenerationTasks(scoped, batch.batchId);
      const polled = await pollUpstreamBatch(scoped, batch.batchId);
      return sendOk(res, { ...submitted, batch: polled.batch, confirmedBatch: confirmed.batch }, requestId);
    }
    if (batch && req.method === "POST" && batch.action === "confirm-assets") {
      return sendOk(res, await confirmBatchAssets(scoped, batch.batchId, await context.readJson(req)), requestId);
    }
    const remix = remixRoute(url.pathname);
    if (remix && req.method === "GET" && remix.action === "detail") {
      return sendOk(res, await getRemixDetail(scoped, remix.remixId), requestId);
    }
    if (remix && req.method === "POST" && remix.action === "stop") {
      return sendOk(res, await stopRemix(scoped, remix.remixId, await context.readJson(req)), requestId);
    }
    if (remix && req.method === "POST" && remix.action === "preview-confirm") {
      return sendOk(res, await confirmRemixPreview(scoped, remix.remixId, await context.readJson(req)), requestId);
    }
    if (remix && req.method === "GET" && remix.action === "qc-report") {
      return sendOk(res, await getRemixQcReport(scoped, remix.remixId), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/tasks") {
      return sendOk(res, await listTasks(scoped, queryObject(url)), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/gallery") {
      return sendOk(res, await getGallery(scoped, queryObject(url)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/download") {
      const result = await buildDownloadPackage(scoped, await context.readJson(req));
      return sendZip(res, result.zip, requestId);
    }
    throw new WangzhuanError("validation_error", "Unsupported wangzhuan endpoint", {
      method: req.method,
      path: url.pathname
    }, 404);
  } catch (error) {
    return sendErrorEnvelope(res, error, requestId);
  }
}
