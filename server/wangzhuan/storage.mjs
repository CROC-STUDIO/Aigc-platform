import { appendFile, mkdir, open, readFile, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  deleteObject,
  deleteRecordedAssetMetadata,
  getRecordedAssetMetadata,
  objectStorageEnabled,
  projectStorageDescriptor,
  uploadProjectAsset
} from "../object-storage.mjs";

const PIPELINE_DIR = "网赚管线";
const RECORD_DIR = "批处理记录";

export function wangzhuanPaths(context) {
  const sharedProjectRoot = context.sharedProjectRoot ?? context.currentBaseProjectRoot?.();
  const userProjectRoot = context.userProjectRoot ?? context.currentProjectRoot?.();
  if (!sharedProjectRoot || !userProjectRoot) {
    throw new Error("sharedProjectRoot and userProjectRoot are required");
  }
  const sharedRoot = join(sharedProjectRoot, RECORD_DIR, PIPELINE_DIR);
  const userRoot = join(userProjectRoot, RECORD_DIR, PIPELINE_DIR);
  return {
    sharedRoot,
    userRoot,
    templatesPath: join(sharedRoot, "templates.json"),
    channelRulesPath: join(sharedRoot, "channel-rules.json"),
    auditPath: join(sharedRoot, "audit.jsonl"),
    telemetryPath: join(userRoot, "telemetry.jsonl"),
    referenceVideosDir: join(userRoot, "reference-videos"),
    estimatesDir: join(userRoot, "estimates"),
    batchesDir: join(userRoot, "batches"),
    remixSourcesDir: join(userRoot, "remix-sources"),
    remixEstimatesDir: join(userRoot, "remix-estimates"),
    remixDir: join(userRoot, "remix"),
    idempotencyDir: join(userRoot, "idempotency")
  };
}

export function toProjectRelative(userProjectRoot, fullPath) {
  return fullPath
    .slice(userProjectRoot.length)
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/");
}

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function localPreviewUrl(relativePath) {
  return `/file?path=${encodeURIComponent(relativePath)}`;
}

export async function syncWangzhuanAsset(context, fullPath, assetKind = "wangzhuan_file") {
  if (!objectStorageEnabled()) return null;
  try {
    return await uploadProjectAsset({
      fullPath,
      userRoot: context.userProjectRoot,
      sharedRoot: context.sharedProjectRoot,
      userId: currentUserId(context),
      assetKind
    });
  } catch (error) {
    console.warn(`[object-storage] failed to upload ${assetKind}: ${error.message}`);
    return null;
  }
}

export async function getWangzhuanAssetMetadata(context, relativePath) {
  if (!relativePath) return null;
  try {
    const fullPath = resolve(context.userProjectRoot, String(relativePath));
    const descriptor = projectStorageDescriptor({
      fullPath,
      userRoot: context.userProjectRoot,
      sharedRoot: context.sharedProjectRoot,
      userId: currentUserId(context)
    });
    return getRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
  } catch {
    return null;
  }
}

export async function previewUrlForWangzhuanAsset(context, relativePath) {
  const metadata = await getWangzhuanAssetMetadata(context, relativePath);
  return metadata?.storageUrl || localPreviewUrl(relativePath);
}

export async function removeWangzhuanAssetFromObjectStorage(context, fullPath) {
  if (!objectStorageEnabled()) return null;
  try {
    const descriptor = projectStorageDescriptor({
      fullPath,
      userRoot: context.userProjectRoot,
      sharedRoot: context.sharedProjectRoot,
      userId: currentUserId(context)
    });
    const metadata = await getRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
    if (metadata?.storageKey) await deleteObject(metadata.storageKey);
    await deleteRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
    return metadata;
  } catch (error) {
    console.warn(`[object-storage] failed to delete object: ${error.message}`);
    return null;
  }
}

export async function ensureParent(target) {
  await mkdir(dirname(target), { recursive: true });
}

export async function writeAtomicJson(target, value) {
  await ensureParent(target);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tmp, "w");
    await handle.writeFile(body, "utf8");
    try {
      await handle.sync();
    } catch {
      // Best effort only: some filesystems do not support fsync for this handle.
    }
    await handle.close();
    handle = null;
    await rename(tmp, target);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Keep the original write error.
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // Tmp cleanup is best effort.
    }
    throw error;
  }
}

export async function readJsonOrDefault(target, defaultValue) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(defaultValue);
    throw error;
  }
}

export async function appendJsonl(target, value) {
  await ensureParent(target);
  await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

export async function repairJsonlTail(target) {
  let text;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { checkedLines: 0, removedLines: 0 };
    throw error;
  }
  const lines = text.split("\n");
  const hadTrailingNewline = text.endsWith("\n");
  const candidateLines = hadTrailingNewline ? lines.slice(0, -1) : lines;
  let validUntil = candidateLines.length;
  for (let index = 0; index < candidateLines.length; index += 1) {
    const line = candidateLines[index].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      validUntil = index;
      break;
    }
  }
  if (validUntil === candidateLines.length) {
    return { checkedLines: candidateLines.length, removedLines: 0 };
  }
  const kept = candidateLines.slice(0, validUntil);
  const nextText = kept.length ? `${kept.join("\n")}\n` : "";
  await writeFile(target, nextText, "utf8");
  const info = await stat(target);
  await truncate(target, info.size);
  return { checkedLines: candidateLines.length, removedLines: candidateLines.length - validUntil };
}
