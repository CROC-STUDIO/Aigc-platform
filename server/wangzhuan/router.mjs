import { getChannelRules } from "./channel-rules.mjs";
import { estimateBatch, prepareBatchPlanFromEstimate, startBatchFromEstimate } from "./estimates.mjs";
import { getGallery } from "./gallery.mjs";
import { listTasks } from "./tasks.mjs";
import { WangzhuanError, requirePermission, sendErrorEnvelope, sendOk } from "./http.mjs";
import { makeRequestId } from "./ids.mjs";
import { saveBatchDraft } from "./batch-drafts.mjs";
import { publicLlmConfig, publicQcLlmConfig } from "./llm-config.mjs";
import { buildDownloadPackage } from "./package.mjs";
import { confirmBatchPlan, getBatchDetail, getActiveBatch, stopBatch, submitPendingGenerationTasks } from "./pipeline.mjs";
import { uploadProductAsset } from "./product-assets.mjs";
import { runBatchQc } from "./qc.mjs";
import { detectRemixRegions } from "./remix-detection.mjs";
import { buildRemixPlan } from "./remix-plan.mjs";
import {
  checkReferenceVideo,
  decomposeReferenceVideo,
  draftReferenceVideoDecomposition,
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

function batchRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})(?:\/(stop|retry-stitch|qc|confirm-plan))?$/);
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
  const scoped = buildContext(context);
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
      return sendOk(res, await checkReferenceVideo(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/draft-decomposition") {
      return sendOk(res, await draftReferenceVideoDecomposition(scoped, await context.readJson(req), { requestId }), requestId);
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
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/draft") {
      return sendOk(res, await saveBatchDraft(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/store-page/inspect") {
      return sendOk(res, await inspectStorePage(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/estimate") {
      return sendOk(res, await estimateBatch(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/plan") {
      return sendOk(res, await prepareBatchPlanFromEstimate(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/start") {
      const started = await startBatchFromEstimate(scoped, await context.readJson(req));
      return sendOk(res, started, requestId);
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
      return sendOk(res, await createVideoOpsJob(scoped, await context.readJson(req)), requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "detail") {
      return sendOk(res, await getVideoOpsJob(scoped, videoOps.jobId, queryObject(url)), requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "result") {
      return sendOk(res, await getVideoOpsJobResult(scoped, videoOps.jobId, queryObject(url)), requestId);
    }
    if (videoOps && req.method === "GET" && videoOps.action === "download") {
      const output = await downloadVideoOpsJob(scoped, videoOps.jobId);
      return sendBinary(res, output, requestId, `video-ops-${videoOps.jobId}.bin`);
    }
    if (videoOps && req.method === "POST" && videoOps.action === "cancel") {
      return sendOk(res, await cancelVideoOpsJob(scoped, videoOps.jobId), requestId);
    }
    if (videoOps && req.method === "POST" && videoOps.action === "retry") {
      return sendOk(res, await retryVideoOpsJob(scoped, videoOps.jobId), requestId);
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
      const confirmed = await confirmBatchPlan(scoped, batch.batchId, await context.readJson(req));
      const submitted = await submitPendingGenerationTasks(scoped, batch.batchId);
      const polled = await pollUpstreamBatch(scoped, batch.batchId);
      return sendOk(res, { ...submitted, batch: polled.batch, confirmedBatch: confirmed.batch }, requestId);
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
