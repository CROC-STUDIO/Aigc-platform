import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const RECORD_DIR = "批处理记录";
const ASSET_INDEX_FILE = "object-storage-assets.json";
const DEFAULT_PREFIX = "uploads";
const DEFAULT_API_PREFIX = "/api";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);
const MIME_BY_EXT = new Map([
  ...IMAGE_MIME_BY_EXT,
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".json", "application/json"],
  [".txt", "text/plain; charset=utf-8"],
  [".zip", "application/zip"]
]);

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function objectStorageSettings(env = process.env) {
  return {
    bucket: String(env.S3_BUCKET || "").trim(),
    region: String(env.AWS_REGION || env.AWS_DEFAULT_REGION || "").trim(),
    endpoint: String(env.S3_ENDPOINT || "").trim(),
    prefix: String(env.S3_PREFIX || DEFAULT_PREFIX).trim().replace(/^[/\s]+|[/\s]+$/g, "") || DEFAULT_PREFIX,
    acl: String(env.S3_ACL || "").trim(),
    publicBaseUrl: String(env.S3_PUBLIC_BASE_URL || "").trim(),
    apiPublicBaseUrl: String(env.PUBLIC_BASE_URL || "").trim(),
    apiPrefix: String(env.API_PREFIX || DEFAULT_API_PREFIX).trim() || DEFAULT_API_PREFIX,
    forcePathStyle: truthy(env.S3_FORCE_PATH_STYLE)
  };
}

export function objectStorageEnabled(env = process.env) {
  const settings = objectStorageSettings(env);
  return Boolean(settings.bucket && settings.region);
}

export function createObjectStorageClient(settings = objectStorageSettings()) {
  if (!settings.bucket || !settings.region) {
    throw new Error("object storage is not configured");
  }
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    ...(settings.forcePathStyle ? { forcePathStyle: true } : {})
  });
}

export function normalizeFilename(filename, fallback = "file") {
  const raw = basename(String(filename || fallback)).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_");
  const parsed = parse(raw);
  const safeBase = parsed.name
    .normalize("NFC")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
  const safeExt = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `${safeBase || parse(fallback).name || "file"}${safeExt}`;
}

export function normalizeContentType(mimeType, filename = "") {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (normalized && normalized.includes("/")) return normalized;
  return MIME_BY_EXT.get(extname(filename).toLowerCase()) || "application/octet-stream";
}

export function buildAssetId(prefix = "asset") {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function sanitizeKeySegment(value, fallback = "item") {
  const clean = String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
  return clean || fallback;
}

function slugSegment(value, fallback = "project") {
  return sanitizeKeySegment(value, fallback).replace(/[^\p{L}\p{N}._-]+/gu, "_") || fallback;
}

function encodeStorageKey(storageKey) {
  return String(storageKey || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function buildPublicUrl(storageKey, env = process.env) {
  const settings = objectStorageSettings(env);
  const quotedKey = encodeStorageKey(storageKey);
  if (settings.publicBaseUrl) {
    return `${settings.publicBaseUrl.replace(/\/+$/, "")}/${quotedKey}`;
  }
  const path = `${settings.apiPrefix.replace(/\/+$/, "")}/public/assets/${quotedKey}`;
  return settings.apiPublicBaseUrl
    ? `${settings.apiPublicBaseUrl.replace(/\/+$/, "")}${path}`
    : path;
}

export function buildStorageKey({ env = process.env, assetId = buildAssetId(), filename, prefix } = {}) {
  const settings = objectStorageSettings(env);
  const basePrefix = String(prefix || settings.prefix || DEFAULT_PREFIX).trim().replace(/^[/\s]+|[/\s]+$/g, "") || DEFAULT_PREFIX;
  return `${basePrefix}/${sanitizeKeySegment(assetId, "asset")}/${normalizeFilename(filename)}`;
}

function normalizedRelativePath(root, fullPath) {
  const base = resolve(root);
  const target = resolve(fullPath);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(base, rel) !== target) {
    return null;
  }
  return rel.replace(/\\/g, "/");
}

export function projectStorageDescriptor({ env = process.env, fullPath, userRoot, sharedRoot, userId = "local", assetId = "" } = {}) {
  if (!fullPath || !userRoot || !sharedRoot) {
    throw new Error("fullPath, userRoot, and sharedRoot are required");
  }
  const userRelative = normalizedRelativePath(userRoot, fullPath);
  const sharedRelative = normalizedRelativePath(sharedRoot, fullPath);
  let scope;
  let root;
  let relativePath;
  if (userRelative) {
    scope = "user";
    root = resolve(userRoot);
    relativePath = userRelative;
  } else if (sharedRelative) {
    scope = "shared";
    root = resolve(sharedRoot);
    relativePath = sharedRelative;
  } else {
    throw new Error("file is outside project roots");
  }

  const settings = objectStorageSettings(env);
  const projectSlug = slugSegment(basename(resolve(sharedRoot)), "project");
  const pathParts = relativePath.split("/").filter(Boolean);
  const fileName = normalizeFilename(pathParts.pop() || basename(fullPath));
  const namespace = scope === "user"
    ? ["users", slugSegment(userId, "local")]
    : ["shared"];
  const storagePathParts = [
    settings.prefix,
    projectSlug,
    ...namespace,
    ...pathParts.map((part) => sanitizeKeySegment(part)),
    assetId ? `${sanitizeKeySegment(assetId)}_${fileName}` : fileName
  ].filter(Boolean);
  const storageKey = storagePathParts.join("/");
  return {
    scope,
    root,
    relativePath,
    storageKey,
    storageUrl: buildPublicUrl(storageKey, env)
  };
}

export async function uploadObjectBuffer({ buffer, storageKey, contentType, env = process.env, client = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("object buffer is empty");
  const settings = objectStorageSettings(env);
  const s3 = client || createObjectStorageClient(settings);
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: storageKey,
    Body: buffer,
    ContentType: normalizeContentType(contentType, storageKey),
    CacheControl: CACHE_CONTROL,
    ...(settings.acl ? { ACL: settings.acl } : {})
  });
  await s3.send(command);
  return storageKey;
}

export async function uploadObjectFile({ filePath, storageKey, contentType, env = process.env, client = null } = {}) {
  const settings = objectStorageSettings(env);
  const s3 = client || createObjectStorageClient(settings);
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: storageKey,
    Body: createReadStream(filePath),
    ContentType: normalizeContentType(contentType, filePath),
    CacheControl: CACHE_CONTROL,
    ...(settings.acl ? { ACL: settings.acl } : {})
  });
  await s3.send(command);
  return storageKey;
}

export async function openObjectStream(storageKey, { env = process.env, client = null, range = "" } = {}) {
  const settings = objectStorageSettings(env);
  const s3 = client || createObjectStorageClient(settings);
  const payload = await s3.send(new GetObjectCommand({
    Bucket: settings.bucket,
    Key: String(storageKey || "").replace(/^\/+/, ""),
    ...(range ? { Range: range } : {})
  }));
  const body = payload.Body;
  return {
    body: typeof body?.pipe === "function" ? body : Readable.fromWeb(body),
    contentType: payload.ContentType || "application/octet-stream",
    contentLength: payload.ContentLength,
    contentRange: payload.ContentRange,
    acceptRanges: payload.AcceptRanges,
    cacheControl: payload.CacheControl || CACHE_CONTROL
  };
}

export async function deleteObject(storageKey, { env = process.env, client = null } = {}) {
  if (!storageKey || !objectStorageEnabled(env)) return { skipped: true };
  const settings = objectStorageSettings(env);
  const s3 = client || createObjectStorageClient(settings);
  await s3.send(new DeleteObjectCommand({
    Bucket: settings.bucket,
    Key: String(storageKey || "").replace(/^\/+/, "")
  }));
  return { skipped: false };
}

function assetIndexPath(root) {
  return join(root, RECORD_DIR, ASSET_INDEX_FILE);
}

async function readAssetIndex(root) {
  try {
    const data = JSON.parse(await readFile(assetIndexPath(root), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? { schemaVersion: "object-storage-assets.v1", items: {}, ...data, items: data.items || {} }
      : { schemaVersion: "object-storage-assets.v1", items: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: "object-storage-assets.v1", items: {} };
    throw error;
  }
}

async function writeAssetIndex(root, index) {
  const target = assetIndexPath(root);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function hashRelative(relativePath) {
  return createHash("sha256").update(String(relativePath), "utf8").digest("hex");
}

export async function recordAssetMetadata({ root, relativePath, metadata } = {}) {
  if (!root || !relativePath) throw new Error("root and relativePath are required");
  const index = await readAssetIndex(root);
  const key = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const now = new Date().toISOString();
  const next = {
    assetId: metadata.assetId || `asset_${hashRelative(key).slice(0, 24)}`,
    assetKind: metadata.assetKind || "file",
    scope: metadata.scope || "",
    filename: normalizeFilename(metadata.filename || basename(key)),
    mimeType: normalizeContentType(metadata.mimeType, metadata.filename || key),
    sizeBytes: Number(metadata.sizeBytes || 0),
    relativePath: key,
    storageKey: String(metadata.storageKey || ""),
    storageUrl: String(metadata.storageUrl || ""),
    createdAt: index.items[key]?.createdAt || now,
    updatedAt: now
  };
  index.items[key] = next;
  index.updatedAt = now;
  await writeAssetIndex(root, index);
  return next;
}

export async function getRecordedAssetMetadata({ root, relativePath } = {}) {
  if (!root || !relativePath) return null;
  const index = await readAssetIndex(root);
  return index.items[String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "")] || null;
}

export async function deleteRecordedAssetMetadata({ root, relativePath } = {}) {
  if (!root || !relativePath) return null;
  const index = await readAssetIndex(root);
  const key = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  const existing = index.items[key] || null;
  delete index.items[key];
  index.updatedAt = new Date().toISOString();
  await writeAssetIndex(root, index);
  return existing;
}

export async function uploadProjectAsset({ env = process.env, fullPath, userRoot, sharedRoot, userId, assetKind = "file", contentType = "", client = null } = {}) {
  if (!objectStorageEnabled(env)) return null;
  const descriptor = projectStorageDescriptor({ env, fullPath, userRoot, sharedRoot, userId });
  const info = await stat(fullPath);
  await uploadObjectFile({
    env,
    client,
    filePath: fullPath,
    storageKey: descriptor.storageKey,
    contentType: contentType || normalizeContentType("", fullPath)
  });
  return recordAssetMetadata({
    root: descriptor.root,
    relativePath: descriptor.relativePath,
    metadata: {
      assetKind,
      scope: descriptor.scope,
      filename: basename(fullPath),
      mimeType: contentType || normalizeContentType("", fullPath),
      sizeBytes: info.size,
      storageKey: descriptor.storageKey,
      storageUrl: descriptor.storageUrl
    }
  });
}
