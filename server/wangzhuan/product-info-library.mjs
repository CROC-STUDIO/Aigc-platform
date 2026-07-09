import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { WangzhuanError } from "./http.mjs";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"]
]);

function productInfoRoot(context = {}) {
  return resolve(context.productInfoRoot || join(process.cwd(), "product_info"));
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringList(value) {
  return Array.isArray(value) ? value.map((item) => cleanString(item)).filter(Boolean) : [];
}

function safeProductId(value) {
  const id = cleanString(value);
  if (!/^[a-z0-9._-]+$/i.test(id)) {
    throw new WangzhuanError("validation_error", "产品 ID 不合法", { productId: value }, 400);
  }
  return id;
}

function safeAssetName(value) {
  const name = basename(cleanString(value));
  if (!name || name !== cleanString(value) || name.includes("..")) {
    throw new WangzhuanError("validation_error", "产品素材文件名不合法", { assetName: value }, 400);
  }
  return name;
}

function productAssetUrl(productId, assetName) {
  return `/api/wangzhuan/product-info/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetName)}`;
}

function normalizeMetadata(productId, metadata = {}) {
  return {
    productId,
    productName: cleanString(metadata.productName || metadata.givenName || productId),
    description: cleanString(metadata.description),
    coreSellingPoints: cleanStringList(metadata.coreSellingPoints),
    sourceUrl: cleanString(metadata.sourceUrl),
    store: cleanString(metadata.store),
    developer: cleanString(metadata.developer),
    category: cleanString(metadata.category),
    status: cleanString(metadata.status)
  };
}

async function readMetadata(productDir, productId) {
  try {
    const raw = await readFile(join(productDir, "product-metadata.json"), "utf8");
    return normalizeMetadata(productId, JSON.parse(raw));
  } catch {
    return normalizeMetadata(productId, { productName: productId });
  }
}

function classifyAsset(fileName) {
  const lower = fileName.toLowerCase();
  const ext = extname(lower);
  if (lower.startsWith("icon.") && IMAGE_EXTS.has(ext)) return "productIcon";
  if (lower.startsWith("screenshot-") && IMAGE_EXTS.has(ext)) return "productScreenshot";
  if ((lower.startsWith("recording-") || lower.startsWith("preview-") || lower.startsWith("video-")) && VIDEO_EXTS.has(ext)) {
    return "productRecording";
  }
  if (IMAGE_EXTS.has(ext)) return "productScreenshot";
  if (VIDEO_EXTS.has(ext)) return "productRecording";
  return "";
}

async function listProductAssets(productDir, productId) {
  const assetsDir = join(productDir, "assets");
  let entries = [];
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const assets = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    if (fileName === "assets-manifest.json" || fileName.startsWith(".")) continue;
    const assetKey = classifyAsset(fileName);
    if (!assetKey) continue;
    const ext = extname(fileName).toLowerCase();
    assets.push({
      assetKey,
      fileName,
      mimeType: MIME_BY_EXT.get(ext) || "application/octet-stream",
      previewUrl: productAssetUrl(productId, fileName),
      storageUrl: productAssetUrl(productId, fileName),
      storageKey: `product_info/${productId}/assets/${fileName}`,
      storedPath: `product_info/${productId}/assets/${fileName}`
    });
  }
  return assets.sort((left, right) => {
    const rank = { productIcon: 0, productScreenshot: 1, productRecording: 2 };
    return (rank[left.assetKey] ?? 9) - (rank[right.assetKey] ?? 9)
      || left.fileName.localeCompare(right.fileName, undefined, { numeric: true });
  });
}

function assetSummary(assets = []) {
  return {
    iconCount: assets.filter((asset) => asset.assetKey === "productIcon").length,
    screenshotCount: assets.filter((asset) => asset.assetKey === "productScreenshot").length,
    recordingCount: assets.filter((asset) => asset.assetKey === "productRecording").length
  };
}

export async function listProductInfoItems(context = {}) {
  const root = productInfoRoot(context);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { items: [], rootAvailable: false };
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const productId = entry.name;
    const productDir = join(root, productId);
    const metadata = await readMetadata(productDir, productId);
    const assets = await listProductAssets(productDir, productId);
    items.push({
      ...metadata,
      assetSummary: assetSummary(assets),
      primaryIconUrl: assets.find((asset) => asset.assetKey === "productIcon")?.previewUrl || "",
      screenshotPreviewUrls: assets.filter((asset) => asset.assetKey === "productScreenshot").slice(0, 3).map((asset) => asset.previewUrl)
    });
  }
  return {
    items: items.sort((left, right) => left.productName.localeCompare(right.productName, undefined, { numeric: true })),
    rootAvailable: true
  };
}

export async function getProductInfoItem(context = {}, productIdValue = "") {
  const productId = safeProductId(productIdValue);
  const root = productInfoRoot(context);
  const productDir = resolve(root, productId);
  if (!productDir.startsWith(`${root}/`) && productDir !== root) {
    throw new WangzhuanError("validation_error", "产品 ID 不合法", { productId }, 400);
  }
  const exists = await stat(productDir).then((item) => item.isDirectory()).catch(() => false);
  if (!exists) {
    throw new WangzhuanError("product_not_found", "产品库中未找到该产品", { productId }, 404);
  }
  const metadata = await readMetadata(productDir, productId);
  const assets = await listProductAssets(productDir, productId);
  return {
    product: {
      ...metadata,
      assets,
      assetSummary: assetSummary(assets),
      productBrief: {
        productName: metadata.productName,
        description: metadata.description,
        coreSellingPoints: metadata.coreSellingPoints,
        sourceUrl: metadata.sourceUrl,
        assetSlots: {
          productIcon: assets.find((asset) => asset.assetKey === "productIcon")?.previewUrl || "",
          productScreenshots: assets.filter((asset) => asset.assetKey === "productScreenshot").map((asset) => asset.previewUrl),
          productRecording: assets.find((asset) => asset.assetKey === "productRecording")?.previewUrl || ""
        }
      }
    }
  };
}

export async function loadProductInfoAsset(context = {}, productIdValue = "", assetNameValue = "") {
  const productId = safeProductId(productIdValue);
  const assetName = safeAssetName(assetNameValue);
  const root = productInfoRoot(context);
  const target = resolve(root, productId, "assets", assetName);
  const assetsRoot = resolve(root, productId, "assets");
  if (!target.startsWith(`${assetsRoot}/`)) {
    throw new WangzhuanError("validation_error", "产品素材路径不合法", { productId, assetName }, 400);
  }
  const ext = extname(assetName).toLowerCase();
  const mimeType = MIME_BY_EXT.get(ext);
  if (!mimeType) {
    throw new WangzhuanError("invalid_material", "产品素材格式不支持", { assetName }, 400);
  }
  try {
    return {
      buffer: await readFile(target),
      mimeType,
      fileName: assetName
    };
  } catch {
    throw new WangzhuanError("asset_not_found", "产品素材不存在", { productId, assetName }, 404);
  }
}
