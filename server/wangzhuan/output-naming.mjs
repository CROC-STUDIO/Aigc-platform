function cleanText(value = "") {
  return String(value || "").trim();
}

function safeFileStem(value = "", fallback = "video") {
  const text = cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.map(cleanText).find(Boolean);
      if (first) return first;
      continue;
    }
    const clean = cleanText(value);
    if (clean) return clean;
  }
  return "";
}

function outputRegion(batch = {}, script = {}) {
  const branch = script.branchDraft || {};
  const request = batch.request || {};
  const estimateRequest = batch.estimate?.request || {};
  const region = firstValue(
    branch.regions,
    branch.targetRegions,
    branch.targetRegion,
    script.regions,
    script.targetRegions,
    script.targetRegion,
    request.regions,
    request.targetRegions,
    request.targetRegion,
    estimateRequest.regions,
    estimateRequest.targetRegions,
    estimateRequest.targetRegion
  );
  return safeFileStem(region || "UNKNOWN", "UNKNOWN").toUpperCase();
}

export function buildOutputDisplayName({ batch = {}, script = {}, outputId = "", width = 720, height = 1280 } = {}) {
  const batchId = safeFileStem(batch.batchId, outputId || "video");
  const canvasWidth = Number(width) > 0 ? Math.trunc(Number(width)) : 720;
  const canvasHeight = Number(height) > 0 ? Math.trunc(Number(height)) : 1280;
  const stem = safeFileStem(`${batchId}_${outputRegion(batch, script)}_${canvasWidth}x${canvasHeight}`, outputId || "video");
  return `${stem}.mp4`;
}
