function cleanText(value = "") {
  return String(value || "").trim();
}

function compactPhrase(value = "", fallback = "") {
  const text = cleanText(value)
    .replace(/[，。、“”"'`]/g, " ")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  return text.split(" ").slice(0, 4).join("");
}

function safeFileStem(value = "", fallback = "video") {
  const text = cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

export function buildOutputDisplayName({ batch = {}, script = {}, outputId = "", durationSec = 15 } = {}) {
  const decomposition = batch.decomposition || {};
  const branch = script.branchDraft || {};
  const scene = compactPhrase(decomposition.scene, "场景");
  const subject = compactPhrase(decomposition.subject, "主角");
  const materialDirection = compactPhrase(branch.materialDirection || batch.templateSnapshot?.draft?.materialDirection, "方向");
  const durationTag = Number(durationSec) === 30 ? "30s" : "15s";
  const stem = safeFileStem([scene, subject, materialDirection, durationTag].filter(Boolean).join("_"), outputId || "video");
  return `${stem}.mp4`;
}
