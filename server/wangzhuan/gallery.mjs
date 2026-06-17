import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { WangzhuanError } from "./http.mjs";
import { wangzhuanPaths } from "./storage.mjs";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

async function readBatch(context, batchId) {
  const target = join(wangzhuanPaths(context).batchesDir, batchId, "batch.json");
  if (!existsSync(target)) return null;
  const batch = JSON.parse(await readFile(target, "utf8"));
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    return null;
  }
  return batch;
}

async function readRemix(context, remixId) {
  const target = join(wangzhuanPaths(context).remixDir, remixId, "remix.json");
  if (!existsSync(target)) return null;
  const remix = JSON.parse(await readFile(target, "utf8"));
  if (remix.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    return null;
  }
  return remix;
}

async function batchIdsFromIndex(context) {
  const indexPath = join(wangzhuanPaths(context).batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    return (Array.isArray(index.items) ? index.items : []).map((item) => item.batchId).filter(Boolean);
  }
  try {
    const entries = await readdir(wangzhuanPaths(context).batchesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function remixIdsFromIndex(context) {
  const indexPath = join(wangzhuanPaths(context).remixDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    return (Array.isArray(index.items) ? index.items : []).map((item) => item.remixId).filter(Boolean);
  }
  try {
    const entries = await readdir(wangzhuanPaths(context).remixDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1";
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    const time = String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
    if (time) return time;
    return String(left.outputId).localeCompare(String(right.outputId));
  });
}

function countsFor(items) {
  const byQcStatus = {};
  const byKind = {};
  for (const item of items) {
    byQcStatus[item.qcStatus] = (byQcStatus[item.qcStatus] || 0) + 1;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  }
  return {
    total: items.length,
    downloadEligible: items.filter((item) => item.downloadEligible).length,
    byQcStatus,
    byKind
  };
}

export async function getGallery(context, query = {}) {
  const batchIds = query.batchId
    ? [String(query.batchId)]
    : await batchIdsFromIndex(context);
  const remixIds = query.remixId
    ? [String(query.remixId)]
    : await remixIdsFromIndex(context);
  const items = [];

  for (const batchId of batchIds) {
    if (!/^wzb_\d{14}_[a-f0-9]{4}$/.test(batchId)) {
      throw new WangzhuanError("validation_error", "batchId 不合法", { batchId });
    }
    const batch = await readBatch(context, batchId);
    if (!batch) continue;
    for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
      items.push({
        ...output,
        batchStatus: batch.status,
        templateId: batch.templateSnapshot?.templateId,
        versionId: batch.templateSnapshot?.versionId,
        productName: batch.templateSnapshot?.draft?.productName || "",
        targetChannel: batch.templateSnapshot?.draft?.targetChannels?.[0] || "generic",
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt
      });
    }
  }

  for (const remixId of remixIds) {
    if (!/^rmx_\d{14}_[a-f0-9]{4}$/.test(remixId)) {
      throw new WangzhuanError("validation_error", "remixId 不合法", { remixId });
    }
    const remix = await readRemix(context, remixId);
    if (!remix) continue;
    for (const output of Array.isArray(remix.outputs) ? remix.outputs : []) {
      items.push({
        ...output,
        remixStatus: remix.status,
        templateId: remix.templateSnapshot?.templateId,
        versionId: remix.templateSnapshot?.versionId,
        productName: remix.templateSnapshot?.draft?.productName || "",
        targetChannel: remix.targetChannel || remix.templateSnapshot?.draft?.targetChannels?.[0] || "generic",
        createdAt: remix.createdAt,
        updatedAt: remix.updatedAt
      });
    }
  }

  let filtered = items;
  if (normalizeBoolean(query.downloadEligibleOnly)) {
    filtered = filtered.filter((item) => item.downloadEligible);
  }
  if (query.qcStatus) {
    filtered = filtered.filter((item) => item.qcStatus === query.qcStatus);
  }
  if (query.kind) {
    filtered = filtered.filter((item) => item.kind === query.kind);
  }

  return {
    items: sortItems(filtered),
    filters: {
      ...(query.batchId ? { batchId: String(query.batchId) } : {}),
      ...(query.remixId ? { remixId: String(query.remixId) } : {}),
      downloadEligibleOnly: normalizeBoolean(query.downloadEligibleOnly),
      ...(query.qcStatus ? { qcStatus: String(query.qcStatus) } : {}),
      ...(query.kind ? { kind: String(query.kind) } : {})
    },
    counts: countsFor(filtered)
  };
}
