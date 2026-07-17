import { getChannelRules } from "./channel-rules.mjs";
import { estimateBatch, prepareBatchPlanFromEstimate, prepareBatchPlanFromEstimateStream, startBatchFromEstimate } from "./estimates.mjs";
import { getGallery } from "./gallery.mjs";
import { listTasks } from "./tasks.mjs";
import { WangzhuanError, requirePermission, sendErrorEnvelope, sendOk } from "./http.mjs";
import { makeRequestId } from "./ids.mjs";
import { saveBatchDraft } from "./batch-drafts.mjs";
import { publicLlmConfig, publicQcLlmConfig } from "./llm-config.mjs";
import { buildDownloadPackage } from "./package.mjs";
import {
  confirmBatchAssets,
  confirmBatchPlan,
  getBatchDetail,
  getActiveBatch,
  retryFailedGenerationTasksForUser,
  retryGenerationTaskForUser,
  stopBatch
} from "./pipeline.mjs";
import { uploadDisclaimerOverlayAsset, uploadProductAsset } from "./product-assets.mjs";
import { uploadPostProcessEnding } from "./postprocess.mjs";
import { runBatchQc } from "./qc.mjs";
import { detectRemixRegions } from "./remix-detection.mjs";
import { buildRemixPlan } from "./remix-plan.mjs";
import { initWangzhuanSse } from "./sse.mjs";
import {
  checkReferenceVideo,
  decomposeReferenceVideo,
  draftReferenceVideoDecomposition,
  draftReferenceVideoDecompositionStream,
  findReusableReferenceVideo,
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
import {
  generateSeedancePromptFromParsedProductLink,
  getParsedProductLinkReviewStatus,
  parseProductLinkForSeedance,
  reviewParsedProductLinkAssets
} from "./product-link-codex.mjs";
import { autoGenerateSeedancePrompt } from "./auto-seedance-prompt.mjs";
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
  resolveVideoOpsArchive,
  syncVideoOpsJobArchive
} from "./video-ops-archive.mjs";
import { createBackgroundJob, getBackgroundJob, isPlanSignatureStale, listBackgroundJobs, planDraftSignature } from "./background-jobs.mjs";
import {
  ensureExpandableOutput,
  expansionJobMeta,
  normalizeExpansionRequest,
  runOutputExpansion
} from "./output-expansion.mjs";
import {
  normalizeLocalStickerRequest,
  runLocalStickerOverlayJob
} from "./local-sticker-overlay.mjs";
import {
  loadCodexPromptDraftFact,
  loadBatchDetailFromMysql,
  loadOutputDetailFromMysql,
  syncBatchFacts,
  syncVideoDecompositionFact,
  syncCodexExecJobFact,
  syncCodexPromptDraftFact
} from "./mysql-facts.mjs";
import {
  generateBaseSeedancePrompt,
  loadSeedancePromptDraft,
  refineSeedancePromptWithApprovedAssets
} from "./codex-prompt.mjs";
import {
  getProductInfoItem,
  listProductInfoItems,
  loadProductInfoAsset
} from "./product-info-library.mjs";

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
    buffer: file.buffer
  };
}

function batchRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})(?:\/(stop|retry-stitch|qc|confirm-plan|confirm-assets))?$/);
  if (!match) return null;
  return { batchId: match[1], action: match[2] || "detail" };
}

function segmentRetryRoute(pathname) {
  const bulkMatch = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})\/tasks\/retry-failed$/);
  if (bulkMatch) return { batchId: bulkMatch[1], action: "retry_failed", taskId: "" };
  const taskMatch = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})\/tasks\/([^/]+)\/retry$/);
  if (!taskMatch) return null;
  return {
    batchId: taskMatch[1],
    action: "retry_one",
    taskId: decodeURIComponent(taskMatch[2])
  };
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

function localVideoEditRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/local-video-edits\/jobs(?:\/([^/]+)(?:\/(result))?)?$/);
  if (!match) return null;
  return { jobId: match[1] ? decodeURIComponent(match[1]) : "", action: match[2] || (match[1] ? "detail" : "collection") };
}

function localProviderJob(job = {}) {
  return {
    ...job,
    job_id: job.id,
    job_type: "local_sticker_overlay",
    provider: "local_ffmpeg",
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    finished_at: ["succeeded", "failed"].includes(job.status) ? job.updatedAt : null
  };
}

function localArchivePayload(payload, normalized) {
  return {
    job_type: "local_sticker_overlay",
    input: {
      source_type: normalized.sourceType,
      ...(normalized.sourceType === "url" ? { source: normalized.source } : {})
    },
    params: {
      region_spec: [{ ...normalized.region, coordinate_space: "normalized", time_ranges: [] }],
      sticker_scale_mode: normalized.stickerScaleMode,
      has_sticker: normalized.hasSticker
    },
    options: { priority: Number(payload.options?.priority || 0) }
  };
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

function referenceVideoCheckJobRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/reference-videos\/check-jobs\/([^/]+)$/);
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

function productInfoRoute(pathname) {
  if (pathname === "/api/wangzhuan/product-info") return { collection: true };
  const assetMatch = pathname.match(/^\/api\/wangzhuan\/product-info\/([^/]+)\/assets\/([^/]+)$/);
  if (assetMatch) {
    return {
      productId: decodeURIComponent(assetMatch[1]),
      assetName: decodeURIComponent(assetMatch[2]),
      asset: true
    };
  }
  const detailMatch = pathname.match(/^\/api\/wangzhuan\/product-info\/([^/]+)$/);
  if (detailMatch) return { productId: decodeURIComponent(detailMatch[1]) };
  return null;
}

function codexSeedancePromptRoute(pathname) {
  if (pathname !== "/api/wangzhuan/codex/seedance-prompt") return null;
  return { collection: true };
}

const DECOMPOSITION_FAILED_MISSING_FIELDS = Object.freeze([
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality",
  "hook"
]);

function normalizeDecompositionJobError(error) {
  const code = error?.code || "model_failed";
  const rawMessage = String(error?.message || "");
  const upstreamMessage = String(error?.data?.upstreamMessage || "");
  const reason = String(error?.data?.reason || "");
  const aborted = rawMessage.includes("aborted")
    || upstreamMessage.includes("aborted")
    || rawMessage.includes("AbortError")
    || upstreamMessage.includes("AbortError");
  const timedOut = reason === "timeout" || rawMessage.includes("超时") || upstreamMessage.includes("timed out");
  if (code === "model_failed" && (aborted || timedOut)) {
    return new WangzhuanError("model_failed", "模型请求已中断，可重试", {
      ...error?.data,
      reason: reason || "timeout",
      upstreamMessage: upstreamMessage || rawMessage || "This operation was aborted",
      originalMessage: rawMessage || "模型拆解请求失败",
      errorCode: code,
      errorMessage: "模型请求已中断，可重试"
    }, error?.status);
  }
  return error instanceof WangzhuanError
    ? error
    : new WangzhuanError(code, rawMessage || "AI 拆解失败", error?.data || {}, error?.status);
}

async function persistFailedDecompositionJob(scoped, context, body, error) {
  if (!body?.referenceVideoId) return;
  const persistDecomposition = scoped.syncVideoDecompositionFact
    || context.syncVideoDecompositionFact
    || syncVideoDecompositionFact;
  const loadBatchDetail = scoped.loadBatchDetailFromMysql
    || context.loadBatchDetailFromMysql
    || loadBatchDetailFromMysql;
  const persistBatch = scoped.syncBatchFacts
    || context.syncBatchFacts
    || syncBatchFacts;
  const failedDecomposition = {
    referenceVideoId: body.referenceVideoId,
    schemaVersion: "video_decomposition.v1",
    status: "failed",
    missingFields: DECOMPOSITION_FAILED_MISSING_FIELDS.slice(),
    errorCode: error?.data?.errorCode || error?.code || "model_failed",
    errorMessage: error?.data?.errorMessage || error?.message || "AI 拆解失败",
    upstreamMessage: String(error?.data?.upstreamMessage || "").slice(0, 500),
    reason: String(error?.data?.reason || "").slice(0, 120)
  };
  await persistDecomposition(scoped, failedDecomposition);
  if (!body.batchId) return;
  const detail = await loadBatchDetail(scoped, body.batchId);
  const batch = detail?.batch;
  if (!batch) return;
  await persistBatch(scoped, {
    ...batch,
    status: "failed",
    stopReason: failedDecomposition.reason || "decomposition_failed",
    decomposition: failedDecomposition,
    updatedAt: new Date().toISOString()
  }, "decomposition_failed");
}

function codexSeedancePromptJobRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/codex\/seedance-prompt-jobs\/([^/]+)$/);
  if (!match) return null;
  return { jobId: decodeURIComponent(match[1]) };
}

function autoSeedancePromptJobsRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})\/auto-seedance-prompt-jobs(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    batchId: match[1],
    jobId: match[2] ? decodeURIComponent(match[2]) : ""
  };
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

function sendProductAsset(res, asset, requestId) {
  res.writeHead(200, {
    "Content-Type": asset.mimeType || "application/octet-stream",
    "Content-Length": asset.buffer.length,
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": `inline; filename="${asset.fileName || "product-asset"}"`,
    "X-Request-Id": requestId
  });
  res.end(asset.buffer);
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
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/reuse-check") {
      const runFindReusable = scoped.findReusableReferenceVideo || context.findReusableReferenceVideo || findReusableReferenceVideo;
      return sendOk(res, await runFindReusable(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/check") {
      const runCheck = scoped.checkReferenceVideo || context.checkReferenceVideo || checkReferenceVideo;
      return sendOk(res, await runCheck(scoped, await readReferenceVideoCheckRequest(context, req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/check-jobs") {
      const body = await readReferenceVideoCheckRequest(context, req);
      const job = createBackgroundJob("reference_video_check", async ({ log, progress }) => {
        log("参考视频后台检查已开始");
        progress(12, "正在写入文件并读取视频基础信息");
        const runCheck = scoped.checkReferenceVideo || context.checkReferenceVideo || checkReferenceVideo;
        progress(35, "正在检查视频规格，必要时生成拆解代理视频");
        const result = await runCheck(scoped, body);
        progress(95, "正在保存参考视频状态");
        return result;
      }, {
        context: scoped,
        subjectType: "reference_video_upload",
        subjectId: String(body.fileHash || body.fileName || body.name || "")
      });
      return sendOk(res, { ...job, referenceVideoCheckJobId: job.id }, requestId);
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
        progress(12, "正在检查拆解缓存和视频基础信息");
        log("正在读取视频基础信息、模型、地区和语言配置");
        const runDraft = scoped.draftReferenceVideoDecomposition || context.draftReferenceVideoDecomposition || draftReferenceVideoDecomposition;
        progress(28, "正在进行场景切点、抽帧和 LLM 秒级剧情拆解");
        let result;
        try {
          result = await runDraft(scoped, body, {
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
        } catch (error) {
          throw normalizeDecompositionJobError(error);
        }
        if (result?.draft?.source === "cache") {
          log("命中拆解缓存，跳过 LLM 调用", { cacheKey: result.draft.cacheKey });
        }
        progress(95, "正在整理拆解字段");
        return result;
      }, {
        context: scoped,
        subjectType: "reference_video",
        subjectId: String(body.referenceVideoId || ""),
        onError: async ({ error }) => {
          await persistFailedDecompositionJob(scoped, context, body, normalizeDecompositionJobError(error));
        }
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
    const referenceCheckJob = referenceVideoCheckJobRoute(url.pathname);
    if (referenceCheckJob && req.method === "GET") {
      const job = await getBackgroundJob(scoped, referenceCheckJob.jobId);
      if (!job) throw new WangzhuanError("job_not_found", "参考视频检查任务不存在或已过期", { jobId: referenceCheckJob.jobId }, 404);
      return sendOk(res, {
        ...job,
        referenceVideoCheckJobId: job.id,
        referenceVideo: job.result?.referenceVideo || null
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
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/postprocess-assets/ending") {
      return sendOk(res, await uploadPostProcessEnding(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/draft") {
      return sendOk(res, await saveBatchDraft(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/store-page/inspect") {
      return sendOk(res, await inspectStorePage(scoped, await context.readJson(req)), requestId);
    }
    const productInfo = productInfoRoute(url.pathname);
    if (productInfo && req.method === "GET" && productInfo.collection) {
      return sendOk(res, await listProductInfoItems(scoped), requestId);
    }
    if (productInfo && req.method === "GET" && productInfo.asset) {
      return sendProductAsset(res, await loadProductInfoAsset(scoped, productInfo.productId, productInfo.assetName), requestId);
    }
    if (productInfo && req.method === "GET" && productInfo.productId) {
      return sendOk(res, await getProductInfoItem(scoped, productInfo.productId), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/product-link/parse") {
      const handler = scoped.parseProductLinkForSeedance || context.parseProductLinkForSeedance || parseProductLinkForSeedance;
      return sendOk(res, await handler(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/product-link/assets/review") {
      const handler = scoped.reviewParsedProductLinkAssets || context.reviewParsedProductLinkAssets || reviewParsedProductLinkAssets;
      return sendOk(res, await handler(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "GET" && url.pathname === "/api/wangzhuan/product-link/assets/review-status") {
      const batchId = String(url.searchParams.get("batchId") || "").trim();
      const handler = scoped.getParsedProductLinkReviewStatus || context.getParsedProductLinkReviewStatus || getParsedProductLinkReviewStatus;
      return sendOk(res, await handler(scoped, batchId), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/product-link/codex/seedance-prompt/base") {
      const handler = scoped.generateSeedancePromptFromParsedProductLink || context.generateSeedancePromptFromParsedProductLink || generateSeedancePromptFromParsedProductLink;
      return sendOk(res, await handler({
        ...scoped,
        syncCodexExecJobFact: scoped.syncCodexExecJobFact || context.syncCodexExecJobFact || syncCodexExecJobFact,
        syncCodexPromptDraftFact: scoped.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact || syncCodexPromptDraftFact
      }, {
        ...(await context.readJson(req)),
        requestId
      }, "base"), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/product-link/codex/seedance-prompt/refine") {
      const handler = scoped.generateSeedancePromptFromParsedProductLink || context.generateSeedancePromptFromParsedProductLink || generateSeedancePromptFromParsedProductLink;
      return sendOk(res, await handler({
        ...scoped,
        syncCodexExecJobFact: scoped.syncCodexExecJobFact || context.syncCodexExecJobFact || syncCodexExecJobFact,
        syncCodexPromptDraftFact: scoped.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact || syncCodexPromptDraftFact
      }, {
        ...(await context.readJson(req)),
        requestId
      }, "refine"), requestId);
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
    const codexPromptRoute = codexSeedancePromptRoute(url.pathname);
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/codex/seedance-prompt-jobs") {
      const body = await context.readJson(req);
      const mode = String(body.mode || "base").trim() || "base";
      const generator = mode === "refine"
        ? (scoped.refineSeedancePromptWithApprovedAssets || context.refineSeedancePromptWithApprovedAssets || refineSeedancePromptWithApprovedAssets)
        : (scoped.generateBaseSeedancePrompt || context.generateBaseSeedancePrompt || generateBaseSeedancePrompt);
      const job = createBackgroundJob("codex_seedance_prompt", async ({ log, progress }) => {
        log(mode === "refine" ? "Codex 正在优化 Seedance prompt" : "Codex 正在生成 Seedance prompt");
        progress(25, "正在调用 Codex");
        const result = await generator({
          context: {
            ...scoped,
            syncCodexExecJobFact: scoped.syncCodexExecJobFact || context.syncCodexExecJobFact || syncCodexExecJobFact,
            syncCodexPromptDraftFact: scoped.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact || syncCodexPromptDraftFact
          },
          ...body,
          requestId
        });
        progress(95, "正在整理 prompt 结果");
        return result;
      }, {
        context: scoped,
        subjectType: "batch",
        subjectId: String(body.batchId || "")
      });
      return sendOk(res, {
        ...job,
        codexPromptJobId: job.id,
        mode,
        batchId: String(body.batchId || "")
      }, requestId);
    }
    const codexPromptJob = codexSeedancePromptJobRoute(url.pathname);
    if (codexPromptJob && req.method === "GET") {
      const job = await getBackgroundJob(scoped, codexPromptJob.jobId);
      if (!job) throw new WangzhuanError("job_not_found", "Codex prompt 任务不存在或已过期", { jobId: codexPromptJob.jobId }, 404);
      return sendOk(res, {
        ...job,
        codexPromptJobId: job.id,
        promptDraft: job.result || null
      }, requestId);
    }
    if (codexPromptRoute && req.method === "POST") {
      const body = await context.readJson(req);
      const mode = String(body.mode || "base").trim() || "base";
      const generator = mode === "refine"
        ? (scoped.refineSeedancePromptWithApprovedAssets || context.refineSeedancePromptWithApprovedAssets || refineSeedancePromptWithApprovedAssets)
        : (scoped.generateBaseSeedancePrompt || context.generateBaseSeedancePrompt || generateBaseSeedancePrompt);
      const result = await generator({
        context: {
          ...scoped,
          syncCodexExecJobFact: scoped.syncCodexExecJobFact || context.syncCodexExecJobFact || syncCodexExecJobFact,
          syncCodexPromptDraftFact: scoped.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact || syncCodexPromptDraftFact
        },
        ...body,
        requestId
      });
      return sendOk(res, result, requestId);
    }
    const autoSeedancePromptJob = autoSeedancePromptJobsRoute(url.pathname);
    if (autoSeedancePromptJob && req.method === "POST" && !autoSeedancePromptJob.jobId) {
      const body = await context.readJson(req);
      const job = createBackgroundJob("auto_seedance_prompt", async ({ log, progress }) => {
        log("自动生成 Seedance prompt 已开始");
        progress(20, "正在检查批次信息与素材审核");
        const result = await (scoped.autoGenerateSeedancePrompt || context.autoGenerateSeedancePrompt || autoGenerateSeedancePrompt)({
          ...scoped,
          getBatchDetail: scoped.getBatchDetail || context.getBatchDetail || getBatchDetail,
          confirmBatchAssets: scoped.confirmBatchAssets || context.confirmBatchAssets || confirmBatchAssets,
          generateBaseSeedancePrompt: scoped.generateBaseSeedancePrompt || context.generateBaseSeedancePrompt || generateBaseSeedancePrompt,
          refineSeedancePromptWithApprovedAssets: scoped.refineSeedancePromptWithApprovedAssets || context.refineSeedancePromptWithApprovedAssets || refineSeedancePromptWithApprovedAssets,
          syncCodexExecJobFact: scoped.syncCodexExecJobFact || context.syncCodexExecJobFact || syncCodexExecJobFact,
          syncCodexPromptDraftFact: scoped.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact || syncCodexPromptDraftFact
        }, autoSeedancePromptJob.batchId, {
          ...body,
          requestId
        });
        progress(95, "正在整理 Seedance prompt 结果");
        return result;
      }, {
        context: scoped,
        subjectType: "batch",
        subjectId: autoSeedancePromptJob.batchId
      });
      return sendOk(res, {
        ...job,
        autoSeedancePromptJobId: job.id,
        batchId: autoSeedancePromptJob.batchId
      }, requestId);
    }
    if (autoSeedancePromptJob && req.method === "GET" && autoSeedancePromptJob.jobId) {
      const job = await getBackgroundJob(scoped, autoSeedancePromptJob.jobId);
      if (!job || job.subjectId !== autoSeedancePromptJob.batchId) {
        throw new WangzhuanError("job_not_found", "自动生成 Seedance prompt 任务不存在或已过期", {
          batchId: autoSeedancePromptJob.batchId,
          jobId: autoSeedancePromptJob.jobId
        }, 404);
      }
      return sendOk(res, {
        ...job,
        autoSeedancePromptJobId: job.id,
        promptDraft: job.result?.promptDraft || null
      }, requestId);
    }
    if (autoSeedancePromptJob && req.method === "GET" && !autoSeedancePromptJob.jobId) {
      const [latest] = await listBackgroundJobs(scoped, {
        type: "auto_seedance_prompt",
        subjectType: "batch",
        subjectId: autoSeedancePromptJob.batchId
      });
      if (!latest) {
        throw new WangzhuanError("job_not_found", "自动生成 Seedance prompt 任务不存在或已过期", {
          batchId: autoSeedancePromptJob.batchId
        }, 404);
      }
      return sendOk(res, {
        ...latest,
        autoSeedancePromptJobId: latest.id,
        promptDraft: latest.result?.promptDraft || null
      }, requestId);
    }
    if (codexPromptRoute && req.method === "GET") {
      const batchId = String(url.searchParams.get("batchId") || "").trim();
      const promptDraftId = String(url.searchParams.get("promptDraftId") || "").trim();
      if (!batchId) {
        throw new WangzhuanError("validation_error", "batchId 不能为空", { field: "batchId" });
      }
      const fromMysql = await (scoped.loadCodexPromptDraftFact || context.loadCodexPromptDraftFact || loadCodexPromptDraftFact)(batchId, promptDraftId);
      if (fromMysql) return sendOk(res, fromMysql, requestId);
      const fromJson = promptDraftId
        ? await (scoped.loadSeedancePromptDraft || context.loadSeedancePromptDraft || loadSeedancePromptDraft)(scoped, batchId, promptDraftId)
        : null;
      if (fromJson) return sendOk(res, fromJson, requestId);
      throw new WangzhuanError("batch_not_found", "Codex prompt 草稿不存在", {
        batchId,
        promptDraftId
      }, 404);
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
    const localVideoEdit = localVideoEditRoute(url.pathname);
    if (localVideoEdit && req.method === "POST" && localVideoEdit.action === "collection") {
      const payload = await context.readJson(req);
      const normalized = normalizeLocalStickerRequest(payload);
      const archivePayload = localArchivePayload(payload, normalized);
      const archiveSubmission = context.archiveVideoOpsSubmission || archiveVideoOpsSubmission;
      const syncArchive = context.syncVideoOpsJobArchive || syncVideoOpsJobArchive;
      const runEdit = context.runLocalStickerOverlayJob || runLocalStickerOverlayJob;
      let releaseArchive;
      let rejectArchive;
      const archiveReady = new Promise((resolve, reject) => {
        releaseArchive = resolve;
        rejectArchive = reject;
      });
      const job = createBackgroundJob("local_sticker_overlay", async ({ jobId, log, progress }) => {
        await archiveReady;
        log("本地视频区域处理已开始");
        progress(15, "正在准备视频和贴纸素材");
        const rendered = await runEdit(payload, { jobId });
        progress(85, "正在校验并归档输出视频");
        const completedJob = localProviderJob({
          ...job,
          id: jobId,
          status: "succeeded",
          updatedAt: new Date().toISOString()
        });
        const archived = await syncArchive(scoped, completedJob, {
          payload: archivePayload,
          outputBuffer: rendered.outputBuffer,
          result: rendered.result,
          triggerName: "remix_write"
        });
        progress(98, "输出视频已归档");
        return {
          ...rendered.result,
          remixId: archived.remixId || "",
          remix_id: archived.remixId || "",
          taskManagementUrl: archived.taskManagementUrl || ""
        };
      }, {
        context: scoped,
        subjectType: "remix",
        subjectId: "local_sticker_overlay"
      });
      try {
        const archived = await archiveSubmission(scoped, archivePayload, localProviderJob(job));
        releaseArchive();
        return sendOk(res, { ...localProviderJob(job), ...archived }, requestId);
      } catch (error) {
        rejectArchive(error);
        throw error;
      }
    }
    if (localVideoEdit && req.method === "GET" && ["detail", "result"].includes(localVideoEdit.action)) {
      const job = await getBackgroundJob(scoped, localVideoEdit.jobId);
      if (!job || job.type !== "local_sticker_overlay") {
        throw new WangzhuanError("job_not_found", "本地视频处理任务不存在或已过期", { jobId: localVideoEdit.jobId }, 404);
      }
      const archive = await (context.resolveVideoOpsArchive || resolveVideoOpsArchive)(scoped, job.id).catch(() => null);
      const publicJob = {
        ...localProviderJob(job),
        ...(archive?.remixId ? {
          remixId: archive.remixId,
          remix_id: archive.remixId,
          taskManagementUrl: `/wangzhuan-tasks.html?remixId=${encodeURIComponent(archive.remixId)}`
        } : {})
      };
      if (localVideoEdit.action === "result") {
        if (job.status !== "succeeded") {
          throw new WangzhuanError("invalid_state_transition", "本地视频处理尚未完成", { jobId: job.id, status: job.status }, 409);
        }
        const output = archive?.outputs?.[0] || {};
        return sendOk(res, {
          ...(job.result || {}),
          download_url: output.previewUrl || output.storageUrl || "",
          outputs: archive?.outputs || [],
          remixId: archive?.remixId || job.result?.remixId || "",
          remix_id: archive?.remixId || job.result?.remix_id || "",
          taskManagementUrl: publicJob.taskManagementUrl || job.result?.taskManagementUrl || ""
        }, requestId);
      }
      return sendOk(res, publicJob, requestId);
    }
    const segmentRetry = segmentRetryRoute(url.pathname);
    if (segmentRetry && req.method === "POST" && segmentRetry.action === "retry_one") {
      const retryOne = scoped.retryGenerationTaskForUser || retryGenerationTaskForUser;
      return sendOk(
        res,
        await retryOne(scoped, segmentRetry.batchId, segmentRetry.taskId, await context.readJson(req)),
        requestId
      );
    }
    if (segmentRetry && req.method === "POST" && segmentRetry.action === "retry_failed") {
      const retryFailed = scoped.retryFailedGenerationTasksForUser || retryFailedGenerationTasksForUser;
      return sendOk(
        res,
        await retryFailed(scoped, segmentRetry.batchId, await context.readJson(req)),
        requestId
      );
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
      const polled = await pollUpstreamBatch(scoped, batch.batchId);
      return sendOk(res, {
        ...confirmed,
        batch: polled.batch,
        confirmedBatch: confirmed.confirmedBatch || confirmed.batch
      }, requestId);
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
    console.error(`[wangzhuan-api] requestId=${requestId} ${req.method} ${url.pathname} failed`, {
      name: error?.name || "",
      code: error?.code || "",
      message: error?.message || "",
      stack: error?.stack || "",
      data: error?.data || error?.details || {}
    });
    return sendErrorEnvelope(res, error, requestId);
  }
}
