import { getChannelRules } from "./channel-rules.mjs";
import { estimateBatch, startBatchFromEstimate } from "./estimates.mjs";
import { getGallery } from "./gallery.mjs";
import { WangzhuanError, requirePermission, sendErrorEnvelope, sendOk } from "./http.mjs";
import { makeRequestId } from "./ids.mjs";
import { publicLlmConfig } from "./llm-config.mjs";
import { buildDownloadPackage } from "./package.mjs";
import { getBatchDetail, stopBatch } from "./pipeline.mjs";
import { checkReferenceVideo, decomposeReferenceVideo, draftReferenceVideoDecomposition } from "./reference-videos.mjs";
import {
  confirmRemixPreview,
  estimateRemix,
  getRemixDetail,
  startDirectMaskEdit,
  startRemix,
  stopRemix,
  uploadRemixSource
} from "./remix.mjs";
import { retryStitch } from "./stitch.mjs";
import { adminTemplateAction, listTemplates, saveTemplate } from "./templates.mjs";

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
  const match = pathname.match(/^\/api\/wangzhuan\/batches\/(wzb_\d{14}_[a-f0-9]{4})(?:\/(stop|retry-stitch))?$/);
  if (!match) return null;
  return { batchId: match[1], action: match[2] || "detail" };
}

function remixRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/remix\/(rmx_\d{14}_[a-f0-9]{4})(?:\/(preview-confirm|stop))?$/);
  if (!match) return null;
  return { remixId: match[1], action: match[2] || "detail" };
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
      return sendOk(res, publicLlmConfig(scoped.config), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/check") {
      return sendOk(res, await checkReferenceVideo(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/draft-decomposition") {
      return sendOk(res, await draftReferenceVideoDecomposition(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/reference-videos/decompose") {
      return sendOk(res, await decomposeReferenceVideo(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/estimate") {
      return sendOk(res, await estimateBatch(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/batches/start") {
      return sendOk(res, await startBatchFromEstimate(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/upload") {
      return sendOk(res, await uploadRemixSource(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/estimate") {
      return sendOk(res, await estimateRemix(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/start") {
      return sendOk(res, await startRemix(scoped, await context.readJson(req)), requestId);
    }
    if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/mask-edit") {
      return sendOk(res, await startDirectMaskEdit(scoped, await context.readJson(req)), requestId);
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
