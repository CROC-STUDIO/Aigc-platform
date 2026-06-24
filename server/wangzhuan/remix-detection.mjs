import { WangzhuanError } from "./http.mjs";

export const DETECTION_CAPABILITY_KEYS = Object.freeze([
  "logo_icon",
  "product_name",
  "cta",
  "ending",
  "watermark",
  "subtitle",
  "phone_ui"
]);

function normalizeBbox(raw = {}) {
  return {
    x: Number(raw.x || 0),
    y: Number(raw.y || 0),
    width: Number(raw.width || 0),
    height: Number(raw.height || 0)
  };
}

export function normalizeDetectionRegions(items = []) {
  return items.map((item, index) => ({
    regionId: String(item.regionId || `det_${index + 1}`),
    capabilityKey: String(item.capabilityKey || ""),
    label: String(item.label || item.capabilityKey || "region"),
    type: item.type === "description" ? "description" : "bbox",
    source: String(item.source || "detector"),
    confidence: Number(item.confidence || 0.5),
    ...(item.type === "description"
      ? { description: String(item.description || "") }
      : { bbox: normalizeBbox(item.bbox) }),
    ...(item.text ? { text: String(item.text) } : {})
  })).filter((item) => DETECTION_CAPABILITY_KEYS.includes(item.capabilityKey));
}

export function summarizeDetection(regions = []) {
  return DETECTION_CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = regions.filter((item) => item.capabilityKey === key).length;
    return acc;
  }, {});
}

export async function detectRemixRegions(context, request = {}) {
  if (!request.sourceId) {
    throw new WangzhuanError("validation_error", "sourceId 必填", { field: "sourceId" });
  }
  const regions = normalizeDetectionRegions(request.mockRegions || []);
  return {
    detectionId: `rdt_${Date.now()}`,
    sourceId: String(request.sourceId),
    status: "succeeded",
    frameSamples: Array.isArray(request.frameSamples) ? request.frameSamples : [],
    regions,
    summary: summarizeDetection(regions),
    warnings: []
  };
}
